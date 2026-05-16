import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return {
      ok: true,
      service: 'ai-relay-api',
      checkedAt: new Date().toISOString()
    };
  }
}
