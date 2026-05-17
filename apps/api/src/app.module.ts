import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma.service';
import { RateEventsController } from './rate-events/rate-events.controller';
import { AuthModule } from './auth/auth.module';
import { AlertRulesModule } from './alert-rules/alert-rules.module';
import { InspectionModule } from './inspection/inspection.module';
import { MainStationModule } from './main-station/main-station.module';
import { UpstreamsModule } from './upstreams/upstreams.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, UpstreamsModule, InspectionModule, MainStationModule, AlertRulesModule],
  controllers: [HealthController, RateEventsController],
  providers: [PrismaService]
})
export class AppModule {}
