import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient, UpstreamStatus } from '@prisma/client';

const prisma = new PrismaClient();

export function startScheduler(connection: IORedis) {
  const queue = new Queue('upstream-sync', { connection });
  const intervalMs = Number(process.env.SYNC_INTERVAL_MS ?? 15 * 60 * 1000);

  async function enqueueDueUpstreams() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - intervalMs);
    const upstreams = await prisma.upstream.findMany({
      where: {
        status: { not: UpstreamStatus.DISABLED },
        OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }]
      },
      select: { id: true }
    });

    for (const upstream of upstreams) {
      await queue.add(
        'sync-upstream',
        { upstreamId: upstream.id },
        {
          jobId: `sync:${upstream.id}:${Math.floor(now.getTime() / intervalMs)}`,
          removeOnComplete: 200,
          removeOnFail: 500
        }
      );
    }
  }

  const timer = setInterval(() => {
    enqueueDueUpstreams().catch((error) => {
      console.error('[scheduler] failed to enqueue upstream sync jobs', error);
    });
  }, intervalMs);

  enqueueDueUpstreams().catch((error) => {
    console.error('[scheduler] initial enqueue failed', error);
  });

  return async () => {
    clearInterval(timer);
    await queue.close();
    await prisma.$disconnect();
  };
}
