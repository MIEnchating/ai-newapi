import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthMode, Prisma, UpstreamStatus, UpstreamType } from '@prisma/client';
import { decryptCredentialPayload, encryptCredentialPayload } from '../vault/credential-vault';
import { PrismaService } from '../prisma.service';
import { SyncQueueService } from './sync-queue.service';

const upstreamTypes = new Set(Object.values(UpstreamType));
const authModes = new Set(Object.values(AuthMode));
const upstreamStatuses = new Set(Object.values(UpstreamStatus));
const upstreamInclude = {
  credential: {
    select: {
      id: true
    }
  },
  _count: {
    select: {
      rateSnapshots: true,
      rateChangeEvents: true
    }
  },
  rateSnapshots: {
    orderBy: { capturedAt: 'desc' },
    take: 200
  }
} satisfies Prisma.UpstreamInclude;

type UpstreamInput = {
  id?: string;
  name: string;
  type: string;
  baseUrl: string;
  authMode: string;
  groupName?: string;
  mainStationGroupName?: string;
  upstreamName?: string;
  upstreamUserId?: string;
  keyName?: string;
  skipLatencyDisable?: boolean;
  status?: string;
  rechargeRatio?: number;
  priority?: number;
  weight?: number;
  credential?: Record<string, string>;
  clearCredential?: boolean;
  syncGroupRechargeRatio?: boolean;
  createMainStation?: boolean;
  mainStationKey?: string;
  mainStationChannelType?: number;
  models?: string;
};

type UpstreamGroupTarget = {
  id: string;
  name: string;
  type: UpstreamType;
  authMode: AuthMode;
  upstreamName: string | null;
  upstreamUserId: string | null;
  rechargeRatio?: unknown;
  credential?: unknown;
};

type CredentialTestResult = {
  ok: boolean;
  status: 'ok' | 'limited' | 'error';
  message: string;
  balance?: number;
  balanceCurrency?: string;
  groupRatio?: number | null;
  rateSource?: string;
  suggestedRechargeRatio?: number | null;
};

type UpstreamGroupInfo = {
  id?: string;
  name: string;
  remark?: string;
  ratio?: number | null;
  source: string;
};

type MainStationChannelPatch = {
  name?: string;
  baseUrl?: string;
  groupName?: string;
  priority?: number;
  weight?: number;
  enabled?: boolean;
  models?: string;
};

