import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type UpstreamProvider = 'newapi' | 'sub2api' | 'cli_proxy';
export type RelayType = 'newapi';
export type StatusTone = 'ok' | 'warn' | 'limited' | 'error';

export type RelayRecord = {
  id: string;
  name: string;
  type: RelayType;
  baseUrl: string;
  auth: string;
  adminUserId: string;
  tokenConfigured: boolean;
  status: string;
  statusTone: StatusTone;
  channelCount: number;
  balance: string;
  sync: string;
};

export type ChannelRecord = {
  id: string;
  relayId: string;
  source?: 'main_station' | 'manual';
  sourceChannelId?: string;
  name: string;
  group: string;
  mainStationGroup?: string;
  upstreamType: UpstreamProvider;
  upstreamName: string;
  upstreamBaseUrl: string;
  upstreamUserId?: string;
  keyName?: string;
  skipLatencyDisable?: boolean;
  enabled: boolean;
  auth: string;
  credentialConfigured: boolean;
  status: string;
  statusTone: StatusTone;
  balance: string;
  models: number;
  groupRatio: number | null;
  rateSource: string;
  rechargeRatio: number;
  currentRate: number | null;
  previousRate: number | null;
  cf: string;
  priority: number;
  weight: number;
  latencyMs?: number | null;
  latencyCheckedAt?: string | null;
  latencyFailureCount?: number;
  latencySuccessCount?: number;
  latencyLastError?: string | null;
  lastError?: string | null;
  disabledByLatency?: boolean;
  latencyDisabledAt?: string | null;
  latencyNextCheckAt?: string | null;
  sync: string;
};

export type EventRecord = {
  title: string;
  detail: string;
  time: string;
  status: 'error' | 'success' | 'warning';
};

export type CpaUsageRecord = {
  timestamp: string;
  authIndex?: string;
  source?: string;
  totalTokens: number;
  failed: boolean;
};

export type Store = {
  relays: RelayRecord[];
  relaySecrets: Record<string, { adminToken: string }>;
  channelSecrets: Record<string, { credential: string }>;
  cpaChannelOverrides: Record<string, ChannelRecord>;
  cpaUsageRecords: CpaUsageRecord[];
  channels: ChannelRecord[];
  events: EventRecord[];
};

const globalStore = globalThis as typeof globalThis & {
  __relayDeskStoreV3?: Store;
};
const cpaStoreFileName = 'cpa-store.json';

export function getStore() {
  if (!globalStore.__relayDeskStoreV3) {
    const persistedCpa = loadPersistedCpaStore();
    globalStore.__relayDeskStoreV3 = {
      relays: [
        {
          id: 'relay-newapi-main',
          name: '主站',
          type: 'newapi',
          baseUrl: '待配置',
          auth: '管理 Token',
          adminUserId: '',
          tokenConfigured: false,
          status: '待配置',
          statusTone: 'limited',
          channelCount: 0,
          balance: '-',
          sync: '尚未同步'
        }
      ],
      relaySecrets: {},
      channelSecrets: persistedCpa.channelSecrets,
      cpaChannelOverrides: Object.fromEntries(persistedCpa.channels.map((channel) => [channel.id, channel])),
      cpaUsageRecords: [],
      channels: persistedCpa.channels,
      events: []
    };
  }

  normalizeStore(globalStore.__relayDeskStoreV3);
  syncRelayCounts(globalStore.__relayDeskStoreV3);
  return globalStore.__relayDeskStoreV3;
}

function normalizeStore(store: Store) {
  store.relaySecrets ??= {};
  store.channelSecrets ??= {};
  store.cpaChannelOverrides ??= {};
  store.cpaUsageRecords ??= [];
  store.relays = store.relays.map((relay) => {
    const tokenConfigured = Boolean(relay.tokenConfigured || store.relaySecrets[relay.id]?.adminToken);
    const hasBaseUrl = relay.baseUrl !== '待配置';
    const configured = hasBaseUrl && tokenConfigured && Boolean(relay.adminUserId);

    return {
      ...relay,
      name: relay.name === '主中转站' ? '主站' : relay.name,
      adminUserId: relay.adminUserId ?? '',
      tokenConfigured,
      status: configured ? relay.status : '待配置',
      statusTone: configured ? relay.statusTone : 'limited',
      sync: configured ? relay.sync : '尚未同步'
    };
  });
  store.channels = dedupeChannels(store.channels, store.channelSecrets);
}

