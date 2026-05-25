import { percentChange, stableRateKey, type RateInfo, type UpstreamAccountState, type UpstreamAdapter } from '@ai-relay/shared';
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
  latencyAutoDisableEnabled: boolean;
  disabledRetestMs: number;
  priorityUpdateEnabled: boolean;
  priorityStrategy: PriorityStrategy;
  balanceLowAction: InspectionRuleAction;
  rateIncreaseAction: InspectionRuleAction;
  ruleActionPriority: number;
  ruleActionWeight: number;
};

type InspectionRuleAction = 'NONE' | 'LOWER' | 'DISABLE';
type PriorityStrategy = 'RATE_FIRST' | 'BALANCED';

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

  if (upstreamRecord.type === UpstreamType.CLI_PROXY) {
    await withDbWriteRetry(() =>
      prisma.upstream.update({
        where: { id: upstreamId },
        data: {
          lastError: null,
          lastSyncAt: new Date()
        }
      })
    );
    return;
  }

  const upstream = {
    ...upstreamRecord,
    skipLatencyDisable: await loadSkipLatencyDisable(upstreamId)
  };
  const setting = await loadInspectionSetting();
  const latencyProbe = await probeMainStationLatency(upstream, setting);

  try {
    const adapter = createAdapter(upstream);
    const [ratesResult, stateResult] = await Promise.allSettled([
      adapter.listRates(),
      adapter.getAccountState()
    ]);
    const rates = ratesResult.status === 'fulfilled' ? ratesResult.value : [];
    const state = accountStateFromResult(stateResult, ratesResult, rates);
    const syncLastError = combinedSyncLastError(state, stateResult, ratesResult, rates);
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

    await withDbWriteRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.upstream.update({
          where: { id: upstreamId },
          data: {
            balance: state.balance,
            balanceCurrency: state.balanceCurrency,
            concurrency: state.concurrency,
            lastError: syncLastError,
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
      })
    );
  } catch (error) {
    const rawMessage = errorMessage(error);
    const message = clip(rawMessage, 1000);
    const challenge = /cloudflare|challenge|captcha|turnstile/i.test(message);
    const credentialFailure = isCredentialFailure(message, Boolean(upstream.credential));
    const latencyData = latencyDataFromFailedSync(upstream, setting, latencyProbe, message);
    const persistedLatencyData = applyMainStationWriteResult(
      upstream,
      latencyData,
      await syncMainStationChannelIfNeeded(upstream, latencyData)
    );

    await withDbWriteRetry(() =>
      prisma.upstream.update({
        where: { id: upstreamId },
        data: {
          ...persistedLatencyData,
          status: persistedLatencyData.status ?? (
            challenge
              ? UpstreamStatus.CHALLENGE_REQUIRED
              : credentialFailure
                ? UpstreamStatus.EXPIRED
                : UpstreamStatus.ERROR
          ),
          lastError: message,
          lastSyncAt: new Date()
        }
      })
    );

    if (credentialFailure || challenge) {
      return;
    }

    throw error;
  }
}

async function withDbWriteRetry<T>(action: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableDbWriteError(error)) {
        throw error;
      }
      await sleep(120 * attempt);
    }
  }

  throw lastError;
}

