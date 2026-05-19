import { NextResponse } from 'next/server';
import { createBackendChannel, listBackendChannels } from '../../backend-upstreams';
import { requireAuth } from '../../auth/session';
import {
  getStore,
  mergePersistentChannels,
  persistCpaStore,
  type ChannelRecord,
  type UpstreamProvider
} from '../../store';

type DetectionType = 'newapi' | 'sub2api' | 'cli_proxy' | 'unknown';

type ProbeResult = {
  path: string;
  status: number;
  text: string;
  json?: Record<string, unknown>;
};

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { channelId?: string; channelIds?: string[]; upstreamBaseUrl?: string };
  if (Array.isArray(body.channelIds)) {
    return detectChannelBatch(body.channelIds);
  }

  const existing = body.channelId
    ? (await loadChannelsForDetection()).find((channel) => channel.id === body.channelId)
    : undefined;
  const upstreamBaseUrl = body.upstreamBaseUrl?.trim() || existing?.upstreamBaseUrl?.trim();

  if (body.channelId && !existing) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  if (!upstreamBaseUrl) {
    return NextResponse.json({ error: '请输入上游地址' }, { status: 400 });
  }

  try {
    const detected = await detectUpstreamType(upstreamBaseUrl);

    if (!existing || !isKnownUpstreamType(detected.type)) {
      return NextResponse.json(detected);
    }

    const channel = await persistDetectedChannel(existing, detected.type);
    const nextStore = getStore();

    return NextResponse.json({
      ...detected,
      channel,
      channels: nextStore.channels,
      relays: nextStore.relays
    });
  } catch (error) {
    return NextResponse.json({ type: 'unknown', reason: errorMessage(error) }, { status: 200 });
  }
}

async function detectChannelBatch(channelIds: string[]) {
  const uniqueIds = [...new Set(channelIds.filter(Boolean))];
  const channelById = new Map((await loadChannelsForDetection()).map((channel) => [channel.id, channel]));
  const channels = uniqueIds.map((id) => channelById.get(id)).filter((channel): channel is ChannelRecord => Boolean(channel));
  const missingResults = uniqueIds
    .filter((id) => !channelById.has(id))
    .map((id) => ({ channelId: id, name: id, type: 'unknown' as DetectionType, reason: '渠道不存在或尚未同步到本地' }));

  if (channels.length === 0 && missingResults.length === 0) {
    return NextResponse.json({ error: '没有可识别的渠道' }, { status: 400 });
  }

  const detectedResults = await mapWithConcurrency(channels, 4, async (channel) => {
    const upstreamBaseUrl = channel.upstreamBaseUrl?.trim();

    if (!upstreamBaseUrl || upstreamBaseUrl === '-') {
      return { channelId: channel.id, name: channel.name, type: 'unknown' as DetectionType, reason: '缺少上游地址' };
    }

    const detected = await detectUpstreamType(upstreamBaseUrl).catch((error): { type: DetectionType; reason: string } => ({
      type: 'unknown',
      reason: errorMessage(error)
    }));

    return { channelId: channel.id, name: channel.name, ...detected };
  });
  const results = [...detectedResults, ...missingResults];

  for (const result of detectedResults) {
    if (isKnownUpstreamType(result.type)) {
      const channel = channelById.get(result.channelId);
      if (channel) {
        await persistDetectedChannel(channel, result.type);
      }
    }
  }

  const nextStore = getStore();
  const detectedCount = results.filter((result) => isKnownUpstreamType(result.type)).length;
  const unknownCount = results.length - detectedCount;

  return NextResponse.json({
    results,
    total: results.length,
    detected: detectedCount,
    unknown: unknownCount,
    channels: nextStore.channels,
    relays: nextStore.relays
  });
}

async function detectUpstreamType(upstreamBaseUrl: string) {
  const baseUrl = normalizeBaseUrl(upstreamBaseUrl);
  const probes = await Promise.all([
    probe(baseUrl, '/api/status'),
    probe(baseUrl, '/api/pricing'),
    probe(baseUrl, '/api/ratio_config'),
    probe(baseUrl, '/api/v1/auth/me'),
    probe(baseUrl, '/api/v1/groups/available'),
    probe(baseUrl, '/api/v1/channels/available'),
    probe(baseUrl, '/v1/models')
  ]);

  return detectType(probes);
}

async function persistDetectedChannel(existing: ChannelRecord, upstreamType: UpstreamProvider) {
  const channel = await createBackendChannel({
    id: existing.id,
    name: existing.name,
    group: upstreamType === 'cli_proxy' ? 'default' : existing.group,
    upstreamType,
    upstreamName: existing.upstreamName,
    upstreamBaseUrl: existing.upstreamBaseUrl,
    upstreamUserId: upstreamType === 'newapi' ? existing.upstreamUserId : '',
    keyName: upstreamType === 'cli_proxy' ? '' : existing.keyName,
    enabled: existing.enabled,
    auth: defaultAuth(upstreamType),
    rechargeRatio: existing.rechargeRatio,
    priority: existing.priority,
    weight: existing.weight,
    mainStationGroup: upstreamType === 'cli_proxy' ? 'default' : existing.mainStationGroup,
    skipLatencyDisable: upstreamType === 'cli_proxy' ? false : existing.skipLatencyDisable
  });
  const store = getStore();
  const persistent = await listBackendChannels();
  delete store.cpaChannelOverrides[existing.id];
  delete store.channelSecrets[existing.id];
  persistCpaStore(store);
  store.channels = store.channels.filter((item) => item.id !== existing.id);
  mergePersistentChannels(store, persistent);

  return channel;
}