export function currentTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

export function nextRate(channel: ChannelRecord) {
  const base = channel.currentRate ?? channel.previousRate ?? 1;
  const direction = channel.upstreamType === 'sub2api' ? 1 : -1;
  const magnitude = channel.id.length % 3 === 0 ? 0.018 : 0.009;
  return Math.round(Math.max(0.01, base * (1 + direction * magnitude)) * 100) / 100;
}

export function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function syncRelayCounts(store: Store) {
  const channels = dedupeChannels(store.channels, store.channelSecrets);
  store.channels = channels;
  store.relays = store.relays.map((relay) => ({
    ...relay,
    channelCount: channels.filter((channel) => channel.relayId === relay.id).length
  }));
}

export function mergePersistentChannels(store: Store, persistent: ChannelRecord[]) {
  const persistentIds = new Set(persistent.map((channel) => channel.id));
  const cpaOverrides = Object.values(store.cpaChannelOverrides ?? {});
  const cpaOverrideIds = new Set(cpaOverrides.map((channel) => channel.id));
  const localChannels = store.channels.filter(
    (channel) =>
      !cpaOverrideIds.has(channel.id) &&
      (
        channel.upstreamType === 'cli_proxy' ||
        (channel.source === 'main_station' && !persistentIds.has(channel.id))
      )
  );

  store.channels = dedupeChannels([...cpaOverrides, ...localChannels, ...persistent], store.channelSecrets);
  syncRelayCounts(store);

  return store.channels;
}

export function persistCpaStore(store: Store) {
  const channels = Object.values(store.cpaChannelOverrides ?? {}).map((channel) => normalizeChannel(channel, store.channelSecrets[channel.id]?.credential));
  const secrets: Record<string, string> = {};

  for (const channel of channels) {
    const credential = store.channelSecrets[channel.id]?.credential?.trim();
    const encrypted = credential ? encryptLocalSecret(credential) : null;

    if (encrypted) {
      secrets[channel.id] = encrypted;
    }
  }

  try {
    const filePath = cpaStorePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, channels, secrets }, null, 2),
      'utf8'
    );
  } catch {
    // CPA 持久化失败不能阻断渠道保存，页面仍保留当前进程内配置。
  }
}

export function dedupeChannels(
  channels: ChannelRecord[],
  channelSecrets: Record<string, { credential: string }> = {}
) {
  const seen = new Set<string>();
  const uniqueChannels: ChannelRecord[] = [];

  for (const channel of channels) {
    if (!channel?.id || seen.has(channel.id)) {
      continue;
    }

    seen.add(channel.id);
    uniqueChannels.push(normalizeChannel(channel, channelSecrets[channel.id]?.credential));
  }

  return uniqueChannels;
}

export function isUpstreamProvider(value: unknown): value is UpstreamProvider {
  return value === 'newapi' || value === 'sub2api' || value === 'cli_proxy';
}

export function providerLabel(type: UpstreamProvider) {
  if (type === 'newapi') {
    return 'NewAPI';
  }

  if (type === 'sub2api') {
    return 'Sub2API';
  }

  return 'CPA（号池）';
}

