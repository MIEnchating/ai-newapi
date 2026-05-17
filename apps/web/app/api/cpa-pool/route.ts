import { NextResponse } from 'next/server';
import { getStore, type CpaUsageRecord } from '../store';
import { requireAuth } from '../auth/session';

const usageRetentionMs = 7 * 24 * 60 * 60_000;

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const store = getStore();
  const url = new URL(request.url);
  const requestedChannelId = url.searchParams.get('channelId')?.trim();
  const cpaChannels = store.channels.filter((channel) => channel.upstreamType === 'cli_proxy');
  const channel = requestedChannelId
    ? cpaChannels.find((item) => item.id === requestedChannelId)
    : cpaChannels.find((item) => store.channelSecrets[item.id]?.credential) ?? cpaChannels[0];
  const channelOptions = cpaChannels.map((item) => ({
    id: item.id,
    name: item.name,
    credentialConfigured: Boolean(store.channelSecrets[item.id]?.credential)
  }));

  if (!channel) {
    return NextResponse.json({ error: '还没有 CPA 号池渠道，请先新增 CPA 类型渠道', channels: [] }, { status: 400 });
  }

  const managementKey = store.channelSecrets[channel.id]?.credential?.trim();
  if (!managementKey) {
    return NextResponse.json({
      error: 'CPA 号池缺少管理密钥，请在渠道配置里填写 CPA 管理密钥',
      channel: channelSummary(channel),
      channels: channelOptions,
      accounts: []
    }, { status: 400 });
  }

  const baseUrl = normalizeBaseUrl(channel.upstreamBaseUrl);
  const [authFilesResult, usageResult] = await Promise.allSettled([
    cpaJson<unknown>(baseUrl, '/v0/management/auth-files', managementKey),
    cpaJson<unknown>(baseUrl, '/v0/management/usage-queue?count=500', managementKey)
  ]);

  if (authFilesResult.status === 'rejected') {
    return NextResponse.json({ error: errorMessage(authFilesResult.reason) }, { status: 502 });
  }

  const now = new Date();
  const usageRecords = parseUsageRecords(unwrapData(usageResult.status === 'fulfilled' ? usageResult.value : undefined));
  const cutoff = now.getTime() - usageRetentionMs;
  store.cpaUsageRecords = [...store.cpaUsageRecords, ...usageRecords]
    .filter((record) => Date.parse(record.timestamp) >= cutoff)
    .slice(-20_000);

  const accounts = parseAuthFiles(unwrapData(authFilesResult.value)).map((account, index) => {
    const usage = aggregateUsage(store.cpaUsageRecords, account, index);

    return {
      ...account,
      successCount: account.successCount || usage.successCount,
      failureCount: account.failureCount || usage.failureCount
    };
  });

  return NextResponse.json({
    channel: channelSummary(channel),
    channels: channelOptions,
    accounts,
    usageQueueError: usageResult.status === 'rejected' ? errorMessage(usageResult.reason) : null,
    refreshedAt: now.toISOString()
  });
}

