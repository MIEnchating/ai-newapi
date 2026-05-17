import { percentChange, stableRateKey, type RateInfo, type UpstreamAdapter } from '@ai-relay/shared';
import { AlertRuleType, RateDirection, UpstreamStatus, UpstreamType } from '@prisma/client';
import { decryptCredentialPayload } from '../credentials';
import { NewApiAdapter } from '../upstream-adapters/newapi-adapter';
import { Sub2ApiAdapter } from '../upstream-adapters/sub2api-adapter';
import { prisma } from '../prisma';

const settingId = 'default';

type InspectionSettingState = {
  latencyTestEnabled: boolean;
  latencyIntervalMs: number;
  latencyTimeoutMs: number;
  latencyDisableThresholdMs: number;
  latencyFailureLimit: number;
  disabledRetestMs: number;
  balanceLowAction: InspectionRuleAction;
  rateIncreaseAction: InspectionRuleAction;
  ruleActionPriority: number;
  ruleActionWeight: number;
};

type InspectionRuleAction = 'NONE' | 'LOWER' | 'DISABLE';

type UpstreamLatencyState = {
  status: UpstreamStatus;
  disabledByLatency: boolean;
  skipLatencyDisable: boolean;
  latencySuccessCount: number;
  latencyFailureCount: number;
  rechargeRatio: unknown;
  groupName: string;
};

type LatencyUpdateData = {
  priority?: number;
  weight?: number;
  status?: UpstreamStatus;
  latencyMs?: number | null;
  latencyCheckedAt?: Date;
  latencySuccessCount?: number;
  latencyFailureCount?: number;
  latencyLastError?: string | null;
  disabledByLatency?: boolean;
  latencyDisabledAt?: Date | null;
  latencyNextCheckAt?: Date | null;
};

type MainStationWritableUpstream = {
  id: string;
  status: UpstreamStatus;
  priority: number;
  weight: number;
  disabledByLatency: boolean;
  latencyDisabledAt: Date | null;
  latencyFailureCount: number;
};

type MainStationChannelUpdate = {
  enabled?: boolean;
  priority?: number;
  weight?: number;
};

type MainStationWriteResult = {
  intent?: MainStationChannelUpdate;
  error?: string;
};

type MainStationLatencyProbe = {
  ok: boolean;
  skipped?: boolean;
  latencyMs: number | null;
  message?: string;
};

