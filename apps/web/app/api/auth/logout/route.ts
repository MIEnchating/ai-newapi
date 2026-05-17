import { NextResponse } from 'next/server';
import { clearSessionCookie, logoutAuth } from '../session';

export async function POST(request: Request) {
  await logoutAuth(request);
  const response = NextResponse.json({ authenticated: false });
  clearSessionCookie(response);

  return response;
}
