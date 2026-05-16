import { NextResponse } from 'next/server';
import {
  currentTime,
  getStore,
  isUpstreamProvider,
  normalizeChannel,
  providerLabel,
  syncRelayCounts,
  type ChannelRecord,
  type EventRecord,
  type StatusTone,
  type UpstreamProvider
} from '../store';

export async function GET(request: Request) {
  const relayId = new URL(request.url).searchParams.get('relayId');
  const store = getStore();
  const channels = relayId ? store.channels.filter((channel) => channel.relayId === relayId) : store.channels;

  return NextResponse.json({ channels });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    relayId?: string;
    name?: string;
    group?: string;
    upstreamType?: UpstreamProvider;
    upstreamName?: string;
    upstreamBaseUrl?: string;
    upstreamUserId?: string;
    keyName?: string;
    auth?: string;
    credential?: string;
    rechargeRatio?: number;
    priority?: number;
    weight?: number;
  };

  const store = getStore();
  const relayId = body.relayId ?? store.relays[0]?.id;

  if (!relayId || !store.relays.some((relay) => relay.id === relayId)) {
    return NextResponse.json({ error: 'relayId is invalid' }, { status: 400 });
  }

  if (!body.name || !body.upstreamType || !body.upstreamName || !body.upstreamBaseUrl || !body.auth) {
    return NextResponse.json(
      { error: 'name, upstreamType, upstreamName, upstreamBaseUrl and auth are required' },
      { status: 400 }
    );
  }

  if (!isUpstreamProvider(body.upstreamType)) {
    return NextResponse.json({ error: 'channel upstream must be newapi, sub2api or cli_proxy' }, { status: 400 });
  }

  const credential = body.credential?.trim();
  if (requiresCredential(body.upstreamType, body.auth) && !credential) {
    return NextResponse.json({ error: 'credential is required for this upstream auth mode' }, { status: 400 });
  }

  const credentialConfigured = Boolean(credential);
  const monitoring = monitoringState(body.upstreamType, body.auth, credentialConfigured);
  const rechargeRatio = normalizeRechargeRatio(body.rechargeRatio);

  const channel: ChannelRecord = {
    id: `channel-${body.upstreamType}-${Date.now()}`,
    relayId,
    source: 'manual',
    name: body.name,
    group: body.group || 'default',
    upstreamType: body.upstreamType,
    upstreamName: body.upstreamName,
    upstreamBaseUrl: body.upstreamBaseUrl,
    upstreamUserId: body.upstreamUserId?.trim() ?? '',
    keyName: body.keyName?.trim() ?? '',
    auth: body.auth,
    credentialConfigured,
    status: monitoring.status,
    statusTone: monitoring.statusTone,
    balance: monitoring.balance,
    models: 0,
    groupRatio: monitoring.groupRatio,
    rateSource: monitoring.rateSource,
    rechargeRatio,
    currentRate: monitoring.currentRate,
    previousRate: monitoring.previousRate,
    cf: monitoring.cf,
    priority: normalizeInteger(body.priority, 50),
    weight: normalizeInteger(body.weight, 0),
    sync: body.upstreamType === 'cli_proxy' ? '不适用' : '尚未同步'
  };

  if (credential) {
    store.channelSecrets[channel.id] = { credential };
  }
  store.channels = [channel, ...store.channels];

  const relay = store.relays.find((item) => item.id === relayId);
  const event: EventRecord = {
    title: `新增渠道 ${body.name}`,
    detail: `${relay?.name ?? 'NewAPI 中转站'} / ${providerLabel(body.upstreamType)} / ${body.auth} / ${credentialConfigured ? '凭据已配置' : '凭据未配置'} / 充值 1:${formatRatio(rechargeRatio)}`,
    time: currentTime(),
    status: 'success'
  };

  store.events = [event, ...store.events].slice(0, 20);
  syncRelayCounts(store);

  return NextResponse.json({ channel });
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    relayId?: string;
    name?: string;
    group?: string;
    upstreamType?: UpstreamProvider;
    upstreamName?: string;
    upstreamBaseUrl?: string;
    upstreamUserId?: string;
    keyName?: string;
    auth?: string;
    credential?: string;
    rechargeRatio?: number;
    priority?: number;
    weight?: number;
  };

  const store = getStore();
  const existing = store.channels.find((channel) => channel.id === body.id);

  if (!body.id || !existing) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  const relayId = body.relayId ?? existing.relayId;
  if (!store.relays.some((relay) => relay.id === relayId)) {
    return NextResponse.json({ error: 'relayId is invalid' }, { status: 400 });
  }

  if (!body.name || !body.group || !body.upstreamType || !body.upstreamName || !body.upstreamBaseUrl || !body.auth) {
    return NextResponse.json(
      { error: 'name, group, upstreamType, upstreamName, upstreamBaseUrl and auth are required' },
      { status: 400 }
    );
  }

  if (!isUpstreamProvider(body.upstreamType)) {
    return NextResponse.json({ error: 'channel upstream must be newapi, sub2api or cli_proxy' }, { status: 400 });
  }

  const credential = body.credential?.trim();
  if (credential) {
    store.channelSecrets[existing.id] = { credential };
  }
  const credentialConfigured = Boolean(credential || existing.credentialConfigured || store.channelSecrets[existing.id]?.credential);
  const monitoring = monitoringState(body.upstreamType, body.auth, credentialConfigured, existing);
  const rechargeRatio = normalizeRechargeRatio(body.rechargeRatio);
  const priority = normalizeInteger(body.priority, existing.priority);
  const weight = normalizeInteger(body.weight, existing.weight);
  const mainStationUpdate = await updateMainStationPriorityAndWeightIfNeeded(store, existing, priority, weight);

  if (!mainStationUpdate.ok) {
    const event: EventRecord = {
      title: `同步主站渠道失败 ${existing.name}`,
      detail: mainStationUpdate.message,
      time: currentTime(),
      status: 'error'
    };
    store.events = [event, ...store.events].slice(0, 20);

    return NextResponse.json({ error: mainStationUpdate.message, events: store.events }, { status: 502 });
  }

  const channel = normalizeChannel({
    ...existing,
    relayId,
    name: body.name.trim(),
    group: body.group.trim(),
    upstreamType: body.upstreamType,
    upstreamName: body.upstreamName.trim(),
    upstreamBaseUrl: body.upstreamBaseUrl.trim(),
    upstreamUserId: body.upstreamUserId?.trim() ?? '',
    keyName: body.keyName?.trim() ?? '',
    auth: body.auth,
    credentialConfigured,
    rechargeRatio,
    status: monitoring.status,
    statusTone: monitoring.statusTone,
    balance: monitoring.balance,
    currentRate: monitoring.currentRate,
    previousRate: monitoring.previousRate,
    groupRatio: monitoring.groupRatio,
    rateSource: monitoring.rateSource,
    cf: monitoring.cf,
    priority,
    weight,
    sync: body.upstreamType === 'cli_proxy' ? '不适用' : '等待同步'
  });

  store.channels = store.channels.map((item) => (item.id === channel.id ? channel : item));

  const relay = store.relays.find((item) => item.id === relayId);
  const event: EventRecord = {
    title: `配置渠道 ${channel.name}`,
    detail: `${relay?.name ?? 'NewAPI 中转站'} / ${providerLabel(channel.upstreamType)} / ${channel.auth} / ${channel.credentialConfigured ? '凭据已配置' : '凭据未配置'} / 充值 1:${formatRatio(channel.rechargeRatio)}`,
    time: currentTime(),
    status: 'success'
  };
  store.events = [event, ...store.events].slice(0, 20);
  syncRelayCounts(store);

  return NextResponse.json({ channel, channels: store.channels, events: store.events, relays: store.relays });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  const store = getStore();
  const existing = store.channels.find((channel) => channel.id === id);

  if (!id || !existing) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  store.channels = store.channels.filter((channel) => channel.id !== id);
  delete store.channelSecrets[id];

  const event: EventRecord = {
    title: `删除渠道 ${existing.name}`,
    detail: `${providerLabel(existing.upstreamType)} / ${existing.auth}`,
    time: currentTime(),
    status: 'warning'
  };
  store.events = [event, ...store.events].slice(0, 20);
  syncRelayCounts(store);

  return NextResponse.json({ channels: store.channels, events: store.events, relays: store.relays });
}

