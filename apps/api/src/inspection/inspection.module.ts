import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SyncQueueService } from '../upstreams/sync-queue.service';
import { InspectionController } from './inspection.controller';
import { InspectionService } from './inspection.service';

@Module({
  controllers: [InspectionController],
  providers: [PrismaService, SyncQueueService, InspectionService]
})
export class InspectionModule {}
