import { NextResponse } from 'next/server';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const cookieName = 'relaydesk_session';
const sessionTtlSeconds = 7 * 24 * 60 * 60;

export type AuthStatus = {
  setupRequired: boolean;
  authenticated: boolean;
  username?: string;
};

type AuthResponse = {
  authenticated: boolean;
  username?: string;
  token?: string;
  error?: string;
  message?: string;
};

export async function authStatus(request: Request): Promise<AuthStatus> {
  return backendAuthJson<AuthStatus>('/auth/status', {
    token: readCookie(request, cookieName)
  });
}

export async function setupAuth(input: { username?: string; password?: string }) {
  return mutateAuth('/auth/setup', input);
}

export async function loginAuth(input: { username?: string; password?: string }) {
  return mutateAuth('/auth/login', input);
}

export async function logoutAuth(request: Request) {
  const token = readCookie(request, cookieName);
  if (!token) {
    return;
  }

  await backendAuthJson('/auth/logout', {
    method: 'POST',
    token
  }).catch(() => undefined);
}

export async function requireAuth(request: Request) {
  const status = await authStatus(request).catch(
    (): AuthStatus => ({ setupRequired: false, authenticated: false })
  );

  if (!status.setupRequired && status.authenticated) {
    return { ok: true as const, username: status.username };
  }

  return {
    ok: false as const,
    response: NextResponse.json(
      { error: status.setupRequired ? 'auth setup required' : 'unauthorized' },
      { status: 401 }
    )
  };
}

export function attachSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: sessionTtlSeconds
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(cookieName, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0
  });
}

async function mutateAuth(path: string, input: { username?: string; password?: string }) {
  try {
    const payload = await backendAuthJson<AuthResponse>(path, {
      method: 'POST',
      body: input
    });

    if (!payload.token) {
      return { ok: false as const, status: 502, error: '登录服务没有返回会话' };
    }

    return { ok: true as const, username: payload.username ?? input.username ?? 'admin', token: payload.token };
  } catch (error) {
    return {
      ok: false as const,
      status: error instanceof BackendAuthError ? error.status : 502,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function backendAuthJson<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {}
): Promise<T> {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  if (options.body) {
    headers.set('content-type', 'application/json');
  }
  if (options.token) {
    headers.set('authorization', `Bearer ${options.token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store'
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { message?: string; error?: string }) : {};

  if (!response.ok) {
    throw new BackendAuthError(response.status, payload.message ?? payload.error ?? text);
  }

  return payload as T;
}

class BackendAuthError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get('cookie') ?? '';
  const target = `${name}=`;
  const value = cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(target))
    ?.slice(target.length);

  return value ? decodeURIComponent(value) : undefined;
}
