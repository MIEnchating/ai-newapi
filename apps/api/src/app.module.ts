import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma.service';
import { RateEventsController } from './rate-events/rate-events.controller';
import { UpstreamsModule } from './upstreams/upstreams.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), UpstreamsModule],
  controllers: [HealthController, RateEventsController],
  providers: [PrismaService]
})
export class AppModule {}
