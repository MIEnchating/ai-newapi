import { NextResponse } from 'next/server';
import {
  currentTime,
  getStore,
  isUpstreamProvider,
  mergePersistentChannels,
  providerLabel,
  type EventRecord,
  type UpstreamProvider
} from '../store';
import { createBackendChannel, listBackendChannels } from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const store = getStore();
  const channels = await listBackendChannels();
  mergePersistentChannels(store, channels);

  return NextResponse.json({ upstreams: store.channels });
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json()) as {
    name?: string;
    baseUrl?: string;
    type?: UpstreamProvider;
    auth?: string;
    credential?: string;
    priority?: number;
    weight?: number;
  };

  if (!body.name || !body.baseUrl || !body.type || !body.auth) {
    return NextResponse.json({ error: 'name, baseUrl, type and auth are required' }, { status: 400 });
  }

  if (!isUpstreamProvider(body.type)) {
    return NextResponse.json({ error: 'only newapi, sub2api and cli_proxy are supported' }, { status: 400 });
  }

  try {
    const upstream = await createBackendChannel({
      name: body.name,
      group: 'default',
      upstreamType: body.type,
      upstreamName: body.name,
      upstreamBaseUrl: body.baseUrl,
      auth: body.auth,
      credential: body.credential,
      rechargeRatio: 1,
      priority: body.priority,
      weight: body.weight
    });
    const store = getStore();
    const event: EventRecord = {
      title: `新增渠道上游 ${body.name}`,
      detail: `${providerLabel(body.type)} / ${body.auth} / 余额和倍率只读同步`,
      time: currentTime(),
      status: 'success'
    };
    store.events = [event, ...store.events].slice(0, 20);
    mergePersistentChannels(store, await listBackendChannels());

    return NextResponse.json({ upstream });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
