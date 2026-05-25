import { NextResponse } from 'next/server';
import {
  currentTime,
  getStore,
  isUpstreamProvider,
  mergePersistentChannels,
  dedupeChannels,
  normalizeChannel,
  persistCpaStore,
  providerLabel,
  syncRelayCounts,
  type ChannelRecord,
  type EventRecord,
  type StatusTone,
  type UpstreamProvider
} from '../store';
import {
  createBackendChannel,
  deleteBackendChannel,
  getInspectionStatus,
  listBackendChannels,
  updateBackendChannel,
  type ChannelInput
} from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const relayId = new URL(request.url).searchParams.get('relayId');
  const channels = await loadChannels();
  const filtered = relayId ? channels.filter((channel) => channel.relayId === relayId) : channels;

  return NextResponse.json({ channels: filtered });
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json()) as ChannelPayload;
  const store = getStore();
  const relayId = body.relayId ?? store.relays[0]?.id;

  const validation = validateChannelPayload(body, relayId);
  if (validation) {
    return validation;
  }

  if (body.upstreamType === 'cli_proxy') {
    const cpaPreferred = await cliProxyPreferredActive(body.upstreamBaseUrl);
    const channelInput = cpaBackendPayload(body, {
      relayId: relayId as string,
      cpaPreferred,
      fallbackPriority: 50,
      fallbackWeight: 0
    });

    try {
      const channel = await createBackendChannel(channelInput);
      appendEvent(store, channelEvent('新增渠道', channel));
      const channels = await loadChannels();

      return NextResponse.json({ channel, channels, events: store.events, relays: store.relays });
    } catch (error) {
      return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
    }
  }

  try {
    const channel = await createBackendChannel(body);
    appendEvent(store, channelEvent('新增渠道', channel));

    return NextResponse.json({ channel, events: store.events, relays: store.relays });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json()) as ChannelPayload & { id?: string };
  const store = getStore();

  if (!body.id) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  const existing = store.channels.find((channel) => channel.id === body.id)
    ?? (await loadChannels()).find((channel) => channel.id === body.id);
  const validation = validateChannelPayload(body, body.relayId ?? existing?.relayId ?? store.relays[0]?.id);
  if (validation) {
    return validation;
  }

  const upstreamType = body.upstreamType ?? existing?.upstreamType;
  if (upstreamType === 'cli_proxy') {
    if (!existing) {
      return NextResponse.json({ error: 'channel not found' }, { status: 404 });
    }

    const cpaPreferred = await cliProxyPreferredActive(body.upstreamBaseUrl ?? existing.upstreamBaseUrl);
    const channelInput = cpaBackendPayload(body, {
      existing,
      relayId: body.relayId ?? existing.relayId,
      cpaPreferred,
      fallbackPriority: existing.priority,
      fallbackWeight: existing.weight
    });

    try {
      const channel = await updateOrCreateBackendCpaChannel(body.id, channelInput);
      delete store.cpaChannelOverrides[body.id];
      delete store.channelSecrets[body.id];
      persistCpaStore(store);
      appendEvent(store, channelEvent('配置渠道', channel));
      const channels = await loadChannels();

      return NextResponse.json({ channel, channels, events: store.events, relays: store.relays });
    } catch (error) {
      return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
    }
  }

  if (existing?.upstreamType === 'cli_proxy') {
    delete store.cpaChannelOverrides[existing.id];
    delete store.channelSecrets[existing.id];
    persistCpaStore(store);
  }

  if (existing?.source === 'main_station') {
    try {
      const channel = await createBackendChannel({
        ...body,
        id: existing.id
      });
      appendEvent(store, channelEvent('配置渠道', channel));
      store.channels = store.channels.filter((item) => item.id !== existing.id);

      return NextResponse.json({ channel, events: store.events, relays: store.relays });
    } catch (error) {
      return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
    }
  }

  try {
    const channel = await updateBackendChannel(body.id, body);
    appendEvent(store, channelEvent('配置渠道', channel));

    return NextResponse.json({ channel, events: store.events, relays: store.relays });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const id = new URL(request.url).searchParams.get('id');
  const store = getStore();
  const existing = store.channels.find((channel) => channel.id === id);

  if (!id) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  if (existing?.upstreamType === 'cli_proxy') {
    const localOverride = Boolean(store.cpaChannelOverrides[existing.id]);
    delete store.cpaChannelOverrides[existing.id];
    delete store.channelSecrets[existing.id];
    persistCpaStore(store);

    try {
      await deleteBackendChannel(existing.id);
    } catch (error) {
      if (!localOverride) {
        return NextResponse.json({ error: `后端渠道删除失败：${errorMessage(error)}` }, { status: 502 });
      }
    }

    store.channels = store.channels.filter((channel) => channel.id !== id);
    appendEvent(store, {
      title: `删除渠道 ${existing.name}`,
      detail: `${providerLabel(existing.upstreamType)} / ${existing.auth}`,
      time: currentTime(),
      status: 'warning'
    });
    syncRelayCounts(store);

    return NextResponse.json({ channels: await loadChannels(), events: store.events, relays: store.relays });
  }

  try {
    await deleteBackendChannel(id);
    if (existing) {
      appendEvent(store, {
        title: `删除渠道 ${existing.name}`,
        detail: `${providerLabel(existing.upstreamType)} / ${existing.auth}`,
        time: currentTime(),
        status: 'warning'
      });
    }
    const channels = await loadChannels();

    return NextResponse.json({ channels, events: store.events, relays: store.relays });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

type ChannelPayload = {
  id?: string;
  relayId?: string;
  name?: string;
  group?: string;
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

async function loadChannels() {
  const store = getStore();
  let persistent = await listBackendChannels();

  if (await migrateLocalCpaChannels(store, persistent)) {
    persistent = await listBackendChannels();
  }

  return mergePersistentChannels(store, persistent);
}

async function migrateLocalCpaChannels(store: ReturnType<typeof getStore>, persistent: ChannelRecord[]) {
  const persistentIds = new Set(persistent.map((channel) => channel.id));
  let changed = false;

  for (const channel of Object.values(store.cpaChannelOverrides ?? {})) {
    if (channel.upstreamType !== 'cli_proxy' || persistentIds.has(channel.id)) {
      continue;
    }

    try {
      await createBackendChannel({
        id: channel.id,
        name: channel.name,
        group: 'default',
        mainStationGroup: 'default',
        upstreamType: 'cli_proxy',
        upstreamName: channel.upstreamName || channel.name,
        upstreamBaseUrl: channel.upstreamBaseUrl,
        upstreamUserId: '',
        keyName: '',
        skipLatencyDisable: false,
        enabled: channel.enabled,
        auth: channel.auth || '无鉴权',
        credential: store.channelSecrets[channel.id]?.credential,
        createMainStation: false,
        rechargeRatio: 1,
        priority: channel.priority,
        weight: channel.weight
      });
      delete store.cpaChannelOverrides[channel.id];
      delete store.channelSecrets[channel.id];
      changed = true;
    } catch {
      // 后端不可用时保留旧本地 CPA 配置，避免页面配置丢失。
    }
  }

  if (changed) {
    persistCpaStore(store);
  }

  return changed;
}

async function updateOrCreateBackendCpaChannel(id: string, input: ChannelInput) {
  try {
    return await updateBackendChannel(id, input);
  } catch (error) {
    if (/not found|404|upstream not found/i.test(errorMessage(error))) {
      return createBackendChannel({ ...input, id });
    }

    throw error;
  }
}

function cpaBackendPayload(
  body: ChannelPayload,
  options: {
    existing?: ChannelRecord;
    relayId: string;
    cpaPreferred: boolean;
    fallbackPriority: number;
    fallbackWeight: number;
  }
): ChannelInput {
  const existing = options.existing;
  const upstreamName = body.upstreamName?.trim() || body.name?.trim() || existing?.upstreamName || existing?.name || 'CPA 号池';
  const managementKey = body.credential?.trim() || body.credentialPassword?.trim();

  return {
    id: body.id,
    name: body.name?.trim() || existing?.name || upstreamName,
    group: 'default',
    mainStationGroup: 'default',
    upstreamType: 'cli_proxy',
    upstreamName,
    upstreamBaseUrl: body.upstreamBaseUrl?.trim() || existing?.upstreamBaseUrl,
    upstreamUserId: '',
    keyName: '',
    skipLatencyDisable: false,
    enabled: body.enabled ?? existing?.enabled ?? true,
    auth: body.auth ?? existing?.auth ?? '无鉴权',
    credential: managementKey || undefined,
    createMainStation: false,
    rechargeRatio: 1,
    priority: options.cpaPreferred ? 100 : normalizeInteger(body.priority, options.fallbackPriority),
    weight: options.cpaPreferred ? 10 : normalizeInteger(body.weight, options.fallbackWeight)
  };
}

function validateChannelPayload(body: ChannelPayload, relayId?: string) {
  const store = getStore();

  if (!relayId || !store.relays.some((relay) => relay.id === relayId)) {
    return NextResponse.json({ error: 'relayId is invalid' }, { status: 400 });
  }

  if (!body.name || !body.upstreamType || !body.upstreamBaseUrl || !body.auth) {
    return NextResponse.json(
      { error: 'name, upstreamType, upstreamBaseUrl and auth are required' },
      { status: 400 }
    );
  }

  if (!isUpstreamProvider(body.upstreamType)) {
    return NextResponse.json({ error: 'channel upstream must be newapi, sub2api or cli_proxy' }, { status: 400 });
  }

  if (body.upstreamType === 'sub2api' && body.auth !== '用户登录' && body.auth !== '用户 Token') {
    return NextResponse.json({ error: 'Sub2API 只支持用户登录或用户 Token' }, { status: 400 });
  }

  if (
    body.upstreamType === 'newapi' &&
    body.auth !== '用户登录' &&
    body.auth !== '用户 Access Token' &&
    body.auth !== '管理 Token' &&
    body.auth !== 'API Key'
  ) {
    return NextResponse.json({ error: 'NewAPI 只支持账号密码、用户 Access Token、管理 Token 或 API Key' }, { status: 400 });
  }

  return null;
}

function createTransientChannel(body: ChannelPayload, relayId: string, cpaPreferred: boolean): ChannelRecord {
  return normalizeChannel({
    id: `channel-${body.upstreamType}-${Date.now()}`,
    relayId,
    source: 'manual',
    name: body.name as string,
    group: body.group || 'default',
    upstreamType: body.upstreamType as UpstreamProvider,
    upstreamName: body.upstreamName?.trim() || (body.name as string),
    upstreamBaseUrl: body.upstreamBaseUrl as string,
    upstreamUserId: body.upstreamUserId?.trim() ?? '',
    keyName: body.keyName?.trim() ?? '',
    skipLatencyDisable: false,
    enabled: body.enabled ?? true,
    auth: body.auth as string,
    credentialConfigured: false,
    status: body.enabled === false ? '已禁用' : '仅转发',
    statusTone: 'limited' as StatusTone,
    balance: '-',
    models: 0,
    groupRatio: null,
    rateSource: '不适用',
    rechargeRatio: 1,
    currentRate: null,
    previousRate: null,
    cf: '不适用',
    priority: cpaPreferred ? 100 : normalizeInteger(body.priority, 50),
    weight: cpaPreferred ? 10 : normalizeInteger(body.weight, 0),
    sync: '不适用'
  });
}

function isLocalCpaChannelId(id: string) {
  return /^channel-cli_proxy-\d+$/.test(id);
}

async function cliProxyPreferredActive(upstreamBaseUrl: string | undefined) {
  const inspection = await getInspectionStatus().catch(() => null);

  return Boolean(inspection?.cpaPreferred) && await isCliProxyAvailable(upstreamBaseUrl);
}

async function isCliProxyAvailable(upstreamBaseUrl: string | undefined) {
  const baseUrl = upstreamBaseUrl?.trim();

  if (!baseUrl) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${normalizeExternalBaseUrl(baseUrl)}/v1/models`, {
      headers: { accept: 'application/json,text/plain,*/*' },
      signal: controller.signal
    });

    return response.status !== 404 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeExternalBaseUrl(baseUrl: string) {
  const value = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return value.replace(/\/+$/, '');
}

function channelEvent(title: string, channel: ChannelRecord): EventRecord {
  const detailParts = [
    providerLabel(channel.upstreamType),
    channel.auth,
    channel.credentialConfigured ? '认证信息已配置' : '认证信息未配置'
  ];

  if (channel.upstreamType === 'cli_proxy') {
    detailParts.push('号池模式');
  } else {
    detailParts.push('余额和倍率只读同步');
  }

  return {
    title: `${title} ${channel.name}`,
    detail: detailParts.join(' / '),
    time: currentTime(),
    status: 'success'
  };
}

function appendEvent(store: ReturnType<typeof getStore>, event: EventRecord) {
  store.events = [event, ...store.events].slice(0, 20);
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
