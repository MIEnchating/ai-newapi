import { NextResponse } from 'next/server';
import { createBackendMainStationGroup, listBackendMainStationGroups } from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    return NextResponse.json(await listBackendMainStationGroups());
  } catch (error) {
    return NextResponse.json({ groups: [], error: errorMessage(error) }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { name?: string; ratio?: number };
  const name = body.name?.trim();

  if (!name) {
    return NextResponse.json({ error: '请输入主站分组名称' }, { status: 400 });
  }

  try {
    return NextResponse.json(await createBackendMainStationGroup({ name, ratio: body.ratio }));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const parsed = JSON.parse(message) as { message?: unknown; error?: unknown };
    return typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error === 'string'
        ? parsed.error
        : message;
  } catch {
    return message;
  }
}
