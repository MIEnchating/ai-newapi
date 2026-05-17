import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlertRulesController } from './alert-rules.controller';
import { AlertRulesService } from './alert-rules.service';

@Module({
  controllers: [AlertRulesController],
  providers: [PrismaService, AlertRulesService]
})
export class AlertRulesModule {}
