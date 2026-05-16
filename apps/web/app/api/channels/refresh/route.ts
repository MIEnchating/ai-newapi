import { NextResponse } from 'next/server';
import { getStore, normalizeChannel, syncRelayCounts } from '../../store';
import { refreshChannelMonitoring } from '../../upstream-monitor';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { channelId?: string };
  const store = getStore();
  const channel = store.channels.find((item) => item.id === body.channelId);

  if (!channel) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }

  const credential = store.channelSecrets[channel.id]?.credential;
  const result = await refreshChannelMonitoring(channel, { credential });
  const normalized = normalizeChannel(result.channel, credential);

  store.channels = store.channels.map((item) => (item.id === channel.id ? normalized : item));
  if (result.event) {
    store.events = [result.event, ...store.events].slice(0, 20);
  }
  syncRelayCounts(store);

  return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events, channel: normalized });
}