@Injectable()
export class UpstreamsService {
  private schemaChecked = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncQueue: SyncQueueService
  ) {}

  async list() {
    await this.ensureSchema();

    const upstreams = await this.prisma.upstream.findMany({
      orderBy: { id: 'asc' },
      include: upstreamInclude
    });

    return this.attachSkipLatencyDisableList(upstreams);
  }

  async create(input: UpstreamInput) {
    await this.ensureSchema();

    const type = parseUpstreamType(input.type);
    const authMode = parseAuthMode(input.authMode);
    let id = trimOrNull(input.id);
    const name = input.name?.trim();
    const baseUrl = input.baseUrl?.trim();

    if (!name || !baseUrl) {
      throw new BadRequestException('name and baseUrl are required');
    }

    if (!id && input.createMainStation) {
      id = await this.createMainStationChannel({
        name,
        type,
        baseUrl,
        key: input.mainStationKey,
        groupName: input.mainStationGroupName,
        priority: input.priority,
        weight: input.weight,
        channelType: input.mainStationChannelType,
        models: input.models
      });
    }

    const data = {
      name,
      type,
      baseUrl,
      authMode,
      groupName: trimOrDefault(input.groupName, 'default'),
      mainStationGroupName: trimOrNull(input.mainStationGroupName),
      upstreamName: trimOrNull(input.upstreamName),
      upstreamUserId: trimOrNull(input.upstreamUserId),
      keyName: trimOrNull(input.keyName),
      status: input.status !== undefined ? parseUpstreamStatus(input.status) : undefined,
      priority: normalizeInteger(input.priority, 50),
      weight: normalizeInteger(input.weight, 0)
    };
    const encryptedPayload = input.credential ? encryptCredentialPayload(input.credential) : undefined;
    const credential = encryptedPayload
      ? {
          create: {
            encryptedPayload
          }
        }
      : undefined;
    let upstream;

    if (id) {
      upstream = await this.prisma.upstream.upsert({
        where: { id },
        create: {
          id,
          ...data,
          credential
        },
        update: encryptedPayload
          ? {
              ...data,
              credential: {
                upsert: {
                  create: {
                    encryptedPayload
                  },
                  update: {
                    encryptedPayload
                  }
                }
              }
            }
          : data,
        include: upstreamInclude
      });
    } else {
      upstream = await this.prisma.upstream.create({
        data: {
          ...data,
          credential
        },
        include: upstreamInclude
      });
    }

    await this.setRechargeRatio(upstream.id, normalizeRechargeRatio(input.rechargeRatio, 1));
    await this.setSkipLatencyDisable(upstream.id, input.skipLatencyDisable === true);

    return encryptedPayload ? this.applyGroupCredential(upstream, encryptedPayload) : this.inheritGroupCredential(upstream);
  }

  async update(id: string, input: Partial<UpstreamInput>) {
    await this.ensureSchema();

    const existing = await this.prisma.upstream.findUnique({
      where: { id },
      include: {
        credential: {
          select: {
            id: true
          }
        }
      }
    });

    if (!existing) {
      throw new BadRequestException('upstream not found');
    }

    const data: Prisma.UpstreamUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException('name is required');
      }
      data.name = name;
    }
    if (input.type !== undefined) {
      data.type = parseUpstreamType(input.type);
    }
    if (input.baseUrl !== undefined) {
      const baseUrl = input.baseUrl.trim();
      if (!baseUrl) {
        throw new BadRequestException('baseUrl is required');
      }
      data.baseUrl = baseUrl;
    }
    if (input.authMode !== undefined) {
      data.authMode = parseAuthMode(input.authMode);
    }
    if (input.groupName !== undefined) {
      data.groupName = trimOrDefault(input.groupName, 'default');
    }
    if (input.mainStationGroupName !== undefined) {
      data.mainStationGroupName = trimOrNull(input.mainStationGroupName);
    }
    if (input.upstreamName !== undefined) {
      data.upstreamName = trimOrNull(input.upstreamName);
    }
    if (input.upstreamUserId !== undefined) {
      data.upstreamUserId = trimOrNull(input.upstreamUserId);
    }
    if (input.keyName !== undefined) {
      data.keyName = trimOrNull(input.keyName);
    }
    const inputStatus = input.status !== undefined ? parseUpstreamStatus(input.status) : undefined;
    if (inputStatus !== undefined) {
      data.status = inputStatus;
    }
    if (input.priority !== undefined) {
      data.priority = normalizeInteger(input.priority, existing.priority);
    }
    if (input.weight !== undefined) {
      data.weight = normalizeInteger(input.weight, existing.weight);
    }
    const encryptedPayload = input.credential && Object.keys(input.credential).length > 0
      ? encryptCredentialPayload(input.credential)
      : undefined;

    if (input.clearCredential && existing.credential) {
      data.credential = {
        delete: true
      };
    } else if (encryptedPayload) {
      data.credential = {
        upsert: {
          create: { encryptedPayload },
          update: { encryptedPayload }
        }
      };
    }

    const shouldRecoverLatencyDisabled =
      input.skipLatencyDisable === true &&
      existing.disabledByLatency &&
      inputStatus !== UpstreamStatus.DISABLED;

    if (shouldRecoverLatencyDisabled) {
      data.status = inputStatus ?? UpstreamStatus.LIMITED;
      data.disabledByLatency = false;
      data.latencyDisabledAt = null;
    }

    await this.updateMainStationChannelIfNeeded(
      existing,
      shouldRecoverLatencyDisabled && inputStatus === undefined ? { ...input, status: UpstreamStatus.LIMITED } : input
    );

    const upstream = await this.prisma.upstream.update({
      where: { id },
      data,
      include: upstreamInclude
    });
    if (input.skipLatencyDisable !== undefined) {
      await this.setSkipLatencyDisable(upstream.id, input.skipLatencyDisable === true);
    }
    if (input.rechargeRatio !== undefined) {
      await this.setRechargeRatio(upstream.id, normalizeRechargeRatio(input.rechargeRatio, existing.rechargeRatio));
    }

    if (input.syncGroupRechargeRatio && input.rechargeRatio !== undefined) {
      await this.syncGroupRechargeRatio(upstream, normalizeRechargeRatio(input.rechargeRatio, existing.rechargeRatio));
    }

    if (input.clearCredential) {
      return this.clearGroupCredential(upstream);
    }

    return encryptedPayload ? this.applyGroupCredential(upstream, encryptedPayload) : this.inheritGroupCredential(upstream);
  }

  async sync(id: string) {
    const upstream = await this.prisma.upstream.findUnique({ where: { id } });

    if (!upstream) {
      throw new BadRequestException('upstream not found');
    }

    const job = await this.syncQueue.enqueue(id);

    return {
      queued: true,
      jobId: job.id,
      upstreamId: id
    };
  }

  async testCredential(id: string, input: Partial<UpstreamInput>): Promise<CredentialTestResult> {
    const upstream = await this.prisma.upstream.findUnique({
      where: { id },
      include: {
        credential: true
      }
    });

    if (!upstream) {
      throw new BadRequestException('upstream not found');
    }

    const type = input.type ? parseUpstreamType(input.type) : upstream.type;
    const authMode = input.authMode ? parseAuthMode(input.authMode) : upstream.authMode;
    const baseUrl = input.baseUrl?.trim() || upstream.baseUrl;
    const upstreamUserId = input.upstreamUserId !== undefined ? trimOrNull(input.upstreamUserId) : upstream.upstreamUserId;
    const credential = input.credential && Object.keys(input.credential).length > 0
      ? input.credential
      : upstream.credential
        ? decryptCredentialPayload(upstream.credential.encryptedPayload)
        : {};

    try {
      if (type === UpstreamType.SUB2API) {
        return await testSub2ApiCredential(baseUrl, authMode, credential, upstream.groupName);
      }

      return await testNewApiCredential(baseUrl, authMode, credential, upstreamUserId, upstream.groupName);
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        message: errorMessage(error)
      };
    }
  }

  async testDraftCredential(input: Partial<UpstreamInput>): Promise<CredentialTestResult> {
    const type = input.type ? parseUpstreamType(input.type) : null;
    const authMode = input.authMode ? parseAuthMode(input.authMode) : null;
    const baseUrl = input.baseUrl?.trim();
    const upstreamUserId = trimOrNull(input.upstreamUserId);
    const credential = input.credential && Object.keys(input.credential).length > 0 ? input.credential : {};
    const groupName = trimOrDefault(input.groupName, 'default');

    if (!type || !authMode || !baseUrl) {
      throw new BadRequestException('type, baseUrl and authMode are required');
    }

    try {
      if (type === UpstreamType.SUB2API) {
        return await testSub2ApiCredential(baseUrl, authMode, credential, groupName);
      }

      return await testNewApiCredential(baseUrl, authMode, credential, upstreamUserId, groupName);
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        message: errorMessage(error)
      };
    }
  }

  async listGroups(id: string, input: Partial<UpstreamInput>): Promise<{ groups: UpstreamGroupInfo[] }> {
    const upstream = await this.prisma.upstream.findUnique({
      where: { id },
      include: {
        credential: true
      }
    });

    if (!upstream) {
      throw new BadRequestException('upstream not found');
    }

    const type = input.type ? parseUpstreamType(input.type) : upstream.type;
    const authMode = input.authMode ? parseAuthMode(input.authMode) : upstream.authMode;
    const baseUrl = input.baseUrl?.trim() || upstream.baseUrl;
    const upstreamUserId = input.upstreamUserId !== undefined ? trimOrNull(input.upstreamUserId) : upstream.upstreamUserId;
    const credential = input.credential && Object.keys(input.credential).length > 0
      ? input.credential
      : upstream.credential
        ? decryptCredentialPayload(upstream.credential.encryptedPayload)
        : {};

    if (type === UpstreamType.SUB2API) {
      return { groups: await listSub2ApiGroups(baseUrl, authMode, credential) };
    }

    return { groups: await listNewApiGroups(baseUrl, authMode, credential, upstreamUserId) };
  }

  async listDraftGroups(input: Partial<UpstreamInput>): Promise<{ groups: UpstreamGroupInfo[] }> {
    const type = input.type ? parseUpstreamType(input.type) : null;
    const authMode = input.authMode ? parseAuthMode(input.authMode) : null;
    const baseUrl = input.baseUrl?.trim();
    const upstreamUserId = trimOrNull(input.upstreamUserId);
    const credential = input.credential && Object.keys(input.credential).length > 0 ? input.credential : {};

    if (!type || !authMode || !baseUrl) {
      throw new BadRequestException('type, baseUrl and authMode are required');
    }

    if (type === UpstreamType.SUB2API) {
      return { groups: await listSub2ApiGroups(baseUrl, authMode, credential) };
    }

    return { groups: await listNewApiGroups(baseUrl, authMode, credential, upstreamUserId) };
  }

  rates(id: string) {
    return this.prisma.rateSnapshot.findMany({
      where: { upstreamId: id },
      orderBy: { capturedAt: 'desc' },
      take: 200
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.upstream.findUnique({ where: { id } });

    if (!existing) {
      throw new BadRequestException('upstream not found');
    }

    await this.prisma.upstream.delete({ where: { id } });
    return { deleted: true, upstreamId: id };
  }

  private async applyGroupCredential(upstream: UpstreamGroupTarget, encryptedPayload: string) {
    const targets = await this.groupTargets(upstream);
    const targetIds = targets.map((target) => target.id);

    await this.prisma.$transaction([
      this.prisma.upstream.updateMany({
        where: { id: { in: targetIds } },
        data: {
          authMode: upstream.authMode,
          upstreamUserId: upstream.upstreamUserId
        }
      }),
      ...targetIds.map((upstreamId) =>
        this.prisma.credential.upsert({
          where: { upstreamId },
          create: { upstreamId, encryptedPayload },
          update: { encryptedPayload }
        })
      )
    ]);

    return this.findIncluded(upstream.id);
  }

  private async inheritGroupCredential(upstream: UpstreamGroupTarget) {
    if (upstream.credential) {
      await this.syncGroupAuth(upstream);
      return this.findIncluded(upstream.id);
    }

    const targets = await this.groupTargets(upstream);
    const source = targets.find((target) => target.id !== upstream.id && target.credential);

    if (!source?.credential) {
      await this.syncGroupAuth(upstream, targets.map((target) => target.id));
      return this.findIncluded(upstream.id);
    }

    await this.prisma.$transaction([
      this.prisma.upstream.update({
        where: { id: upstream.id },
        data: {
          authMode: source.authMode,
          upstreamUserId: source.upstreamUserId
        }
      }),
      this.prisma.credential.upsert({
        where: { upstreamId: upstream.id },
        create: { upstreamId: upstream.id, encryptedPayload: source.credential.encryptedPayload },
        update: { encryptedPayload: source.credential.encryptedPayload }
      })
    ]);

    return this.findIncluded(upstream.id);
  }

  private async syncGroupAuth(upstream: UpstreamGroupTarget, targetIds?: string[]) {
    const ids = targetIds ?? (await this.groupTargets(upstream)).map((target) => target.id);

    await this.prisma.upstream.updateMany({
      where: { id: { in: ids } },
      data: {
        authMode: upstream.authMode,
        upstreamUserId: upstream.upstreamUserId
      }
    });
  }

  private async syncGroupRechargeRatio(upstream: UpstreamGroupTarget, rechargeRatio: number) {
    const targetIds = (await this.groupTargets(upstream)).map((target) => target.id);

    await Promise.all(targetIds.map((upstreamId) => this.setRechargeRatio(upstreamId, rechargeRatio)));
  }

  private async clearGroupCredential(upstream: UpstreamGroupTarget) {
    const targetIds = (await this.groupTargets(upstream)).map((target) => target.id);

    await this.prisma.credential.deleteMany({
      where: { upstreamId: { in: targetIds } }
    });

    return this.findIncluded(upstream.id);
  }

  private async groupTargets(upstream: UpstreamGroupTarget) {
    const groupName = platformGroupName(upstream);
    const candidates = await this.prisma.upstream.findMany({
      where: { type: upstream.type },
      select: {
        id: true,
        name: true,
        type: true,
        authMode: true,
        upstreamName: true,
        upstreamUserId: true,
        credential: {
          select: {
            encryptedPayload: true
          }
        }
      }
    });

    return candidates.filter((candidate) => platformGroupName(candidate) === groupName);
  }

  private async createMainStationChannel(input: {
    name: string;
    type: UpstreamType;
    baseUrl: string;
    key?: string;
    groupName?: string;
    priority?: number;
    weight?: number;
    channelType?: number;
    models?: string;
  }) {
    const station = await this.prisma.mainStation.findUnique({
      where: { id: 'relay-newapi-main' }
    });

    if (!station || !station.baseUrl || !station.adminUserId || !station.encryptedAdminToken) {
      throw new BadRequestException('主站未配置：请先保存 NewAPI 地址、管理员用户 ID 和管理 Token');
    }

    const key = input.key?.trim();
    if (!key) {
      throw new BadRequestException('请输入主站调用 Key，用于在主站创建渠道');
    }

    const adminToken = decryptAdminToken(station.encryptedAdminToken);
    const created = await postNewApiChannel(station.baseUrl, station.adminUserId, adminToken, {
      name: input.name,
      type: input.channelType ?? 1,
      key,
      baseUrl: input.baseUrl,
      groups: [trimOrDefault(input.groupName, 'default')],
      models: input.models,
      priority: normalizeInteger(input.priority, 50),
      weight: normalizeInteger(input.weight, 0),
      enabled: true
    });

    return created.id ? `channel-newapi-${created.id}` : null;
  }

  private async setRechargeRatio(upstreamId: string, rechargeRatio: number) {
    await this.prisma.$executeRaw`
      UPDATE Upstream
      SET rechargeRatio = ${rechargeRatio},
          updatedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ${upstreamId}
    `;
  }

  private async setSkipLatencyDisable(upstreamId: string, skipLatencyDisable: boolean) {
    await this.prisma.$executeRaw`
      UPDATE Upstream
      SET skipLatencyDisable = ${skipLatencyDisable},
          updatedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ${upstreamId}
    `;
  }

  private async ensureSchema() {
    if (this.schemaChecked) {
      return;
    }

    for (const statement of [
      'ALTER TABLE Upstream MODIFY COLUMN rechargeRatio DECIMAL(10,2) NOT NULL DEFAULT 1',
      'ALTER TABLE Upstream ADD COLUMN skipLatencyDisable BOOLEAN NOT NULL DEFAULT false'
    ]) {
      try {
        await this.prisma.$executeRawUnsafe(statement);
      } catch (error) {
        if (!/Unknown column|Duplicate column|1060|1061|already|syntax/i.test(errorMessage(error))) {
          throw error;
        }
      }
    }

    this.schemaChecked = true;
  }

  private async updateMainStationChannelIfNeeded(
    existing: {
      id: string;
      name: string;
      baseUrl: string;
      mainStationGroupName: string | null;
      status: UpstreamStatus;
      priority: number;
      weight: number;
    },
    input: Partial<UpstreamInput>
  ) {
    const channelId = mainStationChannelIdFromUpstreamId(existing.id);

    if (!channelId) {
      return;
    }

    const patch = mainStationPatchFromInput(existing, input);

    if (Object.keys(patch).length === 0) {
      return;
    }

    const station = await this.prisma.mainStation.findUnique({
      where: { id: 'relay-newapi-main' }
    });

    if (!station || !station.baseUrl || !station.adminUserId || !station.encryptedAdminToken) {
      throw new BadRequestException('主站未配置：无法把渠道配置写回主站');
    }

    try {
      await putNewApiChannel(station.baseUrl, station.adminUserId, decryptAdminToken(station.encryptedAdminToken), channelId, patch);
    } catch (error) {
      throw new BadRequestException(`主站渠道更新失败：${errorMessage(error)}`);
    }
  }

  private async findIncluded(id: string) {
    const upstream = await this.prisma.upstream.findUniqueOrThrow({
      where: { id },
      include: upstreamInclude
    });

    return this.attachSkipLatencyDisable(upstream);
  }

  private async attachSkipLatencyDisable<T extends { id: string }>(upstream: T) {
    const [row] = await this.prisma.$queryRaw<Array<{ skipLatencyDisable: boolean | number | null }>>`
      SELECT skipLatencyDisable
      FROM Upstream
      WHERE id = ${upstream.id}
      LIMIT 1
    `;

    return {
      ...upstream,
      skipLatencyDisable: Boolean(row?.skipLatencyDisable)
    };
  }

  private async attachSkipLatencyDisableList<T extends { id: string }>(upstreams: T[]) {
    if (upstreams.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string; skipLatencyDisable: boolean | number | null }>>`
      SELECT id, skipLatencyDisable
      FROM Upstream
      WHERE id IN (${Prisma.join(upstreams.map((upstream) => upstream.id))})
    `;
    const skipById = new Map(rows.map((row) => [row.id, Boolean(row.skipLatencyDisable)]));

    return upstreams.map((upstream) => ({
      ...upstream,
      skipLatencyDisable: skipById.get(upstream.id) ?? false
    }));
  }
}

function mainStationPatchFromInput(
  existing: {
    name: string;
    baseUrl: string;
    mainStationGroupName: string | null;
    status: UpstreamStatus;
    priority: number;
    weight: number;
  },
  input: Partial<UpstreamInput>
) {
  const patch: MainStationChannelPatch = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name && name !== existing.name) {
      patch.name = name;
    }
  }
  if (input.baseUrl !== undefined) {
    const baseUrl = input.baseUrl.trim();
    if (baseUrl && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(existing.baseUrl)) {
      patch.baseUrl = baseUrl;
    }
  }
  if (input.mainStationGroupName !== undefined) {
    const groupName = trimOrDefault(input.mainStationGroupName, 'default');
    if (groupName !== trimOrDefault(existing.mainStationGroupName ?? undefined, 'default')) {
      patch.groupName = groupName;
    }
  }
  if (input.priority !== undefined) {
    const priority = normalizeInteger(input.priority, existing.priority);
    if (priority !== existing.priority) {
      patch.priority = priority;
    }
  }
  if (input.weight !== undefined) {
    const weight = normalizeInteger(input.weight, existing.weight);
    if (weight !== existing.weight) {
      patch.weight = weight;
    }
  }
  if (input.status !== undefined) {
    const status = parseUpstreamStatus(input.status);
    const enabled = status !== UpstreamStatus.DISABLED;
    if (enabled !== (existing.status !== UpstreamStatus.DISABLED)) {
      patch.enabled = enabled;
    }
  }
  if (input.models !== undefined) {
    const models = input.models.trim();
    if (models) {
      patch.models = models;
    }
  }

  return patch;
}

