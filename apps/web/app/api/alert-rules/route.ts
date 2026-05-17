import { NextResponse } from 'next/server';
import { listAlertRules, updateAlertRule, type AlertRuleInput } from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    return NextResponse.json({ rules: await listAlertRules() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const body = (await request.json()) as AlertRuleInput;
    return NextResponse.json({ rules: await updateAlertRule(body) });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
