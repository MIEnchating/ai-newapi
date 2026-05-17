import { NextResponse } from 'next/server';
import {
  currentTime,
  getStore,
  mergePersistentChannels,
  syncRelayCounts,
  type EventRecord
} from '../../store';
import {
  getBackendRelay,
  listBackendChannels,
  runInspectionNow,
  syncMainStationChannels
} from '../../backend-upstreams';
import { requireAuth } from '../../auth/session';

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await request.json().catch(() => ({} as { relayId?: string }));
  const store = getStore();
  const relayId = body.relayId ?? store.relays[0]?.id ?? 'relay-newapi-main';
  const relay = store.relays.find((item) => item.id === relayId) ?? store.relays[0];
  const generatedEvents: EventRecord[] = [];

  if (!relay) {
    return NextResponse.json({ error: 'relay not found' }, { status: 404 });
  }

  let syncResult: Awaited<ReturnType<typeof syncMainStationChannels>>;
  try {
    syncResult = await syncMainStationChannels();
  } catch (error) {
    const detail = errorMessage(error);
    const notConfigured = /not configured|admin token|required|未配置|待配置/i.test(detail);
    const eventStatus: EventRecord['status'] = notConfigured ? 'warning' : 'error';
    store.relays = store.relays.map((item) =>
      item.id === relay.id
        ? {
            ...item,
            status: notConfigured ? '待配置' : '同步失败',
            statusTone: notConfigured ? 'limited' : 'error',
            sync: '刚刚'
          }
        : item
    );
    store.events = [
      {
        title: `${relay.name} 渠道同步失败`,
        detail,
        time: currentTime(),
        status: eventStatus
      },
      ...store.events
    ].slice(0, 20);

    return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events });
  }

  const persistent = await listBackendChannels().catch((error) => {
    generatedEvents.push({
      title: '主站渠道读取失败',
      detail: errorMessage(error),
      time: currentTime(),
      status: 'warning'
    });
    return [];
  });
  mergePersistentChannels(store, persistent);

  const updatedRelay = await getBackendRelay(store.channels.length).catch(() => ({
    ...relay,
    status: '正常',
    statusTone: 'ok' as const,
    channelCount: store.channels.length,
    sync: '刚刚'
  }));
  store.relays = [updatedRelay];
  generatedEvents.push({
    title: `${updatedRelay.name} 渠道同步完成`,
    detail:
      syncResult.importedCount > 0
        ? `从 NewAPI 主站读取到 ${syncResult.importedCount} 个渠道`
        : 'NewAPI 主站没有返回渠道',
    time: currentTime(),
    status: 'success'
  });

  const inspection = await runInspectionNow().catch((error) => {
    generatedEvents.push({
      title: '自动巡检提交失败',
      detail: errorMessage(error),
      time: currentTime(),
      status: 'warning'
    });
    return undefined;
  });

  if (inspection) {
    generatedEvents.push({
      title: '自动巡检已入队',
      detail: inspection.lastResult ?? '已提交到后台 Worker',
      time: currentTime(),
      status: 'success'
    });
  }

  store.events = [...generatedEvents, ...store.events].slice(0, 20);
  syncRelayCounts(store);

  return NextResponse.json({ relays: store.relays, channels: store.channels, events: store.events, inspection });
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
