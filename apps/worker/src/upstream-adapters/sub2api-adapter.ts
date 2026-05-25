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
        lastError: 'Sub2API API Key 模式无法读取用户余额、倍率和分组'
      };
    }

    const token = await this.getToken();
    const payload = await requestJson<unknown>(this.config.baseUrl, '/api/v1/auth/me', { token });
    const user = unwrapData<Record<string, unknown>>(payload);
    const balance = numeric(user.balance);

    return {
      status: balance === undefined ? 'limited' : 'ok',
      balance,
      balanceCurrency: stringValue(user.currency) ?? stringValue(user.balance_currency) ?? 'CNY',
      concurrency: numeric(user.concurrency),
      lastError: balance === undefined ? '余额未获取：Sub2API 没有返回 balance' : undefined
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

    const [groupRatesResult, groupsResult] = await Promise.allSettled([
      requestJson<unknown>(this.config.baseUrl, '/api/v1/groups/rates', { token }),
      requestJson<unknown>(this.config.baseUrl, '/api/v1/groups/available', { token })
    ]);
    const groupRates = groupRatesResult.status === 'fulfilled' ? unwrapData<unknown>(groupRatesResult.value) : {};
    const groups = groupsResult.status === 'fulfilled' ? unwrapData<unknown>(groupsResult.value) : [];
    const groupRateEntries = mergeGroupRateEntries(groups, groupRates);

    for (const { id, group, ratio, source } of groupRateEntries) {
      rates.push({
        provider: 'sub2api',
        model: '*',
        groupId: id,
        group,
        modelRatio: ratio,
        source,
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

function mergeGroupRateEntries(groupsValue: unknown, ratesValue: unknown) {
  const entries = new Map<string, { id?: string; group: string; ratio: number; source: string }>();
  const rateMap = recordValue(ratesValue) ?? {};
  const matchedRateKeys = new Set<string>();

  for (const groupRecord of arrayOfRecords(groupsValue)) {
    const name = groupNameFromRecord(groupRecord);
    if (!name) {
      continue;
    }

    const id = identifierValue(groupRecord.id);
    const rateMatch = ratioFromMap(rateMap, name, id);
    const ratio = rateMatch.value ?? ratioFromValue(groupRecord);
    const source = rateMatch.value !== undefined ? '/api/v1/groups/rates' : '/api/v1/groups/available';

    for (const key of rateMatch.keys) {
      matchedRateKeys.add(normalizeName(key));
    }
    if (ratio !== undefined) {
      entries.set(normalizeName(name), { id, group: name, ratio, source });
    }
  }

  for (const [group, value] of Object.entries(rateMap)) {
    if (matchedRateKeys.has(normalizeName(group))) {
      continue;
    }

    const ratio = ratioFromValue(value);
    const nested = recordValue(value);
    const name =
      stringValue(nested?.name) ??
      stringValue(nested?.group) ??
      stringValue(nested?.group_name) ??
      stringValue(nested?.groupName) ??
      group;

    if (ratio !== undefined) {
      entries.set(normalizeName(name), { group: name, ratio, source: '/api/v1/groups/rates' });
    }
  }

  return [...entries.values()].sort((left, right) => left.group.localeCompare(right.group, 'zh-CN', { numeric: true }));
}

function groupNameFromRecord(record: Record<string, unknown>) {
  return stringValue(record.name) ??
    stringValue(record.group) ??
    stringValue(record.group_name) ??
    stringValue(record.groupName) ??
    identifierValue(record.id);
}

function ratioFromMap(map: Record<string, unknown>, groupName: string, groupId?: string) {
  const candidates = [groupId, groupName].filter((value): value is string => Boolean(value));
  const matchedKeys = Object.keys(map).filter((key) =>
    candidates.some((candidate) => normalizeName(key) === normalizeName(candidate))
  );
  const matchedKey = matchedKeys.find((key) => ratioFromValue(map[key]) !== undefined);

  return {
    value: matchedKey ? ratioFromValue(map[matchedKey]) : undefined,
    keys: matchedKeys
  };
}

function ratioFromValue(value: unknown) {
  const direct = numeric(value);
  if (direct !== undefined) {
    return direct;
  }

  const record = recordValue(value);
  return record
    ? numeric(record.ratio) ??
        numeric(record.rate) ??
        numeric(record.multiplier) ??
        numeric(record.rate_multiplier) ??
        numeric(record.rateMultiplier) ??
        numeric(record.model_ratio) ??
        numeric(record.modelRatio) ??
        numeric(record.group_ratio) ??
        numeric(record.groupRatio) ??
        numeric(record.rate_multiplier) ??
        numeric(record.rateMultiplier)
    : undefined;
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
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return stringValue(value);
}

function normalizeName(value: string | undefined) {
  return value?.trim().toLowerCase() || 'default';
}