export async function syncUpstream(upstreamId: string) {
  await ensureUpstreamLatencySchema();
  const upstreamRecord = await prisma.upstream.findUnique({
    where: { id: upstreamId },
    include: { credential: true }
  });

  if (!upstreamRecord) {
    throw new Error(`upstream not found: ${upstreamId}`);
  }

  const upstream = {
    ...upstreamRecord,
    skipLatencyDisable: await loadSkipLatencyDisable(upstreamId)
  };
  const setting = await loadInspectionSetting();
  const latencyProbe = await probeMainStationLatency(upstream, setting);

  try {
    const adapter = createAdapter(upstream);
    const state = await adapter.getAccountState();
    const rates = await adapter.listRates();
    const previous = await loadPreviousRates(upstreamId, rates);
    const events = diffRates(previous, rates);
    const canonicalGroupName = canonicalRateGroupName(rates, upstream.groupName);
    const latencyData = latencyDataFromMainStationProbe(upstream, rates, state.status, setting, latencyProbe);
    const ruleData = await ruleActionData(upstream, state.balance, events, setting);
    const persistedLatencyData = applyMainStationWriteResult(
      upstream,
      { ...latencyData, ...ruleData },
      await syncMainStationChannelIfNeeded(upstream, { ...latencyData, ...ruleData })
    );

    await prisma.$transaction(async (tx) => {
      await tx.upstream.update({
        where: { id: upstreamId },
        data: {
          balance: state.balance,
          balanceCurrency: state.balanceCurrency,
          concurrency: state.concurrency,
          lastError: state.lastError ?? null,
          lastSyncAt: new Date(),
          ...(canonicalGroupName && canonicalGroupName !== upstream.groupName ? { groupName: canonicalGroupName } : {}),
          ...persistedLatencyData
        }
      });

      if (rates.length > 0) {
        await tx.rateSnapshot.createMany({
          data: rates.map((rate) => ({
            upstreamId,
            provider: rate.provider,
            model: rate.model,
            groupName: rate.group,
            channelName: rate.channelName,
            inputPrice: rate.inputPrice,
            outputPrice: rate.outputPrice,
            modelRatio: rate.modelRatio,
            completionRatio: rate.completionRatio,
            currency: rate.currency,
            source: rate.source,
            rawHash: rate.rawHash,
            capturedAt: new Date(rate.capturedAt)
          }))
        });
      }

      if (events.length > 0) {
        await tx.rateChangeEvent.createMany({
          data: events.map((event) => ({
            upstreamId,
            provider: event.provider,
            model: event.model,
            groupName: event.group,
            field: event.field,
            direction: event.direction,
            oldValue: event.oldValue,
            newValue: event.newValue,
            changePercent: event.changePercent
          }))
        });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown sync error';
    const challenge = /cloudflare|challenge|captcha|turnstile/i.test(message);
    const latencyData = latencyDataFromFailedSync(upstream, setting, latencyProbe, message);
    const persistedLatencyData = applyMainStationWriteResult(
      upstream,
      latencyData,
      await syncMainStationChannelIfNeeded(upstream, latencyData)
    );

    await prisma.upstream.update({
      where: { id: upstreamId },
      data: {
        ...persistedLatencyData,
        status: persistedLatencyData.status ?? (challenge ? UpstreamStatus.CHALLENGE_REQUIRED : UpstreamStatus.ERROR),
        lastError: message,
        lastSyncAt: new Date()
      }
    });

    throw error;
  }
}

async function loadInspectionSetting() {
  await ensureInspectionSchema();
  const setting = await prisma.inspectionSetting.upsert({
    where: { id: settingId },
    create: {
      id: settingId,
      enabled: true,
      intervalMs: normalizeInterval(Number(process.env.SYNC_INTERVAL_MS ?? 900_000)),
      latencyTestEnabled: true,
      latencyIntervalMs: 300_000,
      latencyTimeoutMs: 10_000,
      latencyDisableThresholdMs: 8_000,
      latencyFailureLimit: 3,
      disabledRetestMs: 1_800_000,
      lastResult: '自动巡检已就绪'
    },
    update: {}
  });
  const [extras] = await prisma.$queryRaw<Array<{
    balanceLowAction: string | null;
    rateIncreaseAction: string | null;
    ruleActionPriority: number | null;
    ruleActionWeight: number | null;
  }>>`
    SELECT balanceLowAction, rateIncreaseAction, ruleActionPriority, ruleActionWeight
    FROM InspectionSetting
    WHERE id = ${settingId}
    LIMIT 1
  `;

  return {
    ...setting,
    balanceLowAction: normalizeRuleAction(extras?.balanceLowAction),
    rateIncreaseAction: normalizeRuleAction(extras?.rateIncreaseAction),
    ruleActionPriority: clampInteger(numeric(extras?.ruleActionPriority) ?? 10, 0, 100),
    ruleActionWeight: clampInteger(numeric(extras?.ruleActionWeight) ?? 0, 0, 10)
  };
}

async function probeMainStationLatency(
  upstream: { id: string },
  setting: InspectionSettingState
): Promise<MainStationLatencyProbe | null> {
  if (!setting.latencyTestEnabled) {
    return null;
  }

  const channelId = mainStationChannelId(upstream.id);
  if (!channelId) {
    return {
      ok: false,
      skipped: true,
      latencyMs: null,
      message: '未绑定主站渠道 ID，无法使用主站渠道测试'
    };
  }

  const station = await prisma.mainStation.findUnique({
    where: { id: 'relay-newapi-main' },
    select: {
      baseUrl: true,
      adminUserId: true,
      encryptedAdminToken: true
    }
  });

  if (!station?.baseUrl || !station.adminUserId || !station.encryptedAdminToken) {
    return {
      ok: false,
      skipped: true,
      latencyMs: null,
      message: '主站未配置，无法使用主站渠道测试'
    };
  }

  try {
    return await withTimeout(
      requestMainStationChannelTest(station.baseUrl, station.adminUserId, station.encryptedAdminToken, channelId),
      normalizeLatencyThreshold(setting.latencyTimeoutMs, 10_000),
      `主站渠道测试超时`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mainStationUnavailable = /主站|admin token|HTTP 401|HTTP 403|HTTP 404|Cloudflare|验证码|Challenge/i.test(message);

    return {
      ok: false,
      skipped: mainStationUnavailable,
      latencyMs: null,
      message
    };
  }
}

async function requestMainStationChannelTest(
  baseUrl: string,
  adminUserId: string,
  encryptedAdminToken: string,
  channelId: string
): Promise<MainStationLatencyProbe> {
  const startedAt = Date.now();
  const adminToken = decryptCredentialPayload(encryptedAdminToken).adminToken?.trim();

  if (!adminToken) {
    throw new Error('主站 admin token 无效');
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/channel/test/${encodeURIComponent(channelId)}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${adminToken}`,
      'New-Api-User': adminUserId
    }
  });
  const text = await response.text();

  if (/cloudflare|turnstile|captcha|challenge/i.test(text)) {
    throw new Error('主站渠道测试返回 Cloudflare/验证码页面');
  }
  if (!response.ok) {
    throw new Error(`主站渠道测试 HTTP ${response.status}: ${clip(text)}`);
  }

  const payload = JSON.parse(text) as unknown;
  const record = recordValue(payload);
  const data = recordValue(record?.data);
  const success = booleanValue(record?.success ?? data?.success) ?? false;
  const latencyMs = latencyMsFromValue(record?.time ?? data?.time) ?? Date.now() - startedAt;
  const message = stringValue(record?.message ?? data?.message);

  return {
    ok: success,
    latencyMs,
    message: success ? message : message || '主站渠道测试失败'
  };
}

function latencyDataFromMainStationProbe(
  upstream: UpstreamLatencyState,
  rates: RateInfo[],
  stateStatus: string,
  setting: InspectionSettingState,
  probe: MainStationLatencyProbe | null
): LatencyUpdateData {
  if (!setting.latencyTestEnabled) {
    return {
      status: recoverableStatus(upstream, stateStatus),
      ...(upstream.disabledByLatency
        ? {
            latencyFailureCount: 0,
            latencyLastError: null,
            disabledByLatency: false,
            latencyDisabledAt: null,
            latencyNextCheckAt: null
          }
        : {})
    };
  }

  if (probe?.skipped) {
    return latencySkippedData(upstream, probe.message ?? '主站渠道测试不可用', setting, stateStatus);
  }

  if (probe?.ok && probe.latencyMs !== null) {
    return latencySuccessData(upstream, rates, probe.latencyMs, stateStatus, setting);
  }

  return latencyFailureData(upstream, probe?.message ?? '主站渠道测试失败', setting, probe?.latencyMs ?? null, stateStatus);
}

function latencyDataFromFailedSync(
  upstream: UpstreamLatencyState,
  setting: InspectionSettingState,
  probe: MainStationLatencyProbe | null,
  syncError: string
): LatencyUpdateData {
  if (!setting.latencyTestEnabled) {
    return {};
  }

  if (probe?.skipped) {
    return latencySkippedData(upstream, probe.message ?? '主站渠道测试不可用', setting);
  }

  if (probe?.ok && probe.latencyMs !== null) {
    return latencyPassedData(upstream, probe.latencyMs, setting);
  }

  return latencyFailureData(upstream, probe?.message ?? syncError, setting, probe?.latencyMs ?? null);
}

function latencySuccessData(
  upstream: UpstreamLatencyState,
  rates: RateInfo[],
  latencyMs: number,
  stateStatus: string,
  setting: InspectionSettingState
): LatencyUpdateData {
  if (!setting.latencyTestEnabled) {
    return {
      status: recoverableStatus(upstream, stateStatus),
      ...(upstream.disabledByLatency
        ? {
            latencyFailureCount: 0,
            latencyLastError: null,
            disabledByLatency: false,
            latencyDisabledAt: null,
            latencyNextCheckAt: null
          }
        : {})
    };
  }

  const now = new Date();
  const groupRatio = currentGroupRatio(rates, upstream.groupName);
  const threshold = normalizeLatencyThreshold(setting.latencyDisableThresholdMs);
  const tooSlow = latencyMs > threshold;
  const shouldDisable = tooSlow && !upstream.skipLatencyDisable;
  const dispatch = tooSlow
    ? upstream.skipLatencyDisable
      ? adjustedDispatch(groupRatio, latencyMs, upstream.rechargeRatio)
      : { priority: 0, weight: 0 }
    : adjustedDispatch(groupRatio, latencyMs, upstream.rechargeRatio);
  const latencyLastError = tooSlow
    ? `延迟 ${latencyMs}ms 超过阈值 ${threshold}ms${upstream.skipLatencyDisable ? '，已跳过自动禁用' : ''}`
    : null;

  return {
    ...dispatch,
    status: shouldDisable ? UpstreamStatus.DISABLED : recoverableStatus(upstream, stateStatus),
    latencyMs,
    latencyCheckedAt: now,
    latencySuccessCount: tooSlow ? upstream.latencySuccessCount : upstream.latencySuccessCount + 1,
    latencyFailureCount: tooSlow ? upstream.latencyFailureCount + 1 : 0,
    latencyLastError,
    disabledByLatency: shouldDisable,
    latencyDisabledAt: shouldDisable ? now : null,
    latencyNextCheckAt: new Date(now.getTime() + (shouldDisable ? normalizeInterval(setting.disabledRetestMs) : normalizeInterval(setting.latencyIntervalMs)))
  };
}

function latencyPassedData(
  upstream: UpstreamLatencyState,
  latencyMs: number,
  setting: InspectionSettingState
): LatencyUpdateData {
  if (!setting.latencyTestEnabled) {
    return upstream.disabledByLatency
      ? {
          status: upstream.status === UpstreamStatus.DISABLED ? UpstreamStatus.LIMITED : upstream.status,
          latencyFailureCount: 0,
          latencyLastError: null,
          disabledByLatency: false,
          latencyDisabledAt: null,
          latencyNextCheckAt: null
        }
      : {};
  }

  const now = new Date();
  const threshold = normalizeLatencyThreshold(setting.latencyDisableThresholdMs);
  const tooSlow = latencyMs > threshold;
  const shouldDisable = tooSlow && !upstream.skipLatencyDisable;
  const latencyLastError = tooSlow
    ? `延迟 ${latencyMs}ms 超过阈值 ${threshold}ms${upstream.skipLatencyDisable ? '，已跳过自动禁用' : ''}`
    : null;

  return {
    ...(tooSlow
      ? upstream.skipLatencyDisable
        ? adjustedDispatch(null, latencyMs, upstream.rechargeRatio)
        : { priority: 0, weight: 0 }
      : adjustedDispatch(null, latencyMs, upstream.rechargeRatio)),
    status: shouldDisable ? UpstreamStatus.DISABLED : undefined,
    latencyMs,
    latencyCheckedAt: now,
    latencySuccessCount: tooSlow ? upstream.latencySuccessCount : upstream.latencySuccessCount + 1,
    latencyFailureCount: tooSlow ? 1 : 0,
    latencyLastError,
    disabledByLatency: shouldDisable,
    latencyDisabledAt: shouldDisable ? now : null,
    latencyNextCheckAt: new Date(now.getTime() + (shouldDisable ? normalizeInterval(setting.disabledRetestMs) : normalizeInterval(setting.latencyIntervalMs)))
  };
}

function latencyFailureData(
  upstream: {
    status: UpstreamStatus;
    disabledByLatency: boolean;
    skipLatencyDisable: boolean;
    latencyFailureCount: number;
  },
  message: string,
  setting: InspectionSettingState,
  latencyMs: number | null = null,
  stateStatus?: string
): LatencyUpdateData {
  if (!setting.latencyTestEnabled) {
    return {};
  }

  const now = new Date();
  const failureCount = upstream.latencyFailureCount + 1;
  const reachedFailureLimit = failureCount >= normalizeFailureLimit(setting.latencyFailureLimit);
  const shouldDisable = reachedFailureLimit && !upstream.skipLatencyDisable;
  const nextInterval = shouldDisable
    ? normalizeInterval(setting.disabledRetestMs)
    : normalizeInterval(setting.latencyIntervalMs);
  const latencyLastError = reachedFailureLimit && upstream.skipLatencyDisable
    ? `${message}，已跳过自动禁用`
    : message;

  return {
    ...(shouldDisable ? { priority: 0, weight: 0 } : {}),
    status: shouldDisable
      ? UpstreamStatus.DISABLED
      : stateStatus && upstream.skipLatencyDisable
        ? recoverableStatus(upstream, stateStatus)
        : undefined,
    latencyMs,
    latencyCheckedAt: now,
    latencyFailureCount: failureCount,
    latencyLastError,
    disabledByLatency: shouldDisable,
    latencyDisabledAt: shouldDisable ? now : null,
    latencyNextCheckAt: new Date(now.getTime() + nextInterval)
  };
}

function latencySkippedData(
  upstream: { status: UpstreamStatus; disabledByLatency: boolean },
  message: string,
  setting: InspectionSettingState,
  stateStatus?: string
): LatencyUpdateData {
  const now = new Date();

  return {
    status: stateStatus && !upstream.disabledByLatency ? recoverableStatus(upstream, stateStatus) : undefined,
    latencyCheckedAt: now,
    latencyLastError: message,
    latencyNextCheckAt: new Date(now.getTime() + normalizeInterval(setting.latencyIntervalMs))
  };
}

function recoverableStatus(upstream: { status: UpstreamStatus; disabledByLatency: boolean }, stateStatus: string) {
  if (upstream.status === UpstreamStatus.DISABLED && !upstream.disabledByLatency) {
    return UpstreamStatus.DISABLED;
  }

  return toPrismaStatus(stateStatus);
}

function mainStationChannelId(id: string) {
  const direct = /^\d+$/.test(id) ? id : null;
  const prefixed = id.match(/^channel-newapi-(\d+)$/i)?.[1];

  return direct ?? prefixed ?? null;
}

async function syncMainStationChannelIfNeeded(
  upstream: MainStationWritableUpstream,
  data: LatencyUpdateData
): Promise<MainStationWriteResult> {
  const intent = mainStationChannelUpdateIntent(upstream, data);

  if (!intent) {
    return {};
  }

  const channelId = mainStationChannelId(upstream.id);
  if (!channelId) {
    return {
      intent,
      error: '未绑定主站渠道 ID，无法写回主站渠道状态'
    };
  }

  const station = await prisma.mainStation.findUnique({
    where: { id: 'relay-newapi-main' },
    select: {
      baseUrl: true,
      adminUserId: true,
      encryptedAdminToken: true
    }
  });

  if (!station?.baseUrl || !station.adminUserId || !station.encryptedAdminToken) {
    return {
      intent,
      error: '主站未配置，无法写回主站渠道状态'
    };
  }

  try {
    await requestMainStationChannelUpdate(station.baseUrl, station.adminUserId, station.encryptedAdminToken, channelId, intent);
    return { intent };
  } catch (error) {
    return {
      intent,
      error: errorMessage(error)
    };
  }
}

function mainStationChannelUpdateIntent(
  upstream: MainStationWritableUpstream,
  data: LatencyUpdateData
): MainStationChannelUpdate | null {
  const intent: MainStationChannelUpdate = {};

  if (data.disabledByLatency === true || data.status === UpstreamStatus.DISABLED) {
    intent.enabled = false;
  } else if (data.disabledByLatency === false && upstream.disabledByLatency) {
    intent.enabled = true;
  }

  if (data.priority !== undefined && data.priority !== upstream.priority) {
    intent.priority = data.priority;
  }

  if (data.weight !== undefined && data.weight !== upstream.weight) {
    intent.weight = data.weight;
  }

  return Object.keys(intent).length > 0 ? intent : null;
}

function applyMainStationWriteResult(
  upstream: MainStationWritableUpstream,
  data: LatencyUpdateData,
  result: MainStationWriteResult
): LatencyUpdateData {
  if (!result.intent || !result.error) {
    return data;
  }

  const next: LatencyUpdateData = {
    ...data,
    latencyLastError: `主站渠道写回失败：${result.error}`
  };

  if (result.intent.priority !== undefined) {
    delete next.priority;
  }
  if (result.intent.weight !== undefined) {
    delete next.weight;
  }

  if (result.intent.enabled === false) {
    next.status = UpstreamStatus.ERROR;
    next.disabledByLatency = false;
    next.latencyDisabledAt = null;
  }

  if (result.intent.enabled === true) {
    next.status = UpstreamStatus.DISABLED;
    next.disabledByLatency = true;
    next.latencyDisabledAt = upstream.latencyDisabledAt ?? new Date();
    next.latencyFailureCount = upstream.latencyFailureCount;
  }

  return next;
}

async function requestMainStationChannelUpdate(
  baseUrl: string,
  adminUserId: string,
  encryptedAdminToken: string,
  channelId: string,
  input: MainStationChannelUpdate
) {
  const adminToken = decryptCredentialPayload(encryptedAdminToken).adminToken?.trim();

  if (!adminToken) {
    throw new Error('主站 admin token 无效');
  }

  const body: Record<string, unknown> = {
    id: /^\d+$/.test(channelId) ? Number(channelId) : channelId
  };

  if (input.enabled !== undefined) {
    body.status = input.enabled ? 1 : 2;
  }
  if (input.priority !== undefined) {
    body.priority = input.priority;
  }
  if (input.weight !== undefined) {
    body.weight = input.weight;
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/channel/`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      'New-Api-User': adminUserId
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();

  if (/cloudflare|turnstile|captcha|challenge/i.test(text)) {
    throw new Error('主站渠道更新返回 Cloudflare/验证码页面');
  }
  if (!response.ok) {
    throw new Error(`主站渠道更新 HTTP ${response.status}: ${clip(text)}`);
  }

  const payload = text ? JSON.parse(text) as unknown : {};
  const record = recordValue(payload);
  const code = numeric(record?.code);

  if (record?.success === false) {
    throw new Error(stringValue(record.message) ?? '主站渠道更新失败');
  }
  if (code !== null && code !== 0) {
    throw new Error(stringValue(record?.message ?? record?.reason) ?? `主站渠道更新返回 code ${code}`);
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function latencyMsFromValue(value: unknown) {
  const parsed = numeric(value);
  if (parsed === null) {
    return null;
  }

  return Math.round(parsed <= 120 ? parsed * 1000 : parsed);
}

function booleanValue(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    if (/^(true|success|ok|1)$/i.test(value.trim())) {
      return true;
    }
    if (/^(false|fail|failed|error|0)$/i.test(value.trim())) {
      return false;
    }
  }

  return null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function currentGroupRatio(rates: RateInfo[], groupName: string) {
  const normalized = normalizeName(groupName);
  const groupRates = rates.filter((rate) => rate.model === '*' && rate.modelRatio !== undefined);
  const groupRate = groupRates.find(
    (rate) =>
      rate.model === '*' &&
      (normalizeName(rate.group) === normalized || normalizeName(rate.groupId) === normalized) &&
      rate.modelRatio !== undefined
  );
  if (groupRate?.modelRatio !== undefined) {
    return groupRate.modelRatio;
  }

  const uniqueGroups = new Set(groupRates.map((rate) => normalizeName(rate.group)));
  return normalized === 'default' && uniqueGroups.size === 1 ? groupRates[0]?.modelRatio ?? null : null;
}

function canonicalRateGroupName(rates: RateInfo[], groupName: string) {
  const normalized = normalizeName(groupName);
  const matched = rates.find(
    (rate) => rate.model === '*' && rate.group && normalizeName(rate.groupId) === normalized && normalizeName(rate.group) !== normalized
  );

  return matched?.group ?? null;
}

async function ruleActionData(
  upstream: { priority: number; weight: number },
  balance: number | undefined,
  events: Array<{ direction: RateDirection; field: string; changePercent?: number }>,
  setting: InspectionSettingState
): Promise<LatencyUpdateData> {
  const [balanceRule, rateIncreaseRule] = await prisma.alertRule.findMany({
    where: {
      type: { in: [AlertRuleType.BALANCE_LOW, AlertRuleType.RATE_INCREASE] },
      enabled: true
    }
  }).then((rules) => [
    rules.find((rule) => rule.type === AlertRuleType.BALANCE_LOW),
    rules.find((rule) => rule.type === AlertRuleType.RATE_INCREASE)
  ] as const).catch(() => [undefined, undefined] as const);
  const messages: string[] = [];
  const actions: InspectionRuleAction[] = [];
  const balanceThreshold = numeric(balanceRule?.thresholdAmount);
  const rateThreshold = numeric(rateIncreaseRule?.thresholdPercent);

  if (
    setting.balanceLowAction !== 'NONE' &&
    balance !== undefined &&
    balanceThreshold !== null &&
    balance < balanceThreshold
  ) {
    actions.push(setting.balanceLowAction);
    messages.push(`余额 ${balance.toFixed(2)} 低于 ${balanceThreshold.toFixed(2)}`);
  }

  if (
    setting.rateIncreaseAction !== 'NONE' &&
    events.some(
      (event) =>
        event.direction === RateDirection.UP &&
        event.field === 'model_ratio' &&
        (rateThreshold === null || Math.abs(event.changePercent ?? 0) >= rateThreshold)
    )
  ) {
    actions.push(setting.rateIncreaseAction);
    messages.push(`倍率上涨超过 ${rateThreshold ?? 0}%`);
  }

  if (actions.includes('DISABLE')) {
    return {
      status: UpstreamStatus.DISABLED,
      priority: 0,
      weight: 0,
      disabledByLatency: false,
      latencyLastError: `巡检规则：${messages.join('；')}`
    };
  }

  if (actions.includes('LOWER')) {
    return {
      priority: Math.min(upstream.priority, setting.ruleActionPriority),
      weight: Math.min(upstream.weight, setting.ruleActionWeight),
      latencyLastError: `巡检规则：${messages.join('；')}`
    };
  }

  return {};
}

function adjustedDispatch(groupRatio: number | null, latencyMs: number, rechargeRatio: unknown) {
  const effectiveRatio = normalizePositive(groupRatio) ?? 1;
  const recharge = Math.max(0.01, normalizePositive(rechargeRatio) ?? 1);
  const ratioScore = 100 / (effectiveRatio * recharge);
  const latencyPenalty = Math.min(30, Math.floor(latencyMs / 1000) * 3);
  const priority = clampInteger(Math.round(ratioScore - latencyPenalty), 1, 100);
  const weight = clampInteger(Math.round(priority / 10), 1, 10);

  return { priority, weight };
}

function normalizePositive(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeName(value: string | undefined) {
  return value?.trim().toLowerCase() || 'default';
}

function normalizeRuleAction(value: unknown): InspectionRuleAction {
  const action = typeof value === 'string' ? value.trim().toUpperCase() : 'NONE';

  return action === 'LOWER' || action === 'DISABLE' ? action : 'NONE';
}

async function ensureInspectionSchema() {
  const statements = [
    'ALTER TABLE InspectionSetting ADD COLUMN balanceLowAction VARCHAR(16) NOT NULL DEFAULT "NONE"',
    'ALTER TABLE InspectionSetting ADD COLUMN rateIncreaseAction VARCHAR(16) NOT NULL DEFAULT "NONE"',
    'ALTER TABLE InspectionSetting ADD COLUMN ruleActionPriority INT NOT NULL DEFAULT 10',
    'ALTER TABLE InspectionSetting ADD COLUMN ruleActionWeight INT NOT NULL DEFAULT 0'
  ];

  for (const statement of statements) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (error) {
      if (!/Duplicate column|1060/i.test(errorMessage(error))) {
        throw error;
      }
    }
  }
}

async function ensureUpstreamLatencySchema() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE Upstream ADD COLUMN skipLatencyDisable BOOLEAN NOT NULL DEFAULT false');
  } catch (error) {
    if (!/Duplicate column|1060/i.test(errorMessage(error))) {
      throw error;
    }
  }
}

async function loadSkipLatencyDisable(upstreamId: string) {
  const [row] = await prisma.$queryRaw<Array<{ skipLatencyDisable: boolean | number | null }>>`
    SELECT skipLatencyDisable
    FROM Upstream
    WHERE id = ${upstreamId}
    LIMIT 1
  `;

  return Boolean(row?.skipLatencyDisable);
}

function normalizeInterval(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 900_000;
  }

  return Math.min(24 * 60 * 60_000, Math.max(60_000, Math.trunc(parsed)));
}

function normalizeLatencyThreshold(value: unknown, fallback = 8_000) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(120_000, Math.max(100, Math.trunc(parsed)));
}

function normalizeFailureLimit(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 3;
  }

  return Math.min(20, Math.max(1, Math.trunc(parsed)));
}

function createAdapter(upstream: {
  type: UpstreamType;
  baseUrl: string;
  authMode: string;
  upstreamUserId: string | null;
  credential: { encryptedPayload: string } | null;
}): UpstreamAdapter {
  const credential = parseCredential(upstream.credential?.encryptedPayload);

  if (upstream.type === UpstreamType.SUB2API) {
    return new Sub2ApiAdapter({
      baseUrl: upstream.baseUrl,
      authMode: upstream.authMode.toLowerCase(),
      credential
    });
  }

  if (upstream.type === UpstreamType.NEWAPI) {
    return new NewApiAdapter({
      baseUrl: upstream.baseUrl,
      authMode: upstream.authMode.toLowerCase(),
      upstreamUserId: upstream.upstreamUserId ?? credential.userId,
      credential
    });
  }

  throw new Error(`unsupported upstream type: ${upstream.type}`);
}

function parseCredential(payload?: string): Record<string, string> {
  return decryptCredentialPayload(payload);
}

function toPrismaStatus(status: string): UpstreamStatus {
  return status.toUpperCase() as UpstreamStatus;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message}（${timeoutMs}ms）`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function loadPreviousRates(upstreamId: string, currentRates: RateInfo[]) {
  const previous = new Map<string, RateInfo>();

  for (const rate of currentRates) {
    const snapshot = await prisma.rateSnapshot.findFirst({
      where: {
        upstreamId,
        provider: rate.provider,
        model: rate.model,
        groupName: rate.group
      },
      orderBy: { capturedAt: 'desc' }
    });

    if (!snapshot) {
      continue;
    }

    previous.set(stableRateKey(rate), {
      provider: snapshot.provider,
      model: snapshot.model,
      group: snapshot.groupName ?? undefined,
      channelName: snapshot.channelName ?? undefined,
      inputPrice: snapshot.inputPrice ? Number(snapshot.inputPrice) : undefined,
      outputPrice: snapshot.outputPrice ? Number(snapshot.outputPrice) : undefined,
      modelRatio: snapshot.modelRatio ? Number(snapshot.modelRatio) : undefined,
      completionRatio: snapshot.completionRatio ? Number(snapshot.completionRatio) : undefined,
      currency: snapshot.currency ?? undefined,
      source: snapshot.source,
      capturedAt: snapshot.capturedAt.toISOString(),
      rawHash: snapshot.rawHash ?? undefined
    });
  }

  return { previous };
}

function diffRates(
  loaded: { previous: Map<string, RateInfo> },
  currentRates: RateInfo[]
): Array<{
  provider: string;
  model: string;
  group?: string;
  field: string;
  direction: RateDirection;
  oldValue?: number;
  newValue?: number;
  changePercent?: number;
}> {
  const events = [];

  for (const current of currentRates) {
    const previous = loaded.previous.get(stableRateKey(current));

    if (!previous) {
      events.push({
        provider: current.provider,
        model: current.model,
        group: current.group,
        field: 'model_ratio',
        direction: RateDirection.NEW,
        newValue: current.modelRatio
      });
      continue;
    }

    for (const field of ['inputPrice', 'outputPrice', 'modelRatio', 'completionRatio'] as const) {
      const oldValue = previous[field];
      const newValue = current[field];

      if (oldValue === undefined || newValue === undefined || oldValue === newValue) {
        continue;
      }

      const changed = percentChange(oldValue, newValue);

      events.push({
        provider: current.provider,
        model: current.model,
        group: current.group,
        field: toDatabaseField(field),
        direction: newValue > oldValue ? RateDirection.UP : RateDirection.DOWN,
        oldValue,
        newValue,
        changePercent: changed
      });
    }
  }

  return events;
}

function toDatabaseField(field: 'inputPrice' | 'outputPrice' | 'modelRatio' | 'completionRatio') {
  return {
    inputPrice: 'input_price',
    outputPrice: 'output_price',
    modelRatio: 'model_ratio',
    completionRatio: 'completion_ratio'
  }[field];
}
