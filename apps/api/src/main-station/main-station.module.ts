import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MainStationController } from './main-station.controller';
import { MainStationService } from './main-station.service';

@Module({
  controllers: [MainStationController],
  providers: [PrismaService, MainStationService]
})
export class MainStationModule {}
