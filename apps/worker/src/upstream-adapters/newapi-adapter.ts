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
    const resolvedBalance = quota !== undefined ? quota / quotaPerUnit : balance;

    return {
      status: resolvedBalance === undefined ? 'limited' : 'ok',
      balance: resolvedBalance,
      balanceCurrency: 'CNY',
      lastError: resolvedBalance === undefined ? '余额未获取：NewAPI 没有返回 quota 或 balance' : undefined
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

    const [optionsResult, pricingResult, selfGroupsResult, userGroupsResult] = await Promise.allSettled([
      requestJson<unknown>(this.config.baseUrl, '/api/option/', auth),
      requestJson<unknown>(this.config.baseUrl, '/api/pricing', auth),
      requestJson<unknown>(this.config.baseUrl, '/api/user/self/groups', auth),
      requestJson<unknown>(this.config.baseUrl, '/api/user/groups', auth)
    ]);
    const optionsPayload = fulfilledData(optionsResult);
    const pricingPayload = fulfilledPayload(pricingResult);
    const pricingData = unwrapData<unknown>(pricingPayload);
    const selfGroupsPayload = fulfilledData(selfGroupsResult);
    const userGroupsPayload = fulfilledData(userGroupsResult);
    const options = recordValue(optionsPayload) ?? {};
    const pricing = recordValue(pricingPayload) ?? recordValue(pricingData) ?? {};
    const modelRatio = parseJsonRecord(options.ModelRatio ?? options.model_ratio);
    const completionRatio = parseJsonRecord(options.CompletionRatio ?? options.completion_ratio);
    const groupRates = groupRateInfos(
      [
        { ratios: parseJsonRecord(options.GroupRatio ?? options.group_ratio), source: '/api/option/' },
        { ratios: newApiGroupRatioFromPricing(pricingPayload), source: '/api/pricing' }
      ],
      [
        ...groupRecordsFromPayload(selfGroupsPayload),
        ...newApiGroupRecordsFromPricing(pricingPayload),
        ...groupRecordsFromPayload(userGroupsPayload)
      ],
      capturedAt
    );
    const optionModelRates = optionModelRateInfos(modelRatio, completionRatio, capturedAt);
    const pricingModelRates = pricingModelRateInfos(pricingPayload, capturedAt);

    return dedupeRates([...groupRates, ...optionModelRates, ...pricingModelRates]);
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

function fulfilledPayload(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function fulfilledData(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled' ? unwrapData<unknown>(result.value) : undefined;
}

function groupRateInfos(
  ratioSources: Array<{ ratios: Record<string, unknown>; source: string }>,
  groupRecords: Array<Record<string, unknown>>,
  capturedAt: string
): RateInfo[] {
  const groups = new Map<string, RateInfo>();

  for (const { ratios, source } of ratioSources) {
    for (const [group, value] of Object.entries(ratios)) {
      const modelRatio = numeric(value);
      if (modelRatio === undefined) {
        continue;
      }

      groups.set(normalizeName(group), {
        provider: 'newapi',
        model: '*',
        group,
        modelRatio,
        source,
        capturedAt
      });
    }
  }

  for (const record of groupRecords) {
    const group = groupNameFromRecord(record);
    if (!group) {
      continue;
    }
    const key = normalizeName(group);
    const previous = groups.get(key);
    const modelRatio = groupRatioFromRecord(record)
      ?? previous?.modelRatio
      ?? ratioFromValue(ratioSources.find((source) => source.ratios[group] !== undefined)?.ratios[group]);

    groups.set(key, {
      ...previous,
      provider: 'newapi',
      model: '*',
      groupId: stringValue(record.id),
      group,
      modelRatio,
      source: previous && modelRatio === previous.modelRatio ? previous.source : stringValue(record.source) ?? '/api/user/groups',
      capturedAt
    });
  }

  return [...groups.values()];
}

function newApiGroupRatioFromPricing(value: unknown): Record<string, unknown> {
  const record = recordValue(value);
  const data = recordValue(unwrapData<unknown>(value));

  return {
    ...parseJsonRecord(record?.group_ratio ?? record?.GroupRatio),
    ...parseJsonRecord(data?.group_ratio ?? data?.GroupRatio)
  };
}

function newApiGroupRecordsFromPricing(value: unknown): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown>>();
  const pricingRecord = recordValue(value);
  const groupRatio = newApiGroupRatioFromPricing(value);

  for (const group of arrayOfStrings(pricingRecord?.usable_group ?? pricingRecord?.usableGroup)) {
    groups.set(normalizeName(group), {
      name: group,
      ratio: ratioFromValue(groupRatio[group]),
      source: '/api/pricing'
    });
  }

  for (const [group, ratio] of Object.entries(groupRatio)) {
    groups.set(normalizeName(group), {
      ...groups.get(normalizeName(group)),
      name: groups.get(normalizeName(group))?.name ?? group,
      ratio: ratioFromValue(ratio),
      source: '/api/pricing'
    });
  }

  for (const record of groupRecordsFromPayload(pricingRecord?.auto_groups ?? pricingRecord?.autoGroups)) {
    const name = groupNameFromRecord(record);
    if (!name) {
      continue;
    }

    groups.set(normalizeName(name), {
      ...groups.get(normalizeName(name)),
      id: stringValue(record.id),
      name,
      modelRatio: groupRatioFromRecord(record) ?? ratioFromValue(groupRatio[name]),
      source: '/api/pricing'
    });
  }

  for (const record of recordArrayFromPayload(value)) {
    for (const group of arrayOfStrings(record.enable_groups ?? record.enableGroups ?? record.groups)) {
      const previous = groups.get(normalizeName(group));
      groups.set(normalizeName(group), {
        ...previous,
        name: previous?.name ?? group,
        ratio: ratioFromValue(groupRatio[group]) ?? ratioFromValue(previous?.ratio) ?? ratioFromValue(previous?.modelRatio),
        source: '/api/pricing'
      });
    }
  }

  return [...groups.values()];
}

function optionModelRateInfos(
  modelRatio: Record<string, unknown>,
  completionRatio: Record<string, unknown>,
  capturedAt: string
): RateInfo[] {
  return Object.keys(modelRatio)
    .map((model) => ({
      provider: 'newapi',
      model,
      modelRatio: numeric(modelRatio[model]),
      completionRatio: numeric(completionRatio[model]),
      source: '/api/option/',
      capturedAt
    }))
    .filter((rate) => rate.modelRatio !== undefined || rate.completionRatio !== undefined);
}

function pricingModelRateInfos(payload: unknown, capturedAt: string): RateInfo[] {
  return recordArrayFromPayload(payload)
    .flatMap((record) => {
      const model = stringValue(record.model_name)
        ?? stringValue(record.model)
        ?? stringValue(record.name)
        ?? stringValue(record.id);
      const modelRatio = firstNumeric(record.model_ratio, record.modelRatio, record.ratio);
      const completionRatio = firstNumeric(record.completion_ratio, record.completionRatio);
      const inputPrice = firstNumeric(record.input_price, record.inputPrice, record.prompt_price, record.promptPrice, record.model_price, record.modelPrice);
      const outputPrice = firstNumeric(record.output_price, record.outputPrice, record.completion_price, record.completionPrice);

      if (!model || (modelRatio === undefined && completionRatio === undefined && inputPrice === undefined && outputPrice === undefined)) {
        return [];
      }

      const rate: RateInfo = {
        provider: 'newapi',
        model,
        inputPrice,
        outputPrice,
        modelRatio,
        completionRatio,
        source: '/api/pricing',
        capturedAt
      };

      return [rate];
    });
}

function groupRecordsFromPayload(value: unknown): Array<Record<string, unknown>> {
  const record = recordValue(value);

  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  if (!record) {
    return [];
  }

  for (const key of ['items', 'list', 'groups', 'data', 'rows', 'records']) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    }
  }

  return Object.entries(record)
    .map(([key, entry]) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return { name: key, ratio: ratioFromValue(entry), ...(entry as Record<string, unknown>) };
      }

      return { name: key, ratio: entry };
    })
    .filter((entry) => Boolean(groupNameFromRecord(entry)));
}

