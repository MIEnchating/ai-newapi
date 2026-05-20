import type { ChannelRecord, RelayRecord, StatusTone, UpstreamProvider } from './store';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const DEFAULT_RELAY_ID = 'relay-newapi-main';
const channelIdCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export type ChannelInput = {
  id?: string;
  name?: string;
  group?: string;
  mainStationGroup?: string;
  upstreamType?: UpstreamProvider;
  upstreamName?: string;
  upstreamBaseUrl?: string;
  upstreamUserId?: string;
  keyName?: string;
  skipLatencyDisable?: boolean;
  enabled?: boolean;
  auth?: string;
  credential?: string;
  credentialAccount?: string;
  credentialPassword?: string;
  createMainStation?: boolean;
  mainStationKey?: string;
  mainStationChannelType?: number;
  models?: string;
  rechargeRatio?: number;
  syncGroupRechargeRatio?: boolean;
  priority?: number;
  weight?: number;
};

export type CredentialTestResult = {
  ok: boolean;
  status: 'ok' | 'limited' | 'error';
  message: string;
  balance?: number;
  balanceCurrency?: string;
  groupRatio?: number | null;
  rateSource?: string;
};

export type UpstreamGroupInfo = {
  id?: string;
  name: string;
  remark?: string;
  ratio?: number | null;
  source: string;
};

export type MainStationGroupInfo = {
  name: string;
  ratio?: number | null;
  source: string;
};

export type InspectionStatus = {
  enabled: boolean;
  intervalMs: number;
  latencyTestEnabled: boolean;
  latencyIntervalMs: number;
  latencyTimeoutMs: number;
  latencyDisableThresholdMs: number;
  latencyFailureLimit: number;
  latencyAutoDisableEnabled: boolean;
  disabledRetestMs: number;
  priorityUpdateEnabled: boolean;
  priorityStrategy: 'RATE_FIRST' | 'BALANCED';
  cpaPreferred: boolean;
  inspectionConcurrency: number;
  balanceLowAction: 'NONE' | 'LOWER' | 'DISABLE';
  rateIncreaseAction: 'NONE' | 'LOWER' | 'DISABLE';
  ruleActionPriority: number;
  ruleActionWeight: number;
  lastRunAt?: string | null;
  lastQueuedAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
  activeUpstreamCount: number;
  dueUpstreamCount: number;
  latencyDisabledCount: number;
  latencyDueCount: number;
};

export type AlertRuleType =
  | 'RATE_INCREASE'
  | 'RATE_DECREASE'
  | 'BALANCE_LOW'
  | 'LATENCY_HIGH'
  | 'LATENCY_DISABLED'
  | 'SYNC_ERROR'
  | 'CHALLENGE_REQUIRED'
  | 'CREDENTIAL_EXPIRED';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertNotificationMethod = 'email' | 'webhook';

export type AlertRule = {
  id: string;
  type: AlertRuleType;
  name: string;
  enabled: boolean;
  severity: AlertSeverity;
  thresholdPercent?: string | number | null;
  thresholdMs?: number | null;
  thresholdAmount?: string | number | null;
  failureLimit?: number | null;
  cooldownMinutes: number;
  notificationMethods: AlertNotificationMethod[];
};

export type AlertRuleInput = Partial<Omit<AlertRule, 'id' | 'type' | 'name'>> & {
  type: AlertRuleType;
};

export type BackendRateEvent = {
  id: string;
  provider: string;
  model: string;
  groupName?: string | null;
  field: string;
  direction: 'UP' | 'DOWN' | 'NEW' | 'REMOVED' | 'STABLE';
  oldValue?: string | number | null;
  newValue?: string | number | null;
  changePercent?: string | number | null;
  createdAt: string;
  upstream?: {
    id: string;
    name: string;
    type: 'NEWAPI' | 'SUB2API' | 'CLI_PROXY';
    status: string;
  };
};

export type RelayInput = {
  name?: string;
  baseUrl?: string;
  auth?: string;
  adminUserId?: string;
  adminToken?: string;
};

type BackendMainStation = {
  id: string;
  name: string;
  baseUrl: string;
  auth: string;
  adminUserId: string;
  tokenConfigured: boolean;
  lastSyncAt?: string | null;
  lastError?: string | null;
};

