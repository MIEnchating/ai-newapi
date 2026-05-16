import {
  currentTime,
  type ChannelRecord,
  type EventRecord,
  type StatusTone
} from './store';

type RefreshContext = {
  credential?: string;
};

type RefreshResult = {
  channel: ChannelRecord;
  event?: EventRecord;
};

type JsonRecord = Record<string, unknown>;

export async function refreshChannelMonitoring(channel: ChannelRecord, context: RefreshContext): Promise<RefreshResult> {
  if (channel.upstreamType === 'cli_proxy') {
    return {
      channel: {
        ...channel,
        balance: '-',
        currentRate: null,
        previousRate: null,
        groupRatio: null,
        rateSource: '不适用',
        cf: '不适用',
        status: channel.status === '已禁用' ? '已禁用' : '仅转发',
        statusTone: 'limited',
        sync: '不适用'
      }
    };
  }

  if (!context.credential || !channel.credentialConfigured) {
    return limited(channel, '待配置凭据', '未配置上游 Key / Token，无法读取余额和分组倍率');
  }

  if (channel.auth === 'API Key' && channel.upstreamType !== 'newapi') {
    return limited(channel, '受限监控', '普通 API Key 不能可靠读取账号余额和分组倍率');
  }

  try {
    const snapshot =
      channel.upstreamType === 'sub2api'
        ? await readSub2ApiSnapshot(channel, context.credential)
        : await readNewApiSnapshot(channel, context.credential);

    const previousRate = channel.currentRate;
    const currentRate = snapshot.groupRatio;
    const rateChanged = currentRate !== null && previousRate !== null && Math.abs(currentRate - previousRate) > 1e-9;
    const statusTone: StatusTone = snapshot.limited ? 'limited' : rateChanged ? 'warn' : 'ok';
    const nextChannel: ChannelRecord = {
      ...channel,
      group: snapshot.groupLabel ?? channel.group,
      balance: snapshot.balance ?? '不可见',
      models: snapshot.models ?? channel.models,
      groupRatio: snapshot.groupRatio,
      currentRate,
      previousRate,
      cf: '无防护',
      rateSource: snapshot.source,
      status: snapshot.status,
      statusTone,
      sync: '刚刚'
    };

    return {
      channel: nextChannel,
      event:
        rateChanged && currentRate !== null && previousRate !== null
          ? {
              title: `${channel.name} 分组倍率变化`,
              detail: `${channel.upstreamName} / ${channel.group} / ${previousRate.toFixed(4)}x -> ${currentRate.toFixed(4)}x`,
              time: currentTime(),
              status: currentRate > previousRate ? 'error' : 'success'
            }
          : {
              title: `${channel.name} 同步完成`,
              detail: `${channel.upstreamName} / ${snapshot.source} / ${snapshot.groupLabel ?? channel.group}`,
              time: currentTime(),
              status: snapshot.limited ? 'warning' : 'success'
            }
    };
  } catch (error) {
    const message = errorMessage(error);
    const challenge = isChallenge(message);

    return {
      channel: {
        ...channel,
        cf: challenge ? 'Challenge' : channel.cf,
        status: challenge ? 'CF Challenge' : '读取失败',
        statusTone: challenge ? 'limited' : 'error',
        rateSource: challenge ? 'Cloudflare Challenge' : '读取失败',
        sync: '刚刚'
      },
      event: {
        title: `${channel.name} 同步失败`,
        detail: message,
        time: currentTime(),
        status: challenge ? 'warning' : 'error'
      }
    };
  }
}

function limited(channel: ChannelRecord, status: string, detail: string): RefreshResult {
  return {
    channel: {
      ...channel,
      balance: channel.upstreamType === 'cli_proxy' ? '-' : '不可见',
      currentRate: null,
      previousRate: channel.currentRate ?? channel.previousRate,
      groupRatio: channel.groupRatio ?? null,
      rateSource: status,
      status,
      statusTone: 'limited',
      sync: '刚刚'
    },
    event: {
      title: `${channel.name} ${status}`,
      detail,
      time: currentTime(),
      status: 'warning'
    }
  };
}

