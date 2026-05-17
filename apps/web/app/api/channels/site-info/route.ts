import { NextResponse } from 'next/server';
import { requireAuth } from '../../auth/session';

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { upstreamBaseUrl?: string };
  const upstreamBaseUrl = body.upstreamBaseUrl?.trim();

  if (!upstreamBaseUrl) {
    return NextResponse.json({ error: '请输入上游地址' }, { status: 400 });
  }

  const baseUrl = normalizeBaseUrl(upstreamBaseUrl);
  const statusName = await readStatusName(baseUrl).catch(() => null);
  if (statusName) {
    return NextResponse.json({ name: statusName, source: '/api/status' });
  }

  const titleName = await readHomeTitle(baseUrl).catch(() => null);
  if (titleName) {
    return NextResponse.json({ name: titleName, source: '/' });
  }

  return NextResponse.json({ name: fallbackNameFromUrl(baseUrl), source: 'host' });
}

async function readStatusName(baseUrl: string) {
  const payload = await requestText(`${baseUrl}/api/status`, 'application/json,text/plain,*/*');
  const record = parseJsonObject(payload);
  const data = recordValue(record?.data) ?? record;
  const name =
    stringValue(data?.system_name) ??
    stringValue(data?.systemName) ??
    stringValue(data?.site_name) ??
    stringValue(data?.siteName) ??
    stringValue(data?.name) ??
    stringValue(data?.title);

  return normalizeSiteName(name);
}

async function readHomeTitle(baseUrl: string) {
  const html = await requestText(baseUrl, 'text/html,*/*');
  const ogSiteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];

  return normalizeSiteName(decodeHtml(ogSiteName ?? ogTitle ?? title));
}

async function requestText(url: string, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      headers: { accept },
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(baseUrl: string) {
  const value = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return value.replace(/\/+$/, '');
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return recordValue(parsed);
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSiteName(value: string | undefined) {
  if (!value) {
    return null;
  }

  const normalized = decodeHtml(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-_|].*$/u, '')
    .replace(/(?:\s*(New\s*API|NewAPI|API|AI|中转站|中转|控制台|管理系统|官网|首页|登录))+$/giu, '')
    .trim();

  return normalized || value.trim();
}

function fallbackNameFromUrl(baseUrl: string) {
  try {
    const hostname = new URL(baseUrl).hostname.replace(/^www\./i, '');
    const first = hostname.split('.')[0] || hostname;
    return first.replace(/ai$/i, '') || first;
  } catch {
    return baseUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function decodeHtml(value: string | undefined) {
  return (value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
