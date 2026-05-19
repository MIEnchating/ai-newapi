import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthMode, UpstreamStatus, UpstreamType, type MainStation } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { decryptCredentialPayload, encryptCredentialPayload } from '../vault/credential-vault';

const MAIN_STATION_ID = 'relay-newapi-main';

type MainStationInput = {
  name?: string;
  baseUrl?: string;
  auth?: string;
  adminUserId?: string;
  adminToken?: string;
};

type MainStationGroupInput = {
  name?: string;
  ratio?: number;
};

type MainStationGroupInfo = {
  name: string;
  ratio: number | null;
  source: string;
};

type ImportedChannel = {
  id: string;
  name: string;
  groupName: string;
  mainStationGroupName: string | null;
  platformGroupName: string;
  type: UpstreamType;
  baseUrl: string;
  status: UpstreamStatus;
  priority: number;
  weight: number;
};

@Injectable()
export class MainStationService {
  private schemaChecked = false;

  constructor(private readonly prisma: PrismaService) {}

  async get() {
    await this.ensureSchema();
    const station = await this.prisma.mainStation.findUnique({
      where: { id: MAIN_STATION_ID }
    });

    return toPublicStation(station);
  }

  async update(input: MainStationInput) {
    try {
      return await retryTransientDatabase(async () => {
        await this.ensureSchema();
        const existing = await this.prisma.mainStation.findUnique({
          where: { id: MAIN_STATION_ID }
        });
        const name = trimOrDefault(input.name, '主站');
        const baseUrl = trimOrNull(input.baseUrl);
        const auth = trimOrDefault(input.auth, '管理 Token');
        const adminUserId = trimOrNull(input.adminUserId);
        const adminToken = trimOrNull(input.adminToken);

        if (!name || !baseUrl || !auth || !adminUserId) {
          throw new BadRequestException('name, baseUrl, auth and adminUserId are required');
        }

        const encryptedAdminToken = adminToken
          ? encryptCredentialPayload({ adminToken })
          : existing?.encryptedAdminToken ?? null;

        if (!encryptedAdminToken) {
          throw new BadRequestException('admin token is required');
        }

        const station = await this.prisma.mainStation.upsert({
          where: { id: MAIN_STATION_ID },
          create: {
            id: MAIN_STATION_ID,
            name,
            baseUrl,
            auth,
            adminUserId,
            encryptedAdminToken
          },
          update: {
            name,
            baseUrl,
            auth,
            adminUserId,
            encryptedAdminToken,
            lastError: null
          }
        });

        return toPublicStation(station);
      });
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        throw new BadRequestException('数据库连接临时断开，请重试保存主站配置');
      }

      throw error;
    }
  }

  async syncChannels() {
    await this.ensureSchema();
    const station = await this.prisma.mainStation.findUnique({
      where: { id: MAIN_STATION_ID }
    });

    if (!station || !station.baseUrl || !station.adminUserId || !station.encryptedAdminToken) {
      throw new BadRequestException('主站未配置：请先保存 NewAPI 地址、管理员用户 ID 和管理 Token');
    }

    const adminToken = decryptAdminToken(station.encryptedAdminToken);
    const imported = await fetchNewApiChannels(station.baseUrl, station.adminUserId, adminToken);

    if (!imported.ok) {
      await this.prisma.mainStation.update({
        where: { id: MAIN_STATION_ID },
        data: { lastError: imported.message }
      });
      throw new BadRequestException(imported.message);
    }

    const syncedAt = new Date();
    const updatedStation = await retryTransientDatabase(async () => {
      const existingUpstreams = await this.prisma.upstream.findMany({
        where: { id: { in: imported.channels.map((channel) => channel.id) } },
        select: {
          id: true,
          status: true,
          name: true,
          upstreamName: true,
          keyName: true,
          groupName: true,
          mainStationGroupName: true,
          credential: { select: { id: true } }
        }
      });
      const existingById = new Map(existingUpstreams.map((upstream) => [upstream.id, upstream]));

      return this.prisma.$transaction(async (tx) => {
        for (const channel of imported.channels) {
          const existing = existingById.get(channel.id);
          const status =
            channel.status === UpstreamStatus.DISABLED
              ? UpstreamStatus.DISABLED
              : existing?.status === UpstreamStatus.DISABLED || !existing
                ? UpstreamStatus.LIMITED
                : existing.status;

          const existingNameParts = existing ? splitChannelName(existing.name) : null;
          const shouldRefreshPlatformGroup =
            !existing?.upstreamName ||
            existing.upstreamName.trim() === existing.name.trim() ||
            existing.upstreamName.trim() === existingNameParts?.platformGroupName;
          const shouldResetUnverifiedRateGroup =
            existing &&
            !existing.credential &&
            existing.groupName !== 'default' &&
            (!existing.mainStationGroupName || existing.groupName === existing.mainStationGroupName);

          await tx.upstream.upsert({
            where: { id: channel.id },
            create: {
              id: channel.id,
              name: channel.name,
              type: channel.type,
              baseUrl: channel.baseUrl,
              authMode: defaultAuthMode(channel.type),
              groupName: channel.groupName,
              mainStationGroupName: channel.mainStationGroupName,
              upstreamName: channel.platformGroupName,
              status,
              rechargeRatio: 1,
              priority: channel.priority,
              weight: channel.weight
            },
            update: {
              name: channel.name,
              baseUrl: channel.baseUrl,
              status,
              priority: channel.priority,
              weight: channel.weight,
              mainStationGroupName: channel.mainStationGroupName,
              ...(shouldResetUnverifiedRateGroup ? { groupName: 'default' } : {}),
              ...(shouldRefreshPlatformGroup ? { upstreamName: channel.platformGroupName } : {})
            }
          });
        }

        return tx.mainStation.update({
          where: { id: MAIN_STATION_ID },
          data: {
            lastSyncAt: syncedAt,
            lastError: null
          }
        });
      }, { timeout: 30_000, maxWait: 10_000 });
    }).catch(async (error) => {
      const message = isTransientDatabaseError(error)
        ? '数据库写入主站渠道超时，请稍后重试同步'
        : errorMessage(error);
      await this.prisma.mainStation.update({
        where: { id: MAIN_STATION_ID },
        data: { lastError: message }
      }).catch(() => undefined);
      throw new BadRequestException(message);
    });

    return {
      relay: toPublicStation(updatedStation),
      importedCount: imported.channels.length,
      syncedAt: syncedAt.toISOString()
    };
  }

  async listGroups() {
    await this.ensureSchema();
    const station = await this.requireConfiguredStation();
    const adminToken = decryptAdminToken(station.encryptedAdminToken as string);
    const [groupsResult, optionsResult] = await Promise.allSettled([
      requestNewApiJson<unknown>(station.baseUrl, '/api/group/', station.adminUserId, adminToken),
      requestNewApiJson<unknown>(station.baseUrl, '/api/option/', station.adminUserId, adminToken)
    ]);
    const ratios = parseMainStationGroupRatio(settledValue(optionsResult));
    const records = groupRecordsFromPayload(unwrapData(settledValue(groupsResult)));
    const groups = mergeMainStationGroups(records, ratios);

    if (groups.length === 0) {
      const error = settledError(groupsResult) ?? settledError(optionsResult);
      if (error) {
        throw new BadRequestException(error.message);
      }
    }

    return { groups };
  }

  async createGroup(input: MainStationGroupInput) {
    await this.ensureSchema();
    const name = input.name?.trim();
    const ratio = normalizeRatio(input.ratio, 1);

    if (!name) {
      throw new BadRequestException('请输入主站分组名称');
    }
    if (name.includes(',') || name.includes('，')) {
      throw new BadRequestException('主站分组名称不能包含逗号');
    }

    const station = await this.requireConfiguredStation();
    const adminToken = decryptAdminToken(station.encryptedAdminToken as string);
    const optionsPayload = await requestNewApiJson<unknown>(station.baseUrl, '/api/option/', station.adminUserId, adminToken)
      .catch((error) => {
        throw new BadRequestException(`读取主站分组配置失败：${errorMessage(error)}。请确认主站管理 Token 拥有 Root 权限`);
      });
    const ratios = parseMainStationGroupRatio(optionsPayload);
    const groupsPayload = await requestNewApiJson<unknown>(station.baseUrl, '/api/group/', station.adminUserId, adminToken).catch(() => undefined);
    for (const record of groupRecordsFromPayload(unwrapData(groupsPayload))) {
      setRatioIfMissing(ratios, groupNameFromRecord(record), 1);
    }
    setRatioIfMissing(ratios, 'default', 1);
    const existingName = Object.keys(ratios).find((key) => normalizeName(key) === normalizeName(name));
    const groupName = existingName ?? name;

    ratios[groupName] = existingName ? ratios[existingName] : ratio;

    await requestNewApiJson<unknown>(station.baseUrl, '/api/option/', station.adminUserId, adminToken, {
      method: 'PUT',
      body: JSON.stringify({
        key: 'GroupRatio',
        value: JSON.stringify(sortRatioMap(ratios))
      })
    }).catch((error) => {
      throw new BadRequestException(`创建主站分组失败：${errorMessage(error)}。请确认主站管理 Token 拥有 Root 权限`);
    });

    const groups = mergeMainStationGroups([], ratios);
    const group = groups.find((item) => normalizeName(item.name) === normalizeName(groupName)) ?? {
      name: groupName,
      ratio: ratios[groupName],
      source: 'NewAPI'
    };

    return { group, groups };
  }

  private async requireConfiguredStation() {
    await this.ensureSchema();
    const station = await this.prisma.mainStation.findUnique({
      where: { id: MAIN_STATION_ID }
    });

    if (!station || !station.baseUrl || !station.adminUserId || !station.encryptedAdminToken) {
      throw new BadRequestException('主站未配置：请先保存 NewAPI 地址、管理员用户 ID 和管理 Token');
    }

    return station;
  }

  private async ensureSchema() {
    if (this.schemaChecked) {
      return;
    }

    try {
      await this.prisma.$executeRawUnsafe('ALTER TABLE MainStation MODIFY COLUMN encryptedAdminToken TEXT NULL');
      await this.prisma.$executeRawUnsafe('ALTER TABLE MainStation MODIFY COLUMN lastError TEXT NULL');
    } catch (error) {
      if (!/Unknown column|syntax/i.test(errorMessage(error))) {
        throw error;
      }
    }

    this.schemaChecked = true;
  }
}