async function readNewApiSnapshot(channel: ChannelRecord, credential: string) {
  const baseUrl = normalizeBaseUrl(channel.upstreamBaseUrl);
  const userId = channel.upstreamUserId?.trim();
  const authHeaders = userId
    ? {
        authorization: `Bearer ${stripBearer(credential)}`,
        'New-Api-User': userId
      }
    : undefined;

  const [statusPayload, selfPayload, groupsPayload, tokensPayload, pricingPayload, ratioConfigPayload] = await Promise.all([
    fetchJson(baseUrl, '/api/status').catch(() => null),
    authHeaders ? fetchJson(baseUrl, '/api/user/self', { headers: authHeaders }).catch(errorPayload) : Promise.resolve(null),
    authHeaders ? fetchJson(baseUrl, '/api/user/self/groups', { headers: authHeaders }).catch(errorPayload) : Promise.resolve(null),
    authHeaders ? fetchJson(baseUrl, '/api/token/?p=1&page_size=1000', { headers: authHeaders }).catch(errorPayload) : Promise.resolve(null),
    fetchJson(baseUrl, '/api/pricing', authHeaders ? { headers: authHeaders } : undefined).catch(errorPayload),
    fetchJson(baseUrl, '/api/ratio_config').catch(() => null)
  ]);

  const selfError = errorFromPayload(selfPayload);
  const groupsError = errorFromPayload(groupsPayload);
  const pricingError = errorFromPayload(pricingPayload);
  const status = recordValue(unwrapData(statusPayload));
  const self = recordValue(unwrapData(selfPayload));
  const groupData = recordValue(unwrapData(groupsPayload));
  const tokens = arrayOfRecords(unwrapList(tokensPayload));
  const matchedToken = findNewApiToken(tokens, channel);
  const effectiveGroup = stringValue(matchedToken?.group) ?? channel.group;
  const pricing = recordValue(pricingPayload);
  const ratioConfig = recordValue(unwrapData(ratioConfigPayload));
  const pricingData = arrayOfRecords(unwrapData(pricingPayload));
  const groupRatioFromSelf = parseNewApiUserGroupRatio(groupData, effectiveGroup);
  const groupRatioFromPricing = parseGroupRatio(recordValue(pricing?.group_ratio), effectiveGroup);
  const groupRatio = groupRatioFromSelf ?? groupRatioFromPricing;
  const quotaPerUnit = numeric(status?.quota_per_unit) ?? 500000;
  const quota = numeric(self?.quota ?? self?.balance);
  const modelsFromPricing = pricingData.length;
  const modelsFromRatioConfig = Object.keys(parseMap(ratioConfig?.model_ratio)).length;
  const balanceVisible = quota !== undefined;
  const balanceError = authHeaders && selfError ? `余额读取失败：${selfError}` : undefined;
  const groupError = groupsError ?? pricingError;
  const groupStatus = groupRatio === null && groupError ? `倍率读取失败：${groupError}` : undefined;
  const source =
    groupRatioFromSelf !== null && groupRatioFromSelf !== undefined
      ? '/api/user/self/groups'
      : groupRatioFromPricing !== null && groupRatioFromPricing !== undefined
        ? '/api/pricing'
        : groupStatus ?? '未找到分组倍率';

  return {
    balance: balanceVisible ? formatAmount(quota / quotaPerUnit) : '不可见',
    models: modelsFromPricing || modelsFromRatioConfig,
    groupRatio,
    groupLabel: effectiveGroup,
    source: balanceError ? balanceError : source,
    status: groupRatio === null ? (groupStatus ? '倍率读取失败' : '未找到分组倍率') : balanceVisible ? '正常' : balanceError ? '余额读取失败' : '余额不可见',
    limited: groupRatio === null || !balanceVisible
  };
}

async function readSub2ApiSnapshot(channel: ChannelRecord, credential: string) {
  const baseUrl = normalizeBaseUrl(channel.upstreamBaseUrl);
  const headers = { authorization: `Bearer ${stripBearer(credential)}` };
  const [selfPayload, keysPayload, groupsPayload, ratesPayload, channelsPayload] = await Promise.all([
    fetchJson(baseUrl, '/api/v1/auth/me', { headers }),
    fetchJson(baseUrl, '/api/v1/keys?page=1&page_size=1000', { headers }).catch(() => null),
    fetchJson(baseUrl, '/api/v1/groups/available', { headers }).catch(() => null),
    fetchJson(baseUrl, '/api/v1/groups/rates', { headers }).catch(() => null),
    fetchJson(baseUrl, '/api/v1/channels/available', { headers }).catch(() => null)
  ]);

  const self = recordValue(unwrapData(selfPayload));
  const keys = arrayOfRecords(unwrapList(keysPayload));
  const groups = arrayOfRecords(unwrapData(groupsPayload));
  const rates = unwrapData(ratesPayload);
  const matchedKey = findSub2ApiKey(keys, channel);
  const matchedGroup = findSub2ApiGroup(groups, matchedKey, channel.group);
  const groupRatioInfo = parseSub2ApiGroupRatio(matchedGroup, rates);
  const groupRatio = groupRatioInfo.value;
  const modelCount = modelCountFromSub2ApiChannels(arrayOfRecords(unwrapData(channelsPayload)));
  const balance = numeric(self?.balance);
  const balanceVisible = balance !== undefined;

  return {
    balance: balanceVisible ? formatAmount(balance) : '不可见',
    models: modelCount,
    groupRatio,
    groupLabel: matchedGroup ? stringValue(matchedGroup.name) ?? channel.group : channel.group,
    source: matchedKey ? `/api/v1/keys + ${groupRatioInfo.source}` : groupRatioInfo.source,
    status: groupRatio === null ? '未找到分组倍率' : balanceVisible ? '正常' : '余额不可见',
    limited: groupRatio === null || !balanceVisible
  };
}

