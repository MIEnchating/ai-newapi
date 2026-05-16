import { NextResponse } from 'next/server';
import { currentTime, getStore, type EventRecord, type RelayRecord, type StatusTone } from '../store';

export async function GET() {
  return NextResponse.json({ relays: getStore().relays });
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    name?: string;
    baseUrl?: string;
    auth?: string;
    adminUserId?: string;
    adminToken?: string;
  };
  const store = getStore();
  const relayId = body.id ?? store.relays[0]?.id;

  if (!relayId) {
    return NextResponse.json({ error: 'relay id is required' }, { status: 400 });
  }

  const existingRelay = store.relays.find((relay) => relay.id === relayId);
  if (!existingRelay) {
    return NextResponse.json({ error: 'relay not found' }, { status: 404 });
  }

  const name = body.name?.trim();
  const baseUrl = body.baseUrl?.trim();
  const auth = body.auth?.trim();
  const adminUserId = body.adminUserId?.trim();
  const adminToken = body.adminToken?.trim();

  if (!name || !baseUrl || !auth || !adminUserId) {
    return NextResponse.json({ error: 'name, baseUrl, auth and adminUserId are required' }, { status: 400 });
  }

  if (!adminToken && !existingRelay.tokenConfigured) {
    return NextResponse.json({ error: 'admin token is required' }, { status: 400 });
  }

  let updatedRelay: RelayRecord | undefined;
  if (adminToken) {
    store.relaySecrets[relayId] = { adminToken };
  }
  const tokenConfigured = Boolean(adminToken || existingRelay.tokenConfigured);
  const configured = baseUrl !== '待配置' && tokenConfigured && Boolean(adminUserId);
  const statusTone: StatusTone = configured ? 'ok' : 'limited';

  store.relays = store.relays.map((relay) => {
    if (relay.id !== relayId) {
      return relay;
    }

    updatedRelay = {
      ...relay,
      name,
      baseUrl,
      auth,
      adminUserId,
      tokenConfigured,
      status: configured ? '已配置' : '待配置',
      statusTone,
      sync: configured ? '等待同步' : '尚未同步'
    };

    return updatedRelay as RelayRecord;
  });

  if (!updatedRelay) {
    return NextResponse.json({ error: 'relay not found' }, { status: 404 });
  }

  const event: EventRecord = {
    title: `配置中转站 ${updatedRelay.name}`,
    detail: `${updatedRelay.baseUrl} / 用户 ${updatedRelay.adminUserId} / ${updatedRelay.auth} ${updatedRelay.tokenConfigured ? '已配置' : '未配置'}`,
    time: currentTime(),
    status: 'success'
  };
  store.events = [event, ...store.events].slice(0, 20);

  return NextResponse.json({ relay: updatedRelay, relays: store.relays, events: store.events });
}