async function updateMainStationPriorityAndWeightIfNeeded(
  store: ReturnType<typeof getStore>,
  existing: ChannelRecord,
  priority: number,
  weight: number
) {
  if (existing.source !== 'main_station' || !existing.sourceChannelId) {
    return { ok: true as const };
  }

  if (existing.priority === priority && existing.weight === weight) {
    return { ok: true as const };
  }

  const relay = store.relays.find((item) => item.id === existing.relayId);
  const token = store.relaySecrets[existing.relayId]?.adminToken;
  const channelId = Number(existing.sourceChannelId);

  if (!relay || relay.baseUrl === '待配置' || !relay.adminUserId || !token) {
    return {
      ok: false as const,
      message: '主站管理配置不完整，无法把优先级和权重写回 NewAPI 主站'
    };
  }

  if (!Number.isInteger(channelId) || channelId <= 0) {
    return {
      ok: false as const,
      message: `主站渠道 ID 无效：${existing.sourceChannelId}`
    };
  }

  const url = `${normalizeBaseUrl(relay.baseUrl)}/api/channel/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'New-Api-User': relay.adminUserId
      },
      body: JSON.stringify({ id: channelId, priority, weight }),
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false as const,
        message: `NewAPI 主站返回 HTTP ${response.status}: ${clip(text)}`
      };
    }

    if (isChallenge(text)) {
      return {
        ok: false as const,
        message: 'NewAPI 主站返回 Cloudflare/验证码页面，无法写回优先级和权重'
      };
    }

    const payload = parseJson(text);
    if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false) {
      return {
        ok: false as const,
        message: `NewAPI 主站更新失败：${stringValue(payload.message) ?? '未知错误'}`
      };
    }

    return { ok: true as const };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '请求超时' : errorMessage(error);
    return {
      ok: false as const,
      message: `请求 NewAPI 主站更新渠道失败：${message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function parseJson(text: string) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as { success?: boolean; message?: unknown };
  } catch {
    return null;
  }
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

function stringValue(value: unknown) {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeRechargeRatio(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function formatRatio(value: number) {
  return String(Math.max(1, Math.trunc(value)));
}

function requiresCredential(type: UpstreamProvider, auth: string) {
  return type !== 'cli_proxy' && auth !== '无鉴权';
}

function monitoringState(type: UpstreamProvider, auth: string, credentialConfigured: boolean, existing?: ChannelRecord) {
  if (type === 'cli_proxy') {
    return {
      status: '仅转发',
      statusTone: 'limited' as StatusTone,
      balance: '-',
      currentRate: null,
      previousRate: null,
      cf: '不适用',
      groupRatio: null,
      rateSource: '不适用'
    };
  }

  if (!credentialConfigured) {
    return {
      status: '待配置凭据',
      statusTone: 'limited' as StatusTone,
      balance: '不可见',
      currentRate: null,
      previousRate: existing?.currentRate ?? existing?.previousRate ?? null,
      cf: existing?.cf ?? '待检测',
      groupRatio: existing?.groupRatio ?? null,
      rateSource: '待配置凭据'
    };
  }

  if (auth === 'API Key') {
    return {
      status: '受限监控',
      statusTone: 'limited' as StatusTone,
      balance: '不可见',
      currentRate: null,
      previousRate: existing?.currentRate ?? existing?.previousRate ?? null,
      cf: existing?.cf ?? '待检测',
      groupRatio: existing?.groupRatio ?? null,
      rateSource: 'API Key 受限'
    };
  }

  return {
    status: '待同步',
    statusTone: 'warn' as StatusTone,
    balance: '待同步',
    currentRate: existing?.currentRate ?? null,
    previousRate: existing?.previousRate ?? null,
    cf: existing?.cf ?? '待检测',
    groupRatio: existing?.groupRatio ?? null,
    rateSource: existing?.rateSource ?? '待同步'
  };
}
