import { NextResponse } from 'next/server';
import { getStore, normalizeChannel, type ChannelRecord, type EventRecord } from '../../store';
import { refreshChannelMonitoring } from '../../upstream-monitor';

export async function POST() {
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

  store.channels = refreshedChannels;

  store.events = [...generatedEvents, ...store.events].slice(0, 20);

  return NextResponse.json({ upstreams: store.channels, channels: store.channels, events: store.events });
}
