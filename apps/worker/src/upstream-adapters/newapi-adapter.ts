import type { RateInfo, UpstreamAccountState, UpstreamAdapter } from '@ai-relay/shared';
import { requestJson, unwrapData } from './http';

type AdapterConfig = {
  baseUrl: string;
  authMode: string;
  credential: Record<string, string>;
};

export class NewApiAdapter implements UpstreamAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async testConnection() {
    const state = await this.getAccountState();
    return state.status === 'ok' || state.status === 'limited';
  }

  async getAccountState(): Promise<UpstreamAccountState> {
    const token = this.config.credential.token ?? this.config.credential.adminToken;

    if (!token) {
      return {
        status: 'limited',
        lastError: 'NewAPI 未配置管理 token，只能做调用探测'
      };
    }

    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/user/self', { token }).catch(() => null);
    const user = payload ? unwrapData<Record<string, unknown>>(payload) : {};

    return {
      status: 'ok',
      balance: numeric(user.quota) ?? numeric(user.balance),
      balanceCurrency: 'quota'
    };
  }

  async listModels(): Promise<string[]> {
    const token = this.config.credential.token ?? this.config.credential.adminToken;
    const payload = await requestJson<unknown>(this.config.baseUrl, '/v1/models', { token });
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
    const token = this.config.credential.token ?? this.config.credential.adminToken;

    if (!token || this.config.authMode === 'api_key') {
      return [];
    }

    const capturedAt = new Date().toISOString();
    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/option/', { token }).catch(() => null);
    const options = payload ? unwrapData<Record<string, unknown>>(payload) : {};
    const modelRatio = parseJsonRecord(options.ModelRatio ?? options.model_ratio);
    const completionRatio = parseJsonRecord(options.CompletionRatio ?? options.completion_ratio);

    return Object.keys(modelRatio).map((model) => ({
      provider: 'newapi',
      model,
      modelRatio: numeric(modelRatio[model]),
      completionRatio: numeric(completionRatio[model]),
      source: '/api/option/',
      capturedAt
    }));
  }
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
  return typeof value === 'string' && value.trim() ? value : undefined;
}