function recordArrayFromPayload(value: unknown): Array<Record<string, unknown>> {
  const record = recordValue(value);

  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  if (!record) {
    return [];
  }

  for (const key of ['pricing', 'prices', 'items', 'list', 'models', 'data', 'rows', 'records']) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    }
  }

  return groupNameFromRecord(record) || stringValue(record.model_name) || stringValue(record.model) ? [record] : [];
}

function groupNameFromRecord(record: Record<string, unknown>) {
  return stringValue(record.name) ??
    stringValue(record.group) ??
    stringValue(record.group_name) ??
    stringValue(record.groupName) ??
    stringValue(record.key) ??
    stringValue(record.id);
}

function groupRatioFromRecord(record: Record<string, unknown>) {
  return firstNumeric(
    record.modelRatio,
    record.ratio,
    record.rate,
    record.multiplier,
    record.rate_multiplier,
    record.rateMultiplier,
    record.model_ratio,
    record.modelRatio,
    record.group_ratio,
    record.groupRatio
  );
}

function ratioFromValue(value: unknown) {
  const direct = numeric(value);
  if (direct !== undefined) {
    return direct;
  }

  const record = recordValue(value);
  return record ? groupRatioFromRecord(record) : undefined;
}

function dedupeRates(rates: RateInfo[]) {
  const deduped = new Map<string, RateInfo>();

  for (const rate of rates) {
    const key = [rate.provider, rate.model, normalizeName(rate.group), normalizeName(rate.groupId)].join('\u0000');
    const previous = deduped.get(key);
    deduped.set(key, {
      ...previous,
      ...rate,
      inputPrice: rate.inputPrice ?? previous?.inputPrice,
      outputPrice: rate.outputPrice ?? previous?.outputPrice,
      modelRatio: rate.modelRatio ?? previous?.modelRatio,
      completionRatio: rate.completionRatio ?? previous?.completionRatio
    });
  }

  return [...deduped.values()];
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

function firstNumeric(...values: unknown[]) {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function arrayOfStrings(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
      }
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }

  return [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeName(value: string | undefined) {
  return value?.trim().toLowerCase() || 'default';
}