function mainStationChannelIdFromUpstreamId(id: string) {
  return /^channel-newapi-(.+)$/.exec(id)?.[1] ?? null;
}

function decryptAdminToken(encryptedAdminToken: string) {
  const payload = decryptCredentialPayload(encryptedAdminToken);
  const adminToken = payload.adminToken?.trim();

  if (!adminToken) {
    throw new BadRequestException('admin token is invalid');
  }

  return adminToken;
}

async function putNewApiChannel(
  baseUrl: string,
  adminUserId: string,
  adminToken: string,
  channelId: string,
  input: MainStationChannelPatch
) {
  const headers = new Headers({ 'New-Api-User': adminUserId });
  const body: Record<string, unknown> = {
    id: /^\d+$/.test(channelId) ? Number(channelId) : channelId
  };

  if (input.name !== undefined) {
    body.name = input.name;
  }
  if (input.baseUrl !== undefined) {
    body.base_url = normalizeBaseUrl(input.baseUrl);
  }
  if (input.groupName !== undefined) {
    body.groups = [input.groupName];
    body.group = input.groupName;
  }
  if (input.priority !== undefined) {
    body.priority = input.priority;
  }
  if (input.weight !== undefined) {
    body.weight = input.weight;
  }
  if (input.enabled !== undefined) {
    body.status = input.enabled ? 1 : 2;
  }
  if (input.models !== undefined) {
    body.models = input.models;
  }

  await requestJson<unknown>(baseUrl, '/api/channel/', {
    method: 'PUT',
    token: adminToken,
    headers,
    body: JSON.stringify(body)
  });
}

