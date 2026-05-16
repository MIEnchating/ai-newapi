import { NextResponse } from 'next/server';
import { getStore } from '../store';

export async function GET() {
  return NextResponse.json({ events: getStore().events });
}

export async function DELETE(request: Request) {
  const testOnly = new URL(request.url).searchParams.get('testOnly') === '1';
  const store = getStore();

  if (testOnly) {
    store.events = store.events.filter(
      (event) => !/自动检查|测试渠道/.test(`${event.title} ${event.detail}`)
    );
  } else {
    store.events = [];
  }

  return NextResponse.json({ events: store.events });
}
