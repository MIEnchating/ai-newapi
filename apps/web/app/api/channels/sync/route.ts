import { NextResponse } from 'next/server';
import {
  currentTime,
  getStore,
  normalizeChannel,
  syncRelayCounts,
  type ChannelRecord,
  type EventRecord,
  type UpstreamProvider
} from '../../store';
import { refreshChannelMonitoring } from '../../upstream-monitor';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as { relayId?: string }));
  const store = getStore();
  const relayId = body.relayId ?? store.relays[0]?.id;
  const generatedEvents: EventRecord[] = [];
  const relay = store.relays.find((item) => item.id === relayId);

  if (!relay) {
    return NextResponse.json({ error: 'relay not found' }, { status: 404 });
  }

  const token = store.relaySecrets[relay.id]?.adminToken;

  if (relay.baseUrl === '待配置' || !token || !relay.adminUserId) {
    const event: EventRecord = {
      title: `${relay.name} 未完成主站配置`,
      detail: '请先配置 NewAPI 地址、管理员用户 ID 和管理 Token，再同步渠道',
      time: currentTime(),
      status: 'warning'
    };
    store.relays = store.relays.map((item) =>
      item.id === relay.id ? { ...item, status: '待配置', statusTone: 'limited', sync: '刚刚' } : item
    );
    store.events = [event, ...store.events].slice(0, 20);

    return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events });
  }

  const imported = await fetchNewApiChannels(relay.id, relay.baseUrl, relay.adminUserId, token);
  if (imported.ok) {
    store.channels = mergeImportedChannels(store.channels, relay.id, imported.channels);
    store.relays = store.relays.map((item) =>
      item.id === relay.id
        ? {
            ...item,
            status: '正常',
            statusTone: 'ok',
            sync: '刚刚'
          }
        : item
    );
    generatedEvents.push({
      title: `${relay.name} 渠道同步完成`,
      detail: imported.channels.length > 0 ? `从 NewAPI 主站读取到 ${imported.channels.length} 个渠道` : 'NewAPI 主站没有返回渠道',
      time: currentTime(),
      status: 'success'
    });
  } else {
    store.relays = store.relays.map((item) =>
      item.id === relay.id
        ? {
            ...item,
            status: '同步失败',
            statusTone: imported.challenge ? 'limited' : 'error',
            sync: '刚刚'
          }
        : item
    );
    store.events = [
      {
        title: `${relay.name} 渠道同步失败`,
        detail: imported.message,
        time: currentTime(),
        status: imported.challenge ? ('warning' as const) : ('error' as const)
      },
      ...store.events
    ].slice(0, 20);

    return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events });
  }

  const refreshedChannels: ChannelRecord[] = [];
  for (const channel of store.channels) {
    if (relayId && channel.relayId !== relayId) {
      refreshedChannels.push(channel);
      continue;
    }

    const credential = store.channelSecrets[channel.id]?.credential;
    const result = await refreshChannelMonitoring(channel, { credential });
    refreshedChannels.push(normalizeChannel(result.channel, credential));
    if (result.event) {
      generatedEvents.push(result.event);
    }
  }
  store.channels = refreshedChannels;

  store.relays = store.relays.map((relay) =>
    !relayId || relay.id === relayId
      ? {
          ...relay,
          status: '正常',
          statusTone: 'ok',
          sync: '刚刚'
        }
      : relay
  );
  store.events = [...generatedEvents, ...store.events].slice(0, 20);
  syncRelayCounts(store);

  return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events });
}

function mergeImportedChannels(allChannels: ChannelRecord[], relayId: string, importedChannels: ChannelRecord[]) {
  const importedIds = new Set(importedChannels.map((channel) => channel.id));
  const existingById = new Map(
    allChannels.filter((channel) => channel.relayId === relayId).map((channel) => [channel.id, channel])
  );
  const otherRelays = allChannels.filter((channel) => channel.relayId !== relayId);
  const localOnly = allChannels.filter(
    (channel) => channel.relayId === relayId && !importedIds.has(channel.id) && channel.source !== 'main_station'
  );
  const mergedImported = importedChannels.map((imported) => {
    const existing = existingById.get(imported.id);

    if (!existing) {
      return normalizeChannel(imported);
    }

    const upstreamType = existing.upstreamType;
    const auth = existing.auth;
    const mainStationDisabled = imported.status === '已禁用';

    return normalizeChannel({
      ...imported,
      upstreamType,
      source: imported.source,
      sourceChannelId: imported.sourceChannelId,
      upstreamName: existing.upstreamName,
      upstreamBaseUrl: existing.upstreamBaseUrl,
      upstreamUserId: existing.upstreamUserId,
      keyName: existing.keyName,
      auth,
      credentialConfigured: existing.credentialConfigured,
      rechargeRatio: existing.rechargeRatio ?? imported.rechargeRatio ?? 1,
      balance: balanceForConfig(upstreamType, auth),
      currentRate: upstreamType === 'cli_proxy' ? null : existing.currentRate,
      previousRate: upstreamType === 'cli_proxy' ? null : existing.previousRate,
      groupRatio: upstreamType === 'cli_proxy' ? null : existing.groupRatio,
      rateSource: upstreamType === 'cli_proxy' ? '不适用' : existing.rateSource ?? imported.rateSource,
      cf: upstreamType === 'cli_proxy' ? '不适用' : existing.cf ?? imported.cf,
      status: mainStationDisabled ? '已禁用' : existing.status,
      statusTone: mainStationDisabled ? 'limited' : existing.statusTone,
      weight: imported.weight
    });
  });

  return [...otherRelays, ...mergedImported, ...localOnly.map((channel) => normalizeChannel(channel))];
}

