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
  upstreamType: UpstreamProvider;
  upstreamName: string;
  upstreamBaseUrl: string;
  upstreamUserId?: string;
  keyName?: string;
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
  sync: string;
};

export type EventRecord = {
  title: string;
  detail: string;
  time: string;
  status: 'error' | 'success' | 'warning';
};

type Store = {
  relays: RelayRecord[];
  relaySecrets: Record<string, { adminToken: string }>;
  channelSecrets: Record<string, { credential: string }>;
  channels: ChannelRecord[];
  events: EventRecord[];
};

const globalStore = globalThis as typeof globalThis & {
  __relayDeskStoreV3?: Store;
};

export function getStore() {
  if (!globalStore.__relayDeskStoreV3) {
    globalStore.__relayDeskStoreV3 = {
      relays: [
        {
          id: 'relay-newapi-main',
          name: '主中转站',
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
      channelSecrets: {},
      channels: [],
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
  store.relays = store.relays.map((relay) => {
    const tokenConfigured = Boolean(relay.tokenConfigured || store.relaySecrets[relay.id]?.adminToken);
    const hasBaseUrl = relay.baseUrl !== '待配置';
    const configured = hasBaseUrl && tokenConfigured && Boolean(relay.adminUserId);

    return {
      ...relay,
      adminUserId: relay.adminUserId ?? '',
      tokenConfigured,
      status: configured ? relay.status : '待配置',
      statusTone: configured ? relay.statusTone : 'limited',
      sync: configured ? relay.sync : '尚未同步'
    };
  });
  store.channels = store.channels.map((channel) => normalizeChannel(channel, store.channelSecrets[channel.id]?.credential));
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
  store.relays = store.relays.map((relay) => ({
    ...relay,
    channelCount: store.channels.filter((channel) => channel.relayId === relay.id).length
  }));
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

  return 'CLI Proxy API';
}

export function normalizeChannel(channel: ChannelRecord, storedCredential?: string): ChannelRecord {
  const upstreamType = isUpstreamProvider(channel.upstreamType) ? channel.upstreamType : 'newapi';
  const credentialConfigured = Boolean(channel.credentialConfigured || storedCredential);

  if (upstreamType === 'cli_proxy') {
    return {
      ...channel,
      upstreamType,
      credentialConfigured,
      upstreamUserId: channel.upstreamUserId ?? '',
      keyName: channel.keyName ?? '',
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
      weight: normalizeInteger(channel.weight)
    };
  }

  return {
    ...channel,
    upstreamType,
    credentialConfigured,
    upstreamUserId: channel.upstreamUserId ?? '',
    keyName: channel.keyName ?? '',
    rechargeRatio: normalizeRechargeRatio(channel.rechargeRatio),
    balance: credentialConfigured ? channel.balance ?? '待同步' : '不可见',
    currentRate: channel.currentRate ?? null,
    previousRate: channel.previousRate ?? null,
    groupRatio: numericOrNull(channel.groupRatio),
    rateSource: channel.rateSource ?? '待同步',
    cf: channel.cf ?? '待检测',
    priority: normalizeInteger(channel.priority),
    weight: normalizeInteger(channel.weight),
    status: !credentialConfigured && channel.status !== '已禁用' ? '待配置凭据' : channel.status,
    statusTone: !credentialConfigured && channel.status !== '已禁用' ? 'limited' : channel.statusTone
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
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

function normalizeInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