type MainStationSyncResult = {
  relay: BackendMainStation;
  importedCount: number;
  syncedAt: string;
};

type BackendUpstream = {
  id: string;
  name: string;
  type: 'NEWAPI' | 'SUB2API' | 'CLI_PROXY';
  baseUrl: string;
  authMode: 'API_KEY' | 'PASSWORD' | 'USER_TOKEN' | 'SESSION' | 'ADMIN_TOKEN';
  groupName?: string | null;
  mainStationGroupName?: string | null;
  upstreamName?: string | null;
  upstreamUserId?: string | null;
  keyName?: string | null;
  skipLatencyDisable?: boolean | null;
  enabled?: boolean | null;
  rechargeRatio?: string | number | null;
  priority?: number | null;
  weight?: number | null;
  status: 'OK' | 'LIMITED' | 'CHALLENGE_REQUIRED' | 'EXPIRED' | 'ERROR' | 'DISABLED';
  balance?: string | number | null;
  balanceCurrency?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  latencyMs?: number | null;
  latencyCheckedAt?: string | null;
  latencyFailureCount?: number | null;
  latencySuccessCount?: number | null;
  latencyLastError?: string | null;
  disabledByLatency?: boolean | null;
  latencyDisabledAt?: string | null;
  latencyNextCheckAt?: string | null;
  credential?: { id: string } | null;
  rateSnapshots?: Array<{
    id: string;
    provider: string;
    model: string;
    groupName?: string | null;
    modelRatio?: string | number | null;
    source: string;
    capturedAt: string;
  }>;
  _count?: {
    rateSnapshots?: number;
    rateChangeEvents?: number;
  };
};

export type BackendCpaUsageMetric = {
  percent: number | null;
  used?: number | null;
  limit?: number | null;
  label?: string | null;
};

export type BackendCpaPoolAccount = {
  key: string;
  index: string;
  name: string;
  account: string;
  provider: string;
  status: string;
  successCount: number;
  failureCount: number;
  usage5h: BackendCpaUsageMetric | number | null;
  usage7d: BackendCpaUsageMetric | number | null;
  lastRefresh?: string | null;
  refreshTime?: string | null;
};

export type BackendCpaPool = {
  channel?: {
    id: string;
    name: string;
    baseUrl: string;
  };
  accounts: BackendCpaPoolAccount[];
  usageQueueError?: string | null;
  refreshedAt?: string;
};

export async function getBackendRelay(channelCount = 0) {
  const relay = await backendJson<BackendMainStation>('/main-station');
  return toRelayRecord(relay, channelCount);
}

export async function updateBackendRelay(input: RelayInput, channelCount = 0) {
  const relay = await backendJson<BackendMainStation>('/main-station', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });

  return toRelayRecord(relay, channelCount);
}

export async function syncMainStationChannels() {
  return backendJson<MainStationSyncResult>('/main-station/sync-channels', {
    method: 'POST'
  });
}

export async function listBackendMainStationGroups() {
  return backendJson<{ groups: MainStationGroupInfo[] }>('/main-station/groups');
}

export async function createBackendMainStationGroup(input: { name: string; ratio?: number }) {
  return backendJson<{ group: MainStationGroupInfo; groups: MainStationGroupInfo[] }>('/main-station/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function listBackendChannels() {
  const upstreams = await backendJson<BackendUpstream[]>('/upstreams');
  return upstreams.map(toChannelRecord).sort(compareChannelRecordId);
}

export async function createBackendChannel(input: ChannelInput) {
  const upstream = await backendJson<BackendUpstream>('/upstreams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBackendPayload(input))
  });

  return toChannelRecord(upstream);
}

export async function updateBackendChannel(id: string, input: ChannelInput) {
  const upstream = await backendJson<BackendUpstream>(`/upstreams/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBackendPayload(input, true))
  });

  return toChannelRecord(upstream);
}

export async function testBackendChannelCredential(id: string, input: ChannelInput) {
  return backendJson<CredentialTestResult>(`/upstreams/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBackendPayload(input, true))
  });
}

export async function testBackendDraftCredential(input: ChannelInput) {
  return backendJson<CredentialTestResult>('/upstreams/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBackendPayload(input, true))
  });
}

