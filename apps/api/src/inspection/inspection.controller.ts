import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { InspectionService } from './inspection.service';

@Controller('inspection')
export class InspectionController {
  constructor(private readonly inspection: InspectionService) {}

  @Get()
  status() {
    return this.inspection.status();
  }

  @Patch()
  update(
    @Body()
    body: {
      enabled?: boolean;
      intervalMs?: number;
      latencyTestEnabled?: boolean;
      latencyIntervalMs?: number;
      latencyTimeoutMs?: number;
      latencyDisableThresholdMs?: number;
      latencyFailureLimit?: number;
      disabledRetestMs?: number;
      latencyAutoDisableEnabled?: boolean;
      priorityUpdateEnabled?: boolean;
      priorityStrategy?: string;
      cpaPreferred?: boolean;
      inspectionConcurrency?: number;
      balanceLowAction?: string;
      rateIncreaseAction?: string;
      ruleActionPriority?: number;
      ruleActionWeight?: number;
    }
  ) {
    return this.inspection.update(body);
  }

  @Post('run')
  runNow() {
    return this.inspection.runNow();
  }
}