async function fetchJson(baseUrl: string, path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.headers ?? {})
      },
      signal: controller.signal
    });
    const text = await response.text();

    if (isChallenge(text)) {
      throw new Error('上游返回 Cloudflare/验证码页面');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${clip(text)}`);
    }

    const payload = JSON.parse(text) as unknown;
    const record = recordValue(payload);
    const code = numeric(record?.code);

    if (record?.success === false) {
      throw new Error(stringValue(record.message) ?? '上游接口返回失败');
    }

    if (code !== undefined && code !== 0) {
      throw new Error(stringValue(record?.message) ?? stringValue(record?.reason) ?? `上游接口返回 code ${code}`);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorPayload(error: unknown) {
  return { __relayDeskError: errorMessage(error) };
}

function errorFromPayload(payload: unknown) {
  return stringValue(recordValue(payload)?.__relayDeskError);
}

function parseNewApiUserGroupRatio(groups: JsonRecord | undefined, group: string) {
  const value = groups?.[group];
  const record = recordValue(value);
  const ratio = numeric(record?.ratio ?? value);
  return ratio ?? null;
}

function findNewApiToken(tokens: JsonRecord[], channel: ChannelRecord) {
  const keyName = channel.keyName?.trim().toLowerCase();

  if (!keyName) {
    return undefined;
  }

  return tokens.find((token) => {
    const name = stringValue(token.name)?.toLowerCase();
    const key = stringValue(token.key)?.toLowerCase();
    return name === keyName || key === keyName || Boolean(key?.endsWith(keyName));
  });
}

function parseGroupRatio(groupRatio: JsonRecord | undefined, group: string) {
  return numeric(groupRatio?.[group]) ?? null;
}

function parseSub2ApiGroupRatio(group: JsonRecord | undefined, rates: unknown) {
  if (!group) {
    return { value: null, source: '未找到分组' };
  }

  const id = stringValue(group.id);
  const defaultRate = numeric(group.rate_multiplier ?? group.rateMultiplier);
  const rateMap = recordValue(rates);
  const rateRows = arrayOfRecords(rates);
  const userRate = id ? numeric(rateMap?.[id]) : undefined;
  const rowRate = id
    ? rateRows
        .map((row) => (stringValue(row.group_id ?? row.groupId ?? row.id) === id ? numeric(row.rate_multiplier ?? row.rateMultiplier) : undefined))
        .find((value) => value !== undefined)
    : undefined;

  if (userRate !== undefined || rowRate !== undefined) {
    return { value: userRate ?? rowRate ?? null, source: '/api/v1/groups/rates' };
  }

  return { value: defaultRate ?? null, source: defaultRate === undefined ? '未找到分组倍率' : '/api/v1/groups/available' };
}

function findSub2ApiKey(keys: JsonRecord[], channel: ChannelRecord) {
  const keyName = channel.keyName?.trim().toLowerCase();

  if (!keyName) {
    return undefined;
  }

  return keys.find((key) => {
    const name = stringValue(key.name)?.toLowerCase();
    const value = stringValue(key.key)?.toLowerCase();
    return name === keyName || value === keyName || Boolean(value?.endsWith(keyName));
  });
}

function findSub2ApiGroup(groups: JsonRecord[], key: JsonRecord | undefined, groupName: string) {
  const keyGroupId = stringValue(key?.group_id ?? key?.groupId);
  const normalizedName = groupName.trim().toLowerCase();

  return (
    groups.find((group) => keyGroupId && stringValue(group.id) === keyGroupId) ??
    groups.find((group) => stringValue(group.name)?.toLowerCase() === normalizedName || stringValue(group.id) === groupName)
  );
}

function modelCountFromSub2ApiChannels(channels: JsonRecord[]) {
  const models = new Set<string>();

  for (const channel of channels) {
    const values = Array.isArray(channel.models) ? channel.models : [];
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        models.add(value);
      }
    }
  }

  return models.size;
}

function unwrapData(payload: unknown): unknown {
  const record = recordValue(payload);
  return record && 'data' in record ? record.data : payload;
}

function unwrapList(payload: unknown): unknown {
  const data = unwrapData(payload);
  const record = recordValue(data);
  return record?.items ?? record?.data ?? data;
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object') : [];
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function parseMap(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return recordValue(parsed) ?? {};
    } catch {
      return {};
    }
  }

  return {};
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '自动') {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function stripBearer(value: string) {
  return value.replace(/^bearer\s+/i, '').trim();
}

function isChallenge(text: string) {
  return /cloudflare|turnstile|captcha|challenge/i.test(text);
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatAmount(value: number) {
  if (!Number.isFinite(value)) {
    return '不可见';
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
