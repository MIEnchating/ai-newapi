import { NextResponse } from 'next/server';
import { getInspectionStatus, runInspectionNow, updateInspectionStatus } from '../backend-upstreams';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    return NextResponse.json({ inspection: await getInspectionStatus() });
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
    const body = (await request.json().catch(() => ({}))) as {
      enabled?: boolean;
      intervalMs?: number;
      latencyTestEnabled?: boolean;
      latencyIntervalMs?: number;
      latencyTimeoutMs?: number;
      latencyDisableThresholdMs?: number;
      latencyFailureLimit?: number;
      disabledRetestMs?: number;
      cpaPreferred?: boolean;
      inspectionConcurrency?: number;
      balanceLowAction?: 'NONE' | 'LOWER' | 'DISABLE';
      rateIncreaseAction?: 'NONE' | 'LOWER' | 'DISABLE';
      ruleActionPriority?: number;
      ruleActionWeight?: number;
    };
    return NextResponse.json({ inspection: await updateInspectionStatus(body) });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    return NextResponse.json({ inspection: await runInspectionNow() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