async function postNewApiChannel(
  baseUrl: string,
  adminUserId: string,
  adminToken: string,
  input: {
    name: string;
    type: number;
    key: string;
    baseUrl: string;
    groups: string[];
    models?: string;
    priority: number;
    weight: number;
    enabled: boolean;
  }
) {
  const headers = new Headers({ 'New-Api-User': adminUserId });
  const payload = await requestJson<unknown>(baseUrl, '/api/channel/', {
    method: 'POST',
    token: adminToken,
    headers,
    body: JSON.stringify({
      mode: 'single',
      channel: {
        name: input.name,
        type: input.type,
        key: input.key,
        base_url: normalizeBaseUrl(input.baseUrl),
        models: input.models?.trim() || undefined,
        groups: input.groups,
        group: input.groups[0] ?? 'default',
        priority: input.priority,
        weight: input.weight,
        status: input.enabled ? 1 : 2
      }
    })
  });
  const id = channelIdFromPayload(payload) ?? await findNewApiChannelId(baseUrl, adminUserId, adminToken, input.name);

  return { id };
}

async function findNewApiChannelId(baseUrl: string, adminUserId: string, adminToken: string, name: string) {
  const headers = new Headers({ 'New-Api-User': adminUserId });
  const payload = await requestJson<unknown>(baseUrl, '/api/channel/?p=0&page_size=1000', {
    token: adminToken,
    headers
  });
  const records = channelRecordsFromPayload(payload);
  const matched = records.find((record) => stringValue(record.name)?.trim() === name);

  return channelIdFromRecord(matched);
}

