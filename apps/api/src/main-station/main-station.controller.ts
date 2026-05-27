import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common';
import { MainStationService } from './main-station.service';

@Controller('main-station')
export class MainStationController {
  constructor(@Inject(MainStationService) private readonly mainStation: MainStationService) {}

  @Get()
  get() {
    return this.mainStation.get();
  }

  @Patch()
  update(
    @Body()
    body: {
      name?: string;
      baseUrl?: string;
      auth?: string;
      adminUserId?: string;
      adminToken?: string;
    }
  ) {
    return this.mainStation.update(body);
  }

  @Post('sync-channels')
  syncChannels() {
    return this.mainStation.syncChannels();
  }

  @Get('groups')
  groups() {
    return this.mainStation.listGroups();
  }

  @Post('groups')
  createGroup(
    @Body()
    body: {
      name?: string;
      ratio?: number;
    }
  ) {
    return this.mainStation.createGroup(body);
  }
}
