import { NextResponse } from 'next/server';
import { currentTime, getStore, mergePersistentChannels, type EventRecord } from '../store';
import { getBackendRelay, listBackendChannels, updateBackendRelay } from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const session = await requireAuth(request);
  if (!session.ok) {
    return session.response;
  }

  const store = getStore();

  try {
    const persistent = await listBackendChannels();
    const channelCount = mergePersistentChannels(store, persistent).length;
    store.relays = [await getBackendRelay(channelCount)];
  } catch {
    // API 未启动时保留内存态，避免首页整体不可用。
  }

  return NextResponse.json({ relays: store.relays });
}

export async function PATCH(request: Request) {
  const session = await requireAuth(request);
  if (!session.ok) {
    return session.response;
  }

  const body = (await request.json()) as {
    id?: string;
    name?: string;
    baseUrl?: string;
    auth?: string;
    adminUserId?: string;
    adminToken?: string;
  };
  const store = getStore();
  const persistent = await listBackendChannels().catch(() => []);
  const channelCount = mergePersistentChannels(store, persistent).length;

  try {
    const updatedRelay = await updateBackendRelay(
      {
        name: body.name,
        baseUrl: body.baseUrl,
        auth: body.auth,
        adminUserId: body.adminUserId,
        adminToken: body.adminToken
      },
      channelCount
    );
    delete store.relaySecrets[updatedRelay.id];
    store.relays = [updatedRelay];

    const event: EventRecord = {
      title: `配置主站 ${updatedRelay.name}`,
      detail: `${updatedRelay.baseUrl} / 用户 ${updatedRelay.adminUserId} / ${updatedRelay.auth} ${updatedRelay.tokenConfigured ? '已配置' : '未配置'}`,
      time: currentTime(),
      status: 'success'
    };
    store.events = [event, ...store.events].slice(0, 20);

    return NextResponse.json({ relay: updatedRelay, relays: store.relays, events: store.events });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const parsed = JSON.parse(message) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : message;
  } catch {
    return message;
  }
}
