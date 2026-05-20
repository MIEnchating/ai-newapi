import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthMode, Prisma, UpstreamStatus, UpstreamType } from '@prisma/client';
import { decryptCredentialPayload, encryptCredentialPayload } from '../vault/credential-vault';
import { PrismaService } from '../prisma.service';
import { SyncQueueService } from './sync-queue.service';
import { syncUpstream } from '../../../worker/src/sync/sync-upstream';

const upstreamTypes = new Set(Object.values(UpstreamType));
const authModes = new Set(Object.values(AuthMode));
const upstreamStatuses = new Set(Object.values(UpstreamStatus));
const cpaUsageRetentionMs = 7 * 24 * 60 * 60_000;
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

type CpaUsageMetric = {
  percent: number | null;
  used?: number | null;
  limit?: number | null;
  label?: string | null;
};

type CpaUsageRecord = {
  timestamp: string;
  authIndex?: string;
  source?: string;
  totalTokens: number;
  failed: boolean;
};

@Injectable()
export class UpstreamsService {
  private schemaChecked = false;
  private readonly cpaUsageRecords = new Map<string, CpaUsageRecord[]>();

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

    if (type === UpstreamType.CLI_PROXY && input.createMainStation) {
      throw new BadRequestException('CPA 号池不写入主站渠道，只保存到本地数据库');
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

    if (type === UpstreamType.CLI_PROXY) {
      return this.findIncluded(upstream.id);
    }

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
    const nextType = input.type !== undefined ? parseUpstreamType(input.type) : existing.type;
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException('name is required');
      }
      data.name = name;
    }
    if (input.type !== undefined) {
      data.type = nextType;
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

    if (existing.type !== UpstreamType.CLI_PROXY && nextType !== UpstreamType.CLI_PROXY) {
      await this.updateMainStationChannelIfNeeded(
        existing,
        shouldRecoverLatencyDisabled && inputStatus === undefined ? { ...input, status: UpstreamStatus.LIMITED } : input
      );
    }

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

    if (nextType === UpstreamType.CLI_PROXY) {
      return this.findIncluded(upstream.id);
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

    if (upstream.type === UpstreamType.CLI_PROXY) {
      throw new BadRequestException('CPA 号池不参与自动巡检同步');
    }

    await syncUpstream(id);

    return {
      completed: true,
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
      if (type === UpstreamType.CLI_PROXY) {
        return {
          ok: true,
          status: credential.managementKey || credential.token ? 'ok' : 'limited',
          message: credential.managementKey || credential.token ? 'CPA 管理密钥已配置' : 'CPA 管理密钥未配置'
        };
      }
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
      if (type === UpstreamType.CLI_PROXY) {
        return {
          ok: true,
          status: credential.managementKey || credential.token ? 'ok' : 'limited',
          message: credential.managementKey || credential.token ? 'CPA 管理密钥已填写' : 'CPA 管理密钥未填写'
        };
      }
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

    if (type === UpstreamType.CLI_PROXY) {
      return { groups: [] };
    }

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

    if (type === UpstreamType.CLI_PROXY) {
      return { groups: [] };
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

  async cpaPool(id: string) {
    await this.ensureSchema();

    const upstream = await this.prisma.upstream.findUnique({
      where: { id },
      include: { credential: true }
    });

    if (!upstream) {
      throw new BadRequestException('upstream not found');
    }
    if (upstream.type !== UpstreamType.CLI_PROXY) {
      throw new BadRequestException('只有 CPA 号池渠道可以读取号池账号');
    }

    const credential = upstream.credential ? decryptCredentialPayload(upstream.credential.encryptedPayload) : {};
    const managementKey = cpaManagementKey(credential);

    if (!managementKey) {
      throw new BadRequestException('CPA 号池缺少管理密钥，请在渠道配置里填写 CPA 管理密钥');
    }

    const baseUrl = normalizeBaseUrl(upstream.baseUrl);
    const now = new Date();
    const [authFilesResult, usageResult] = await Promise.allSettled([
      cpaJson<unknown>(baseUrl, '/v0/management/auth-files', managementKey),
      cpaJson<unknown>(baseUrl, '/v0/management/usage-queue?count=500', managementKey)
    ]);

    if (authFilesResult.status === 'rejected') {
      throw new BadRequestException(errorMessage(authFilesResult.reason));
    }

    const usageRecords = parseCpaUsageRecords(unwrapData(usageResult.status === 'fulfilled' ? usageResult.value : undefined));
    const cutoff = now.getTime() - cpaUsageRetentionMs;
    const retained = [...(this.cpaUsageRecords.get(id) ?? []), ...usageRecords]
      .filter((record) => Date.parse(record.timestamp) >= cutoff)
      .slice(-20_000);
    this.cpaUsageRecords.set(id, retained);

    const accounts = parseCpaAuthFiles(unwrapData(authFilesResult.value)).map((account, index) => {
      const usage = aggregateCpaUsage(retained, account, index);

      return {
        ...account,
        successCount: account.successCount || usage.successCount,
        failureCount: account.failureCount || usage.failureCount
      };
    });

    return {
      channel: {
        id: upstream.id,
        name: upstream.name,
        baseUrl: upstream.baseUrl
      },
      accounts,
      usageQueueError: usageResult.status === 'rejected' ? errorMessage(usageResult.reason) : null,
      refreshedAt: now.toISOString()
    };
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
      "ALTER TABLE Upstream MODIFY COLUMN type ENUM('NEWAPI','SUB2API','CLI_PROXY') NOT NULL",
      'ALTER TABLE Upstream MODIFY COLUMN rechargeRatio DECIMAL(10,2) NOT NULL DEFAULT 1',
      'ALTER TABLE Upstream MODIFY COLUMN lastError TEXT NULL',
      'ALTER TABLE Upstream MODIFY COLUMN latencyLastError TEXT NULL',
      'ALTER TABLE Upstream ADD COLUMN skipLatencyDisable BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE Credential MODIFY COLUMN encryptedPayload TEXT NOT NULL'
    ]) {
      try {
        await this.prisma.$executeRawUnsafe(statement);
      } catch (error) {
        if (!/Unknown column|Duplicate column|doesn't exist|1060|1061|1146|already|syntax/i.test(errorMessage(error))) {
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
  const statusPayload = await requestJson<unknown>(baseUrl, '/api/status').catch(() => null);
  const status = recordValue(unwrapData(statusPayload)) ?? {};
  const quotaPerUnit = numeric(status.quota_per_unit) ?? 500000;

  if (authMode === AuthMode.API_KEY) {
    const token = credential.adminToken ?? credential.token ?? credential.bearerToken;
    if (!token) {
      throw new Error('请输入 NewAPI API Key');
    }

    await requestJson<unknown>(baseUrl, '/v1/models', { token });
    return {
      ok: true,
      status: 'limited',
      message: 'API Key 可用，但 NewAPI API Key 通常不能读取余额和倍率'
    };
  }

  const auth = await newApiAuthContext(baseUrl, authMode, credential, upstreamUserId);

  const [selfResult, pricingResult, optionsResult, selfGroupsResult, userGroupsResult] = await Promise.allSettled([
    requestJson<unknown>(baseUrl, '/api/user/self', auth),
    requestJson<unknown>(baseUrl, '/api/pricing', auth),
    requestJson<unknown>(baseUrl, '/api/option/', auth),
    requestJson<unknown>(baseUrl, '/api/user/self/groups', auth),
    requestJson<unknown>(baseUrl, '/api/user/groups', auth)
  ]);
  const self = settledRecord(selfResult);
  const pricingPayload = settledPayload(pricingResult);
  const pricingData = unwrapData(pricingPayload);
  const pricing = recordValue(pricingPayload) ?? recordValue(pricingData);
  const options = settledRecord(optionsResult);
  const selfGroupRecords = groupRecordsFromResult(selfGroupsResult);
  const userGroupRecords = groupRecordsFromResult(userGroupsResult);
  const quota = numeric(self?.quota);
  const balance = quota !== undefined ? quota / quotaPerUnit : numeric(self?.balance);
  const groupRatioResult = parseNewApiGroupRatio(groupName, pricingPayload, options, selfGroupRecords, userGroupRecords);
  const readable = self || pricing || options || selfGroupRecords.length > 0 || userGroupRecords.length > 0;

  if (!readable) {
    throw settledError(selfResult) ?? settledError(pricingResult) ?? settledError(optionsResult) ?? settledError(selfGroupsResult) ?? settledError(userGroupsResult) ?? new Error('凭证测试失败');
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
    rateSource: groupRatioResult.source
  };
}

async function listNewApiGroups(
  baseUrl: string,
  authMode: AuthMode,
  credential: Record<string, string>,
  upstreamUserId: string | null
): Promise<UpstreamGroupInfo[]> {
  if (authMode === AuthMode.API_KEY) {
    throw new Error('NewAPI API Key 不能读取上游分组，请使用账号密码、用户 Access Token 或管理 Token');
  }

  const auth = await newApiAuthContext(baseUrl, authMode, credential, upstreamUserId);

  const [pricingResult, optionsResult, groupResult, groupsResult, userGroupsResult] = await Promise.allSettled([
    requestJson<unknown>(baseUrl, '/api/pricing', auth),
    requestJson<unknown>(baseUrl, '/api/option/', auth),
    requestJson<unknown>(baseUrl, '/api/group/', auth),
    requestJson<unknown>(baseUrl, '/api/groups', auth),
    requestJson<unknown>(baseUrl, '/api/user/groups', auth)
  ]);
  const pricingPayload = settledPayload(pricingResult);
  const pricingData = unwrapData(pricingPayload);
  const pricing = recordValue(pricingPayload) ?? recordValue(pricingData);
  const options = settledRecord(optionsResult);
  const groupRatio = {
    ...parseJsonRecord(options?.GroupRatio ?? options?.group_ratio),
    ...newApiGroupRatioFromPricing(pricingPayload),
    ...parseJsonRecord(pricing?.group_ratio ?? pricing?.GroupRatio)
  };
  const records = [
    ...newApiGroupRecordsFromPricing(pricingPayload),
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

async function newApiAuthContext(
  baseUrl: string,
  authMode: AuthMode,
  credential: Record<string, string>,
  upstreamUserId: string | null
): Promise<RequestInit & { token?: string }> {
  if (authMode === AuthMode.PASSWORD) {
    return newApiPasswordAuthContext(baseUrl, credential, upstreamUserId);
  }

  const token = credential.adminToken ?? credential.token ?? credential.bearerToken;
  if (!token) {
    throw new Error('请输入 NewAPI Token');
  }

  const headers = new Headers();
  const userId = upstreamUserId ?? credential.userId;
  if (userId) {
    headers.set('New-Api-User', userId);
  }

  return { token, headers };
}

async function newApiPasswordAuthContext(
  baseUrl: string,
  credential: Record<string, string>,
  upstreamUserId: string | null
): Promise<RequestInit> {
  const account = credential.email ?? credential.username;
  const password = credential.password;

  if (!account || !password) {
    throw new Error('请输入 NewAPI 账号/邮箱和密码');
  }

  const login = await requestJsonResponse<unknown>(baseUrl, '/api/user/login', {
    method: 'POST',
    body: JSON.stringify({ username: account, password })
  });
  const data = recordValue(unwrapData(login.payload)) ?? {};

  if (data.require_2fa === true) {
    throw new Error('NewAPI 账号启用了 2FA，暂不能使用账号密码自动鉴权');
  }

  const cookie = cookieHeader(login.headers);
  if (!cookie) {
    throw new Error('NewAPI 登录成功但没有返回 session cookie');
  }

  const userId = upstreamUserId ?? credential.userId ?? stringValue(data.id);
  if (!userId) {
    throw new Error('请输入 NewAPI 上游用户 ID');
  }

  const headers = new Headers({ cookie });
  headers.set('New-Api-User', userId);

  return { headers };
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
      message: 'API Key 可用，但 Sub2API API Key 不能稳定读取余额、倍率和分组'
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
    rateSource: groupRatio !== null ? '/api/v1/groups/rates' : undefined
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
  pricingPayload: unknown,
  options: Record<string, unknown> | undefined,
  selfGroupRecords: Array<Record<string, unknown>> = [],
  userGroupRecords: Array<Record<string, unknown>> = []
) {
  const pricing = recordValue(pricingPayload) ?? recordValue(unwrapData(pricingPayload));
  const pricingGroupRatio = newApiGroupRatioFromPricing(pricingPayload);
  const selfGroups = mergeGroupInfos(selfGroupRecords, pricingGroupRatio, '/api/user/self/groups');
  const matchedSelfGroup = findGroupInfo(selfGroups, groupName);
  if (matchedSelfGroup?.ratio !== undefined && matchedSelfGroup.ratio !== null) {
    return {
      value: matchedSelfGroup.ratio,
      source: matchedSelfGroup.source
    };
  }

  const matchedUserGroup = findGroupInfo(mergeGroupInfos(userGroupRecords, pricingGroupRatio, '/api/user/groups'), groupName);
  if (matchedUserGroup?.ratio !== undefined && matchedUserGroup.ratio !== null) {
    return {
      value: matchedUserGroup.ratio,
      source: matchedUserGroup.source
    };
  }

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

function settledPayload(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function newApiGroupRatioFromPricing(value: unknown): Record<string, unknown> {
  const record = recordValue(value);
  const data = recordValue(unwrapData(value));

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
      remark: groupRemarkFromRecord(record),
      ratio: groupRatioFromRecord(record) ?? ratioFromValue(groupRatio[name]),
      source: '/api/pricing'
    });
  }

  for (const record of pricingRecordsFromPayload(value)) {
    const enabledGroups = arrayOfStrings(record.enable_groups ?? record.enableGroups ?? record.groups);

    for (const group of enabledGroups) {
      if (!group.trim()) {
        continue;
      }

      const previous = groups.get(normalizeName(group));
      groups.set(normalizeName(group), {
        ...previous,
        name: group,
        ratio: ratioFromValue(groupRatio[group]) ?? ratioFromValue(previous?.ratio),
        source: '/api/pricing'
      });
    }
  }

  return [...groups.values()];
}

function pricingRecordsFromPayload(value: unknown): Array<Record<string, unknown>> {
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

  return stringValue(record.model_name) || stringValue(record.model) || Array.isArray(record.enable_groups) ? [record] : [];
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

async function cpaJson<T>(baseUrl: string, path: string, managementKey: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
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

function cpaManagementKey(payload: Record<string, string>) {
  return payload.managementKey?.trim()
    || payload.token?.trim()
    || payload.adminToken?.trim()
    || payload.bearerToken?.trim()
    || payload.password?.trim()
    || null;
}

function parseCpaAuthFiles(value: unknown) {
  const records = arrayOfRecords(value);

  return records.map((record, index) => ({
    key: String(stringValue(record.auth_index) ?? stringValue(record.authIndex) ?? stringValue(record.id) ?? stringValue(record.key) ?? stringValue(record.name) ?? index),
    index: stringValue(record.index) ?? stringValue(record.auth_index) ?? stringValue(record.authIndex) ?? String(index),
    name: stringValue(record.name) ?? stringValue(record.label) ?? stringValue(record.filename) ?? stringValue(record.file) ?? `账号 ${index + 1}`,
    account: stringValue(record.email) ?? stringValue(record.account) ?? stringValue(record.username) ?? '-',
    provider: stringValue(record.provider) ?? stringValue(record.account_type) ?? stringValue(record.accountType) ?? stringValue(record.type) ?? '-',
    status: cpaAccountStatus(record),
    successCount: numeric(record.success) ?? numeric(record.success_count) ?? numeric(record.successCount) ?? 0,
    failureCount: numeric(record.failed) ?? numeric(record.failure_count) ?? numeric(record.failedCount) ?? 0,
    usage5h: cpaUsageMetric(
      record.usage_5h,
      record.usage5h,
      record.usage_5_hours,
      record.usage5Hours,
      record.five_hour,
      record.fiveHour,
      record.five_hours,
      record.fiveHours,
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
      record.limitUsage5h,
      usageMetricFromPair(firstDefined(record.five_hour_used, record.fiveHourUsed, record.five_hours_used, record.fiveHoursUsed, record.usage_5h_used, record.usage5hUsed, record.used_5h, record.used5h), firstDefined(record.five_hour_limit, record.fiveHourLimit, record.five_hours_limit, record.fiveHoursLimit, record.usage_5h_limit, record.usage5hLimit, record.limit_5h, record.limit5h)),
      usageMetricFromPair(firstDefined(record.five_hour_usage, record.fiveHourUsage, record.five_hours_usage, record.fiveHoursUsage), firstDefined(record.five_hour_limit, record.fiveHourLimit, record.five_hours_limit, record.fiveHoursLimit))
    ),
    usage7d: cpaUsageMetric(
      record.usage_7d,
      record.usage7d,
      record.week,
      record.weekly,
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
      record.limitUsage7d,
      usageMetricFromPair(firstDefined(record.week_used, record.weekUsed, record.weekly_used, record.weeklyUsed, record.usage_7d_used, record.usage7dUsed, record.used_7d, record.used7d), firstDefined(record.week_limit, record.weekLimit, record.weekly_limit, record.weeklyLimit, record.usage_7d_limit, record.usage7dLimit, record.limit_7d, record.limit7d)),
      usageMetricFromPair(firstDefined(record.week_usage, record.weekUsage, record.weekly_usage, record.weeklyUsage), firstDefined(record.week_limit, record.weekLimit, record.weekly_limit, record.weeklyLimit))
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

function parseCpaUsageRecords(value: unknown): CpaUsageRecord[] {
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

function aggregateCpaUsage(records: CpaUsageRecord[], account: { index: string; key: string; name: string }, index: number) {
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

function cpaAccountStatus(record: Record<string, unknown>) {
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

function cpaUsageMetric(...values: unknown[]): CpaUsageMetric | null {
  for (const value of values) {
    const metric = usageMetricFromValue(value);
    if (metric) {
      return metric;
    }
  }

  return null;
}

function usageMetricFromValue(value: unknown): CpaUsageMetric | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const direct = numeric(value);
  if (direct !== undefined) {
    return { percent: normalizePercent(direct) };
  }

  if (typeof value === 'string') {
    const text = value.trim();
    const pair = /^([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
    if (pair) {
      return usageMetricFromPair(Number(pair[1]), Number(pair[2]));
    }
    const percent = /^([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(text);
    if (percent) {
      return { percent: normalizePercent(Number(percent[1])), label: text };
    }
  }

  const record = recordValue(value);
  if (!record) {
    return null;
  }

  const nested = usageMetricFromValue(record.usage) ?? usageMetricFromValue(record.value);
  if (nested?.used !== undefined || nested?.limit !== undefined) {
    return nested;
  }

  const percent = firstNumeric(
    record.percent,
    record.percentage,
    record.usage_percent,
    record.usagePercent,
    record.limit_percent,
    record.limitPercent,
    record.rate,
    record.ratio
  );
  const paired = usageMetricFromPair(
    firstDefined(record.used, record.current, record.count, record.usage, record.used_count, record.usedCount, record.consumed),
    firstDefined(record.limit, record.max, record.maximum, record.quota, record.total, record.cap)
  );

  if (paired) {
    return paired;
  }
  if (percent !== undefined) {
    return { percent: normalizePercent(percent) };
  }

  return nested;
}

function usageMetricFromPair(usedValue: unknown, limitValue: unknown): CpaUsageMetric | null {
  const used = numeric(usedValue);
  const limit = numeric(limitValue);

  if (used === undefined || limit === undefined || limit <= 0) {
    return null;
  }

  const percent = normalizePercent((used / limit) * 100);

  return {
    percent,
    used,
    limit,
    label: `${formatUsageNumber(used)} / ${formatUsageNumber(limit)}`
  };
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
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

function normalizePercent(value: number) {
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent * 100) / 100));
}

function formatUsageNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  return (await requestJsonResponse<T>(baseUrl, path, options)).payload;
}

async function requestJsonResponse<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<{ payload: T; headers: Headers }> {
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

    return { payload: payload as T, headers: response.headers };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
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