function toPublicStation(station: MainStation | null) {
  if (!station) {
    return {
      id: MAIN_STATION_ID,
      name: '主站',
      baseUrl: '待配置',
      auth: '管理 Token',
      adminUserId: '',
      tokenConfigured: false,
      lastSyncAt: null,
      lastError: null
    };
  }

  return {
    id: station.id,
    name: station.name,
    baseUrl: station.baseUrl || '待配置',
    auth: station.auth,
    adminUserId: station.adminUserId,
    tokenConfigured: Boolean(station.encryptedAdminToken),
    lastSyncAt: station.lastSyncAt?.toISOString() ?? null,
    lastError: station.lastError
  };
}

function decryptAdminToken(encryptedAdminToken: string) {
  const payload = decryptCredentialPayload(encryptedAdminToken);
  const adminToken = payload.adminToken?.trim();

  if (!adminToken) {
    throw new BadRequestException('admin token is invalid');
  }

  return adminToken;
}

async function fetchNewApiChannels(baseUrl: string, adminUserId: string, token: string) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/channel/?p=0&page_size=1000`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'new-api-user': adminUserId
      },
      signal: controller.signal
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false as const,
        message: `NewAPI 返回 HTTP ${response.status}: ${clip(text)}`
      };
    }

    if (isChallenge(text)) {
      return {
        ok: false as const,
        message: 'NewAPI 主站返回 Cloudflare/验证码页面，无法通过服务器同步'
      };
    }

    const payload = JSON.parse(text) as unknown;
    const records = extractChannelRecords(payload);

    return {
      ok: true as const,
      channels: records.map((record, index) => toImportedChannel(record, index))
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '请求超时' : errorMessage(error);
    return {
      ok: false as const,
      message: `请求 NewAPI 渠道接口失败：${message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestNewApiJson<T>(
  baseUrl: string,
  path: string,
  adminUserId: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${stripBearer(token)}`);
  headers.set('new-api-user', adminUserId);

  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });
    const text = await response.text();

    if (isChallenge(text)) {
      throw new Error('NewAPI 主站返回 Cloudflare/验证码页面');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${clip(text)}`);
    }

    const payload = text ? JSON.parse(text) as unknown : {};
    const record = recordValue(payload);
    const code = numeric(record?.code);

    if (record?.success === false) {
      throw new Error(stringValue(record.message) ?? 'NewAPI 主站接口返回失败');
    }
    if (code !== undefined && code !== 0) {
      throw new Error(stringValue(record?.message) ?? stringValue(record?.reason) ?? `NewAPI 主站返回 code ${code}`);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMainStationGroupRatio(payload: unknown) {
  const direct = recordValue(payload);
  const data = unwrapData(payload);
  const optionValue =
    optionValueByKey(data, 'GroupRatio') ??
    optionValueByKey(direct, 'GroupRatio') ??
    direct?.GroupRatio ??
    direct?.group_ratio;

  return parseRatioMap(optionValue);
}

function optionValueByKey(value: unknown, key: string) {
  const records = arrayOfRecords(value);
  const matched = records.find((record) => stringValue(record.key)?.toLowerCase() === key.toLowerCase());

  return matched?.value;
}

function parseRatioMap(value: unknown): Record<string, number> {
  if (typeof value === 'string') {
    try {
      return parseRatioMap(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }

  const record = recordValue(value);
  if (!record) {
    return {};
  }

  const entries = Object.entries(record)
    .map(([key, item]) => [key.trim(), numeric(item) ?? numeric(recordValue(item)?.ratio) ?? 1] as const)
    .filter(([key]) => Boolean(key));

  return Object.fromEntries(entries);
}

function groupRecordsFromPayload(value: unknown): Array<Record<string, unknown>> {
  const data = unwrapData(value);
  const direct = arrayOfRecords(data);

  if (direct.length > 0) {
    return direct;
  }

  const record = recordValue(data);
  if (!record) {
    return [];
  }

  for (const key of ['items', 'list', 'groups', 'data', 'rows', 'records']) {
    const records = arrayOfRecords(record[key]);
    if (records.length > 0) {
      return records;
    }
  }

  return Object.entries(record)
    .map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { name: key, ...(value as Record<string, unknown>) };
      }

      return { name: key, ratio: value };
    })
    .filter((record) => Boolean(groupNameFromRecord(record)));
}

