import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { startScheduler } from './scheduler';
import { syncUpstream } from './sync/sync-upstream';

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
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
  { connection }
);

const stopScheduler = startScheduler(connection);

worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on('failed', (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

process.on('SIGINT', async () => {
  await stopScheduler();
  await worker.close();
  await connection.quit();
  process.exit(0);
});
