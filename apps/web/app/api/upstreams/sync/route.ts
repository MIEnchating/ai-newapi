import { NextResponse } from 'next/server';
import { dedupeChannels, getStore, normalizeChannel, type ChannelRecord, type EventRecord } from '../../store';
import { refreshChannelMonitoring } from '../../upstream-monitor';
import { requireAuth } from '../../auth/session';

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const store = getStore();
  const generatedEvents: EventRecord[] = [];
  const refreshedChannels: ChannelRecord[] = [];

  for (const upstream of store.channels) {
    const credential = store.channelSecrets[upstream.id]?.credential;
    const result = await refreshChannelMonitoring(upstream, { credential });
    refreshedChannels.push(normalizeChannel(result.channel, credential));
    if (result.event) {
      generatedEvents.push(result.event);
    }
  }

  store.channels = dedupeChannels(refreshedChannels, store.channelSecrets);

  store.events = [...generatedEvents, ...store.events].slice(0, 20);

  return NextResponse.json({ upstreams: store.channels, channels: store.channels, events: store.events });
}
