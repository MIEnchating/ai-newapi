import { NextResponse } from 'next/server';
import { listAlertRules, listBackendChannels, listBackendRateEvents, type AlertRule, type BackendRateEvent } from '../backend-upstreams';
import { currentTime, getStore, type ChannelRecord, type EventRecord } from '../store';
import { requireAuth } from '../auth/session';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const store = getStore();
  const generatedEvents = await generatedRuleEvents().catch(() => []);

  return NextResponse.json({ events: [...generatedEvents, ...store.events].slice(0, 50) });
}

export async function DELETE(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  const testOnly = new URL(request.url).searchParams.get('testOnly') === '1';
  const store = getStore();

  if (testOnly) {
    store.events = store.events.filter(
      (event) => !/自动检查|测试渠道/.test(`${event.title} ${event.detail}`)
    );
  } else {
    store.events = [];
  }

  return NextResponse.json({ events: store.events });
}

async function generatedRuleEvents(): Promise<EventRecord[]> {
  const [rules, channels, rateEvents] = await Promise.all([
    listAlertRules(),
    listBackendChannels(),
    listBackendRateEvents()
  ]);
  const ruleMap = new Map(rules.map((rule) => [rule.type, rule]));

  return [
    ...rateAlertEvents(ruleMap, rateEvents),
    ...channelAlertEvents(ruleMap, channels)
  ].slice(0, 30);
}

function rateAlertEvents(ruleMap: Map<string, AlertRule>, rateEvents: BackendRateEvent[]): EventRecord[] {
  const events: EventRecord[] = [];
  const lastEventByKey = new Map<string, number>();

  for (const event of rateEvents) {
    const ruleType = event.direction === 'UP' ? 'RATE_INCREASE' : event.direction === 'DOWN' ? 'RATE_DECREASE' : null;
    if (!ruleType) {
      continue;
    }

    const rule = enabledRule(ruleMap, ruleType);
    const changePercent = Math.abs(numeric(event.changePercent) ?? 0);
    const threshold = numeric(rule?.thresholdPercent) ?? 0;

    if (!rule || changePercent < threshold) {
      continue;
    }

    const timestamp = Date.parse(event.createdAt);
    const cooldownMs = Math.max(1, rule.cooldownMinutes) * 60_000;
    const dedupeKey = `${ruleType}:${event.upstream?.id ?? ''}:${event.groupName ?? 'default'}:${event.model}:${event.field}`;
    const previousTimestamp = lastEventByKey.get(dedupeKey);
    if (Number.isFinite(timestamp) && previousTimestamp !== undefined && Math.abs(previousTimestamp - timestamp) < cooldownMs) {
      continue;
    }
    if (Number.isFinite(timestamp)) {
      lastEventByKey.set(dedupeKey, timestamp);
    }

    events.push({
      title: `${event.upstream?.name ?? '渠道'} ${event.direction === 'UP' ? '倍率上涨' : '倍率下降'} ${formatPercent(changePercent)}`,
      detail: `${event.groupName ?? 'default'} / ${event.model} / ${formatValue(event.oldValue)} -> ${formatValue(event.newValue)}`,
      time: formatEventTime(event.createdAt),
      status: severityStatus(rule.severity)
    });
  }

  return events;
}

function channelAlertEvents(ruleMap: Map<string, AlertRule>, channels: ChannelRecord[]): EventRecord[] {
  const events: EventRecord[] = [];
  const balanceRule = enabledRule(ruleMap, 'BALANCE_LOW');
  const latencyRule = enabledRule(ruleMap, 'LATENCY_HIGH');
  const disabledRule = enabledRule(ruleMap, 'LATENCY_DISABLED');
  const syncRule = enabledRule(ruleMap, 'SYNC_ERROR');
  const challengeRule = enabledRule(ruleMap, 'CHALLENGE_REQUIRED');
  const expiredRule = enabledRule(ruleMap, 'CREDENTIAL_EXPIRED');

  for (const channel of channels) {
    const balance = numeric(channel.balance);
    if (balanceRule && balance !== undefined && balance <= (numeric(balanceRule.thresholdAmount) ?? 0)) {
      events.push({
        title: `${channel.name} 余额过低`,
        detail: `当前余额 ${balance.toFixed(2)}，阈值 ${formatValue(balanceRule.thresholdAmount)}`,
        time: currentTime(),
        status: severityStatus(balanceRule.severity)
      });
    }

    if (disabledRule && channel.disabledByLatency) {
      events.push({
        title: `${channel.name} 已被延迟规则禁用`,
        detail: channel.latencyLastError ?? `连续失败 ${channel.latencyFailureCount ?? 0} 次`,
        time: currentTime(),
        status: severityStatus(disabledRule.severity)
      });
    } else if (latencyRule && typeof channel.latencyMs === 'number' && channel.latencyMs >= (latencyRule.thresholdMs ?? 0)) {
      events.push({
        title: `${channel.name} 延迟过高`,
        detail: `当前 ${formatLatencySeconds(channel.latencyMs)}，阈值 ${formatLatencySeconds(latencyRule.thresholdMs ?? 0)}`,
        time: currentTime(),
        status: severityStatus(latencyRule.severity)
      });
    }

    if (syncRule && /同步失败|读取失败/.test(channel.status)) {
      events.push({
        title: `${channel.name} 同步失败`,
        detail: channel.rateSource || channel.status,
        time: currentTime(),
        status: severityStatus(syncRule.severity)
      });
    }

    if (challengeRule && /人工处理|Challenge|验证码|CF/i.test(`${channel.status} ${channel.cf}`)) {
      events.push({
        title: `${channel.name} 需要人工处理`,
        detail: '上游返回防护或验证码状态',
        time: currentTime(),
        status: severityStatus(challengeRule.severity)
      });
    }

    if (expiredRule && /过期|失效|权限不足/.test(channel.status)) {
      events.push({
        title: `${channel.name} 认证异常`,
        detail: channel.status,
        time: currentTime(),
        status: severityStatus(expiredRule.severity)
      });
    }
  }

  return events;
}

function enabledRule(ruleMap: Map<string, AlertRule>, type: string) {
  const rule = ruleMap.get(type);
  return rule?.enabled ? rule : null;
}

function severityStatus(severity: AlertRule['severity']): EventRecord['status'] {
  if (severity === 'CRITICAL') {
    return 'error';
  }

  if (severity === 'WARNING') {
    return 'warning';
  }

  return 'success';
}

function numeric(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatValue(value: unknown) {
  const parsed = numeric(value);
  return parsed === undefined ? '-' : parsed.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLatencySeconds(value: number) {
  const seconds = value / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : Number(seconds.toFixed(2))}秒`;
}

function formatEventTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return currentTime();
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp));
}
