import { NextResponse } from 'next/server';
import {
  deleteBackendPasswordVaultEntry,
  listBackendPasswordVaultEntries,
  revealBackendPasswordVaultEntry,
  saveBackendPasswordVaultEntry
} from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id')?.trim();
  const reveal = url.searchParams.get('reveal') === '1';

  try {
    if (id && reveal) {
      return NextResponse.json(await revealBackendPasswordVaultEntry(id));
    }

    return NextResponse.json({ entries: await listBackendPasswordVaultEntries() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await request.json().catch(() => ({}));

  try {
    const entry = await saveBackendPasswordVaultEntry(body);
    return NextResponse.json({ entry, entries: await listBackendPasswordVaultEntries() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await request.json().catch(() => ({}));

  if (!body?.id) {
    return NextResponse.json({ error: 'password vault entry not found' }, { status: 404 });
  }

  try {
    const entry = await saveBackendPasswordVaultEntry(body);
    return NextResponse.json({ entry, entries: await listBackendPasswordVaultEntries() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) {
    return NextResponse.json({ error: 'password vault entry not found' }, { status: 404 });
  }

  try {
    await deleteBackendPasswordVaultEntry(id);
    return NextResponse.json({ deleted: true, id, entries: await listBackendPasswordVaultEntries() });
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