function channelIdFromPayload(payload: unknown) {
  const data = unwrapData(payload);
  const record = recordValue(data) ?? recordValue(payload);

  return channelIdFromRecord(record);
}

function channelIdFromRecord(record: Record<string, unknown> | undefined) {
  const id = stringValue(record?.id ?? record?.channel_id ?? record?.channelId);
  return id?.trim();
}

function channelRecordsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  const data = unwrapData(payload);
  const candidates = [
    data,
    recordValue(data)?.items,
    recordValue(data)?.channels,
    recordValue(data)?.data,
    recordValue(recordValue(data)?.data)?.items
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    }
  }

  return [];
}

function parseUpstreamType(value: string) {
  const type = value.toUpperCase() as UpstreamType;

  if (!upstreamTypes.has(type)) {
    throw new BadRequestException('unsupported upstream type');
  }

  return type;
}

function parseAuthMode(value: string) {
  const authMode = value.toUpperCase() as AuthMode;

  if (!authModes.has(authMode)) {
    throw new BadRequestException('unsupported auth mode');
  }

  return authMode;
}

function parseUpstreamStatus(value: string) {
  const status = value.toUpperCase() as UpstreamStatus;

  if (!upstreamStatuses.has(status)) {
    throw new BadRequestException('unsupported upstream status');
  }

  return status;
}