async function loadChannelsForDetection() {
  const store = getStore();
  const persistent = await listBackendChannels().catch(() => [] as ChannelRecord[]);

  return mergePersistentChannels(store, persistent);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  return results;
}

function isKnownUpstreamType(value: DetectionType): value is UpstreamProvider {
  return value === 'newapi' || value === 'sub2api' || value === 'cli_proxy';
}

function defaultAuth(type: UpstreamProvider) {
  if (type === 'sub2api') {
    return '用户登录';
  }

  if (type === 'cli_proxy') {
    return '无鉴权';
  }

  return '用户登录';
}

function detectType(probes: ProbeResult[]): { type: DetectionType; reason: string } {
  const newApiScore = probes.reduce((score, probeResult) => score + newApiSignal(probeResult), 0);
  const sub2ApiScore = probes.reduce((score, probeResult) => score + sub2ApiSignal(probeResult), 0);
  const cliProxyScore = probes.reduce((score, probeResult) => score + cliProxySignal(probeResult), 0);

  if (newApiScore >= 2 && newApiScore > sub2ApiScore && newApiScore > cliProxyScore) {
    return { type: 'newapi', reason: '检测到 NewAPI 公开接口特征' };
  }

  if (sub2ApiScore >= 2 && sub2ApiScore > newApiScore && sub2ApiScore > cliProxyScore) {
    return { type: 'sub2api', reason: '检测到 Sub2API v1 接口特征' };
  }

  if (cliProxyScore >= 2 && cliProxyScore > newApiScore && cliProxyScore > sub2ApiScore) {
    return { type: 'cli_proxy', reason: '检测到 CPA 号池的 OpenAI 兼容 /v1/models 接口特征' };
  }

  return {
    type: 'unknown',
    reason: '没有识别到 NewAPI、Sub2API 或 CPA 号池的稳定接口特征，请手动选择'
  };
}

function newApiSignal(probeResult: ProbeResult) {
  const text = probeResult.text.toLowerCase();
  const keys = Object.keys(probeResult.json ?? {}).map((key) => key.toLowerCase());

  if (probeResult.path === '/api/status' && probeResult.status !== 404) {
    if (keys.some((key) => ['quota_per_unit', 'version', 'start_time', 'system_name'].includes(key)) || text.includes('newapi') || text.includes('new-api')) {
      return 3;
    }
    return 1;
  }

  if (probeResult.path === '/api/pricing' && probeResult.status !== 404) {
    return keys.some((key) => key.includes('group_ratio') || key.includes('model')) || text.includes('group_ratio') ? 3 : 1;
  }

  if (probeResult.path === '/api/ratio_config' && probeResult.status !== 404) {
    return keys.some((key) => key.includes('model_ratio') || key.includes('completion_ratio')) || text.includes('model_ratio') ? 3 : 1;
  }

  return 0;
}

function sub2ApiSignal(probeResult: ProbeResult) {
  const text = probeResult.text.toLowerCase();

  if (!probeResult.path.startsWith('/api/v1/')) {
    return 0;
  }

  if (probeResult.status === 404) {
    return 0;
  }

  if (text.includes('sub2api') || text.includes('unauthorized') || text.includes('token') || text.includes('login')) {
    return 3;
  }

  return 1;
}

function cliProxySignal(probeResult: ProbeResult) {
  if (probeResult.path !== '/v1/models' || probeResult.status === 404 || probeResult.status === 0) {
    return 0;
  }

  const text = probeResult.text.toLowerCase();
  const json = probeResult.json ?? {};
  const data = Array.isArray(json.data) ? json.data : [];

  if (
    json.object === 'list' ||
    data.some((item) => recordValue(item)?.object === 'model' || typeof recordValue(item)?.id === 'string') ||
    text.includes('"object":"list"') ||
    text.includes('"object":"model"')
  ) {
    return 4;
  }

  if (
    probeResult.status === 401 ||
    probeResult.status === 403 ||
    text.includes('authorization') ||
    text.includes('bearer') ||
    text.includes('api key') ||
    text.includes('invalid_api_key') ||
    text.includes('missing api key') ||
    text.includes('openai')
  ) {
    return 2;
  }

  return probeResult.status < 500 ? 1 : 0;
}

async function probe(baseUrl: string, path: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json,text/plain,*/*' },
      signal: controller.signal
    });
    const text = await response.text();

    return {
      path,
      status: response.status,
      text: clip(text),
      json: parseJsonObject(text)
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { path, status: 0, text: 'timeout' };
    }

    return { path, status: 0, text: errorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(baseUrl: string) {
  const value = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return value.replace(/\/+$/, '');
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const data = recordValue(parsed)?.data;
    return recordValue(data) ?? recordValue(parsed);
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 800);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
