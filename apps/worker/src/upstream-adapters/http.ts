export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  return (await requestJsonResponse<T>(baseUrl, path, options)).payload;
}

export async function requestJsonResponse<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<{ payload: T; headers: Headers }> {
  const url = `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');

  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  if (options.token) {
    headers.set('authorization', `Bearer ${options.token}`);
  }

  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (!response.ok) {
    if (/cloudflare|turnstile|captcha|challenge/i.test(text)) {
      throw new Error(`Cloudflare challenge required for ${url}`);
    }

    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  }

  if (!contentType.includes('application/json')) {
    if (/cloudflare|turnstile|captcha|challenge/i.test(text)) {
      throw new Error(`Cloudflare challenge required for ${url}`);
    }
  }

  const payload = JSON.parse(text) as unknown;
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  const code = numeric(record?.code);

  if (record?.success === false) {
    throw new Error(stringValue(record.message) ?? 'upstream request failed');
  }
  if (code !== undefined && code !== 0) {
    throw new Error(stringValue(record?.message) ?? stringValue(record?.reason) ?? `upstream returned code ${code}`);
  }

  return { payload: payload as T, headers: response.headers };
}

export function unwrapData<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
