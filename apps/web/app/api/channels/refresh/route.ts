import { NextResponse } from 'next/server';
import { currentTime, getStore, mergePersistentChannels, syncRelayCounts, type EventRecord } from '../../store';
import { createBackendChannel, listBackendChannels, syncBackendChannel } from '../../backend-upstreams';
import { requireAuth } from '../../auth/session';

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { channelId?: string };
  const store = getStore();

  if (!body.channelId) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  try {
    let channelId = body.channelId;
    const existing = store.channels.find((channel) => channel.id === body.channelId);

    if (existing?.upstreamType === 'cli_proxy') {
      return NextResponse.json({ error: 'CPA 号池不支持后台同步' }, { status: 400 });
    }

    if (existing?.source === 'main_station') {
      const channel = await createBackendChannel({
        id: existing.id,
        name: existing.name,
        group: existing.group,
        upstreamType: existing.upstreamType,
        upstreamName: existing.upstreamName,
        upstreamBaseUrl: existing.upstreamBaseUrl,
        upstreamUserId: existing.upstreamUserId,
        keyName: existing.keyName,
        enabled: existing.enabled,
        auth: existing.auth,
        rechargeRatio: existing.rechargeRatio,
        priority: existing.priority,
        weight: existing.weight
      });
      channelId = channel.id;
      store.channels = store.channels.filter((item) => item.id !== existing.id);
    }

    await syncBackendChannel(channelId);
    const channels = await listBackendChannels();
    const event: EventRecord = {
      title: '单个渠道巡检已入队',
      detail: `渠道 ${channelId} 已提交到后台 Worker`,
      time: currentTime(),
      status: 'success'
    };

    mergePersistentChannels(store, channels);
    store.events = [event, ...store.events].slice(0, 20);
    syncRelayCounts(store);

    return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
