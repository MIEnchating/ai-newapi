import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

@Injectable()
export class SyncQueueService implements OnModuleDestroy {
  private readonly connection = new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null
  });

  private readonly queue = new Queue('upstream-sync', {
    connection: this.connection
  });

  enqueue(upstreamId: string) {
    return this.queue.add('sync-upstream', { upstreamId }, { removeOnComplete: 200, removeOnFail: 500 });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
