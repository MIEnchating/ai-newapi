import { NextResponse } from 'next/server';
import {
  currentTime,
  getStore,
  isUpstreamProvider,
  providerLabel,
  syncRelayCounts,
  type ChannelRecord,
  type EventRecord,
  type StatusTone,
  type UpstreamProvider
} from '../store';

export async function GET() {
  return NextResponse.json({ upstreams: getStore().channels });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    baseUrl?: string;
    type?: UpstreamProvider;
    auth?: string;
    credential?: string;
    rechargeRatio?: number;
    priority?: number;
    weight?: number;
  };

  if (!body.name || !body.baseUrl || !body.type || !body.auth) {
    return NextResponse.json({ error: 'name, baseUrl, type and auth are required' }, { status: 400 });
  }

  if (!isUpstreamProvider(body.type)) {
    return NextResponse.json({ error: 'only newapi, sub2api and cli_proxy are supported' }, { status: 400 });
  }

  const store = getStore();
  const relayId = store.relays[0]?.id;
  if (!relayId) {
    return NextResponse.json({ error: 'relay is required before creating channel upstream' }, { status: 400 });
  }

  const credential = body.credential?.trim();
  const credentialConfigured = Boolean(credential);
  const monitoring = monitoringState(body.type, body.auth, credentialConfigured);
  const rechargeRatio = normalizeRechargeRatio(body.rechargeRatio);
  const upstream: ChannelRecord = {
    id: `channel-${body.type}-${Date.now()}`,
    relayId,
    source: 'manual',
    name: body.name,
    group: 'default',
    upstreamType: body.type,
    upstreamName: body.name,
    upstreamBaseUrl: body.baseUrl,
    upstreamUserId: '',
    keyName: '',
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
    sync: body.type === 'cli_proxy' ? '不适用' : '尚未同步'
  };

  if (credential) {
    store.channelSecrets[upstream.id] = { credential };
  }
  store.channels = [upstream, ...store.channels];
  const event: EventRecord = {
    title: `新增渠道上游 ${body.name}`,
    detail: `${providerLabel(body.type)} / ${body.auth} / 充值 1:${formatRatio(rechargeRatio)}`,
    time: currentTime(),
    status: 'success'
  };

  store.events = [event, ...store.events].slice(0, 20);
  syncRelayCounts(store);

  return NextResponse.json({ upstream });
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

function monitoringState(type: UpstreamProvider, auth: string, credentialConfigured: boolean) {
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
      previousRate: null,
      cf: '待检测',
      groupRatio: null,
      rateSource: '待配置凭据'
    };
  }

  return {
    status: auth === 'API Key' ? '受限监控' : '待同步',
    statusTone: (auth === 'API Key' ? 'limited' : 'warn') as StatusTone,
    balance: auth === 'API Key' ? '不可见' : '待同步',
    currentRate: null,
    previousRate: null,
    cf: '待检测',
    groupRatio: null,
    rateSource: auth === 'API Key' ? 'API Key 受限' : '待同步'
  };
}