function trimOrDefault(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function trimOrNull(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeRechargeRatio(value: unknown, fallback: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  const fallbackParsed = typeof fallback === 'number' ? fallback : Number(fallback);
  const next = Number.isFinite(parsed) && parsed >= 0.01
    ? parsed
    : Number.isFinite(fallbackParsed) && fallbackParsed >= 0.01
      ? fallbackParsed
      : 1;

  return Math.round(next * 100) / 100;
}

function platformGroupName(upstream: { name: string; upstreamName: string | null }) {
  const upstreamName = upstream.upstreamName?.trim();
  const name = upstream.name.trim();

  if (upstreamName && upstreamName !== name) {
    return upstreamName;
  }

  return splitByNameSuffix(name)?.prefix ?? upstreamName ?? name;
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

async function testNewApiCredential(
  baseUrl: string,
  authMode: AuthMode,
  credential: Record<string, string>,
  upstreamUserId: string | null,
  groupName: string
): Promise<CredentialTestResult> {
  const token = credential.adminToken ?? credential.token ?? credential.bearerToken;

  if (!token) {
    throw new Error('请输入 NewAPI 认证信息');
  }

  const statusPayload = await requestJson<unknown>(baseUrl, '/api/status').catch(() => null);
  const status = recordValue(unwrapData(statusPayload)) ?? {};
  const quotaPerUnit = numeric(status.quota_per_unit) ?? 500000;
  const suggestedRechargeRatio = suggestRechargeRatio(quotaPerUnit);

  if (authMode === AuthMode.API_KEY) {
    await requestJson<unknown>(baseUrl, '/v1/models', { token });
    return {
      ok: true,
      status: 'limited',
      message: 'API Key 可用，但 NewAPI API Key 通常不能读取余额和倍率',
      suggestedRechargeRatio
    };
  }

  const headers = new Headers();
  if (upstreamUserId) {
    headers.set('New-Api-User', upstreamUserId);
  }

  const [selfResult, pricingResult, optionsResult] = await Promise.allSettled([
    requestJson<unknown>(baseUrl, '/api/user/self', { token, headers }),
    requestJson<unknown>(baseUrl, '/api/pricing', { token, headers }),
    requestJson<unknown>(baseUrl, '/api/option/', { token, headers })
  ]);
  const self = settledRecord(selfResult);
  const pricing = settledRecord(pricingResult);
  const options = settledRecord(optionsResult);
  const quota = numeric(self?.quota);
  const balance = quota !== undefined ? quota / quotaPerUnit : numeric(self?.balance);
  const groupRatioResult = parseNewApiGroupRatio(groupName, pricing, options);
  const readable = self || pricing || options;

  if (!readable) {
    throw settledError(selfResult) ?? settledError(pricingResult) ?? settledError(optionsResult) ?? new Error('凭证测试失败');
  }

  const complete = balance !== undefined && groupRatioResult.value !== null;

  return {
    ok: true,
    status: complete ? 'ok' : 'limited',
    message: complete
      ? '测试通过，已读取余额和倍率'
      : '测试通过，但上游没有返回完整余额或倍率',
    balance,
    balanceCurrency: balance !== undefined ? 'CNY' : undefined,
    groupRatio: groupRatioResult.value,
    rateSource: groupRatioResult.source,
    suggestedRechargeRatio
  };
}

async function listNewApiGroups(
  baseUrl: string,
  authMode: AuthMode,
  credential: Record<string, string>,
  upstreamUserId: string | null
): Promise<UpstreamGroupInfo[]> {
  const token = credential.adminToken ?? credential.token ?? credential.bearerToken;

  if (!token) {
    throw new Error('请输入 NewAPI 认证信息');
  }
  if (authMode === AuthMode.API_KEY) {
    throw new Error('NewAPI API Key 不能读取上游分组，请使用用户 Access Token 或管理 Token');
  }

  const headers = new Headers();
  if (upstreamUserId) {
    headers.set('New-Api-User', upstreamUserId);
  }

  const [pricingResult, optionsResult, groupResult, groupsResult, userGroupsResult] = await Promise.allSettled([
    requestJson<unknown>(baseUrl, '/api/pricing', { token, headers }),
    requestJson<unknown>(baseUrl, '/api/option/', { token, headers }),
    requestJson<unknown>(baseUrl, '/api/group/', { token, headers }),
    requestJson<unknown>(baseUrl, '/api/groups', { token, headers }),
    requestJson<unknown>(baseUrl, '/api/user/groups', { token, headers })
  ]);
  const pricing = settledRecord(pricingResult);
  const options = settledRecord(optionsResult);
  const groupRatio = {
    ...parseJsonRecord(options?.GroupRatio ?? options?.group_ratio),
    ...parseJsonRecord(pricing?.group_ratio ?? pricing?.GroupRatio)
  };
  const records = [
    ...groupRecordsFromResult(groupResult),
    ...groupRecordsFromResult(groupsResult),
    ...groupRecordsFromResult(userGroupsResult)
  ];
  const groups = mergeGroupInfos(records, groupRatio, 'NewAPI');

  if (groups.length === 0) {
    throw settledError(pricingResult) ?? settledError(optionsResult) ?? new Error('上游没有返回可读取的分组');
  }

  return groups;
}

async function testSub2ApiCredential(
  baseUrl: string,
  authMode: AuthMode,
  credential: Record<string, string>,
  groupName: string
): Promise<CredentialTestResult> {
  if (authMode === AuthMode.API_KEY) {
    const token = credential.token ?? credential.bearerToken;
    if (!token) {
      throw new Error('请输入 Sub2API API Key');
    }

    await requestJson<unknown>(baseUrl, '/v1/models', { token }).catch(() => requestJson<unknown>(baseUrl, '/api/v1/models', { token }));
    return {
      ok: true,
      status: 'limited',
      message: 'API Key 可用，但 Sub2API API Key 不能稳定读取余额、倍率和分组',
      suggestedRechargeRatio: null
    };
  }

  const token = await sub2ApiToken(baseUrl, authMode, credential);
  const [meResult, groupResult, availableResult] = await Promise.allSettled([
    requestJson<unknown>(baseUrl, '/api/v1/auth/me', { token }),
    requestJson<unknown>(baseUrl, '/api/v1/groups/rates', { token }),
    requestJson<unknown>(baseUrl, '/api/v1/groups/available', { token })
  ]);
  const user = settledRecord(meResult);
  const groupRates = settledRecord(groupResult);
  const balance = numeric(user?.balance);
  const groups = mergeGroupInfos(groupRecordsFromResult(availableResult), groupRates ?? {}, 'Sub2API');
  const matchedGroup = findGroupInfo(groups, groupName);
  const groupRatio = matchedGroup?.ratio ?? parseGroupRatio(groupName, groupRates).value;
  const readable = user || groupRates || groups.length > 0;

  if (!readable) {
    throw settledError(meResult) ?? settledError(groupResult) ?? new Error('凭证测试失败');
  }

  const complete = balance !== undefined && groupRatio !== null;

  return {
    ok: true,
    status: complete ? 'ok' : 'limited',
    message: complete
      ? '测试通过，已读取余额和倍率'
      : '测试通过，但 Sub2API 没有返回完整余额或倍率',
    balance,
    balanceCurrency: stringValue(user?.currency) ?? stringValue(user?.balance_currency) ?? (balance !== undefined ? 'CNY' : undefined),
    groupRatio,
    rateSource: groupRatio !== null ? '/api/v1/groups/rates' : undefined,
    suggestedRechargeRatio: null
  };
}

async function listSub2ApiGroups(
  baseUrl: string,
  authMode: AuthMode,
  credential: Record<string, string>
): Promise<UpstreamGroupInfo[]> {
  if (authMode === AuthMode.API_KEY) {
    throw new Error('Sub2API API Key 不能读取上游分组，请使用用户 Token 或用户登录');
  }

  const token = await sub2ApiToken(baseUrl, authMode, credential);
  const [availableResult, ratesResult] = await Promise.allSettled([
    requestJson<unknown>(baseUrl, '/api/v1/groups/available', { token }),
    requestJson<unknown>(baseUrl, '/api/v1/groups/rates', { token })
  ]);
  const rates = settledRecord(ratesResult) ?? {};
  const groups = mergeGroupInfos(groupRecordsFromResult(availableResult), rates, 'Sub2API');

  if (groups.length === 0) {
    throw settledError(availableResult) ?? settledError(ratesResult) ?? new Error('上游没有返回可读取的分组');
  }

  return groups;
}

async function sub2ApiToken(baseUrl: string, authMode: AuthMode, credential: Record<string, string>) {
  const directToken = credential.token ?? credential.bearerToken;

  if (authMode !== AuthMode.PASSWORD) {
    if (!directToken) {
      throw new Error('请输入 Sub2API 用户 Token');
    }

    return directToken;
  }

  const account = credential.email ?? credential.username;
  const password = credential.password;
  if (!account || !password) {
    throw new Error('请输入 Sub2API 账号/邮箱和密码');
  }

  const payload = await requestJson<unknown>(baseUrl, '/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: account, username: account, password })
  });
  const data = recordValue(unwrapData(payload)) ?? {};
  const token = stringValue(data.token) ?? stringValue(data.access_token) ?? stringValue(data.jwt);

  if (!token) {
    throw new Error('Sub2API 登录成功但没有返回 token');
  }

  return token;
}

function parseNewApiGroupRatio(
  groupName: string,
  pricing: Record<string, unknown> | undefined,
  options: Record<string, unknown> | undefined
) {
  const pricingGroupRatio = parseJsonRecord(pricing?.group_ratio ?? pricing?.GroupRatio);
  const optionGroupRatio = parseJsonRecord(options?.GroupRatio ?? options?.group_ratio);
  const merged = { ...optionGroupRatio, ...pricingGroupRatio };
  const source = Object.keys(pricingGroupRatio).length > 0 ? '/api/pricing' : Object.keys(optionGroupRatio).length > 0 ? '/api/option/' : undefined;
  const result = parseGroupRatio(groupName, merged);

  return {
    value: result.value,
    source: result.value !== null ? source : undefined
  };
}

function parseGroupRatio(groupName: string, ratios: Record<string, unknown> | undefined) {
  if (!ratios) {
    return { value: null as number | null };
  }

  const normalizedTarget = normalizeName(groupName);
  const exactKey = Object.keys(ratios).find((key) => normalizeName(key) === normalizedTarget);
  const ratioEntries = Object.entries(ratios)
    .map(([key, value]) => ({ key, value: ratioFromValue(value) }))
    .filter((entry): entry is { key: string; value: number } => entry.value !== undefined);
  const fallbackKey = exactKey ?? (normalizedTarget === 'default' && ratioEntries.length === 1 ? ratioEntries[0].key : undefined);
  const value = fallbackKey ? ratioFromValue(ratios[fallbackKey]) : undefined;

  return { value: value ?? null };
}

function groupRecordsFromResult(result: PromiseSettledResult<unknown>) {
  if (result.status !== 'fulfilled') {
    return [];
  }

  return groupRecordsFromPayload(unwrapData(result.value));
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
        return { name: key, ...(entry as Record<string, unknown>) };
      }

      return { name: key, ratio: entry };
    })
    .filter((entry) => Boolean(groupNameFromRecord(entry)));
}

