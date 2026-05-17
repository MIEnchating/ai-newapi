import { NextResponse } from 'next/server';
import { attachSessionCookie, loginAuth } from '../session';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
  const result = await loginAuth(body);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const response = NextResponse.json({ authenticated: true, username: result.username });
  attachSessionCookie(response, result.token);

  return response;
}
