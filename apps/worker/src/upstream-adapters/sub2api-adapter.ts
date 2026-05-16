import type { RateInfo, UpstreamAccountState, UpstreamAdapter, UsageInfo } from '@ai-relay/shared';
import { requestJson, unwrapData } from './http';

type AdapterConfig = {
  baseUrl: string;
  authMode: string;
  credential: Record<string, string>;
};

export class Sub2ApiAdapter implements UpstreamAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async testConnection() {
    const state = await this.getAccountState();
    return state.status === 'ok' || state.status === 'limited';
  }

  async getAccountState(): Promise<UpstreamAccountState> {
    if (this.config.authMode === 'api_key') {
      return {
        status: 'limited',
        lastError: 'Sub2API API Key 模式无法读取用户余额和倍率'
      };
    }

    const token = await this.getToken();
    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/v1/auth/me', { token });
    const user = unwrapData<Record<string, unknown>>(payload);

    return {
      status: 'ok',
      balance: numeric(user.balance),
      balanceCurrency: stringValue(user.currency) ?? stringValue(user.balance_currency) ?? 'CNY',
      concurrency: numeric(user.concurrency)
    };
  }

  async listModels(): Promise<string[]> {
    const token = await this.getToken();
    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/v1/channels/available', { token });
    const channels = arrayOfRecords(unwrapData<unknown>(payload));
    const models = new Set<string>();

    for (const channel of channels) {
      for (const model of arrayOfStrings(channel.models)) {
        models.add(model);
      }
    }

    return [...models].sort();
  }

  async listRates(): Promise<RateInfo[]> {
    if (this.config.authMode === 'api_key') {
      return [];
    }

    const token = await this.getToken();
    const capturedAt = new Date().toISOString();
    const rates: RateInfo[] = [];

    const groupRates = await requestJson<unknown>(this.config.baseUrl, '/api/v1/groups/rates', { token }).catch(() => null);
    const groupMap = groupRates ? unwrapData<Record<string, number | string>>(groupRates) : {};

    for (const [group, ratio] of Object.entries(groupMap)) {
      rates.push({
        provider: 'sub2api',
        model: '*',
        group,
        modelRatio: numeric(ratio),
        source: '/api/v1/groups/rates',
        capturedAt
      });
    }

    const channels = await requestJson<unknown>(this.config.baseUrl, '/api/v1/channels/available', { token }).catch(() => null);

    for (const channel of arrayOfRecords(channels ? unwrapData<unknown>(channels) : [])) {
      const provider = stringValue(channel.platform) ?? stringValue(channel.provider) ?? 'sub2api';
      const channelName = stringValue(channel.name);

      for (const model of arrayOfStrings(channel.models)) {
        const modelPricing = findModelPricing(channel, model);

        rates.push({
          provider,
          model,
          channelName,
          inputPrice: modelPricing.inputPrice,
          outputPrice: modelPricing.outputPrice,
          modelRatio: modelPricing.modelRatio,
          completionRatio: modelPricing.completionRatio,
          currency: modelPricing.currency,
          source: '/api/v1/channels/available',
          capturedAt
        });
      }
    }

    return rates;
  }

  async listUsage(): Promise<UsageInfo[]> {
    const token = await this.getToken();
    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/v1/keys', { token });
    const keys = arrayOfRecords(unwrapData<unknown>(payload));

    return keys.map((key) => ({
      keyName: stringValue(key.name),
      quota: numeric(key.quota),
      quotaUsed: numeric(key.quota_used),
      usage5h: numeric(key.usage_5h),
      usage1d: numeric(key.usage_1d),
      usage7d: numeric(key.usage_7d)
    }));
  }

  private async getToken() {
    const directToken = this.config.credential.token ?? this.config.credential.bearerToken;

    if (directToken) {
      return directToken;
    }

    const email = this.config.credential.email ?? this.config.credential.username;
    const password = this.config.credential.password;

    if (!email || !password) {
      throw new Error('Sub2API 用户模式需要 email/username 和 password，或用户级 token');
    }

    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, username: email, password })
    });

    const data = unwrapData<Record<string, unknown>>(payload);
    const token = stringValue(data.token) ?? stringValue(data.access_token) ?? stringValue(data.jwt);

    if (!token) {
      throw new Error('Sub2API login succeeded but no token was returned');
    }

    return token;
  }
}

function findModelPricing(channel: Record<string, unknown>, model: string) {
  const pricing = recordValue(channel.pricing) ?? recordValue(channel.model_pricing);
  const modelPricing = pricing ? recordValue(pricing[model]) : undefined;

  return {
    inputPrice: numeric(modelPricing?.input_price ?? modelPricing?.inputPrice),
    outputPrice: numeric(modelPricing?.output_price ?? modelPricing?.outputPrice),
    modelRatio: numeric(modelPricing?.model_ratio ?? modelPricing?.modelRatio),
    completionRatio: numeric(modelPricing?.completion_ratio ?? modelPricing?.completionRatio),
    currency: stringValue(modelPricing?.currency)
  };
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
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
  return typeof value === 'string' && value.trim() ? value : undefined;
}