export function normalizeChannel(channel: ChannelRecord, storedCredential?: string): ChannelRecord {
  const upstreamType = isUpstreamProvider(channel.upstreamType) ? channel.upstreamType : 'newapi';
  const credentialConfigured = Boolean(channel.credentialConfigured || storedCredential);
  const enabled = channel.enabled ?? channel.status !== '已禁用';

  if (upstreamType === 'cli_proxy') {
    return {
      ...channel,
      upstreamType,
      enabled,
      credentialConfigured,
      upstreamUserId: channel.upstreamUserId ?? '',
      keyName: channel.keyName ?? '',
      skipLatencyDisable: false,
      rechargeRatio: normalizeRechargeRatio(channel.rechargeRatio),
      balance: '-',
      currentRate: null,
      previousRate: null,
      groupRatio: null,
      rateSource: '不适用',
      status: channel.status === '已禁用' ? channel.status : '仅转发',
      statusTone: channel.statusTone === 'error' ? 'error' : 'limited',
      cf: channel.cf ?? '不适用',
      priority: normalizeInteger(channel.priority),
      weight: normalizeInteger(channel.weight),
      latencyMs: null,
      latencyCheckedAt: null,
      latencyFailureCount: 0,
      latencySuccessCount: 0,
      latencyLastError: null,
      disabledByLatency: false,
      latencyDisabledAt: null,
      latencyNextCheckAt: null
    };
  }

  return {
    ...channel,
    upstreamType,
    enabled,
    credentialConfigured,
    upstreamUserId: channel.upstreamUserId ?? '',
    keyName: channel.keyName ?? '',
    skipLatencyDisable: Boolean(channel.skipLatencyDisable),
    rechargeRatio: normalizeRechargeRatio(channel.rechargeRatio),
    balance: channel.balance ?? '未获取',
    currentRate: channel.currentRate ?? null,
    previousRate: channel.previousRate ?? null,
    groupRatio: numericOrNull(channel.groupRatio),
    rateSource: channel.rateSource ?? '未获取',
    cf: channel.cf ?? '待检测',
    priority: normalizeInteger(channel.priority),
    weight: normalizeInteger(channel.weight),
    status: !credentialConfigured && channel.status !== '已禁用' ? '待配置认证信息' : channel.status,
    statusTone: !credentialConfigured && channel.status !== '已禁用' ? 'limited' : channel.statusTone,
    latencyMs: numericOrNull(channel.latencyMs),
    latencyCheckedAt: channel.latencyCheckedAt ?? null,
    latencyFailureCount: normalizeInteger(channel.latencyFailureCount),
    latencySuccessCount: normalizeInteger(channel.latencySuccessCount),
    latencyLastError: channel.latencyLastError ?? null,
    disabledByLatency: Boolean(channel.disabledByLatency),
    latencyDisabledAt: channel.latencyDisabledAt ?? null,
    latencyNextCheckAt: channel.latencyNextCheckAt ?? null
  };
}

function numericOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRechargeRatio(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0.01 ? Math.round(parsed * 100) / 100 : 1;
}

function normalizeInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function loadPersistedCpaStore(): { channels: ChannelRecord[]; channelSecrets: Record<string, { credential: string }> } {
  try {
    const filePath = cpaStorePath();

    if (!existsSync(filePath)) {
      return { channels: [], channelSecrets: {} };
    }

    const payload = JSON.parse(readFileSync(filePath, 'utf8')) as {
      channels?: unknown;
      secrets?: Record<string, string>;
    };
    const channels = Array.isArray(payload.channels)
      ? payload.channels
          .filter((channel): channel is ChannelRecord => Boolean(channel) && typeof channel === 'object')
          .map((channel) => normalizeChannel(channel))
          .filter((channel) => channel.upstreamType === 'cli_proxy')
      : [];
    const channelIds = new Set(channels.map((channel) => channel.id));
    const channelSecrets: Record<string, { credential: string }> = {};

    for (const [channelId, encrypted] of Object.entries(payload.secrets ?? {})) {
      if (!channelIds.has(channelId)) {
        continue;
      }

      const credential = decryptLocalSecret(encrypted);
      if (credential) {
        channelSecrets[channelId] = { credential };
      }
    }

    return { channels, channelSecrets };
  } catch {
    return { channels: [], channelSecrets: {} };
  }
}

function cpaStorePath() {
  return path.join(workspaceRoot(), '.relaydesk', cpaStoreFileName);
}

function workspaceRoot() {
  let current = process.cwd();

  for (let index = 0; index < 5; index += 1) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return process.cwd();
}

function encryptLocalSecret(value: string) {
  const key = localSecretKey();
  if (!key) {
    return null;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

function decryptLocalSecret(value: string) {
  const key = localSecretKey();
  if (!key) {
    return null;
  }

  try {
    const [version, ivValue, tagValue, encryptedValue] = value.split(':');
    if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
      return null;
    }

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function localSecretKey() {
  const secret = process.env.CREDENTIAL_SECRET?.trim();

  return secret ? createHash('sha256').update(secret).digest() : null;
}