function isRetryableDbWriteError(error: unknown) {
  const message = errorMessage(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';

  return code === 'P2034' || /deadlock|write conflict|Transaction failed|1205|1213/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountStateFromResult(
  stateResult: PromiseSettledResult<UpstreamAccountState>,
  ratesResult: PromiseSettledResult<RateInfo[]>,
  rates: RateInfo[]
): UpstreamAccountState {
  if (stateResult.status === 'fulfilled') {
    return stateResult.value;
  }

  if (rates.length > 0) {
    return {
      status: 'limited',
      lastError: syncReadError('余额读取失败', stateResult.reason)
    };
  }

  if (ratesResult.status === 'rejected') {
    throw new Error(`${syncReadError('倍率读取失败', ratesResult.reason)}；${syncReadError('余额读取失败', stateResult.reason)}`);
  }

  throw stateResult.reason;
}

function combinedSyncLastError(
  state: UpstreamAccountState,
  stateResult: PromiseSettledResult<UpstreamAccountState>,
  ratesResult: PromiseSettledResult<RateInfo[]>,
  rates: RateInfo[]
) {
  const messages = [
    stateResult.status === 'rejected' ? syncReadError('余额读取失败', stateResult.reason) : state.lastError,
    ratesResult.status === 'rejected'
      ? syncReadError('倍率读取失败', ratesResult.reason)
      : rates.length === 0
        ? '倍率读取为空：上游没有返回可保存的倍率'
        : null
  ].filter((message): message is string => Boolean(message));

  return messages.length > 0 ? messages.join('；') : null;
}

function syncReadError(prefix: string, error: unknown) {
  const raw = errorMessage(error);

  if (/HTTP 401|HTTP 403|unauthorized|forbidden|insufficient privileges|权限不足/i.test(raw)) {
    return `${prefix}：上游接口无权限或不可用`;
  }

  return `${prefix}：${clip(raw, 500)}`;
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
    latencyAutoDisableEnabled: boolean | number | null;
    priorityUpdateEnabled: boolean | number | null;
    priorityStrategy: string | null;
    balanceLowAction: string | null;
    rateIncreaseAction: string | null;
    ruleActionPriority: number | null;
    ruleActionWeight: number | null;
  }>>`
    SELECT latencyAutoDisableEnabled, priorityUpdateEnabled, priorityStrategy,
           balanceLowAction, rateIncreaseAction, ruleActionPriority, ruleActionWeight
    FROM InspectionSetting
    WHERE id = ${settingId}
    LIMIT 1
  `;

  return {
    ...setting,
    latencyAutoDisableEnabled: normalizeBoolean(extras?.latencyAutoDisableEnabled, true),
    priorityUpdateEnabled: normalizeBoolean(extras?.priorityUpdateEnabled, true),
    priorityStrategy: normalizePriorityStrategy(extras?.priorityStrategy),
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
  const shouldDisable = tooSlow && shouldAutoDisable(upstream, setting);
  const dispatch = tooSlow
    ? shouldDisable
      ? zeroDispatch(setting)
      : adjustedDispatchForSetting(setting, groupRatio, latencyMs)
    : adjustedDispatchForSetting(setting, groupRatio, latencyMs);
  const latencyLastError = tooSlow
    ? `延迟 ${latencyMs}ms 超过阈值 ${threshold}ms${latencyDisableSkipMessage(upstream, setting)}`
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
  const shouldDisable = tooSlow && shouldAutoDisable(upstream, setting);
  const latencyLastError = tooSlow
    ? `延迟 ${latencyMs}ms 超过阈值 ${threshold}ms${latencyDisableSkipMessage(upstream, setting)}`
    : null;

  return {
    ...(tooSlow
      ? shouldDisable
        ? zeroDispatch(setting)
        : adjustedDispatchForSetting(setting, null, latencyMs)
      : adjustedDispatchForSetting(setting, null, latencyMs)),
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
  const shouldDisable = reachedFailureLimit && shouldAutoDisable(upstream, setting);
  const nextInterval = shouldDisable
    ? normalizeInterval(setting.disabledRetestMs)
    : normalizeInterval(setting.latencyIntervalMs);
  const latencyLastError = reachedFailureLimit && !shouldDisable
    ? `${message}${latencyDisableSkipMessage(upstream, setting)}`
    : message;

  return {
    ...(shouldDisable ? zeroDispatch(setting) : {}),
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

function clip(text: string, maxLength = 180) {
  return text.replace(/\s+/g, ' ').slice(0, maxLength);
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
      type: { in: [AlertRuleType.BALANCE_LOW, AlertRuleType.RATE_INCREASE] }
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
      ...zeroDispatch(setting),
      disabledByLatency: false,
      latencyLastError: `巡检规则：${messages.join('；')}`
    };
  }

  if (actions.includes('LOWER')) {
    if (!setting.priorityUpdateEnabled) {
      return {
        latencyLastError: `巡检规则：${messages.join('；')}，已跳过优先级回写`
      };
    }

    return {
      priority: Math.min(upstream.priority, setting.ruleActionPriority),
      weight: Math.min(upstream.weight, setting.ruleActionWeight),
      latencyLastError: `巡检规则：${messages.join('；')}`
    };
  }

  return {};
}

function shouldAutoDisable(upstream: { skipLatencyDisable: boolean }, setting: InspectionSettingState) {
  return setting.latencyAutoDisableEnabled && !upstream.skipLatencyDisable;
}

function latencyDisableSkipMessage(upstream: { skipLatencyDisable: boolean }, setting: InspectionSettingState) {
  if (upstream.skipLatencyDisable) {
    return '，已按渠道配置跳过自动禁用';
  }
  if (!setting.latencyAutoDisableEnabled) {
    return '，已按巡检配置跳过自动禁用';
  }

  return '';
}

function zeroDispatch(setting: InspectionSettingState) {
  return setting.priorityUpdateEnabled ? { priority: 0, weight: 0 } : {};
}

function adjustedDispatchForSetting(
  setting: InspectionSettingState,
  groupRatio: number | null,
  latencyMs: number
) {
  return setting.priorityUpdateEnabled ? adjustedDispatch(groupRatio, latencyMs, setting.priorityStrategy) : {};
}

function adjustedDispatch(groupRatio: number | null, latencyMs: number, strategy: PriorityStrategy) {
  const effectiveRatio = normalizePositive(groupRatio) ?? 1;
  const ratioScore = clampInteger(Math.round(100 / effectiveRatio), 1, 100);
  const latencyScore = clampInteger(Math.round(100 - latencyMs / 200), 1, 100);
  const priority = strategy === 'BALANCED'
    ? clampInteger(Math.round(ratioScore * 0.65 + latencyScore * 0.35), 1, 100)
    : clampInteger(Math.round(ratioScore - Math.min(15, Math.floor(latencyMs / 1000) * 2)), 1, 100);
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

function normalizePriorityStrategy(value: unknown): PriorityStrategy {
  const strategy = typeof value === 'string' ? value.trim().toUpperCase() : 'RATE_FIRST';

  return strategy === 'BALANCED' ? 'BALANCED' : 'RATE_FIRST';
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }

  return fallback;
}

async function ensureInspectionSchema() {
  const statements = [
    'ALTER TABLE InspectionSetting ADD COLUMN latencyAutoDisableEnabled BOOLEAN NOT NULL DEFAULT true',
    'ALTER TABLE InspectionSetting ADD COLUMN priorityUpdateEnabled BOOLEAN NOT NULL DEFAULT true',
    'ALTER TABLE InspectionSetting ADD COLUMN priorityStrategy VARCHAR(24) NOT NULL DEFAULT "RATE_FIRST"',
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
  const statements = [
    "ALTER TABLE Upstream MODIFY COLUMN type ENUM('NEWAPI','SUB2API','CLI_PROXY') NOT NULL",
    'ALTER TABLE Upstream MODIFY COLUMN lastError TEXT NULL',
    'ALTER TABLE Upstream MODIFY COLUMN latencyLastError TEXT NULL',
    'ALTER TABLE Upstream ADD COLUMN skipLatencyDisable BOOLEAN NOT NULL DEFAULT false'
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

function isCredentialFailure(message: string, credentialConfigured: boolean) {
  return credentialConfigured && /Unsupported state|authenticate data|credential payload|CREDENTIAL_SECRET|HTTP 401|HTTP 403|unauthorized|forbidden|invalid token|token.*invalid|expired|失效|过期|权限不足|认证失败|鉴权失败|登录失败|password|账号密码|用户模式需要|需要 email|需要 upstreamUserId/i.test(message);
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
