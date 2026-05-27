import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';

@Controller('alert-rules')
export class AlertRulesController {
  constructor(@Inject(AlertRulesService) private readonly alertRules: AlertRulesService) {}

  @Get()
  list() {
    return this.alertRules.list();
  }

  @Patch()
  update(
    @Body()
    body: {
      type?: string;
      enabled?: boolean;
      severity?: string;
      thresholdPercent?: number | null;
      thresholdMs?: number | null;
      thresholdAmount?: number | null;
      failureLimit?: number | null;
      cooldownMinutes?: number;
      notificationMethods?: string[] | string | null;
    }
  ) {
    return this.alertRules.update(body.type, body);
  }
}
