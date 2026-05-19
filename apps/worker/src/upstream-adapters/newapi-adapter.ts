import type { RateInfo, UpstreamAccountState, UpstreamAdapter } from '@ai-relay/shared';
import { requestJson, requestJsonResponse, unwrapData } from './http';

type AdapterConfig = {
  baseUrl: string;
  authMode: string;
  upstreamUserId?: string | null;
  credential: Record<string, string>;
};

type NewApiAuthContext = RequestInit & { token?: string };

export class NewApiAdapter implements UpstreamAdapter {
  private authContextPromise?: Promise<NewApiAuthContext | null>;

  constructor(private readonly config: AdapterConfig) {}

  async testConnection() {
    const state = await this.getAccountState();
    return state.status === 'ok' || state.status === 'limited';
  }

  async getAccountState(): Promise<UpstreamAccountState> {
    const auth = await this.getAuthContext();

    if (!auth) {
      return {
        status: 'limited',
        lastError: 'NewAPI 未配置 Token 或账号密码，只能做调用探测'
      };
    }

    const [statusPayload, selfPayload] = await Promise.all([
      requestJson<unknown>(this.config.baseUrl, '/api/status').catch(() => null),
      requestJson<unknown>(this.config.baseUrl, '/api/user/self', auth).catch(() => null)
    ]);
    const status = statusPayload ? unwrapData<Record<string, unknown>>(statusPayload) : {};
    const quotaPerUnit = numeric(status.quota_per_unit) ?? 500000;
    const user = selfPayload ? unwrapData<Record<string, unknown>>(selfPayload) : {};
    const quota = numeric(user.quota);
    const balance = numeric(user.balance);

    return {
      status: 'ok',
      balance: quota !== undefined ? quota / quotaPerUnit : balance,
      balanceCurrency: 'CNY'
    };
  }

  async listModels(): Promise<string[]> {
    const auth = await this.getAuthContext();
    const payload = await requestJson<unknown>(this.config.baseUrl, '/v1/models', auth ?? {});
    const data = unwrapData<unknown>(payload);
    const models = Array.isArray(data) ? data : recordArray(recordValue(data)?.data);

    return models
      .map((model) => {
        if (typeof model === 'string') {
          return model;
        }

        const record = recordValue(model);
        return stringValue(record?.id) ?? stringValue(record?.model);
      })
      .filter((model): model is string => Boolean(model));
  }

  async listRates(): Promise<RateInfo[]> {
    if (this.config.authMode === 'api_key') {
      return [];
    }

    const auth = await this.getAuthContext();

    if (!auth) {
      return [];
    }

    const capturedAt = new Date().toISOString();

    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/option/', auth).catch(() => null);
    const options = payload ? unwrapData<Record<string, unknown>>(payload) : {};
    const pricingPayload = await requestJson<unknown>(this.config.baseUrl, '/api/pricing', auth).catch(() => null);
    const pricing = pricingPayload ? unwrapData<Record<string, unknown>>(pricingPayload) : {};
    const modelRatio = parseJsonRecord(options.ModelRatio ?? options.model_ratio);
    const completionRatio = parseJsonRecord(options.CompletionRatio ?? options.completion_ratio);
    const groupRatio = {
      ...parseJsonRecord(options.GroupRatio ?? options.group_ratio),
      ...parseJsonRecord(pricing.group_ratio ?? pricing.GroupRatio)
    };

    const groupRates = Object.keys(groupRatio).map((group) => ({
      provider: 'newapi',
      model: '*',
      group,
      modelRatio: numeric(groupRatio[group]),
      source: pricingPayload ? '/api/pricing' : '/api/option/',
      capturedAt
    }));

    const modelRates = Object.keys(modelRatio).map((model) => ({
      provider: 'newapi',
      model,
      modelRatio: numeric(modelRatio[model]),
      completionRatio: numeric(completionRatio[model]),
      source: '/api/option/',
      capturedAt
    }));

    return [...groupRates, ...modelRates];
  }

  private async getAuthContext(): Promise<NewApiAuthContext | null> {
    this.authContextPromise ??= this.loadAuthContext();
    return this.authContextPromise;
  }

  private async loadAuthContext(): Promise<NewApiAuthContext | null> {
    if (this.config.authMode === 'password') {
      return this.passwordAuthContext();
    }

    const token = this.config.credential.token ?? this.config.credential.adminToken ?? this.config.credential.bearerToken;
    if (!token) {
      return null;
    }

    const headers = new Headers();
    const userId = this.config.upstreamUserId ?? this.config.credential.userId;
    if (userId) {
      headers.set('New-Api-User', userId);
    }

    return { token, headers };
  }

  private async passwordAuthContext(): Promise<NewApiAuthContext> {
    const account = this.config.credential.email ?? this.config.credential.username;
    const password = this.config.credential.password;

    if (!account || !password) {
      throw new Error('NewAPI 用户登录需要 email/username 和 password');
    }

    const login = await requestJsonResponse<unknown>(this.config.baseUrl, '/api/user/login', {
      method: 'POST',
      body: JSON.stringify({ username: account, password })
    });
    const data = recordValue(unwrapData<unknown>(login.payload)) ?? {};

    if (data.require_2fa === true) {
      throw new Error('NewAPI 账号启用了 2FA，暂不能使用账号密码自动鉴权');
    }

    const cookie = cookieHeader(login.headers);
    if (!cookie) {
      throw new Error('NewAPI 登录成功但没有返回 session cookie');
    }

    const userId = this.config.upstreamUserId ?? this.config.credential.userId ?? stringValue(data.id);
    if (!userId) {
      throw new Error('NewAPI 用户登录需要 upstreamUserId');
    }

    const headers = new Headers({ cookie });
    headers.set('New-Api-User', userId);

    return { headers };
  }
}

function cookieHeader(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookieValues = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : [];
  const fallback = headers.get('set-cookie');
  const rawValues = setCookieValues.length > 0 ? setCookieValues : fallback ? [fallback] : [];
  const cookies = rawValues
    .flatMap((value) => value.split(/,(?=\s*[^;,]+=)/))
    .map((value) => value.split(';')[0]?.trim())
    .filter((value): value is string => Boolean(value));

  return cookies.join('; ');
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function recordArray(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' || (Boolean(item) && typeof item === 'object'))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value : undefined;
}
