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
import { createBackendChannel, deleteBackendChannel, getInspectionStatus, listBackendChannels, updateBackendChannel } from '../backend-upstreams';
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
    const channel = createTransientChannel(body, relayId as string, cpaPreferred);
    const managementKey = body.credential?.trim();

    if (managementKey) {
      store.channelSecrets[channel.id] = { credential: managementKey };
      channel.credentialConfigured = true;
    }
    store.channels = [channel, ...store.channels.filter((item) => item.id !== channel.id)];
    store.cpaChannelOverrides[channel.id] = channel;
    persistCpaStore(store);
    appendEvent(store, {
      title: `新增渠道 ${body.name}`,
      detail: `${providerLabel(body.upstreamType)} / ${body.auth} / 仅本地临时配置`,
      time: currentTime(),
      status: 'success'
    });
    syncRelayCounts(store);

    return NextResponse.json({ channel });
  }

  try {
    const channel = await createBackendChannel(body);
    appendEvent(store, channelEvent('新增渠道', channel));
    const channels = await loadChannels();

    return NextResponse.json({ channel, channels, events: store.events, relays: store.relays });
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
    const managementKey = body.credential?.trim();
    const channel = normalizeChannel({
      ...existing,
      relayId: body.relayId ?? existing.relayId,
      name: body.name?.trim() ?? existing.name,
      group: body.group?.trim() ?? existing.group,
      upstreamType: 'cli_proxy',
      upstreamName: body.upstreamName?.trim() ?? body.name?.trim() ?? existing.upstreamName,
      upstreamBaseUrl: body.upstreamBaseUrl?.trim() ?? existing.upstreamBaseUrl,
      upstreamUserId: body.upstreamUserId?.trim() ?? '',
      keyName: body.keyName?.trim() ?? '',
      skipLatencyDisable: false,
      enabled: body.enabled ?? existing.enabled,
      auth: body.auth ?? existing.auth,
      status: body.enabled === false ? '已禁用' : '仅转发',
      rechargeRatio: normalizeRechargeRatio(body.rechargeRatio),
      priority: cpaPreferred ? 100 : normalizeInteger(body.priority, existing.priority),
      weight: cpaPreferred ? 10 : normalizeInteger(body.weight, existing.weight),
      sync: '不适用'
    });
    if (managementKey) {
      store.channelSecrets[channel.id] = { credential: managementKey };
      channel.credentialConfigured = true;
    }
    store.cpaChannelOverrides[channel.id] = channel;
    store.channels = dedupeChannels([channel, ...store.channels.filter((item) => item.id !== channel.id)], store.channelSecrets);
    persistCpaStore(store);
    appendEvent(store, channelEvent('配置渠道', channel));
    syncRelayCounts(store);

    return NextResponse.json({ channel, channels: await loadChannels(), events: store.events, relays: store.relays });
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
      const channels = await loadChannels();

      return NextResponse.json({ channel, channels, events: store.events, relays: store.relays });
    } catch (error) {
      return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
    }
  }

  try {
    const channel = await updateBackendChannel(body.id, body);
    appendEvent(store, channelEvent('配置渠道', channel));
    const channels = await loadChannels();

    return NextResponse.json({ channel, channels, events: store.events, relays: store.relays });
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
    delete store.cpaChannelOverrides[existing.id];
    delete store.channelSecrets[existing.id];
    persistCpaStore(store);

    if (!isLocalCpaChannelId(existing.id)) {
      try {
        await deleteBackendChannel(existing.id);
      } catch (error) {
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
  const persistent = await listBackendChannels();

  return mergePersistentChannels(store, persistent);
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
    detailParts.push(`充值 1:${formatRatio(channel.rechargeRatio)}`);
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

function normalizeRechargeRatio(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0.01 ? Math.round(parsed * 100) / 100 : 1;
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function formatRatio(value: number) {
  return Math.max(0.01, value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
