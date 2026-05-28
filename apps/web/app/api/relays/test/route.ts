import { NextResponse } from 'next/server';
import { testBackendRelay } from '../../backend-upstreams';
import { requireAuth } from '../../auth/session';

type RelayTestPayload = {
  name?: string;
  baseUrl?: string;
  auth?: string;
  adminUserId?: string;
  adminToken?: string;
  adminAccount?: string;
  adminPassword?: string;
};

export async function POST(request: Request) {
  const session = await requireAuth(request);
  if (!session.ok) {
    return session.response;
  }

  const body = (await request.json().catch(() => ({}))) as RelayTestPayload;

  try {
    return NextResponse.json(await testBackendRelay(body));
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
