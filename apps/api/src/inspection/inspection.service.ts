import { Inject, Injectable } from '@nestjs/common';
import { Prisma, UpstreamStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SyncQueueService } from '../upstreams/sync-queue.service';

const settingId = 'default';
const minIntervalMs = 60_000;
const maxIntervalMs = 24 * 60 * 60_000;
const minLatencyThresholdMs = 100;
const maxLatencyThresholdMs = 120_000;
const ruleActions = new Set(['NONE', 'LOWER', 'DISABLE']);
const priorityStrategies = new Set(['RATE_FIRST', 'BALANCED']);

@Injectable()
export class InspectionService {
  private schemaChecked = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SyncQueueService) private readonly syncQueue: SyncQueueService
  ) {}

  async status() {
    const setting = await this.ensureSetting();
    const extras = await this.inspectionExtras();
    const intervalMs = normalizeInterval(setting.intervalMs);
    const latencyIntervalMs = normalizeInterval(setting.latencyIntervalMs);
    const [activeUpstreamCount, dueUpstreamCount, latencyDisabledCount, latencyDueCount] = await Promise.all([
      this.prisma.upstream.count({ where: activeUpstreamWhere() }),
      this.prisma.upstream.count({ where: dueUpstreamWhere(intervalMs, latencyIntervalMs, setting.latencyTestEnabled) }),
      this.prisma.upstream.count({ where: { disabledByLatency: true } }),
      setting.latencyTestEnabled
        ? this.prisma.upstream.count({ where: latencyDueWhere(latencyIntervalMs) })
        : Promise.resolve(0)
    ]);

    return {
      ...setting,
      intervalMs,
      latencyIntervalMs,
      latencyTimeoutMs: normalizeLatencyThreshold(setting.latencyTimeoutMs, 10_000),
      latencyDisableThresholdMs: normalizeLatencyThreshold(setting.latencyDisableThresholdMs, 8_000),
      latencyFailureLimit: normalizeFailureLimit(setting.latencyFailureLimit),
      disabledRetestMs: normalizeInterval(setting.disabledRetestMs),
      ...extras,
      activeUpstreamCount,
      dueUpstreamCount,
      latencyDisabledCount,
      latencyDueCount
    };
  }

  async update(input: {
    enabled?: boolean;
    intervalMs?: number;
    latencyTestEnabled?: boolean;
    latencyIntervalMs?: number;
    latencyTimeoutMs?: number;
    latencyDisableThresholdMs?: number;
    latencyFailureLimit?: number;
    disabledRetestMs?: number;
    latencyAutoDisableEnabled?: boolean;
    priorityUpdateEnabled?: boolean;
    priorityStrategy?: string;
    cpaPreferred?: boolean;
    inspectionConcurrency?: number;
    balanceLowAction?: string;
    rateIncreaseAction?: string;
    ruleActionPriority?: number;
    ruleActionWeight?: number;
  }) {
    const data: {
      enabled?: boolean;
      intervalMs?: number;
      latencyTestEnabled?: boolean;
      latencyIntervalMs?: number;
      latencyTimeoutMs?: number;
      latencyDisableThresholdMs?: number;
      latencyFailureLimit?: number;
      disabledRetestMs?: number;
      lastError?: null;
    } = { lastError: null };

    if (typeof input.enabled === 'boolean') {
      data.enabled = input.enabled;
    }
    if (input.intervalMs !== undefined) {
      data.intervalMs = normalizeInterval(input.intervalMs);
    }
    if (typeof input.latencyTestEnabled === 'boolean') {
      data.latencyTestEnabled = input.latencyTestEnabled;
    }
    if (input.latencyIntervalMs !== undefined) {
      data.latencyIntervalMs = normalizeInterval(input.latencyIntervalMs);
    }
    if (input.latencyTimeoutMs !== undefined) {
      data.latencyTimeoutMs = normalizeLatencyThreshold(input.latencyTimeoutMs, 10_000);
    }
    if (input.latencyDisableThresholdMs !== undefined) {
      data.latencyDisableThresholdMs = normalizeLatencyThreshold(input.latencyDisableThresholdMs, 8_000);
    }
    if (input.latencyFailureLimit !== undefined) {
      data.latencyFailureLimit = normalizeFailureLimit(input.latencyFailureLimit);
    }
    if (input.disabledRetestMs !== undefined) {
      data.disabledRetestMs = normalizeInterval(input.disabledRetestMs);
    }

    await this.ensureSetting();
    await this.prisma.inspectionSetting.update({
      where: { id: settingId },
      data
    });
    if (typeof input.cpaPreferred === 'boolean') {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET cpaPreferred = ${input.cpaPreferred},
            lastError = NULL,
            updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    const extraData = normalizeExtraUpdate(input);
    if (extraData.inspectionConcurrency !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET inspectionConcurrency = ${extraData.inspectionConcurrency}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.latencyAutoDisableEnabled !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET latencyAutoDisableEnabled = ${extraData.latencyAutoDisableEnabled}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.priorityUpdateEnabled !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET priorityUpdateEnabled = ${extraData.priorityUpdateEnabled}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.priorityStrategy !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET priorityStrategy = ${extraData.priorityStrategy}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.balanceLowAction !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET balanceLowAction = ${extraData.balanceLowAction}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.rateIncreaseAction !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET rateIncreaseAction = ${extraData.rateIncreaseAction}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.ruleActionPriority !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET ruleActionPriority = ${extraData.ruleActionPriority}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }
    if (extraData.ruleActionWeight !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE InspectionSetting
        SET ruleActionWeight = ${extraData.ruleActionWeight}, lastError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ${settingId}
      `;
    }

    return this.status();
  }

  async runNow() {
    const setting = await this.ensureSetting();
    const upstreams = await this.prisma.upstream.findMany({
      where: {
        OR: [
          activeUpstreamWhere(),
          ...(setting.latencyTestEnabled ? [{ disabledByLatency: true }] : [])
        ]
      },
      select: { id: true }
    });

    for (const upstream of upstreams) {
      await this.syncQueue.enqueue(upstream.id);
    }

    await this.prisma.inspectionSetting.update({
      where: { id: setting.id },
      data: {
        lastRunAt: new Date(),
        lastQueuedAt: upstreams.length > 0 ? new Date() : setting.lastQueuedAt,
        lastResult: upstreams.length > 0 ? `手动巡检已入队 ${upstreams.length} 个上游，包含主站渠道测试与禁用复测` : '没有可巡检的上游',
        lastError: null
      }
    });

    return this.status();
  }

  private async ensureSetting() {
    await this.ensureSchema();

    return this.prisma.inspectionSetting.upsert({
      where: { id: settingId },
      create: {
        id: settingId,
        enabled: true,
        intervalMs: normalizeInterval(Number(process.env.SYNC_INTERVAL_MS ?? 900_000)),
        latencyTestEnabled: true,
        latencyIntervalMs: 300_000,
        latencyTimeoutMs: 10_000,
        latencyDisableThresholdMs: 8_000,
        latencyFailureLimit: 3,
        disabledRetestMs: 1_800_000,
        lastResult: '自动巡检已就绪'
      },
      update: {}
    });
  }

  private async inspectionExtras() {
    await this.ensureSchema();
    const rows = await this.prisma.$queryRaw<Array<{
      cpaPreferred: boolean | number | null;
      inspectionConcurrency: number | null;
      latencyAutoDisableEnabled: boolean | number | null;
      priorityUpdateEnabled: boolean | number | null;
      priorityStrategy: string | null;
      balanceLowAction: string | null;
      rateIncreaseAction: string | null;
      ruleActionPriority: number | null;
      ruleActionWeight: number | null;
    }>>`
      SELECT cpaPreferred, inspectionConcurrency, latencyAutoDisableEnabled, priorityUpdateEnabled, priorityStrategy,
             balanceLowAction, rateIncreaseAction, ruleActionPriority, ruleActionWeight
      FROM InspectionSetting
      WHERE id = ${settingId}
      LIMIT 1
    `;
    const row = rows[0];

    return {
      cpaPreferred: row?.cpaPreferred === true || row?.cpaPreferred === 1,
      inspectionConcurrency: normalizeConcurrency(row?.inspectionConcurrency),
      latencyAutoDisableEnabled: normalizeBoolean(row?.latencyAutoDisableEnabled, true),
      priorityUpdateEnabled: normalizeBoolean(row?.priorityUpdateEnabled, true),
      priorityStrategy: normalizePriorityStrategy(row?.priorityStrategy),
      balanceLowAction: normalizeRuleAction(row?.balanceLowAction),
      rateIncreaseAction: normalizeRuleAction(row?.rateIncreaseAction),
      ruleActionPriority: normalizePriority(row?.ruleActionPriority),
      ruleActionWeight: normalizeWeight(row?.ruleActionWeight)
    };
  }

  private async ensureSchema() {
    if (this.schemaChecked) {
      return;
    }

    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN cpaPreferred BOOLEAN NOT NULL DEFAULT false');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN inspectionConcurrency INT NOT NULL DEFAULT 3');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN latencyAutoDisableEnabled BOOLEAN NOT NULL DEFAULT true');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN priorityUpdateEnabled BOOLEAN NOT NULL DEFAULT true');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN priorityStrategy VARCHAR(24) NOT NULL DEFAULT "RATE_FIRST"');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN balanceLowAction VARCHAR(16) NOT NULL DEFAULT "NONE"');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN rateIncreaseAction VARCHAR(16) NOT NULL DEFAULT "NONE"');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN ruleActionPriority INT NOT NULL DEFAULT 10');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting ADD COLUMN ruleActionWeight INT NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting MODIFY COLUMN lastResult TEXT NULL');
    await this.addColumnIfMissing('ALTER TABLE InspectionSetting MODIFY COLUMN lastError TEXT NULL');

    this.schemaChecked = true;
  }

  private async addColumnIfMissing(sql: string) {
    try {
      await this.prisma.$executeRawUnsafe(sql);
    } catch (error) {
      if (!/Duplicate column|1060/i.test(errorMessage(error))) {
        throw error;
      }
    }
  }
}

function activeUpstreamWhere() {
  return {
    status: { not: UpstreamStatus.DISABLED }
  };
}

function dueUpstreamWhere(intervalMs: number, latencyIntervalMs: number, latencyEnabled: boolean) {
  const now = new Date();
  const activeDueConditions: Prisma.UpstreamWhereInput[] = latencyEnabled
    ? [
        { lastSyncAt: null },
        { lastSyncAt: { lt: new Date(Date.now() - intervalMs) } },
        { latencyCheckedAt: null },
        { latencyCheckedAt: { lt: new Date(Date.now() - latencyIntervalMs) } },
        { latencyNextCheckAt: { lte: now } }
      ]
    : [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(Date.now() - intervalMs) } }];
  const branches: Prisma.UpstreamWhereInput[] = [
    {
      ...activeUpstreamWhere(),
      OR: activeDueConditions
    }
  ];

  if (latencyEnabled) {
    branches.push({
      disabledByLatency: true,
      OR: [{ latencyNextCheckAt: null }, { latencyNextCheckAt: { lte: now } }]
    });
  }

  return { OR: branches };
}

function latencyDueWhere(latencyIntervalMs: number) {
  return {
    OR: [
      {
        ...activeUpstreamWhere(),
        OR: [
          { latencyCheckedAt: null },
          { latencyCheckedAt: { lt: new Date(Date.now() - latencyIntervalMs) } },
          { latencyNextCheckAt: { lte: new Date() } }
        ]
      },
      {
        disabledByLatency: true,
        OR: [{ latencyNextCheckAt: null }, { latencyNextCheckAt: { lte: new Date() } }]
      }
    ]
  };
}

function normalizeInterval(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 900_000;
  }

  return Math.min(maxIntervalMs, Math.max(minIntervalMs, Math.trunc(parsed)));
}

function normalizeLatencyThreshold(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maxLatencyThresholdMs, Math.max(minLatencyThresholdMs, Math.trunc(parsed)));
}

function normalizeFailureLimit(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 3;
  }

  return Math.min(20, Math.max(1, Math.trunc(parsed)));
}

function normalizeExtraUpdate(input: {
  latencyAutoDisableEnabled?: boolean;
  priorityUpdateEnabled?: boolean;
  priorityStrategy?: string;
  inspectionConcurrency?: number;
  balanceLowAction?: string;
  rateIncreaseAction?: string;
  ruleActionPriority?: number;
  ruleActionWeight?: number;
}) {
  return {
    latencyAutoDisableEnabled:
      typeof input.latencyAutoDisableEnabled === 'boolean' ? input.latencyAutoDisableEnabled : undefined,
    priorityUpdateEnabled:
      typeof input.priorityUpdateEnabled === 'boolean' ? input.priorityUpdateEnabled : undefined,
    priorityStrategy: input.priorityStrategy === undefined ? undefined : normalizePriorityStrategy(input.priorityStrategy),
    inspectionConcurrency: input.inspectionConcurrency === undefined ? undefined : normalizeConcurrency(input.inspectionConcurrency),
    balanceLowAction: input.balanceLowAction === undefined ? undefined : normalizeRuleAction(input.balanceLowAction),
    rateIncreaseAction: input.rateIncreaseAction === undefined ? undefined : normalizeRuleAction(input.rateIncreaseAction),
    ruleActionPriority: input.ruleActionPriority === undefined ? undefined : normalizePriority(input.ruleActionPriority),
    ruleActionWeight: input.ruleActionWeight === undefined ? undefined : normalizeWeight(input.ruleActionWeight)
  };
}

function normalizeConcurrency(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(20, Math.max(1, Math.trunc(parsed))) : 3;
}

function normalizeRuleAction(value: unknown) {
  const action = typeof value === 'string' ? value.trim().toUpperCase() : 'NONE';
  return ruleActions.has(action) ? action : 'NONE';
}

function normalizePriorityStrategy(value: unknown) {
  const strategy = typeof value === 'string' ? value.trim().toUpperCase() : 'RATE_FIRST';
  return priorityStrategies.has(strategy) ? strategy : 'RATE_FIRST';
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }

  return fallback;
}

function normalizePriority(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.trunc(parsed))) : 10;
}

function normalizeWeight(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(10, Math.max(0, Math.trunc(parsed))) : 0;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