function mergeMainStationGroups(records: Array<Record<string, unknown>>, ratioMap: Record<string, number>): MainStationGroupInfo[] {
  const groups = new Map<string, MainStationGroupInfo>();

  for (const record of records) {
    const name = groupNameFromRecord(record);
    if (!name) {
      continue;
    }

    const ratio = numeric(record.ratio) ?? numeric(record.group_ratio) ?? ratioMap[name] ?? ratioFromNormalizedName(ratioMap, name);
    groups.set(normalizeName(name), {
      name,
      ratio: ratio ?? null,
      source: 'NewAPI'
    });
  }

  for (const [name, ratio] of Object.entries(ratioMap)) {
    const key = normalizeName(name);
    const existing = groups.get(key);

    groups.set(key, {
      name: existing?.name ?? name,
      ratio: existing?.ratio ?? ratio,
      source: 'NewAPI'
    });
  }

  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
}

function groupNameFromRecord(record: Record<string, unknown>) {
  return stringValue(record.name) ??
    stringValue(record.group) ??
    stringValue(record.group_name) ??
    stringValue(record.groupName) ??
    stringValue(record.key) ??
    stringValue(record.id);
}

function ratioFromNormalizedName(map: Record<string, number>, name: string) {
  const matchedKey = Object.keys(map).find((key) => normalizeName(key) === normalizeName(name));
  return matchedKey ? map[matchedKey] : undefined;
}

