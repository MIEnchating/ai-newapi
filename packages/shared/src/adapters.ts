import type { ChannelInfo, RateInfo, UpstreamAccountState, UsageInfo } from './types';

export interface UpstreamAdapter {
  testConnection(): Promise<boolean>;
  getAccountState(): Promise<UpstreamAccountState>;
  listModels(): Promise<string[]>;
  listRates(): Promise<RateInfo[]>;
  listChannels?(): Promise<ChannelInfo[]>;
  listUsage?(): Promise<UsageInfo[]>;
}

export function percentChange(oldValue?: number, newValue?: number): number | undefined {
  if (oldValue === undefined || newValue === undefined || oldValue === 0) {
    return undefined;
  }

  return ((newValue - oldValue) / oldValue) * 100;
}

export function stableRateKey(rate: Pick<RateInfo, 'provider' | 'model' | 'group'>): string {
  return [rate.provider, rate.group ?? 'default', rate.model].join(':');
}
