import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { UpstreamsService } from './upstreams.service';

@Controller('upstreams')
export class UpstreamsController {
  constructor(private readonly upstreams: UpstreamsService) {}

  @Get()
  list() {
    return this.upstreams.list();
  }

  @Post()
  create(
    @Body()
    body: {
      id?: string;
      name: string;
      type: string;
      baseUrl: string;
      authMode: string;
      groupName?: string;
      mainStationGroupName?: string;
      upstreamName?: string;
      upstreamUserId?: string;
      keyName?: string;
      skipLatencyDisable?: boolean;
      status?: string;
      rechargeRatio?: number;
      priority?: number;
      weight?: number;
      credential?: Record<string, string>;
      clearCredential?: boolean;
      syncGroupRechargeRatio?: boolean;
      createMainStation?: boolean;
      mainStationKey?: string;
      mainStationChannelType?: number;
      models?: string;
    }
  ) {
    return this.upstreams.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      id?: string;
      name?: string;
      type?: string;
      baseUrl?: string;
      authMode?: string;
      groupName?: string;
      mainStationGroupName?: string;
      upstreamName?: string;
      upstreamUserId?: string;
      keyName?: string;
      skipLatencyDisable?: boolean;
      status?: string;
      rechargeRatio?: number;
      priority?: number;
      weight?: number;
      credential?: Record<string, string>;
      clearCredential?: boolean;
      syncGroupRechargeRatio?: boolean;
      models?: string;
    }
  ) {
    return this.upstreams.update(id, body);
  }

  @Post(':id/test')
  test(
    @Param('id') id: string,
    @Body()
    body: {
      type?: string;
      baseUrl?: string;
      authMode?: string;
      upstreamUserId?: string;
      credential?: Record<string, string>;
    }
  ) {
    return this.upstreams.testCredential(id, body);
  }

  @Post('test')
  testDraft(
    @Body()
    body: {
      type?: string;
      baseUrl?: string;
      authMode?: string;
      groupName?: string;
      upstreamUserId?: string;
      credential?: Record<string, string>;
    }
  ) {
    return this.upstreams.testDraftCredential(body);
  }

  @Post(':id/groups')
  groups(
    @Param('id') id: string,
    @Body()
    body: {
      type?: string;
      baseUrl?: string;
      authMode?: string;
      upstreamUserId?: string;
      credential?: Record<string, string>;
    }
  ) {
    return this.upstreams.listGroups(id, body);
  }

  @Post('groups')
  draftGroups(
    @Body()
    body: {
      type?: string;
      baseUrl?: string;
      authMode?: string;
      upstreamUserId?: string;
      credential?: Record<string, string>;
    }
  ) {
    return this.upstreams.listDraftGroups(body);
  }

  @Post(':id/sync')
  sync(@Param('id') id: string) {
    return this.upstreams.sync(id);
  }

  @Get(':id/rates')
  rates(@Param('id') id: string) {
    return this.upstreams.rates(id);
  }

  @Get(':id/cpa-pool')
  cpaPool(@Param('id') id: string) {
    return this.upstreams.cpaPool(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.upstreams.remove(id);
  }
}