function setRatioIfMissing(map: Record<string, number>, rawName: string | undefined, ratio: number) {
  const name = rawName?.trim();

  if (!name) {
    return;
  }

  const exists = Object.keys(map).some((key) => normalizeName(key) === normalizeName(name));
  if (!exists) {
    map[name] = ratio;
  }
}

function normalizeRatio(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sortRatioMap(map: Record<string, number>) {
  return Object.fromEntries(Object.entries(map).sort(([left], [right]) => left.localeCompare(right, 'zh-CN', { numeric: true })));
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function settledValue<T>(result: PromiseSettledResult<T>) {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function settledError(result: PromiseSettledResult<unknown>) {
  return result.status === 'rejected' ? (result.reason instanceof Error ? result.reason : new Error(String(result.reason))) : undefined;
}

function toImportedChannel(record: Record<string, unknown>, index: number): ImportedChannel {
  const rawId = stringValue(record.id) ?? String(index + 1);
  const name = stringValue(record.name) ?? `渠道 ${rawId}`;
  const baseUrl = stringValue(record.base_url) ?? stringValue(record.baseUrl) ?? '-';
  const status = numeric(record.status);
  const enabled = status === 1 || status === undefined;
  const nameParts = splitChannelName(name);

  return {
    id: `channel-newapi-${rawId}`,
    name,
    groupName: 'default',
    mainStationGroupName: stringValue(record.group) ?? firstGroup(record.groups) ?? null,
    platformGroupName: nameParts.platformGroupName,
    type: inferUpstreamType(name, baseUrl),
    baseUrl,
    status: enabled ? UpstreamStatus.LIMITED : UpstreamStatus.DISABLED,
    priority: numeric(record.priority) ?? index + 1,
    weight: numeric(record.weight) ?? 0
  };
}

function firstGroup(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === 'string' && item.trim() !== '') ?? null;
  }

  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).find(Boolean) ?? null : null;
}

