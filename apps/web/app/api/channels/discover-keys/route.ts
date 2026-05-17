import { NextResponse } from 'next/server';
import { requireAuth } from '../../auth/session';

type JsonRecord = Record<string, unknown>;

type DiscoverPayload = {
  upstreamType?: string;
  upstreamBaseUrl?: string;
  upstreamUserId?: string;
  auth?: string;
  credential?: string;
  credentialAccount?: string;
  credentialPassword?: string;
};

type KeyOption = {
  keyName: string;
  group: string;
  label: string;
};

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as DiscoverPayload;

  try {
    if (!body.upstreamBaseUrl?.trim()) {
      return NextResponse.json({ error: '请输入上游地址' }, { status: 400 });
    }
    if (body.auth === 'API Key' || body.auth === '无鉴权') {
      return NextResponse.json({ error: '当前认证方式不能读取 Key 列表' }, { status: 400 });
    }

    const baseUrl = normalizeBaseUrl(body.upstreamBaseUrl);
    const options =
      body.upstreamType === 'sub2api'
        ? await discoverSub2ApiKeys(baseUrl, body)
        : await discoverNewApiKeys(baseUrl, body);

    return NextResponse.json({ options: uniqueOptions(options).slice(0, 20) });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}

async function discoverNewApiKeys(baseUrl: string, body: DiscoverPayload): Promise<KeyOption[]> {
  const token = body.credential?.trim();
  const userId = body.upstreamUserId?.trim();

  if (!token) {
    throw new Error('请输入上游认证信息');
  }
  if (!userId) {
    throw new Error('请输入上游用户 ID');
  }

  const payload = await fetchJson(baseUrl, '/api/token/?p=1&page_size=1000', {
    headers: {
      authorization: `Bearer ${stripBearer(token)}`,
      'New-Api-User': userId
    }
  });
  const tokens = arrayOfRecords(unwrapList(payload));

  return tokens.map((tokenRecord, index) => {
    const keyName =
      stringValue(tokenRecord.name) ??
      stringValue(tokenRecord.key_name) ??
      keySuffix(stringValue(tokenRecord.key) ?? stringValue(tokenRecord.token)) ??
      `Key ${index + 1}`;
    const group =
      stringValue(tokenRecord.group) ??
      stringValue(tokenRecord.group_name) ??
      firstString(tokenRecord.groups) ??
      'default';

    return {
      keyName,
      group,
      label: `${keyName} / ${group}`
    };
  });
}

async function discoverSub2ApiKeys(baseUrl: string, body: DiscoverPayload): Promise<KeyOption[]> {
  const token = await sub2ApiToken(baseUrl, body);
  const [keysPayload, groupsPayload] = await Promise.all([
    fetchJson(baseUrl, '/api/v1/keys?page=1&page_size=1000', {
      headers: { authorization: `Bearer ${stripBearer(token)}` }
    }),
    fetchJson(baseUrl, '/api/v1/groups/available', {
      headers: { authorization: `Bearer ${stripBearer(token)}` }
    }).catch(() => null)
  ]);
  const keys = arrayOfRecords(unwrapList(keysPayload));
  const groups = arrayOfRecords(unwrapData(groupsPayload));

  return keys.map((key, index) => {
    const keyName =
      stringValue(key.name) ??
      stringValue(key.key_name) ??
      keySuffix(stringValue(key.key) ?? stringValue(key.token)) ??
      `Key ${index + 1}`;
    const groupRecord = recordValue(key.group);
    const groupId = stringValue(key.group_id ?? key.groupId ?? groupRecord?.id);
    const matchedGroup = groups.find((group) => groupId && stringValue(group.id) === groupId);
    const group =
      stringValue(key.group_name ?? key.groupName) ??
      stringValue(groupRecord?.name) ??
      stringValue(matchedGroup?.name) ??
      groupId ??
      'default';

    return {
      keyName,
      group,
      label: `${keyName} / ${group}`
    };
  });
}

async function sub2ApiToken(baseUrl: string, body: DiscoverPayload) {
  if (body.auth === '用户登录') {
    const account = body.credentialAccount?.trim();
    const password = body.credentialPassword?.trim();

    if (!account || !password) {
      throw new Error('请输入账号或邮箱和密码');
    }

    const payload = await fetchJson(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: account, username: account, password })
    });
    const data = recordValue(unwrapData(payload));
    const token = stringValue(data?.token) ?? stringValue(data?.access_token) ?? stringValue(data?.jwt);

    if (!token) {
      throw new Error('Sub2API 登录成功但没有返回 token');
    }

    return token;
  }

  const token = body.credential?.trim();
  if (!token) {
    throw new Error('请输入上游认证信息');
  }

  return token;
}

async function fetchJson(baseUrl: string, path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {})
      },
      signal: controller.signal
    });
    const text = await response.text();

    if (isChallenge(text)) {
      throw new Error('上游返回 Cloudflare/验证码页面');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${clip(text)}`);
    }

    const payload = JSON.parse(text) as unknown;
    const record = recordValue(payload);
    const code = numeric(record?.code);

    if (record?.success === false) {
      throw new Error(stringValue(record.message) ?? '上游接口返回失败');
    }
    if (code !== undefined && code !== 0) {
      throw new Error(stringValue(record?.message) ?? stringValue(record?.reason) ?? `上游接口返回 code ${code}`);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function uniqueOptions(options: KeyOption[]) {
  const seen = new Set<string>();
  const result: KeyOption[] = [];

  for (const option of options) {
    const key = `${option.keyName}\n${option.group}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(option);
    }
  }

  return result;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function stripBearer(value: string) {
  return value.replace(/^Bearer\s+/i, '').trim();
}

function unwrapData(payload: unknown): unknown {
  const record = recordValue(payload);
  return record && 'data' in record ? record.data : payload;
}

function unwrapList(payload: unknown): unknown {
  const data = unwrapData(payload);
  const record = recordValue(data);
  return record?.items ?? record?.data ?? data;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object') : [];
}

function stringValue(value: unknown) {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string' && item.trim() !== '')?.trim();
  }

  return stringValue(value);
}

function keySuffix(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return value.length > 8 ? `...${value.slice(-8)}` : value;
}

function numeric(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function isChallenge(text: string) {
  return /cloudflare|turnstile|captcha|challenge/i.test(text);
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
