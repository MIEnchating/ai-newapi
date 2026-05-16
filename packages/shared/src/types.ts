export type UpstreamType = 'newapi' | 'sub2api';

export type AuthMode =
  | 'api_key'
  | 'password'
  | 'user_token'
  | 'session'
  | 'admin_token';

export type UpstreamStatus =
  | 'ok'
  | 'limited'
  | 'challenge_required'
  | 'expired'
  | 'error'
  | 'disabled';

export type RateDirection = 'up' | 'down' | 'new' | 'removed' | 'stable';

export interface UpstreamAccountState {
  balance?: number;
  balanceCurrency?: string;
  concurrency?: number;
  quota?: number;
  quotaUsed?: number;
  status: UpstreamStatus;
  lastError?: string;
}

export interface RateInfo {
  provider: string;
  model: string;
  group?: string;
  channelName?: string;
  inputPrice?: number;
  outputPrice?: number;
  modelRatio?: number;
  completionRatio?: number;
  currency?: string;
  source: string;
  capturedAt: string;
  rawHash?: string;
}

export interface ChannelInfo {
  id?: string;
  name: string;
  provider: string;
  models: string[];
  status?: string;
  priority?: number;
  weight?: number;
}

export interface UsageInfo {
  keyName?: string;
  quota?: number;
  quotaUsed?: number;
  usage5h?: number;
  usage1d?: number;
  usage7d?: number;
}

export interface RateChange {
  provider: string;
  model: string;
  group?: string;
  direction: RateDirection;
  field: 'input_price' | 'output_price' | 'model_ratio' | 'completion_ratio';
  oldValue?: number;
  newValue?: number;
  changePercent?: number;
}