function splitChannelName(name: string) {
  const normalized = name.trim();
  const split = splitByNameSuffix(normalized);

  if (!split) {
    return { platformGroupName: normalized, keyName: null };
  }

  return { platformGroupName: split.prefix, keyName: split.suffix };
}

function splitByNameSuffix(value: string) {
  const index = value.search(/[-_]/);

  if (index < 1) {
    return null;
  }

  const prefix = value.slice(0, index).trim();
  const suffix = value.slice(index + 1).trim();

  return prefix && suffix ? { prefix, suffix } : null;
}

function inferUpstreamType(name: string, baseUrl: string) {
  return /sub2api/i.test(`${name} ${baseUrl}`) ? UpstreamType.SUB2API : UpstreamType.NEWAPI;
}

function defaultAuthMode(type: UpstreamType) {
  return type === UpstreamType.SUB2API ? AuthMode.PASSWORD : AuthMode.PASSWORD;
}

function extractChannelRecords(payload: unknown): Array<Record<string, unknown>> {
  const data = unwrapData(payload);
  const candidates = [
    data,
    recordValue(data)?.items,
    recordValue(data)?.channels,
    recordValue(data)?.data,
    recordValue(recordValue(data)?.data)?.items
  ];

  for (const candidate of candidates) {
    const records = arrayOfRecords(candidate);
    if (records.length > 0) {
      return records;
    }
  }

  return [];
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function stripBearer(token: string) {
  return token.replace(/^Bearer\s+/i, '').trim();
}

function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: unknown }).data;
  }

  return payload;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
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
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function trimOrDefault(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function trimOrNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

async function retryTransientDatabase<T>(operation: () => Promise<T>, retries = 2) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === retries) {
        throw error;
      }
      await wait(150 * (attempt + 1));
    }
  }

  throw lastError;
}

function isTransientDatabaseError(error: unknown) {
  const message = errorMessage(error);

  return /Server has closed the connection|Transaction already closed|P1017|P2028/i.test(message);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isChallenge(text: string) {
  return /cloudflare|turnstile|captcha|challenge/i.test(text);
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
