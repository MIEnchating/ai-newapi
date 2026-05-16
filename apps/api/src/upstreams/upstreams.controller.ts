import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
      name: string;
      type: string;
      baseUrl: string;
      authMode: string;
      credential?: Record<string, string>;
    }
  ) {
    return this.upstreams.create(body);
  }

  @Post(':id/sync')
  sync(@Param('id') id: string) {
    return this.upstreams.sync(id);
  }

  @Get(':id/rates')
  rates(@Param('id') id: string) {
    return this.upstreams.rates(id);
  }
}
