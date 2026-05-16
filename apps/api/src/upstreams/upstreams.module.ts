import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SyncQueueService } from './sync-queue.service';
import { UpstreamsController } from './upstreams.controller';
import { UpstreamsService } from './upstreams.service';

@Module({
  controllers: [UpstreamsController],
  providers: [PrismaService, SyncQueueService, UpstreamsService]
})
export class UpstreamsModule {}
