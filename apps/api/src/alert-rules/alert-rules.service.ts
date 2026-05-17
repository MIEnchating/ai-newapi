import { BadRequestException, Injectable } from '@nestjs/common';
import { AlertRuleType, AlertSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

const ruleTypes = new Set(Object.values(AlertRuleType));
const severities = new Set(Object.values(AlertSeverity));
const notificationMethods = new Set(['email', 'webhook']);

const defaultRules: Array<{
  type: AlertRuleType;
  name: string;
  enabled: boolean;
  severity: AlertSeverity;
  thresholdPercent?: number;
  thresholdMs?: number;
  thresholdAmount?: number;
  failureLimit?: number;
  cooldownMinutes: number;
  notificationMethods?: string[];
}> = [
  {
    type: AlertRuleType.RATE_INCREASE,
    name: '倍率上涨',
    enabled: true,
    severity: AlertSeverity.WARNING,
    thresholdPercent: 3,
    cooldownMinutes: 30
  },
  {
    type: AlertRuleType.RATE_DECREASE,
    name: '倍率下降',
    enabled: false,
    severity: AlertSeverity.INFO,
    thresholdPercent: 5,
    cooldownMinutes: 30
  },
  {
    type: AlertRuleType.BALANCE_LOW,
    name: '余额过低',
    enabled: true,
    severity: AlertSeverity.WARNING,
    thresholdAmount: 10,
    cooldownMinutes: 60
  },
  {
    type: AlertRuleType.LATENCY_HIGH,
    name: '延迟过高',
    enabled: true,
    severity: AlertSeverity.WARNING,
    thresholdMs: 8000,
    cooldownMinutes: 30
  },
  {
    type: AlertRuleType.LATENCY_DISABLED,
    name: '延迟自动禁用',
    enabled: true,
    severity: AlertSeverity.CRITICAL,
    failureLimit: 3,
    cooldownMinutes: 30
  },
  {
    type: AlertRuleType.SYNC_ERROR,
    name: '同步失败',
    enabled: true,
    severity: AlertSeverity.CRITICAL,
    failureLimit: 1,
    cooldownMinutes: 15
  },
  {
    type: AlertRuleType.CHALLENGE_REQUIRED,
    name: 'CF/验证码',
    enabled: true,
    severity: AlertSeverity.WARNING,
    cooldownMinutes: 60
  },
  {
    type: AlertRuleType.CREDENTIAL_EXPIRED,
    name: '认证过期',
    enabled: true,
    severity: AlertSeverity.CRITICAL,
    failureLimit: 1,
    cooldownMinutes: 60
  }
];

@Injectable()
export class AlertRulesService {
  private schemaChecked = false;

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    await this.ensureDefaults();
    const [rules, methodRows] = await Promise.all([
      this.prisma.alertRule.findMany({
        orderBy: { type: 'asc' }
      }),
      this.notificationMethodRows()
    ]);
    const methodMap = new Map(methodRows.map((row) => [row.type, row.notificationMethods]));

    return rules.sort((left, right) => ruleOrder(left.type) - ruleOrder(right.type)).map((rule) => ({
      ...rule,
      notificationMethods: parseNotificationMethods(methodMap.get(rule.type))
    }));
  }

  async update(typeInput: string | undefined, input: {
    enabled?: boolean;
    severity?: string;
    thresholdPercent?: number | null;
    thresholdMs?: number | null;
    thresholdAmount?: number | null;
    failureLimit?: number | null;
    cooldownMinutes?: number;
    notificationMethods?: unknown;
  }) {
    const type = parseRuleType(typeInput);
    const data: Prisma.AlertRuleUpdateInput = {};
    const normalizedNotificationMethods =
      input.notificationMethods === undefined ? undefined : normalizeNotificationMethods(input.notificationMethods);

    if (typeof input.enabled === 'boolean') {
      data.enabled = input.enabled;
    }
    if (input.severity !== undefined) {
      data.severity = parseSeverity(input.severity);
    }
    if (input.thresholdPercent !== undefined) {
      data.thresholdPercent = input.thresholdPercent === null ? null : normalizeDecimal(input.thresholdPercent, 0, 1000);
    }
    if (input.thresholdMs !== undefined) {
      data.thresholdMs = input.thresholdMs === null ? null : normalizeInteger(input.thresholdMs, 100, 120_000);
    }
    if (input.thresholdAmount !== undefined) {
      data.thresholdAmount = input.thresholdAmount === null ? null : normalizeDecimal(input.thresholdAmount, 0, 10_000_000);
    }
    if (input.failureLimit !== undefined) {
      data.failureLimit = input.failureLimit === null ? null : normalizeInteger(input.failureLimit, 1, 100);
    }
    if (input.cooldownMinutes !== undefined) {
      data.cooldownMinutes = normalizeInteger(input.cooldownMinutes, 1, 24 * 60);
    }

    await this.ensureDefaults();
    if (Object.keys(data).length > 0) {
      await this.prisma.alertRule.update({
        where: { type },
        data
      });
    }
    if (normalizedNotificationMethods !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE AlertRule
        SET notificationMethods = ${normalizedNotificationMethods},
            updatedAt = CURRENT_TIMESTAMP(3)
        WHERE type = ${type}
      `;
    }

    return this.list();
  }

  private async ensureDefaults() {
    await this.ensureSchema();
    await this.prisma.$transaction(
      defaultRules.map((rule) => {
        const { notificationMethods: _notificationMethods, ...create } = rule;

        return this.prisma.alertRule.upsert({
          where: { type: rule.type },
          create,
          update: {}
        });
      })
    );
  }

  private notificationMethodRows() {
    return this.prisma.$queryRaw<Array<{ type: AlertRuleType; notificationMethods: string | null }>>`
      SELECT type, notificationMethods
      FROM AlertRule
    `;
  }

  private async ensureSchema() {
    if (this.schemaChecked) {
      return;
    }

    const rows = await this.prisma.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AlertRule'
        AND COLUMN_NAME = 'notificationMethods'
    `;

    if (Number(rows[0]?.count ?? 0) === 0) {
      await this.prisma.$executeRawUnsafe(
        "ALTER TABLE `AlertRule` ADD COLUMN `notificationMethods` VARCHAR(191) NOT NULL DEFAULT ''"
      );
    }

    this.schemaChecked = true;
  }
}

function parseRuleType(value: string | undefined) {
  const type = value?.toUpperCase() as AlertRuleType;

  if (!type || !ruleTypes.has(type)) {
    throw new BadRequestException('unsupported alert rule type');
  }

  return type;
}

function parseSeverity(value: string) {
  const severity = value.toUpperCase() as AlertSeverity;

  if (!severities.has(severity)) {
    throw new BadRequestException('unsupported alert severity');
  }

  return severity;
}

function normalizeInteger(value: unknown, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new BadRequestException('invalid numeric value');
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeDecimal(value: unknown, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new BadRequestException('invalid numeric value');
  }

  return new Prisma.Decimal(Math.min(max, Math.max(min, parsed)));
}

function normalizeNotificationMethods(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const normalized: string[] = [];

  for (const raw of values) {
    const method = String(raw).trim().toLowerCase();
    if (!notificationMethods.has(method) || normalized.includes(method)) {
      continue;
    }

    normalized.push(method);
  }

  return normalized.join(',');
}

function parseNotificationMethods(value: string | null | undefined) {
  return normalizeNotificationMethods(value).split(',').filter(Boolean);
}

function ruleOrder(type: AlertRuleType) {
  return defaultRules.findIndex((rule) => rule.type === type);
}
