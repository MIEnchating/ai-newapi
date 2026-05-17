import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma, UpstreamStatus } from '@prisma/client';
import { prisma } from './prisma';

const settingId = 'default';

export function startScheduler(connection: IORedis) {
  const queue = new Queue('upstream-sync', { connection });
  const defaultIntervalMs = normalizeInterval(Number(process.env.SYNC_INTERVAL_MS ?? 15 * 60 * 1000));
  const pollIntervalMs = Math.min(defaultIntervalMs, 60_000);

  async function enqueueDueUpstreams() {
    const now = new Date();
    const setting = await prisma.inspectionSetting.upsert({
      where: { id: settingId },
      create: {
        id: settingId,
        enabled: true,
        intervalMs: defaultIntervalMs,
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

    if (!setting.enabled) {
      return;
    }

    const intervalMs = normalizeInterval(setting.intervalMs);
    const latencyIntervalMs = normalizeInterval(setting.latencyIntervalMs);
    const cutoff = new Date(now.getTime() - intervalMs);
    const latencyCutoff = new Date(now.getTime() - latencyIntervalMs);
    const activeDueConditions: Prisma.UpstreamWhereInput[] = setting.latencyTestEnabled
      ? [
          { lastSyncAt: null },
          { lastSyncAt: { lt: cutoff } },
          { latencyCheckedAt: null },
          { latencyCheckedAt: { lt: latencyCutoff } },
          { latencyNextCheckAt: { lte: now } }
        ]
      : [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }];
    const dueBranches: Prisma.UpstreamWhereInput[] = [
      {
        status: { not: UpstreamStatus.DISABLED },
        OR: activeDueConditions
      }
    ];

    if (setting.latencyTestEnabled) {
      dueBranches.push({
        disabledByLatency: true,
        OR: [{ latencyNextCheckAt: null }, { latencyNextCheckAt: { lte: now } }]
      });
    }

    const upstreams = await prisma.upstream.findMany({
      where: {
        OR: dueBranches
      },
      select: { id: true }
    });
    const jobBucketMs = Math.min(intervalMs, latencyIntervalMs, normalizeInterval(setting.disabledRetestMs));

    for (const upstream of upstreams) {
      await queue.add(
        'sync-upstream',
        { upstreamId: upstream.id },
        {
          jobId: `sync:${upstream.id}:${Math.floor(now.getTime() / jobBucketMs)}`,
          removeOnComplete: 200,
          removeOnFail: 500
        }
      );
    }

    await prisma.inspectionSetting.update({
      where: { id: setting.id },
      data: {
        lastRunAt: now,
        lastQueuedAt: upstreams.length > 0 ? now : setting.lastQueuedAt,
        lastResult: upstreams.length > 0 ? `自动巡检已入队 ${upstreams.length} 个上游，包含主站渠道测试与禁用复测` : '没有到期上游',
        lastError: null
      }
    });
  }

  const timer = setInterval(() => {
    enqueueDueUpstreams().catch((error) => {
      console.error('[scheduler] failed to enqueue upstream sync jobs', error);
      prisma.inspectionSetting
        .update({
          where: { id: settingId },
          data: {
            lastRunAt: new Date(),
            lastError: error instanceof Error ? error.message : String(error)
          }
        })
        .catch(() => undefined);
    });
  }, pollIntervalMs);

  enqueueDueUpstreams().catch((error) => {
    console.error('[scheduler] initial enqueue failed', error);
  });

  return async () => {
    clearInterval(timer);
    await queue.close();
  };
}

function normalizeInterval(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 900_000;
  }

  return Math.min(24 * 60 * 60_000, Math.max(60_000, Math.trunc(parsed)));
}