export async function listBackendUpstreamGroups(id: string, input: ChannelInput) {
  return backendJson<{ groups: UpstreamGroupInfo[] }>(`/upstreams/${encodeURIComponent(id)}/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBackendPayload(input, true))
  });
}

export async function listBackendDraftUpstreamGroups(input: ChannelInput) {
  return backendJson<{ groups: UpstreamGroupInfo[] }>('/upstreams/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBackendPayload(input, true))
  });
}

export async function deleteBackendChannel(id: string) {
  await backendJson(`/upstreams/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function fetchBackendCpaPool(id: string) {
  return backendJson<BackendCpaPool>(`/upstreams/${encodeURIComponent(id)}/cpa-pool`);
}

export async function syncBackendChannel(id: string) {
  return backendJson(`/upstreams/${encodeURIComponent(id)}/sync`, {
    method: 'POST'
  });
}

export async function getInspectionStatus() {
  return backendJson<InspectionStatus>('/inspection');
}

export async function updateInspectionStatus(input: Partial<Pick<
  InspectionStatus,
  | 'enabled'
  | 'intervalMs'
  | 'latencyTestEnabled'
  | 'latencyIntervalMs'
  | 'latencyTimeoutMs'
  | 'latencyDisableThresholdMs'
  | 'latencyFailureLimit'
  | 'latencyAutoDisableEnabled'
  | 'disabledRetestMs'
  | 'priorityUpdateEnabled'
  | 'priorityStrategy'
  | 'cpaPreferred'
  | 'inspectionConcurrency'
  | 'balanceLowAction'
  | 'rateIncreaseAction'
  | 'ruleActionPriority'
  | 'ruleActionWeight'
>>) {
  return backendJson<InspectionStatus>('/inspection', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function runInspectionNow() {
  return backendJson<InspectionStatus>('/inspection/run', {
    method: 'POST'
  });
}

export async function listAlertRules() {
  return backendJson<AlertRule[]>('/alert-rules');
}

export async function updateAlertRule(input: AlertRuleInput) {
  return backendJson<AlertRule[]>('/alert-rules', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function listBackendRateEvents() {
  return backendJson<BackendRateEvent[]>('/rate-events');
}

function toBackendPayload(input: ChannelInput, partial = false) {
  const payload: Record<string, unknown> = {};

  assign(payload, 'id', partial ? undefined : input.id?.trim());
  assign(payload, 'name', input.name?.trim());
  assign(payload, 'type', input.upstreamType);
  assign(payload, 'baseUrl', input.upstreamBaseUrl?.trim());
  assign(payload, 'authMode', input.auth ? toAuthMode(input.auth) : undefined);
  assign(payload, 'groupName', input.group?.trim());
  assign(payload, 'mainStationGroupName', input.mainStationGroup?.trim());
  assign(payload, 'upstreamName', input.upstreamName?.trim() || input.name?.trim());
  assign(payload, 'upstreamUserId', input.upstreamUserId?.trim());
  assign(payload, 'keyName', input.keyName?.trim());
  assign(payload, 'skipLatencyDisable', input.skipLatencyDisable);
  assign(payload, 'status', statusPayload(input.enabled));
  assign(payload, 'createMainStation', input.createMainStation === true ? true : undefined);
  assign(payload, 'mainStationKey', input.mainStationKey?.trim());
  assign(payload, 'mainStationChannelType', input.mainStationChannelType);
  assign(payload, 'models', input.models?.trim());
  if (!partial || input.rechargeRatio !== undefined) {
    assign(payload, 'rechargeRatio', normalizeRechargeRatio(input.rechargeRatio, 1));
  }
  if (!partial || input.priority !== undefined) {
    assign(payload, 'priority', normalizeInteger(input.priority, 50));
  }
  if (!partial || input.weight !== undefined) {
    assign(payload, 'weight', normalizeInteger(input.weight, 0));
  }
  assign(payload, 'syncGroupRechargeRatio', input.syncGroupRechargeRatio === true ? true : undefined);

  const credential = toCredentialPayload(input);
  if (credential) {
    payload.credential = credential;
  }

  if (!partial) {
    for (const key of ['name', 'type', 'baseUrl', 'authMode']) {
      if (!payload[key]) {
        throw new Error(`${key} is required`);
      }
    }
  }

  return payload;
}

function toCredentialPayload(input: ChannelInput) {
  if (input.upstreamType === 'cli_proxy') {
    const managementKey = input.credential?.trim() || input.credentialPassword?.trim();

    return managementKey
      ? {
          managementKey,
          token: managementKey
        }
      : undefined;
  }

  if (input.auth === '用户登录') {
    const account = input.credentialAccount?.trim();
    const password = input.credentialPassword?.trim();

    if (!account || !password) {
      return undefined;
    }

    return {
      email: account,
      username: account,
      password
    };
  }

  const credential = input.credential?.trim();
  if (!credential || input.auth === '无鉴权') {
    return undefined;
  }

  const payload: Record<string, string> = { token: credential };

  if (input.auth === '管理 Token') {
    payload.adminToken = credential;
  }
  if (input.auth === 'Bearer Token') {
    payload.bearerToken = credential;
  }
  if (input.upstreamUserId?.trim()) {
    payload.userId = input.upstreamUserId.trim();
  }
  if (input.keyName?.trim()) {
    payload.keyName = input.keyName.trim();
  }

  return payload;
}

function toChannelRecord(upstream: BackendUpstream): ChannelRecord {
  const upstreamType = upstream.type.toLowerCase() as UpstreamProvider;
  const credentialConfigured = Boolean(upstream.credential);
  const status = statusLabel(upstream.status, credentialConfigured, Boolean(upstream.disabledByLatency), upstream.lastError);
  const groupRate = latestGroupRate(upstream);
  const nameParts = splitChannelName(upstream.name);
  const upstreamName = normalizePlatformGroupName(upstream.upstreamName, upstream.name, nameParts.platformGroupName);
  const failureReason = failureReasonText(upstream.lastError);

  if (upstreamType === 'cli_proxy') {
    return {
      id: upstream.id,
      relayId: DEFAULT_RELAY_ID,
      source: 'manual',
      name: upstream.name,
      group: 'default',
      mainStationGroup: upstream.mainStationGroupName ?? 'default',
      upstreamType,
      upstreamName,
      upstreamBaseUrl: upstream.baseUrl,
      upstreamUserId: upstream.upstreamUserId ?? '',
      keyName: upstream.keyName ?? '',
      skipLatencyDisable: false,
      enabled: upstream.status !== 'DISABLED',
      auth: authLabel(upstream.authMode, upstreamType),
      credentialConfigured,
      status: upstream.status === 'DISABLED' ? '已禁用' : '仅转发',
      statusTone: upstream.status === 'ERROR' ? 'error' : 'limited',
      balance: '-',
      models: 0,
      groupRatio: null,
      rateSource: '不适用',
      rechargeRatio: normalizeRechargeRatio(upstream.rechargeRatio, 1),
      currentRate: null,
      previousRate: null,
      cf: '不适用',
      priority: normalizeInteger(upstream.priority, 50),
      weight: normalizeInteger(upstream.weight, 0),
      latencyMs: null,
      latencyCheckedAt: null,
      latencyFailureCount: 0,
      latencySuccessCount: 0,
      latencyLastError: null,
      lastError: upstream.lastError ?? null,
      disabledByLatency: false,
      latencyDisabledAt: null,
      latencyNextCheckAt: null,
      sync: '不适用'
    };
  }

  return {
    id: upstream.id,
    relayId: DEFAULT_RELAY_ID,
    source: 'manual',
    name: upstream.name,
    group: groupRate.displayGroupName ?? (upstream.groupName || 'default'),
    mainStationGroup: upstream.mainStationGroupName ?? '',
    upstreamType,
    upstreamName,
    upstreamBaseUrl: upstream.baseUrl,
    upstreamUserId: upstream.upstreamUserId ?? '',
    keyName: upstream.keyName ?? '',
    skipLatencyDisable: Boolean(upstream.skipLatencyDisable),
    enabled: upstream.status !== 'DISABLED',
    auth: authLabel(upstream.authMode, upstreamType),
    credentialConfigured,
    status: status.label,
    statusTone: status.tone,
    balance: balanceText(upstream, credentialConfigured),
    models: upstream._count?.rateSnapshots ?? 0,
    groupRatio: groupRate.current,
    rateSource: failureReason ?? groupRate.source ?? (upstream._count?.rateSnapshots ? '未找到当前上游分组倍率' : credentialConfigured ? '待同步' : '待配置认证信息'),
    rechargeRatio: normalizeRechargeRatio(upstream.rechargeRatio, 1),
    currentRate: groupRate.current,
    previousRate: groupRate.previous,
    cf: upstream.status === 'CHALLENGE_REQUIRED' ? '需要人工处理' : '正常',
    priority: normalizeInteger(upstream.priority, 50),
    weight: normalizeInteger(upstream.weight, 0),
    latencyMs: upstream.latencyMs ?? null,
    latencyCheckedAt: upstream.latencyCheckedAt ?? null,
    latencyFailureCount: normalizeInteger(upstream.latencyFailureCount, 0),
    latencySuccessCount: normalizeInteger(upstream.latencySuccessCount, 0),
    latencyLastError: upstream.latencyLastError ?? null,
    lastError: upstream.lastError ?? null,
    disabledByLatency: Boolean(upstream.disabledByLatency),
    latencyDisabledAt: upstream.latencyDisabledAt ?? null,
    latencyNextCheckAt: upstream.latencyNextCheckAt ?? null,
    sync: upstream.lastSyncAt ? formatSyncTime(upstream.lastSyncAt) : '尚未同步'
  };
}

function normalizePlatformGroupName(value: string | null | undefined, channelName: string, inferred: string) {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === channelName.trim()) {
    return inferred;
  }

  return trimmed;
}

function splitChannelName(name: string) {
  const normalized = name.trim();
  const split = splitByNameSuffix(normalized);

  if (!split) {
    return { platformGroupName: normalized, keyName: null as string | null };
  }

  return { platformGroupName: split.prefix, keyName: split.suffix };
}

function splitByNameSuffix(value: string) {
  const index = value.search(/[-_]/);

  if (index < 1) {
    return null;
  }

  const prefix = value.slice(0, index).trim();
  const suffix = value.slice(index + 1).trim();

  return prefix && suffix ? { prefix, suffix } : null;
}

function compareChannelRecordId(left: ChannelRecord, right: ChannelRecord) {
  return channelIdCollator.compare(left.id, right.id);
}

function latestGroupRate(upstream: BackendUpstream) {
  const groupName = normalizeGroupName(upstream.groupName);
  const allGroupSnapshots = (upstream.rateSnapshots ?? []).filter(
    (snapshot) => snapshot.model === '*' && numericOrNull(snapshot.modelRatio) !== null
  );
  const exactCandidates = allGroupSnapshots.filter(
    (snapshot) =>
      normalizeGroupName(snapshot.groupName) === groupName
  );
  const uniqueGroupNames = new Set(allGroupSnapshots.map((snapshot) => normalizeGroupName(snapshot.groupName)));
  const fallbackCandidates = uniqueGroupNames.size === 1 ? allGroupSnapshots : [];
  const candidates = exactCandidates.length > 0 ? exactCandidates : fallbackCandidates;
  const latest = candidates[0];

  if (!latest) {
    return { current: null, previous: null, source: null, displayGroupName: null };
  }

  const latestCapturedAt = Date.parse(latest.capturedAt);
  const previous =
    candidates.find((snapshot) => {
      if (snapshot.id === latest.id) {
        return false;
      }

      const capturedAt = Date.parse(snapshot.capturedAt);
      return Number.isFinite(latestCapturedAt) && Number.isFinite(capturedAt) ? capturedAt < latestCapturedAt : true;
    }) ?? null;

  return {
    current: numericOrNull(latest.modelRatio),
    previous: previous ? numericOrNull(previous.modelRatio) : null,
    source: exactCandidates.length > 0 ? latest.source : `按唯一上游分组 ${normalizeGroupName(latest.groupName)} 展示`,
    displayGroupName: exactCandidates.length > 0 ? null : normalizeGroupName(latest.groupName)
  };
}

function normalizeGroupName(value: string | null | undefined) {
  return value?.trim() || 'default';
}

function numericOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function backendJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: 'no-store'
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || `backend request failed: ${response.status}`);
  }

  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function assign(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined && value !== '') {
    target[key] = value;
  }
}

function statusPayload(enabled: boolean | undefined) {
  if (enabled === false) {
    return 'DISABLED';
  }

  if (enabled === true) {
    return 'LIMITED';
  }

  return undefined;
}

function toAuthMode(auth: string) {
  if (auth === 'API Key') {
    return 'API_KEY';
  }
  if (auth === '管理 Token') {
    return 'ADMIN_TOKEN';
  }
  if (auth === '用户登录') {
    return 'PASSWORD';
  }
  if (auth === '手动 Session') {
    return 'SESSION';
  }

  return 'USER_TOKEN';
}

function authLabel(authMode: BackendUpstream['authMode'], upstreamType: UpstreamProvider) {
  if (upstreamType === 'cli_proxy') {
    return '无鉴权';
  }

  if (authMode === 'API_KEY') {
    return 'API Key';
  }
  if (authMode === 'ADMIN_TOKEN') {
    return '管理 Token';
  }
  if (authMode === 'PASSWORD') {
    return '用户登录';
  }
  if (authMode === 'SESSION') {
    return '手动 Session';
  }

  return upstreamType === 'sub2api' ? '用户 Token' : '用户 Access Token';
}

function toRelayRecord(relay: BackendMainStation, channelCount: number): RelayRecord {
  const configured = relay.baseUrl !== '待配置' && relay.tokenConfigured && Boolean(relay.adminUserId);
  const failed = configured && Boolean(relay.lastError);

  return {
    id: relay.id || DEFAULT_RELAY_ID,
    name: relay.name || '主站',
    type: 'newapi',
    baseUrl: relay.baseUrl || '待配置',
    auth: relay.auth || '管理 Token',
    adminUserId: relay.adminUserId ?? '',
    tokenConfigured: relay.tokenConfigured,
    status: configured ? (failed ? '同步失败' : '正常') : '待配置',
    statusTone: configured ? (failed ? 'error' : 'ok') : 'limited',
    channelCount,
    balance: '-',
    sync: relay.lastSyncAt ? formatSyncTime(relay.lastSyncAt) : configured ? '等待同步' : '尚未同步'
  };
}

function statusLabel(
  status: BackendUpstream['status'],
  credentialConfigured: boolean,
  disabledByLatency = false,
  lastError?: string | null
): { label: string; tone: StatusTone } {
  if (disabledByLatency) {
    return { label: '延迟禁用', tone: 'error' };
  }

  if (!credentialConfigured && status !== 'DISABLED') {
    return { label: '待配置认证信息', tone: 'limited' };
  }

  if (lastError && isCredentialFailureMessage(lastError)) {
    return { label: '凭证失效', tone: 'error' };
  }

  if (status === 'OK') {
    return { label: '正常', tone: 'ok' };
  }
  if (status === 'CHALLENGE_REQUIRED') {
    return { label: '需要人工处理', tone: 'limited' };
  }
  if (status === 'EXPIRED') {
    return { label: '凭证失效', tone: 'error' };
  }
  if (status === 'ERROR') {
    return { label: '同步失败', tone: 'error' };
  }
  if (status === 'DISABLED') {
    return { label: '已禁用', tone: 'limited' };
  }

  return { label: '待同步', tone: 'warn' };
}

function failureReasonText(message: string | null | undefined) {
  const normalized = message?.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return null;
  }
  if (/Unsupported state|authenticate data|credential payload|CREDENTIAL_SECRET/i.test(normalized)) {
    return '认证信息无法解密，请重新保存该渠道密钥';
  }

  return normalized.slice(0, 160);
}

function isCredentialFailureMessage(message: string) {
  return /Unsupported state|authenticate data|credential payload|CREDENTIAL_SECRET|HTTP 401|HTTP 403|unauthorized|forbidden|invalid token|token.*invalid|expired|失效|过期|权限不足|认证失败|鉴权失败|登录失败|password|账号密码|用户模式需要|需要 email|需要 upstreamUserId/i.test(message);
}

function balanceText(upstream: BackendUpstream, credentialConfigured: boolean) {
  if (upstream.balance !== null && upstream.balance !== undefined) {
    return formatAmount(upstream.balance);
  }

  return credentialConfigured ? '待同步' : '不可见';
}

function formatAmount(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed.toFixed(2) : String(value);
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function normalizeRechargeRatio(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  const next = Number.isFinite(parsed) && parsed >= 0.01 ? parsed : fallback;

  return Math.round(next * 100) / 100;
}

function formatSyncTime(value: string) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return '已同步';
  }

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return '刚刚';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }

  return `${Math.floor(seconds / 3600)} 小时前`;
}
