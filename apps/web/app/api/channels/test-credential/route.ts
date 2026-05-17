import { NextResponse } from 'next/server';
import { testBackendChannelCredential, testBackendDraftCredential } from '../../backend-upstreams';
import { requireAuth } from '../../auth/session';

type TestCredentialPayload = {
  id?: string;
  name?: string;
  group?: string;
  upstreamType?: 'newapi' | 'sub2api' | 'cli_proxy';
  upstreamName?: string;
  upstreamBaseUrl?: string;
  upstreamUserId?: string;
  keyName?: string;
  auth?: string;
  credential?: string;
  credentialAccount?: string;
  credentialPassword?: string;
  rechargeRatio?: number;
  priority?: number;
  weight?: number;
};

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as TestCredentialPayload;

  if (body.upstreamType === 'cli_proxy') {
    return NextResponse.json({ error: 'CPA 号池不需要测试上游凭证' }, { status: 400 });
  }

  if (body.upstreamType === 'sub2api' && body.auth !== '用户登录' && body.auth !== '用户 Token') {
    return NextResponse.json({ error: 'Sub2API 只支持用户登录或用户 Token' }, { status: 400 });
  }

  try {
    const result = body.id ? await testBackendChannelCredential(body.id, body) : await testBackendDraftCredential(body);
    return NextResponse.json(result);
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