async function cpaJson<T>(baseUrl: string, path: string, managementKey: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${stripBearer(managementKey)}`,
        'x-management-key': stripBearer(managementKey)
      },
      signal: controller.signal
    });
    const text = await response.text();

    if (/cloudflare|turnstile|captcha|challenge/i.test(text)) {
      throw new Error('CPA 返回 Cloudflare/验证码页面');
    }
    if (!response.ok) {
      throw new Error(`CPA 管理接口 HTTP ${response.status}: ${clip(text)}`);
    }

    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('CPA 管理接口请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseAuthFiles(value: unknown) {
  const records = arrayOfRecords(value);

  return records.map((record, index) => ({
    key: String(stringValue(record.auth_index) ?? stringValue(record.authIndex) ?? stringValue(record.id) ?? stringValue(record.key) ?? stringValue(record.name) ?? index),
    index: stringValue(record.index) ?? stringValue(record.auth_index) ?? stringValue(record.authIndex) ?? String(index),
    name: stringValue(record.name) ?? stringValue(record.label) ?? stringValue(record.filename) ?? stringValue(record.file) ?? `账号 ${index + 1}`,
    account: stringValue(record.email) ?? stringValue(record.account) ?? stringValue(record.username) ?? '-',
    provider: stringValue(record.provider) ?? stringValue(record.account_type) ?? stringValue(record.accountType) ?? stringValue(record.type) ?? '-',
    status: accountStatus(record),
    successCount: numeric(record.success) ?? numeric(record.success_count) ?? numeric(record.successCount) ?? 0,
    failureCount: numeric(record.failed) ?? numeric(record.failure_count) ?? numeric(record.failedCount) ?? 0,
    usage5h:
      percentageValue(
        record.usage_5h,
        record.usage5h,
        record.usage_5_hours,
        record.usage5Hours,
        record.five_hour_usage,
        record.fiveHourUsage,
        record.five_hours_usage,
        record.fiveHoursUsage,
        record.five_hour_usage_percent,
        record.fiveHourUsagePercent,
        record.five_hour_limit_usage,
        record.fiveHourLimitUsage,
        record.five_hours_limit_usage,
        record.fiveHoursLimitUsage,
        record.limit_usage_5h,
        record.limitUsage5h
      ),
    usage7d:
      percentageValue(
        record.usage_7d,
        record.usage7d,
        record.week_usage,
        record.weekUsage,
        record.weekly_usage,
        record.weeklyUsage,
        record.week_usage_percent,
        record.weekUsagePercent,
        record.weekly_usage_percent,
        record.weeklyUsagePercent,
        record.week_limit_usage,
        record.weekLimitUsage,
        record.weekly_limit_usage,
        record.weeklyLimitUsage,
        record.limit_usage_7d,
        record.limitUsage7d
      ),
    lastRefresh:
      stringValue(record.last_refresh) ??
      stringValue(record.lastRefresh) ??
      stringValue(record.last_refreshed_at) ??
      stringValue(record.lastRefreshedAt) ??
      stringValue(record.quota_refresh_at) ??
      stringValue(record.quotaRefreshAt) ??
      stringValue(record.refresh_time) ??
      stringValue(record.last_used) ??
      null,
    refreshTime: stringValue(record.modtime) ?? stringValue(record.mtime) ?? stringValue(record.updated_at) ?? null
  }));
}

function parseUsageRecords(value: unknown): CpaUsageRecord[] {
  return arrayOfRecords(value).map((record) => ({
    timestamp: stringValue(record.timestamp) ?? stringValue(record.time) ?? stringValue(record.created_at) ?? new Date().toISOString(),
    authIndex: stringValue(record.auth_index) ?? stringValue(record.authIndex) ?? stringValue(record.index) ?? stringValue(record.file) ?? stringValue(record.name),
    source: stringValue(record.source) ?? stringValue(record.model),
    totalTokens:
      numeric(record.total_tokens) ??
      numeric(record.totalTokens) ??
      numeric(record.tokens) ??
      numeric(recordValue(record.tokens)?.total_tokens) ??
      numeric(recordValue(record.tokens)?.totalTokens) ??
      numeric(recordValue(record.usage)?.total_tokens) ??
      numeric(recordValue(record.usage)?.totalTokens) ??
      (numeric(record.prompt_tokens) ?? 0) + (numeric(record.completion_tokens) ?? 0),
    failed: booleanValue(record.failed) === true || ['failed', 'error'].includes(stringValue(record.status)?.toLowerCase() ?? '')
  })).filter((record) => Number.isFinite(Date.parse(record.timestamp)));
}

function aggregateUsage(records: CpaUsageRecord[], account: { index: string; key: string; name: string }, index: number) {
  const keys = new Set([account.index, account.key, account.name, String(index)]);
  let successCount = 0;
  let failureCount = 0;

  for (const record of records) {
    if (record.authIndex && !keys.has(record.authIndex)) {
      continue;
    }

    if (record.failed) {
      failureCount += 1;
      continue;
    }

    successCount += 1;
  }

  return { successCount, failureCount };
}

function accountStatus(record: Record<string, unknown>) {
  const disabled = booleanValue(record.disabled) === true || booleanValue(record.is_disabled) === true;
  if (disabled) {
    return '已禁用';
  }

  const unavailable = booleanValue(record.unavailable) === true || booleanValue(record.is_unavailable) === true;
  if (unavailable) {
    return '不可用';
  }

  const status = stringValue(record.status) ?? stringValue(record.state);
  const statusMessage = stringValue(record.status_message) ?? stringValue(record.statusMessage);
  const normalized = `${status ?? ''} ${statusMessage ?? ''}`.trim().toLowerCase();

  if (!normalized) {
    return '正常';
  }

  if (/ready|ok|normal|available|active|healthy|success|正常|可用/.test(normalized)) {
    return '正常';
  }
  if (/refresh|loading|pending|wait|刷新|等待|处理中/.test(normalized)) {
    return '刷新中';
  }
  if (/disable|disabled|inactive|paused|ban|blocked|locked|禁用|封禁|锁定/.test(normalized)) {
    return '已禁用';
  }
  if (/unavailable|quota|limit|limited|受限|不可用|限额/.test(normalized)) {
    return '不可用';
  }
  if (/error|failed|fail|invalid|expired|异常|失败|失效|过期/.test(normalized)) {
    return '异常';
  }

  return status ?? statusMessage ?? '正常';
}

function unwrapData(value: unknown): unknown {
  const record = recordValue(value);
  return record && 'data' in record ? record.data : value;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  const data = unwrapData(value);
  const record = recordValue(data);
  const candidates = [
    data,
    record?.files,
    record?.items,
    record?.list,
    record?.records,
    record?.auth_files,
    record?.authFiles,
    record?.data
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    }
  }

  return [];
}

function channelSummary(channel: { id: string; name: string; upstreamBaseUrl: string }) {
  return {
    id: channel.id,
    name: channel.name,
    baseUrl: channel.upstreamBaseUrl
  };
}

function normalizeBaseUrl(baseUrl: string) {
  const value = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return value.replace(/\/+$/, '');
}

function stripBearer(value: string) {
  return value.replace(/^Bearer\s+/i, '').trim();
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown) {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function percentageValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed === undefined) {
      continue;
    }

    const percent = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
    return Math.max(0, Math.min(100, Math.round(percent * 100) / 100));
  }

  return null;
}

function booleanValue(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    if (/^(true|1|yes|y)$/i.test(value.trim())) {
      return true;
    }
    if (/^(false|0|no|n)$/i.test(value.trim())) {
      return false;
    }
  }

  return null;
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