function mergeGroupInfos(
  records: Array<Record<string, unknown>>,
  ratioMap: Record<string, unknown>,
  provider: string
): UpstreamGroupInfo[] {
  const groups = new Map<string, UpstreamGroupInfo>();
  const matchedRatioKeys = new Set<string>();

  for (const record of records) {
    const name = groupNameFromRecord(record);
    if (!name) {
      continue;
    }

    const id = stringValue(record.id);
    const ratioMatch = ratioFromMap(ratioMap, name, id);
    const ratio = ratioMatch.value ?? groupRatioFromRecord(record);

    for (const key of ratioMatch.keys) {
      matchedRatioKeys.add(normalizeName(key));
    }

    groups.set(normalizeName(name), {
      id,
      name,
      remark: groupRemarkFromRecord(record),
      ratio: ratio ?? null,
      source: provider
    });
  }

  for (const [name, value] of Object.entries(ratioMap)) {
    if (matchedRatioKeys.has(normalizeName(name))) {
      continue;
    }

    const key = normalizeName(name);
    const ratio = ratioFromValue(value);
    const existing = groups.get(key);

    groups.set(key, {
      ...existing,
      name: existing?.name ?? name,
      remark: existing?.remark ?? groupRemarkFromRecord(recordValue(value) ?? {}),
      ratio: existing?.ratio ?? ratio ?? null,
      source: existing?.source ?? provider
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

function groupRemarkFromRecord(record: Record<string, unknown>) {
  return stringValue(record.remark) ??
    stringValue(record.description) ??
    stringValue(record.desc) ??
    stringValue(record.note) ??
    stringValue(record.memo);
}

function groupRatioFromRecord(record: Record<string, unknown>) {
  return numeric(record.ratio) ??
    numeric(record.rate) ??
    numeric(record.multiplier) ??
    numeric(record.rate_multiplier) ??
    numeric(record.rateMultiplier) ??
    numeric(record.model_ratio) ??
    numeric(record.modelRatio) ??
    numeric(record.group_ratio) ??
    numeric(record.groupRatio);
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
  return record ? groupRatioFromRecord(record) : undefined;
}

function findGroupInfo(groups: UpstreamGroupInfo[], groupName: string) {
  const normalized = normalizeName(groupName);

  return groups.find((group) => normalizeName(group.name) === normalized || normalizeName(group.id) === normalized);
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');

  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (options.token) {
    headers.set('authorization', `Bearer ${stripBearer(options.token)}`);
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`, {
      ...options,
      headers,
      signal: controller.signal
    });
    const text = await response.text();

    if (/cloudflare|turnstile|captcha|challenge/i.test(text)) {
      throw new Error('上游返回 Cloudflare/验证码页面');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${clip(text)}`);
    }

    const payload = JSON.parse(text) as unknown;
    const record = recordValue(payload);
    const code = numeric(record?.code);

    if (record?.success === false) {
      throw new Error(stringValue(record.message) ?? '上游接口返回失败');
    }
    if (code !== undefined && code !== 0) {
      throw new Error(stringValue(record?.message) ?? stringValue(record?.reason) ?? `上游接口返回 code ${code}`);
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

function unwrapData(value: unknown) {
  const record = recordValue(value);
  return record && 'data' in record ? record.data : value;
}

function settledRecord(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled' ? recordValue(unwrapData(result.value)) : undefined;
}

function settledError(result: PromiseSettledResult<unknown>) {
  return result.status === 'rejected' ? result.reason : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return {};
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

function stringValue(value: unknown) {
  if (typeof value === 'number') {
    return String(value);
  }

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function suggestRechargeRatio(quotaPerUnit: number) {
  const ratio = quotaPerUnit / 500000;
  return Number.isFinite(ratio) && ratio >= 1 ? Math.max(1, Math.round(ratio)) : null;
}

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeName(value: string | undefined) {
  return value?.trim().toLowerCase() || 'default';
}

function stripBearer(value: string) {
  return value.replace(/^Bearer\s+/i, '').trim();
}

function clip(text: string) {
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
