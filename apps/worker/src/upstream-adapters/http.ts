export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
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

  return JSON.parse(text) as T;
}

export function unwrapData<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}