async function fetchNewApiChannels(relayId: string, baseUrl: string, adminUserId: string, token: string) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/channel/?p=0&page_size=1000`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'new-api-user': adminUserId
      },
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false as const,
        challenge: isChallenge(text),
        message: `NewAPI 返回 HTTP ${response.status}: ${clip(text)}`
      };
    }

    if (isChallenge(text)) {
      return {
        ok: false as const,
        challenge: true,
        message: 'NewAPI 主站返回 Cloudflare/验证码页面，无法通过服务器同步'
      };
    }

    const payload = JSON.parse(text) as unknown;
    const records = extractChannelRecords(payload);
    const channels = records.map((record, index) => toChannelRecord(relayId, record, index));

    return { ok: true as const, channels };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '请求超时' : errorMessage(error);
    return {
      ok: false as const,
      challenge: /cloudflare|challenge|captcha|turnstile/i.test(message),
      message: `请求 NewAPI 渠道接口失败：${message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toChannelRecord(relayId: string, record: Record<string, unknown>, index: number): ChannelRecord {
  const rawId = stringValue(record.id) ?? String(index + 1);
  const name = stringValue(record.name) ?? `渠道 ${rawId}`;
  const baseUrl = stringValue(record.base_url) ?? stringValue(record.baseUrl) ?? '-';
  const status = numeric(record.status);
  const upstreamType = inferUpstreamType(name, baseUrl);
  const models = parseModels(record.models);
  const auth = defaultAuth(upstreamType);

  return {
    id: `channel-newapi-${rawId}`,
    relayId,
    source: 'main_station',
    sourceChannelId: rawId,
    name,
    group: stringValue(record.group) ?? firstGroup(record.groups) ?? 'default',
    upstreamType,
    upstreamName: name,
    upstreamBaseUrl: baseUrl,
    upstreamUserId: '',
    keyName: '',
    auth,
    credentialConfigured: false,
    status: status === 1 || status === undefined ? '正常' : '已禁用',
    statusTone: status === 1 || status === undefined ? 'ok' : 'limited',
    balance: balanceForConfig(upstreamType, auth),
    models: models.length,
    groupRatio: null,
    rateSource: '待同步',
    rechargeRatio: 1,
    currentRate: null,
    previousRate: null,
    cf: '待检测',
    priority: numeric(record.priority) ?? index + 1,
    weight: numeric(record.weight) ?? 0,
    sync: '刚刚'
  };
}

function extractChannelRecords(payload: unknown): Array<Record<string, unknown>> {
  const data = unwrapData(payload);
  const candidates = [
    data,
    recordValue(data)?.items,
    recordValue(data)?.channels,
    recordValue(data)?.data,
    recordValue(recordValue(data)?.data)?.items
  ];

  for (const candidate of candidates) {
    const records = arrayOfRecords(candidate);
    if (records.length > 0) {
      return records;
    }
  }

  return [];
}

function parseModels(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function firstGroup(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string' && item.trim() !== '');
  }

  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).find(Boolean) : undefined;
}

function inferUpstreamType(name: string, baseUrl: string): UpstreamProvider {
  const value = `${name} ${baseUrl}`;
  if (/cli[\s_-]*proxy/i.test(value)) {
    return 'cli_proxy';
  }

  return /sub2api/i.test(value) ? 'sub2api' : 'newapi';
}

function defaultAuth(type: UpstreamProvider) {
  if (type === 'sub2api') {
    return '用户 Token';
  }

  if (type === 'cli_proxy') {
    return 'API Key';
  }

  return '用户 Access Token';
}

function balanceForConfig(type: UpstreamProvider, auth: string) {
  if (type === 'cli_proxy') {
    return '-';
  }

  return auth === 'API Key' ? '不可见' : '待同步';
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: unknown }).data;
  }

  return payload;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value : undefined;
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
