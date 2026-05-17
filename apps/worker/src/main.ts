import './env';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { startScheduler } from './scheduler';
import { syncUpstream } from './sync/sync-upstream';
import { prisma } from './prisma';

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
});

const worker = new Worker(
  'upstream-sync',
  async (job) => {
    if (job.name !== 'sync-upstream') {
      return;
    }

    await syncUpstream(String(job.data.upstreamId));
  },
  { connection, concurrency: normalizeConcurrency(process.env.SYNC_CONCURRENCY ?? 3) }
);

const stopScheduler = startScheduler(connection);
const concurrencyTimer = setInterval(() => {
  loadInspectionConcurrency()
    .then((concurrency) => {
      worker.concurrency = concurrency;
    })
    .catch(() => undefined);
}, 30_000);

worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on('failed', (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

process.on('SIGINT', async () => {
  clearInterval(concurrencyTimer);
  await stopScheduler();
  await worker.close();
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
});

async function loadInspectionConcurrency() {
  await ensureInspectionConcurrencyColumn();
  const rows = await prisma.$queryRaw<Array<{ inspectionConcurrency: number | null }>>`
    SELECT inspectionConcurrency FROM InspectionSetting WHERE id = 'default' LIMIT 1
  `;

  return normalizeConcurrency(rows[0]?.inspectionConcurrency ?? process.env.SYNC_CONCURRENCY ?? 3);
}

async function ensureInspectionConcurrencyColumn() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE InspectionSetting ADD COLUMN inspectionConcurrency INT NOT NULL DEFAULT 3');
  } catch (error) {
    if (!/Duplicate column|1060/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }
}

function normalizeConcurrency(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(20, Math.max(1, Math.trunc(parsed))) : 3;
}
