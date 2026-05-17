import { NextResponse } from 'next/server';
import { authStatus } from '../session';

export async function GET(request: Request) {
  return NextResponse.json(await authStatus(request));
}
