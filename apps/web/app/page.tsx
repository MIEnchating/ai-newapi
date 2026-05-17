'use client';

import {
  AlertOutlined,
  ApiOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloudOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DownOutlined,
  EditOutlined,
  FieldTimeOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import {
  AutoComplete,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  message,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  theme
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DefaultOptionType } from 'antd/es/select';
import type { FormInstance } from 'antd/es/form';
import type { MenuProps } from 'antd';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const { Header, Sider, Content } = Layout;
const { Text, Title, Paragraph } = Typography;

type View = 'overview' | 'channels' | 'rates' | 'credentials' | 'cpaPool' | 'alerts';
type RelayType = 'newapi';
type UpstreamProvider = 'newapi' | 'sub2api' | 'cli_proxy';
type ChannelFormUpstreamType = UpstreamProvider | 'unknown';
type StatusTone = 'ok' | 'warn' | 'limited' | 'error';
type RateFilter = 'all' | 'changed' | 'limited';
type ProviderFilter = 'all' | UpstreamProvider;
type CredentialMode = 'server' | 'none';
const MAIN_STATION_GROUP_ALL = '__all_main_station_groups__';

type AuthStatus = {
  setupRequired: boolean;
  authenticated: boolean;
  username?: string;
};

type RelayView = {
  id: string;
  name: string;
  type: RelayType;
  baseUrl: string;
  auth: string;
  adminUserId: string;
  tokenConfigured: boolean;
  status: string;
  statusTone: StatusTone;
  channelCount: number;
  balance: string;
  sync: string;
};

type ChannelView = {
  id: string;
  relayId: string;
  name: string;
  group: string;
  mainStationGroup?: string;
  upstreamType: UpstreamProvider;
  upstreamName: string;
  upstreamBaseUrl: string;
  upstreamUserId?: string;
  keyName?: string;
  skipLatencyDisable?: boolean;
  enabled: boolean;
  auth: string;
  credentialConfigured: boolean;
  status: string;
  statusTone: StatusTone;
  balance: string;
  models: number;
  groupRatio: number | null;
  rateSource: string;
  rechargeRatio: number;
  currentRate: number | null;
  previousRate: number | null;
  cf: string;
  priority: number;
  weight: number;
  latencyMs?: number | null;
  latencyCheckedAt?: string | null;
  latencyFailureCount?: number;
  latencySuccessCount?: number;
  latencyLastError?: string | null;
  disabledByLatency?: boolean;
  latencyDisabledAt?: string | null;
  latencyNextCheckAt?: string | null;
  sync: string;
};

type RateRow = {
  key: string;
  relayName: string;
  channelName: string;
  upstreamName: string;
  upstreamType: UpstreamProvider;
  keyName: string;
  group: string;
  input: string;
  output: string;
  currentRate: number | null;
  previousRate: number | null;
  direction: 'up' | 'down' | 'limited' | 'stable';
};

type RateGroup = {
  key: string;
  name: string;
  upstreamType: UpstreamProvider;
  rows: RateRow[];
};

type ChannelGroup = {
  key: string;
  name: string;
  channels: ChannelView[];
};

type CredentialGroup = ChannelGroup & {
  primary: ChannelView;
  configuredCount: number;
  enabledCount: number;
  authLabels: string[];
  providerTypes: UpstreamProvider[];
  latestSync: string;
};

type EventItem = {
  title: string;
  detail: string;
  time: string;
  status: 'error' | 'success' | 'warning';
};

type AlertRuleType =
  | 'RATE_INCREASE'
  | 'RATE_DECREASE'
  | 'BALANCE_LOW'
  | 'LATENCY_HIGH'
  | 'LATENCY_DISABLED'
  | 'SYNC_ERROR'
  | 'CHALLENGE_REQUIRED'
  | 'CREDENTIAL_EXPIRED';

type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
type AlertNotificationMethod = 'email' | 'webhook';

type AlertRuleView = {
  id: string;
  type: AlertRuleType;
  name: string;
  enabled: boolean;
  severity: AlertSeverity;
  thresholdPercent?: string | number | null;
  thresholdMs?: number | null;
  thresholdAmount?: string | number | null;
  failureLimit?: number | null;
  cooldownMinutes: number;
  notificationMethods: AlertNotificationMethod[] | string | null;
};

type AlertRuleUpdate = Partial<Omit<AlertRuleView, 'id' | 'type' | 'name'>> & {
  type: AlertRuleType;
};

type CpaPoolAccountView = {
  key: string;
  index: string;
  name: string;
  account: string;
  provider: string;
  status: string;
  successCount: number;
  failureCount: number;
  usage5h: number | null;
  usage7d: number | null;
  lastRefresh?: string | null;
  refreshTime?: string | null;
};

type CpaPoolView = {
  channel?: {
    id: string;
    name: string;
    baseUrl: string;
  };
  channels: Array<{
    id: string;
    name: string;
    credentialConfigured: boolean;
  }>;
  accounts: CpaPoolAccountView[];
  usageQueueError?: string | null;
  refreshedAt?: string;
};

type InspectionView = {
  enabled: boolean;
  intervalMs: number;
  latencyTestEnabled: boolean;
  latencyIntervalMs: number;
  latencyTimeoutMs: number;
  latencyDisableThresholdMs: number;
  latencyFailureLimit: number;
  disabledRetestMs: number;
  cpaPreferred: boolean;
  inspectionConcurrency: number;
  balanceLowAction: InspectionRuleAction;
  rateIncreaseAction: InspectionRuleAction;
  ruleActionPriority: number;
  ruleActionWeight: number;
  lastRunAt?: string | null;
  lastQueuedAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
  activeUpstreamCount: number;
  dueUpstreamCount: number;
  latencyDisabledCount: number;
  latencyDueCount: number;
};

type InspectionUpdate = Partial<Pick<
  InspectionView,
  | 'enabled'
  | 'intervalMs'
  | 'latencyTestEnabled'
  | 'latencyIntervalMs'
  | 'latencyTimeoutMs'
  | 'latencyDisableThresholdMs'
  | 'latencyFailureLimit'
  | 'disabledRetestMs'
  | 'cpaPreferred'
  | 'inspectionConcurrency'
  | 'balanceLowAction'
  | 'rateIncreaseAction'
  | 'ruleActionPriority'
  | 'ruleActionWeight'
>>;

type InspectionRuleAction = 'NONE' | 'LOWER' | 'DISABLE';

type UpstreamTypeDetection = {
  type: UpstreamProvider | 'unknown';
  reason: string;
};

type ChannelForm = {
  id?: string;
  relayId: string;
  name: string;
  group: string;
  mainStationGroup?: string;
  upstreamType?: ChannelFormUpstreamType;
  upstreamName: string;
  upstreamBaseUrl: string;
  upstreamUserId?: string;
  keyName?: string;
  skipLatencyDisable?: boolean;
  auth: string;
  credential?: string;
  credentialAccount?: string;
  credentialPassword?: string;
  createMainStation?: boolean;
  mainStationKey?: string;
  models?: string;
  rechargeRatio: number;
  priority: number;
  weight: number;
  enabled: boolean;
};

type PlatformCredentialForm = {
  auth: string;
  upstreamUserId?: string;
  credential?: string;
  credentialAccount?: string;
  credentialPassword?: string;
};

type CredentialTestResult = {
  ok: boolean;
  status: 'ok' | 'limited' | 'error';
  message: string;
  balance?: number;
  balanceCurrency?: string;
  groupRatio?: number | null;
  rateSource?: string;
  suggestedRechargeRatio?: number | null;
};

type UpstreamGroupInfo = {
  id?: string;
  name: string;
  remark?: string;
  ratio?: number | null;
  source: string;
};

type MainStationGroupInfo = {
  name: string;
  ratio?: number | null;
  source: string;
};

type AutocompleteOption = DefaultOptionType & {
  value: string;
  searchText: string;
};

type LoginForm = {
  username: string;
  password: string;
  confirmPassword?: string;
};

type RelayForm = {
  id: string;
  name: string;
  baseUrl: string;
  auth: string;
  adminUserId: string;
  adminToken?: string;
};

const initialRelays: RelayView[] = [
  {
    id: 'relay-newapi-main',
    name: '主站',
    type: 'newapi',
    baseUrl: '待配置',
    auth: '管理 Token',
    adminUserId: '',
    tokenConfigured: false,
    status: '待配置',
    statusTone: 'limited',
    channelCount: 0,
    balance: '-',
    sync: '尚未同步'
  }
];

const initialChannels: ChannelView[] = [];

const initialEvents: EventItem[] = [];
const initialAlertRules: AlertRuleView[] = [];
const initialCpaPool: CpaPoolView = { channels: [], accounts: [] };
const channelIdCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const notificationMethodOptions: Array<{ label: string; value: AlertNotificationMethod }> = [
  { label: '邮箱', value: 'email' },
  { label: 'Webhook', value: 'webhook' }
];
const inspectionActionOptions: Array<{ label: string; value: InspectionRuleAction }> = [
  { label: '只告警', value: 'NONE' },
  { label: '降低优权', value: 'LOWER' },
  { label: '禁用渠道', value: 'DISABLE' }
];
const intervalOptions = [
  { label: '5 分钟', value: 300_000 },
  { label: '15 分钟', value: 900_000 },
  { label: '30 分钟', value: 1_800_000 },
  { label: '1 小时', value: 3_600_000 },
  { label: '6 小时', value: 21_600_000 }
];

async function validateFormOrStop<T>(
  form: {
    validateFields: () => Promise<T>;
    scrollToField?: (name: string | number | Array<string | number>) => void;
  },
  onError?: (message: string) => void
) {
  try {
    return await form.validateFields();
  } catch (error) {
    const fields = formValidationFields(error);
    const firstField = fields[0];
    const firstError = firstField?.errors?.[0];

    if (firstField?.name) {
      form.scrollToField?.(firstField.name);
    }
    onError?.(firstError ?? '请检查表单必填项');
    return null;
  }
}

function formValidationFields(error: unknown): Array<{ name?: Array<string | number>; errors?: string[] }> {
  if (!error || typeof error !== 'object' || !('errorFields' in error)) {
    return [];
  }

  const errorFields = (error as { errorFields?: unknown }).errorFields;

  return Array.isArray(errorFields) ? errorFields as Array<{ name?: Array<string | number>; errors?: string[] }> : [];
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const directMessage = record.message ?? record.error ?? record.reason;

    if (typeof directMessage === 'string' && directMessage.trim()) {
      return directMessage;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return '未知错误';
    }
  }

  return String(error);
}

export default function DashboardPage() {
  const [activeView, setActiveView] = useState<View>('overview');
  const [rateFilter, setRateFilter] = useState<RateFilter>('all');
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [groupChannels, setGroupChannels] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingChannelId, setSyncingChannelId] = useState<string | null>(null);
  const [detectingUpstreamType, setDetectingUpstreamType] = useState(false);
  const [loadingSiteName, setLoadingSiteName] = useState(false);
  const [autoFilledUpstreamName, setAutoFilledUpstreamName] = useState(false);
  const [upstreamTypeHint, setUpstreamTypeHint] = useState<UpstreamTypeDetection | null>(null);
  const [detectingChannelTypes, setDetectingChannelTypes] = useState(false);
  const [inspection, setInspection] = useState<InspectionView | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [savingChannel, setSavingChannel] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [credentialModalOpen, setCredentialModalOpen] = useState(false);
  const [editingCredentialGroupKey, setEditingCredentialGroupKey] = useState<string | null>(null);
  const [testingCredential, setTestingCredential] = useState(false);
  const [credentialTestResult, setCredentialTestResult] = useState<CredentialTestResult | null>(null);
  const [loadingUpstreamGroups, setLoadingUpstreamGroups] = useState(false);
  const [upstreamGroups, setUpstreamGroups] = useState<UpstreamGroupInfo[]>([]);
  const [mainStationGroups, setMainStationGroups] = useState<MainStationGroupInfo[]>([]);
  const [creatingMainStationGroup, setCreatingMainStationGroup] = useState(false);
  const [relayModalOpen, setRelayModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mainStationGroupFilter, setMainStationGroupFilter] = useState(MAIN_STATION_GROUP_ALL);
  const [relays, setRelays] = useState(initialRelays);
  const [channels, setChannels] = useState(initialChannels);
  const [events, setEvents] = useState(initialEvents);
  const [alertRules, setAlertRules] = useState(initialAlertRules);
  const [cpaPool, setCpaPool] = useState<CpaPoolView>(initialCpaPool);
  const [cpaPoolLoading, setCpaPoolLoading] = useState(false);
  const [selectedCpaChannelId, setSelectedCpaChannelId] = useState<string | undefined>();
  const [savingAlertRuleType, setSavingAlertRuleType] = useState<AlertRuleType | null>(null);
  const [form] = Form.useForm<ChannelForm>();
  const [credentialForm] = Form.useForm<PlatformCredentialForm>();
  const [relayForm] = Form.useForm<RelayForm>();
  const [messageApi, contextHolder] = message.useMessage();
  const watchedChannelBaseUrl = Form.useWatch('upstreamBaseUrl', form);
  const watchedUpstreamName = Form.useWatch('upstreamName', form);
  const watchedUpstreamType = Form.useWatch('upstreamType', form);
  const autoFilledSiteUrlRef = useRef('');

  const selectedRelay = useMemo(() => relays[0] ?? initialRelays[0], [relays]);
  const normalizedSearch = search.trim().toLowerCase();
  const activeChannels = useMemo(
    () => sortChannelsById(channels.filter((channel) => channel.relayId === selectedRelay.id)),
    [channels, selectedRelay.id]
  );
  const editingChannel = useMemo(
    () => channels.find((channel) => channel.id === editingChannelId),
    [channels, editingChannelId]
  );
  const mainStationGroupFilterOptions = useMemo(
    () => buildMainStationGroupFilterOptions(activeChannels, mainStationGroups),
    [activeChannels, mainStationGroups]
  );

  const visibleChannels = useMemo(() => {
    return activeChannels.filter((channel) => {
      const matchesProvider = providerFilter === 'all' || channel.upstreamType === providerFilter;
      const matchesMainStationGroup =
        mainStationGroupFilter === MAIN_STATION_GROUP_ALL ||
        mainStationGroupLabel(channel) === mainStationGroupFilter;
      const matchesSearch =
        !normalizedSearch ||
        [
          channel.id,
          channel.name,
          channel.group,
          channel.mainStationGroup,
          channel.upstreamType,
          upstreamProviderLabel(channel.upstreamType),
          channel.upstreamName,
          channel.upstreamBaseUrl,
          channel.auth,
          channel.status
        ].some((value) => String(value ?? '').toLowerCase().includes(normalizedSearch));

      return matchesProvider && matchesMainStationGroup && matchesSearch;
    });
  }, [activeChannels, mainStationGroupFilter, normalizedSearch, providerFilter]);
  const visibleChannelGroups = useMemo(() => groupChannelsByPlatform(visibleChannels), [visibleChannels]);
  const credentialGroups = useMemo(() => buildCredentialGroups(activeChannels), [activeChannels]);
  const mainStationGroupOptions = useMemo(
    () => buildMainStationGroupOptions(activeChannels, mainStationGroups, editingChannel),
    [activeChannels, editingChannel, mainStationGroups]
  );
  const upstreamGroupOptions = useMemo(
    () =>
      buildUpstreamGroupOptions(upstreamGroups, activeChannels, {
        upstreamName: String(watchedUpstreamName ?? ''),
        upstreamType: watchedUpstreamType,
        editingChannel
      }),
    [activeChannels, editingChannel, upstreamGroups, watchedUpstreamName, watchedUpstreamType]
  );
  const editingCredentialGroup = useMemo(
    () => credentialGroups.find((group) => group.key === editingCredentialGroupKey) ?? null,
    [credentialGroups, editingCredentialGroupKey]
  );

  const rateRows = useMemo(() => buildRateRows(activeChannels, relays), [activeChannels, relays]);
  const visibleRates = useMemo(() => {
    return filterRateRows(rateRows, rateFilter).filter((row) => {
      if (!normalizedSearch) {
        return true;
      }

      return [row.relayName, row.channelName, row.upstreamName, row.upstreamType, row.keyName, row.group].some((value) =>
        value.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [normalizedSearch, rateFilter, rateRows]);
  const visibleRateGroups = useMemo(() => groupRateRowsByUpstream(visibleRates), [visibleRates]);

  const readableCount = activeChannels.filter((channel) => channel.enabled && canReadRateAndBalance(channel)).length;
  const cliProxyCount = activeChannels.filter((channel) => channel.upstreamType === 'cli_proxy').length;
  const limitedCount = activeChannels.filter(
    (channel) => channel.enabled && channel.upstreamType !== 'cli_proxy' && channel.statusTone === 'limited'
  ).length;
  const pendingSyncCount = activeChannels.filter(
    (channel) =>
      channel.enabled &&
      channel.upstreamType !== 'cli_proxy' &&
      (channel.sync === '尚未同步' || channel.sync === '等待同步' || channel.status === '待同步')
  ).length;

  useEffect(() => {
    window.localStorage.removeItem('relaydesk.localCredentials.v1');
    void loadAuthStatus();
  }, []);

  useEffect(() => {
    if (authStatus?.authenticated) {
      void loadDashboard();
    }
  }, [authStatus?.authenticated]);

  useEffect(() => {
    if (activeView === 'cpaPool' && authStatus?.authenticated) {
      void loadCpaPool();
    }
  }, [activeView, authStatus?.authenticated, selectedCpaChannelId]);

  useEffect(() => {
    if (!modalOpen || editingChannelId) {
      return;
    }

    const upstreamBaseUrl = String(watchedChannelBaseUrl ?? '').trim();
    if (!upstreamBaseUrl) {
      return;
    }

    const timer = window.setTimeout(() => {
      void fillChannelNameFromUrl(upstreamBaseUrl);
    }, 650);

    return () => window.clearTimeout(timer);
  }, [editingChannelId, modalOpen, watchedChannelBaseUrl, autoFilledUpstreamName]);

  async function loadAuthStatus() {
    setAuthChecking(true);
    try {
      const response = await fetch('/api/auth/status', { cache: 'no-store' });
      setAuthStatus((await response.json()) as AuthStatus);
    } finally {
      setAuthChecking(false);
    }
  }

  async function loadDashboard() {
    const [relayResponse, channelResponse, eventResponse, inspectionResponse, alertRuleResponse] = await Promise.all([
      fetch('/api/relays', { cache: 'no-store' }),
      fetch('/api/channels', { cache: 'no-store' }),
      fetch('/api/events', { cache: 'no-store' }),
      fetch('/api/inspection', { cache: 'no-store' }),
      fetch('/api/alert-rules', { cache: 'no-store' })
    ]);

    if ([relayResponse, channelResponse, eventResponse, inspectionResponse, alertRuleResponse].some((response) => response.status === 401)) {
      setAuthStatus({ setupRequired: false, authenticated: false });
      return;
    }

    const relayPayload = (await relayResponse.json()) as { relays: RelayView[] };
    const channelPayload = (await channelResponse.json()) as { channels: ChannelView[] };
    const eventPayload = (await eventResponse.json()) as { events: EventItem[] };
    const inspectionPayload = (await inspectionResponse.json()) as { inspection?: InspectionView };
    const alertRulePayload = (await alertRuleResponse.json()) as { rules?: AlertRuleView[] };

    setRelays(relayPayload.relays);
    setChannels(channelPayload.channels);
    setEvents(eventPayload.events);
    setAlertRules(alertRulePayload.rules ?? []);
    if (inspectionPayload.inspection) {
      setInspection(inspectionPayload.inspection);
    }
    void loadMainStationGroups();
  }

  async function loadMainStationGroups() {
    const response = await fetch('/api/main-station-groups', { cache: 'no-store' });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json().catch(() => ({}))) as { groups?: MainStationGroupInfo[] };
    setMainStationGroups(payload.groups ?? []);
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthStatus({ setupRequired: false, authenticated: false });
    setRelays(initialRelays);
    setChannels(initialChannels);
    setEvents(initialEvents);
    setAlertRules(initialAlertRules);
    setCpaPool(initialCpaPool);
    setMainStationGroups([]);
  }

  const menuItems: MenuProps['items'] = [
    { key: 'overview', icon: <DashboardOutlined />, label: '总览' },
    { key: 'channels', icon: <CloudOutlined />, label: '渠道管理' },
    { key: 'rates', icon: <ThunderboltOutlined />, label: '倍率快照' },
    { key: 'credentials', icon: <KeyOutlined />, label: '平台凭证' },
    { key: 'cpaPool', icon: <DatabaseOutlined />, label: '号池管理' },
    { key: 'alerts', icon: <BellOutlined />, label: '告警' }
  ];

  const channelColumns: ColumnsType<ChannelView> = [
    {
      title: '渠道 / Key',
      dataIndex: 'name',
      width: 300,
      fixed: 'left',
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <Badge status={badgeStatus(record.statusTone)} />
            <Text strong>{record.name}</Text>
            <ProviderTag type={record.upstreamType} />
          </Space>
          <Text type="secondary" className="truncate-text">
            ID：{record.id} / 类型：{upstreamProviderLabel(record.upstreamType)}
          </Text>
          <Text type="secondary" className="truncate-text">
            {channelKeyDisplay(record)}
          </Text>
          <Text type="secondary" className="truncate-text">
            平台分组：{channelPlatformGroup(record)}
          </Text>
        </Flex>
      )
    },
    {
      title: '主站分组',
      key: 'mainStationGroup',
      width: 132,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Text>{mainStationGroupLabel(record)}</Text>
          <Text type="secondary" className="table-subtle">
            主站渠道分组
          </Text>
        </Flex>
      )
    },
    {
      title: '倍率分组',
      key: 'rateGroup',
      width: 132,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Text code>{rateGroupLabel(record)}</Text>
          <Text type="secondary" className="table-subtle">
            Key 倍率分组
          </Text>
        </Flex>
      )
    },
    {
      title: '地址 / 认证',
      key: 'upstreamKey',
      width: 230,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <UpstreamEndpoint channel={record} />
          <Text type="secondary" className="truncate-text">
            {record.auth} / {record.sync}
          </Text>
          <Space size={6} wrap className="center-wrap">
            {record.upstreamType === 'cli_proxy' ? <Tag>不适用</Tag> : <CredentialTag mode={credentialMode(record)} />}
            {record.upstreamType === 'cli_proxy' ? null : <RechargeRatioValue value={record.rechargeRatio} />}
          </Space>
        </Flex>
      )
    },
    {
      title: '余额(1:1)',
      dataIndex: 'balance',
      width: 92,
      render: (_, record) => <BalanceValue channel={record} />
    },
    {
      title: '倍率(1:1)',
      key: 'rateSnapshot',
      width: 142,
      render: (_, record) => (
        <Flex vertical gap={4} className="metric-stack">
          <Space size={6}>
            <Text type="secondary">现</Text>
            <RateValue value={record.currentRate} ratio={record.rechargeRatio} ignored={record.upstreamType === 'cli_proxy'} />
          </Space>
          <Space size={6}>
            <Text type="secondary">前</Text>
            <RateValue value={record.previousRate} ratio={record.rechargeRatio} muted ignored={record.upstreamType === 'cli_proxy'} />
          </Space>
          <RateChange
            current={record.currentRate}
            previous={record.previousRate}
            ratio={record.rechargeRatio}
            ignored={record.upstreamType === 'cli_proxy'}
          />
        </Flex>
      )
    },
    {
      title: '优 / 权',
      key: 'dispatch',
      width: 76,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Text>优 {record.priority}</Text>
          <Text type="secondary">权 {record.weight}</Text>
        </Flex>
      )
    },
    {
      title: '状态',
      key: 'enabled',
      width: 76,
      render: (_, record) => <ChannelEnabledTag channel={record} />
    },
    {
      title: '巡检',
      dataIndex: 'status',
      width: 112,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <StatusTag tone={record.statusTone}>{displayChannelStatusLabel(record.status)}</StatusTag>
          <Text type="secondary" className="table-subtle">
            {monitorDetailLabel(record)}
          </Text>
        </Flex>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 104,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            loading={syncingChannelId === record.id}
            disabled={record.upstreamType === 'cli_proxy' || !record.enabled}
            onClick={() => syncChannel(record.id)}
          >
            同步
          </Button>
          <Button type="link" size="small" onClick={() => openChannelModal(record)}>
            配置
          </Button>
        </Space>
      )
    }
  ];

  const rateColumns: ColumnsType<RateRow> = [
    {
      title: '上游分组',
      dataIndex: 'group',
      width: 360,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <ProviderTag type={record.upstreamType} />
            <Text code>{record.group}</Text>
          </Space>
          <Text type="secondary">
            Key：{record.keyName}
          </Text>
        </Flex>
      )
    },
    {
      title: '渠道来源',
      key: 'source',
      width: 260,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Text>{record.upstreamName}</Text>
          <Text type="secondary">{record.channelName}</Text>
        </Flex>
      )
    },
    {
      title: '依据',
      key: 'source',
      width: 180,
      render: (_, record) => (
        <Flex vertical gap={4}>
          <Text>{record.input}</Text>
          <Text type="secondary">{record.output}</Text>
        </Flex>
      )
    },
    {
      title: '当前倍率',
      dataIndex: 'currentRate',
      width: 110,
      align: 'right',
      render: (_, record) => <RateValue value={record.currentRate} ratio={rechargeRatioForRate(record.key, channels)} />
    },
    {
      title: '上次倍率',
      dataIndex: 'previousRate',
      width: 110,
      align: 'right',
      render: (_, record) => <RateValue value={record.previousRate} ratio={rechargeRatioForRate(record.key, channels)} muted />
    },
    {
      title: '变化',
      key: 'delta',
      width: 100,
      align: 'right',
      render: (_, record) => (
        <RateChange current={record.currentRate} previous={record.previousRate} ratio={rechargeRatioForRate(record.key, channels)} />
      )
    }
  ];

  async function runSync() {
    setSyncing(true);
    try {
      const response = await fetch('/api/channels/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relayId: selectedRelay?.id })
      });
      const payload = (await response.json()) as {
        relays: RelayView[];
        channels: ChannelView[];
        events: EventItem[];
        inspection?: InspectionView;
      };
      setRelays(payload.relays);
      setChannels(payload.channels);
      setEvents(payload.events);
      if (payload.inspection) {
        setInspection(payload.inspection);
      }
      const latestEvent = payload.events[0];
      if (latestEvent?.status === 'error') {
        messageApi.error(latestEvent.title);
      } else if (latestEvent?.status === 'warning') {
        messageApi.warning(latestEvent.title);
      } else {
        messageApi.success(latestEvent?.title ?? '同步完成');
      }
    } finally {
      setSyncing(false);
    }
  }

  async function syncChannel(channelId: string) {
    setSyncingChannelId(channelId);
    try {
      const response = await fetch('/api/channels/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId })
      });
      const payload = (await response.json()) as {
        relays?: RelayView[];
        channels?: ChannelView[];
        events?: EventItem[];
        error?: string;
      };

      if (!response.ok) {
        messageApi.error(payload.error ?? '同步失败');
        return;
      }

      if (payload.relays) {
        setRelays(payload.relays);
      }
      if (payload.channels) {
        setChannels(payload.channels);
      }
      if (payload.events) {
        setEvents(payload.events);
      }

      const latestEvent = payload.events?.[0];
      if (latestEvent?.status === 'error') {
        messageApi.error(latestEvent.title);
      } else if (latestEvent?.status === 'warning') {
        messageApi.warning(latestEvent.title);
      } else {
        messageApi.success(latestEvent?.title ?? '同步完成');
      }
    } finally {
      setSyncingChannelId(null);
    }
  }

  async function updateInspection(input: InspectionUpdate) {
    setInspectionBusy(true);
    try {
      const response = await fetch('/api/inspection', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
      const payload = (await response.json()) as { inspection?: InspectionView; error?: string };

      if (!response.ok || !payload.inspection) {
        messageApi.error(payload.error ?? '自动巡检保存失败');
        return;
      }

      setInspection(payload.inspection);
      messageApi.success('自动巡检已更新');
    } finally {
      setInspectionBusy(false);
    }
  }

  async function loadCpaPool() {
    setCpaPoolLoading(true);
    try {
      const query = selectedCpaChannelId ? `?channelId=${encodeURIComponent(selectedCpaChannelId)}` : '';
      const response = await fetch(`/api/cpa-pool${query}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => ({}))) as CpaPoolView & { error?: string };

      if (!response.ok) {
        setCpaPool((current) => ({
          ...current,
          channel: payload.channel ?? current.channel,
          channels: payload.channels ?? current.channels,
          accounts: []
        }));
        if (payload.channel?.id && !selectedCpaChannelId) {
          setSelectedCpaChannelId(payload.channel.id);
        }
        messageApi.error(payload.error ?? '号池读取失败');
        return;
      }

      setCpaPool({
        channel: payload.channel,
        channels: payload.channels ?? [],
        accounts: payload.accounts ?? [],
        usageQueueError: payload.usageQueueError,
        refreshedAt: payload.refreshedAt
      });
      if (payload.channel?.id && !selectedCpaChannelId) {
        setSelectedCpaChannelId(payload.channel.id);
      }
      if (payload.usageQueueError) {
        messageApi.warning(`用量队列读取失败：${payload.usageQueueError}`);
      }
    } finally {
      setCpaPoolLoading(false);
    }
  }

  async function runInspectionNow() {
    setInspectionBusy(true);
    try {
      const response = await fetch('/api/inspection', { method: 'POST' });
      const payload = (await response.json()) as { inspection?: InspectionView; error?: string };

      if (!response.ok || !payload.inspection) {
        messageApi.error(payload.error ?? '巡检提交失败');
        return;
      }

      setInspection(payload.inspection);
      await loadDashboard();
      messageApi.success(payload.inspection.lastResult ?? '巡检已入队');
    } finally {
      setInspectionBusy(false);
    }
  }

  async function updateAlertRule(input: AlertRuleUpdate) {
    setSavingAlertRuleType(input.type);
    try {
      const response = await fetch('/api/alert-rules', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
      const payload = (await response.json()) as { rules?: AlertRuleView[]; error?: string };

      if (!response.ok || !payload.rules) {
        messageApi.error(payload.error ?? '告警规则保存失败');
        return;
      }

      setAlertRules(payload.rules);
      messageApi.success('告警规则已更新');
    } finally {
      setSavingAlertRuleType(null);
    }
  }

  function openChannelModal(channel?: ChannelView) {
    setEditingChannelId(channel?.id ?? null);
    setAutoFilledUpstreamName(false);
    setUpstreamTypeHint(null);
    setCredentialTestResult(null);
    setUpstreamGroups([]);
    autoFilledSiteUrlRef.current = '';
    form.resetFields();
    form.setFieldsValue({
      id: channel?.id,
      relayId: channel?.relayId ?? selectedRelay.id,
      name: channel?.name,
      group: channel?.group ?? 'default',
      mainStationGroup: channel?.mainStationGroup ?? 'default',
      upstreamType: channel?.upstreamType,
      upstreamName: channel?.upstreamName ?? channel?.name,
      upstreamBaseUrl: channel?.upstreamBaseUrl,
      upstreamUserId: channel?.upstreamUserId ?? '',
      keyName: channel?.keyName ?? '',
      skipLatencyDisable: channel?.skipLatencyDisable ?? false,
      auth: normalizeAuthForType(channel?.upstreamType, channel?.auth),
      credential: undefined,
      credentialAccount: '',
      credentialPassword: '',
      createMainStation: !channel,
      mainStationKey: '',
      models: '',
      rechargeRatio: channel?.rechargeRatio ?? 1,
      priority: channel?.priority ?? 50,
      weight: channel?.weight ?? 0,
      enabled: channel?.enabled ?? true
    });
    setModalOpen(true);
  }

  function openCredentialModal(group: CredentialGroup) {
    const primary = group.primary;
    const baseline = credentialGroupBaseline(group);
    setEditingCredentialGroupKey(group.key);
    setCredentialTestResult(null);
    setUpstreamGroups([]);
    credentialForm.resetFields();
    credentialForm.setFieldsValue({
      auth: normalizeAuthForType(primary.upstreamType, baseline.auth),
      upstreamUserId: baseline.upstreamUserId ?? primary.upstreamUserId ?? '',
      credential: undefined,
      credentialAccount: '',
      credentialPassword: ''
    });
    setCredentialModalOpen(true);
  }

  function openRelayModal(relay = selectedRelay) {
    if (!relay) {
      return;
    }

    relayForm.setFieldsValue({
      id: relay.id,
      name: relay.name,
      baseUrl: relay.baseUrl === '待配置' ? '' : relay.baseUrl,
      auth: relay.auth,
      adminUserId: relay.adminUserId,
      adminToken: undefined
    });
    setRelayModalOpen(true);
  }

  async function saveRelay() {
    const values = await validateFormOrStop(relayForm, messageApi.warning);
    if (!values) {
      return;
    }
    const response = await fetch('/api/relays', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values)
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      const fieldName = payload.error?.includes('adminUserId') ? 'adminUserId' : 'adminToken';
      relayForm.setFields([
        {
          name: fieldName,
          errors: [payload.error === 'admin token is required' ? '请输入管理 Token' : payload.error ?? '保存失败']
        }
      ]);
      return;
    }
    const payload = (await response.json()) as { relays: RelayView[]; events: EventItem[] };
    setRelays(payload.relays);
    setEvents(payload.events);
    setRelayModalOpen(false);
  }

  async function detectChannelUpstreamType() {
    const upstreamBaseUrl = form.getFieldValue('upstreamBaseUrl')?.trim();

    if (!upstreamBaseUrl) {
      form.setFields([{ name: 'upstreamBaseUrl', errors: ['请输入上游地址'] }]);
      return;
    }

    setDetectingUpstreamType(true);
    try {
      const response = await fetch('/api/channels/detect-type', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upstreamBaseUrl })
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<UpstreamTypeDetection> & { error?: string };

      if (!response.ok) {
        setUpstreamTypeHint(null);
        messageApi.error(payload.error ?? '类型识别失败');
        return;
      }

      const detectedType = payload.type;
      if (!isKnownUpstreamType(detectedType)) {
        setUpstreamTypeHint({ type: 'unknown', reason: payload.reason ?? '未识别出上游类型，请手动选择' });
        messageApi.warning(payload.reason ?? '未识别出上游类型，请手动选择');
        return;
      }

      setUpstreamTypeHint({
        type: detectedType,
        reason: payload.reason ?? `已识别为 ${upstreamProviderLabel(detectedType)}`
      });
      setCredentialTestResult(null);
      setUpstreamGroups([]);
      form.setFieldsValue({
        upstreamType: detectedType,
        auth: defaultAuth(detectedType),
        group: detectedType === 'cli_proxy' ? 'default' : form.getFieldValue('group'),
        keyName: detectedType === 'cli_proxy' ? '' : form.getFieldValue('keyName'),
        mainStationGroup: detectedType === 'cli_proxy' ? 'default' : form.getFieldValue('mainStationGroup'),
        skipLatencyDisable: detectedType === 'cli_proxy' ? false : form.getFieldValue('skipLatencyDisable') ?? false,
        credential: undefined,
        credentialAccount: '',
        credentialPassword: '',
        rechargeRatio: detectedType === 'cli_proxy' ? 1 : form.getFieldValue('rechargeRatio')
      });
      messageApi.success(`已识别并选中 ${upstreamProviderLabel(detectedType)}`);
    } finally {
      setDetectingUpstreamType(false);
    }
  }

  async function fillChannelNameFromUrl(expectedBaseUrl?: string) {
    const upstreamBaseUrl = (expectedBaseUrl ?? form.getFieldValue('upstreamBaseUrl'))?.trim();
    const currentName = form.getFieldValue('upstreamName')?.trim();

    if (
      editingChannelId ||
      !upstreamBaseUrl ||
      (currentName && (!autoFilledUpstreamName || autoFilledSiteUrlRef.current === upstreamBaseUrl))
    ) {
      return;
    }

    setLoadingSiteName(true);
    try {
      const response = await fetch('/api/channels/site-info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upstreamBaseUrl })
      });
      const payload = (await response.json().catch(() => ({}))) as { name?: string; error?: string };
      const siteName = payload.name?.trim();

      if (!response.ok || !siteName) {
        return;
      }

      if (form.getFieldValue('upstreamBaseUrl')?.trim() !== upstreamBaseUrl) {
        return;
      }

      form.setFieldValue('upstreamName', siteName);
      setAutoFilledUpstreamName(true);
      autoFilledSiteUrlRef.current = upstreamBaseUrl;
    } finally {
      setLoadingSiteName(false);
    }
  }

  async function detectListedChannelTypes() {
    const channelIds = activeChannels.map((channel) => channel.id);

    if (channelIds.length === 0) {
      messageApi.warning('当前没有可识别的渠道');
      return;
    }

    setDetectingChannelTypes(true);
    try {
      const response = await fetch('/api/channels/detect-type', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelIds })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        total?: number;
        detected?: number;
        unknown?: number;
        results?: Array<{ channelId: string; name: string; type: UpstreamProvider | 'unknown'; reason: string }>;
        channels?: ChannelView[];
        relays?: RelayView[];
        error?: string;
      };

      if (!response.ok) {
        messageApi.error(payload.error ?? '类型识别失败');
        return;
      }

      if (payload.channels) {
        setChannels(payload.channels);
      }
      if (payload.relays) {
        setRelays(payload.relays);
      }

      const detected = payload.detected ?? 0;
      const unknown = payload.unknown ?? 0;
      if (detected > 0 && unknown > 0) {
        const sample = payload.results?.find((result) => result.type === 'unknown');
        messageApi.warning(`已识别 ${detected} 个，${unknown} 个需要手动选择${sample ? `；${sample.name}：${sample.reason}` : ''}`);
      } else if (detected > 0) {
        messageApi.success(`已识别并写回 ${detected} 个渠道`);
      } else {
        messageApi.warning('没有识别出渠道类型，请打开配置手动选择');
      }
    } finally {
      setDetectingChannelTypes(false);
    }
  }

  async function saveChannel() {
    const values = await validateFormOrStop(form, messageApi.warning);
    if (!values) {
      return;
    }
    if (!isKnownUpstreamType(values.upstreamType)) {
      const error = '请先识别或手动选择上游类型';
      form.setFields([{ name: 'upstreamType', errors: [error] }]);
      form.scrollToField('upstreamType');
      messageApi.warning(error);
      return;
    }
    if (!editingChannelId && values.upstreamType !== 'cli_proxy' && !values.mainStationKey?.trim()) {
      const error = '请输入主站调用 Key，新增时要同步创建到主站';
      form.setFields([{ name: 'mainStationKey', errors: [error] }]);
      form.scrollToField('mainStationKey');
      messageApi.warning(error);
      return;
    }

    const upstreamName = values.upstreamName.trim();
    const keyName = values.upstreamType === 'cli_proxy' ? undefined : values.keyName?.trim();
    const recordName = keyName ? `${upstreamName}-${keyName}` : upstreamName;
    const cliProxyPreferred = values.upstreamType === 'cli_proxy' && inspection?.cpaPreferred;

    const payloadValues = {
      ...values,
      upstreamType: values.upstreamType,
      name: recordName,
      upstreamName,
      keyName,
      group: values.upstreamType === 'cli_proxy' ? 'default' : canonicalUpstreamGroupName(values.group, upstreamGroups),
      mainStationGroup: values.upstreamType === 'cli_proxy' ? 'default' : values.mainStationGroup?.trim() || 'default',
      skipLatencyDisable: values.upstreamType === 'cli_proxy' ? false : values.skipLatencyDisable === true,
      createMainStation: !editingChannelId && values.upstreamType !== 'cli_proxy',
      priority: cliProxyPreferred ? 100 : values.priority,
      weight: cliProxyPreferred ? 10 : values.weight
    };

    setSavingChannel(true);
    try {
      const response = await fetch('/api/channels', {
        method: editingChannelId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payloadValues, id: editingChannelId ?? values.id })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        messageApi.error(payload.error ?? '渠道保存失败');
        return;
      }
    } catch (error) {
      messageApi.error(`渠道保存失败：${errorMessage(error)}`);
      return;
    } finally {
      setSavingChannel(false);
    }
    setModalOpen(false);
    setEditingChannelId(null);
    setActiveView('channels');
    form.resetFields();
    messageApi.success('渠道已保存');
    void loadDashboard().catch(() => undefined);
  }

  function channelCredentialTarget(values: Partial<ChannelForm>) {
    const upstreamName = values.upstreamName?.trim().toLowerCase();
    const upstreamType = values.upstreamType;

    if (!upstreamName || !isKnownUpstreamType(upstreamType)) {
      return null;
    }

    const group = credentialGroups.find(
      (item) => item.name.trim().toLowerCase() === upstreamName && item.primary.upstreamType === upstreamType
    );

    return group?.channels.find((channel) => channel.credentialConfigured && channel.auth === values.auth) ?? null;
  }

  function channelCredentialFieldErrors(values: Partial<ChannelForm>) {
    const upstreamType = values.upstreamType;
    const auth = values.auth;
    const loginMode = upstreamType === 'sub2api' && auth === '用户登录';
    const hasToken = Boolean(values.credential?.trim());
    const hasAccountPassword = Boolean(values.credentialAccount?.trim() && values.credentialPassword?.trim());
    const canUseExistingCredential = Boolean(channelCredentialTarget(values));
    const fieldErrors: Array<{ name: keyof ChannelForm; errors: string[] }> = [];

    if (!values.upstreamBaseUrl?.trim()) {
      fieldErrors.push({ name: 'upstreamBaseUrl', errors: ['请输入上游地址'] });
    }
    if (!isKnownUpstreamType(upstreamType)) {
      fieldErrors.push({ name: 'upstreamType', errors: ['请先选择上游类型'] });
      return fieldErrors;
    }
    if (upstreamType === 'cli_proxy') {
      fieldErrors.push({ name: 'upstreamType', errors: ['CPA 号池不需要读取凭证'] });
      return fieldErrors;
    }
    if (!values.group?.trim()) {
      fieldErrors.push({ name: 'group', errors: ['请输入上游分组'] });
    }
    if (!auth) {
      fieldErrors.push({ name: 'auth', errors: ['请选择认证方式'] });
    }
    if (upstreamType === 'newapi' && auth !== 'API Key' && !values.upstreamUserId?.trim()) {
      fieldErrors.push({ name: 'upstreamUserId', errors: ['请输入上游用户 ID'] });
    }
    if (!canUseExistingCredential && loginMode && !hasAccountPassword) {
      fieldErrors.push({ name: 'credentialAccount', errors: ['请输入账号或邮箱'] });
      fieldErrors.push({ name: 'credentialPassword', errors: ['请输入密码'] });
    }
    if (!canUseExistingCredential && !loginMode && auth !== '无鉴权' && !hasToken) {
      fieldErrors.push({ name: 'credential', errors: ['请输入认证信息'] });
    }

    return fieldErrors;
  }

  function channelCredentialPayload(values: Partial<ChannelForm>) {
    const existingTarget = channelCredentialTarget(values);
    const upstreamName = values.upstreamName?.trim() || existingTarget?.upstreamName || '未分组';
    const keyName = values.keyName?.trim();
    const name = keyName ? `${upstreamName}-${keyName}` : upstreamName;

    return {
      id: editingChannelId ?? values.id ?? existingTarget?.id,
      relayId: values.relayId ?? selectedRelay.id,
      name,
      group: canonicalUpstreamGroupName(values.group, upstreamGroups),
      mainStationGroup: values.mainStationGroup?.trim() || 'default',
      upstreamType: values.upstreamType,
      upstreamName,
      upstreamBaseUrl: values.upstreamBaseUrl?.trim(),
      upstreamUserId: values.upstreamUserId?.trim() || existingTarget?.upstreamUserId,
      keyName,
      auth: values.auth,
      credential: values.credential?.trim(),
      credentialAccount: values.credentialAccount?.trim(),
      credentialPassword: values.credentialPassword?.trim(),
      rechargeRatio: values.rechargeRatio ?? existingTarget?.rechargeRatio ?? 1,
      priority: values.priority ?? existingTarget?.priority ?? 50,
      weight: values.weight ?? existingTarget?.weight ?? 0
    };
  }

  async function testChannelCredential() {
    const values = form.getFieldsValue();
    const fieldErrors = channelCredentialFieldErrors(values);
    if (fieldErrors.length > 0) {
      form.setFields(fieldErrors);
      return;
    }

    setTestingCredential(true);
    try {
      const response = await fetch('/api/channels/test-credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(channelCredentialPayload(values))
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<CredentialTestResult> & { error?: string };

      if (!response.ok) {
        const error = errorMessage(payload.error ?? '凭证测试失败');
        setCredentialTestResult({ ok: false, status: 'error', message: error });
        messageApi.error(error);
        return;
      }

      const result = payload as CredentialTestResult;
      const rechargeRatio = normalizeSuggestedRechargeRatio(result.suggestedRechargeRatio);

      setCredentialTestResult(result);
      if (rechargeRatio) {
        form.setFieldValue('rechargeRatio', rechargeRatio);
      }
      if (result.status === 'ok') {
        messageApi.success('凭证测试通过');
      } else {
        messageApi.warning(result.message || '凭证可用，但余额或倍率不完整');
      }
    } finally {
      setTestingCredential(false);
    }
  }

  async function loadChannelUpstreamGroups() {
    const values = form.getFieldsValue();
    const fieldErrors = channelCredentialFieldErrors(values);
    if (fieldErrors.length > 0) {
      form.setFields(fieldErrors);
      return;
    }

    setLoadingUpstreamGroups(true);
    try {
      const response = await fetch('/api/channels/upstream-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(channelCredentialPayload(values))
      });
      const payload = (await response.json().catch(() => ({}))) as { groups?: UpstreamGroupInfo[]; error?: string };

      if (!response.ok) {
        messageApi.error(payload.error ?? '上游分组读取失败');
        return;
      }

      const groups = payload.groups ?? [];
      setUpstreamGroups(groups);
      reconcileChannelGroupField(groups, form);
      if (payload.groups?.length) {
        messageApi.success(`读取到 ${payload.groups.length} 个上游分组`);
      } else {
        messageApi.warning('上游没有返回分组');
      }
    } finally {
      setLoadingUpstreamGroups(false);
    }
  }

  function applyUpstreamGroupToChannel(upstreamGroup: UpstreamGroupInfo) {
    form.setFieldValue('group', upstreamGroup.name);
    if (!form.getFieldValue('keyName')?.trim()) {
      form.setFieldValue('keyName', upstreamGroup.remark?.trim() || upstreamGroup.name);
    }
    messageApi.success(`已填入上游分组 ${upstreamGroup.name}`);
  }

  async function createMainStationGroup() {
    const name = String(form.getFieldValue('mainStationGroup') ?? '').trim();

    if (!name) {
      form.setFields([{ name: 'mainStationGroup', errors: ['请输入主站分组名称'] }]);
      return;
    }

    setCreatingMainStationGroup(true);
    try {
      const response = await fetch('/api/main-station-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ratio: 1 })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        group?: MainStationGroupInfo;
        groups?: MainStationGroupInfo[];
        error?: string;
      };

      if (!response.ok || !payload.group) {
        messageApi.error(payload.error ?? '主站分组创建失败');
        return;
      }

      setMainStationGroups((current) => payload.groups ?? mergeMainStationGroupState(current, payload.group as MainStationGroupInfo));
      form.setFieldValue('mainStationGroup', payload.group.name);
      messageApi.success(`主站分组已创建：${payload.group.name}`);
    } finally {
      setCreatingMainStationGroup(false);
    }
  }

  function credentialGroupBaseline(group: CredentialGroup) {
    return group.channels.find((channel) => channel.credentialConfigured) ?? group.primary;
  }

  function credentialGroupFieldErrors(group: CredentialGroup, values: Partial<PlatformCredentialForm>, mode: 'save' | 'test') {
    const primary = group.primary;
    const baseline = credentialGroupBaseline(group);
    const authChanged = values.auth !== baseline.auth;
    const loginMode = primary.upstreamType === 'sub2api' && values.auth === '用户登录';
    const hasToken = Boolean(values.credential?.trim());
    const hasAccountPassword = Boolean(values.credentialAccount?.trim() && values.credentialPassword?.trim());
    const needsCredential =
      mode === 'save'
        ? authChanged || group.configuredCount !== group.channels.length
        : authChanged || group.configuredCount === 0;
    const fieldErrors: Array<{ name: keyof PlatformCredentialForm; errors: string[] }> = [];

    if (!values.auth) {
      fieldErrors.push({ name: 'auth', errors: ['请选择认证方式'] });
    }
    if (primary.upstreamType === 'newapi' && values.auth !== 'API Key' && !values.upstreamUserId?.trim()) {
      fieldErrors.push({ name: 'upstreamUserId', errors: ['请输入上游用户 ID'] });
    }
    if (needsCredential && loginMode && !hasAccountPassword) {
      fieldErrors.push({ name: 'credentialAccount', errors: ['请输入账号或邮箱'] });
      fieldErrors.push({ name: 'credentialPassword', errors: ['请输入密码'] });
    }
    if (needsCredential && !loginMode && values.auth !== '无鉴权' && !hasToken) {
      fieldErrors.push({ name: 'credential', errors: ['请输入认证信息'] });
    }

    return fieldErrors;
  }

  function credentialGroupPayload(
    group: CredentialGroup,
    values: PlatformCredentialForm,
    options: { target?: ChannelView; suggestedRechargeRatio?: number | null } = {}
  ) {
    const channel = options.target ?? group.primary;
    const suggestedRechargeRatio = normalizeSuggestedRechargeRatio(options.suggestedRechargeRatio);

    return {
      id: channel.id,
      relayId: channel.relayId,
      name: channel.name,
      group: channel.group,
      upstreamType: channel.upstreamType,
      upstreamName: channel.upstreamName,
      upstreamBaseUrl: channel.upstreamBaseUrl,
      upstreamUserId: values.upstreamUserId?.trim() ?? '',
      keyName: channel.keyName,
      auth: values.auth,
      credential: values.credential?.trim(),
      credentialAccount: values.credentialAccount?.trim(),
      credentialPassword: values.credentialPassword?.trim(),
      rechargeRatio: suggestedRechargeRatio ?? channel.rechargeRatio,
      syncGroupRechargeRatio: suggestedRechargeRatio !== null && suggestedRechargeRatio !== channel.rechargeRatio,
      priority: channel.priority,
      weight: channel.weight
    };
  }

  async function testCredentialGroup() {
    const group = editingCredentialGroup;
    if (!group) {
      messageApi.error('平台分组不存在');
      return;
    }

    const values = credentialForm.getFieldsValue();
    const fieldErrors = credentialGroupFieldErrors(group, values, 'test');
    if (fieldErrors.length > 0) {
      credentialForm.setFields(fieldErrors);
      return;
    }

    const hasNewCredential = Boolean(
      values.credential?.trim() || (values.credentialAccount?.trim() && values.credentialPassword?.trim())
    );
    const target = hasNewCredential ? group.primary : group.channels.find((channel) => channel.credentialConfigured) ?? group.primary;

    setTestingCredential(true);
    try {
      const response = await fetch('/api/channels/test-credential', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentialGroupPayload(group, values as PlatformCredentialForm, { target }))
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<CredentialTestResult> & { error?: string };

      if (!response.ok) {
        const error = errorMessage(payload.error ?? '凭证测试失败');
        setCredentialTestResult({ ok: false, status: 'error', message: error });
        messageApi.error(error);
        return;
      }

      const result = payload as CredentialTestResult;
      setCredentialTestResult(result);
      if (result.status === 'ok') {
        messageApi.success('凭证测试通过');
      } else {
        messageApi.warning(result.message || '凭证可用，但余额或倍率不完整');
      }
    } finally {
      setTestingCredential(false);
    }
  }

  async function loadCredentialGroupUpstreamGroups() {
    const group = editingCredentialGroup;
    if (!group) {
      messageApi.error('平台分组不存在');
      return;
    }

    const values = credentialForm.getFieldsValue();
    const fieldErrors = credentialGroupFieldErrors(group, values, 'test');
    if (fieldErrors.length > 0) {
      credentialForm.setFields(fieldErrors);
      return;
    }

    const hasNewCredential = Boolean(
      values.credential?.trim() || (values.credentialAccount?.trim() && values.credentialPassword?.trim())
    );
    const target = hasNewCredential ? group.primary : group.channels.find((channel) => channel.credentialConfigured) ?? group.primary;

    setLoadingUpstreamGroups(true);
    try {
      const response = await fetch('/api/channels/upstream-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credentialGroupPayload(group, values as PlatformCredentialForm, { target }))
      });
      const payload = (await response.json().catch(() => ({}))) as { groups?: UpstreamGroupInfo[]; error?: string };

      if (!response.ok) {
        messageApi.error(payload.error ?? '上游分组读取失败');
        return;
      }

      setUpstreamGroups(payload.groups ?? []);
      if (payload.groups?.length) {
        messageApi.success(`读取到 ${payload.groups.length} 个上游分组`);
      } else {
        messageApi.warning('上游没有返回分组');
      }
    } finally {
      setLoadingUpstreamGroups(false);
    }
  }

  function openChannelModalFromUpstreamGroup(upstreamGroup: UpstreamGroupInfo) {
    const group = editingCredentialGroup;
    if (!group) {
      messageApi.error('平台分组不存在');
      return;
    }

    const values = credentialForm.getFieldsValue();
    const primary = group.primary;
    const keyName = upstreamGroup.remark?.trim() || upstreamGroup.name;
    const rechargeRatio = normalizeSuggestedRechargeRatio(credentialTestResult?.suggestedRechargeRatio) ?? primary.rechargeRatio;

    setCredentialModalOpen(false);
    setEditingCredentialGroupKey(null);
    setCredentialTestResult(null);
    setUpstreamGroups([]);
    credentialForm.resetFields();
    form.resetFields();
    form.setFieldsValue({
      relayId: primary.relayId,
      upstreamName: group.name,
      upstreamBaseUrl: primary.upstreamBaseUrl,
      upstreamType: primary.upstreamType,
      auth: values.auth || primary.auth,
      keyName,
      group: upstreamGroup.name,
      rechargeRatio,
      priority: primary.priority,
      weight: primary.weight
    });
    setEditingChannelId(null);
    setActiveView('channels');
    setModalOpen(true);
  }

  async function saveCredentialGroup() {
    const group = editingCredentialGroup;
    if (!group) {
      messageApi.error('平台分组不存在');
      return;
    }

    const values = await validateFormOrStop(credentialForm, messageApi.warning);
    if (!values) {
      return;
    }
    const fieldErrors = credentialGroupFieldErrors(group, values, 'save');
    if (fieldErrors.length > 0) {
      credentialForm.setFields(fieldErrors);
      return;
    }

    const suggestedRechargeRatio =
      credentialTestResult?.ok && credentialTestResult.status !== 'error'
        ? credentialTestResult.suggestedRechargeRatio
        : null;
    const payload = credentialGroupPayload(group, values, { suggestedRechargeRatio });

    const response = await fetch('/api/channels', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const responsePayload = (await response.json().catch(() => ({}))) as { error?: string };
      if (responsePayload.error === 'Sub2API 用户登录需要账号/邮箱和密码') {
        credentialForm.setFields([
          { name: 'credentialAccount', errors: ['请输入账号或邮箱'] },
          { name: 'credentialPassword', errors: ['请输入密码'] }
        ]);
      } else if (responsePayload.error === 'credential is required for this upstream auth mode') {
        credentialForm.setFields([{ name: 'credential', errors: ['请输入认证信息'] }]);
      }
      messageApi.error(responsePayload.error ?? '平台凭证保存失败');
      return;
    }

    setCredentialModalOpen(false);
    setEditingCredentialGroupKey(null);
    setCredentialTestResult(null);
    setUpstreamGroups([]);
    credentialForm.resetFields();
    setActiveView('credentials');
    await loadDashboard();
    const rechargeRatio = normalizeSuggestedRechargeRatio(suggestedRechargeRatio);
    messageApi.success(
      rechargeRatio
        ? `平台分组 ${group.name} 的凭证已保存，充值倍率 1:${formatRatio(rechargeRatio)}`
        : `平台分组 ${group.name} 的凭证已保存`
    );
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#0f766e',
          borderRadius: 6,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        },
        components: {
          Layout: {
            bodyBg: '#f6f8fb',
            siderBg: '#ffffff',
            headerBg: '#f6f8fb'
          },
          Card: {
            borderRadiusLG: 8
          },
          Table: {
            headerBg: '#f3f6f9'
          }
        }
      }}
    >
      {contextHolder}
      {authChecking || !authStatus?.authenticated ? (
        <AuthScreen
          status={authStatus}
          checking={authChecking}
          onAuthenticated={(username) => setAuthStatus({ setupRequired: false, authenticated: true, username })}
        />
      ) : (
        <>
      <Layout className="app-shell">
        <Sider width={248} className="app-sider">
          <div className="app-brand">
            <Avatar shape="square" size={36} icon={<ApiOutlined />} className="brand-avatar" />
            <div>
              <Text strong>RelayDesk</Text>
              <Text type="secondary">NewAPI 中转管控</Text>
            </div>
          </div>

          <Menu
            mode="inline"
            selectedKeys={[activeView]}
            items={menuItems}
            onClick={({ key }) => setActiveView(key as View)}
            className="app-menu"
          />

          <Card size="small" className="sider-note">
            <Space align="start">
              <LockOutlined />
              <Text type="secondary">当前只管理一个 NewAPI 主站；渠道上游支持 NewAPI、Sub2API 和 CPA 号池。</Text>
            </Space>
          </Card>
        </Sider>

        <Layout className="app-main">
          <Header className="app-header">
            <div className="header-title">
              <Title level={3}>{viewTitle(activeView)}</Title>
              <Text type="secondary">{viewDescription(activeView)}</Text>
            </div>
            <div className="header-actions">
              <Input
                prefix={<SearchOutlined />}
                placeholder="搜索渠道、ID、上游、分组"
                className="search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                allowClear
              />
              <Select
                className="main-station-group-filter"
                value={mainStationGroupFilter}
                options={mainStationGroupFilterOptions}
                onChange={setMainStationGroupFilter}
                optionFilterProp="label"
                showSearch
              />
              <Button icon={<BellOutlined />} onClick={() => setActiveView('alerts')} />
              <Button icon={<LockOutlined />} onClick={logout}>
                退出
              </Button>
              <Button icon={<SettingOutlined />} onClick={() => openRelayModal()}>
                配置主站
              </Button>
              <Button type="primary" icon={<ReloadOutlined spin={syncing} />} onClick={runSync}>
                同步渠道
              </Button>
              <Button icon={<PlusOutlined />} onClick={() => openChannelModal()}>
                新增渠道
              </Button>
            </div>
          </Header>

          <Content className="app-content">
            {activeView === 'overview' ? (
              <OverviewView
                selectedRelay={selectedRelay}
                relayCount={relays.length}
                channelCount={activeChannels.length}
                readableCount={readableCount}
                limitedCount={limitedCount}
                pendingSyncCount={pendingSyncCount}
                cliProxyCount={cliProxyCount}
                onConfigureRelay={() => openRelayModal()}
                channelColumns={channelColumns}
                channels={visibleChannels}
                events={events}
              />
            ) : null}

            {activeView === 'channels' ? (
              <Flex vertical gap={14}>
                <ChannelGuide
                  inspection={inspection}
                  inspectionBusy={inspectionBusy}
                  onUpdateInspection={updateInspection}
                  onRunInspection={runInspectionNow}
                />
                <Card
                  title={
                    <div className="table-card-header">
                      <div className="table-card-title">
                        <Text strong>{selectedRelay?.name ?? 'NewAPI 主站'}</Text>
                        <Text type="secondary">NewAPI / Sub2API 会保存到 MySQL；CPA 号池仅临时转发配置。</Text>
                      </div>
                    </div>
                  }
                  extra={
                    <Space size={8} wrap>
                      <Button
                        icon={<SearchOutlined />}
                        loading={detectingChannelTypes}
                        disabled={activeChannels.length === 0}
                        onClick={detectListedChannelTypes}
                      >
                        批量识别类型
                      </Button>
                      <Switch
                        checked={groupChannels}
                        checkedChildren="分组"
                        unCheckedChildren="平铺"
                        onChange={setGroupChannels}
                      />
                      <Segmented
                        value={providerFilter}
                        onChange={(value) => setProviderFilter(value as ProviderFilter)}
                        options={[
                          { label: '全部', value: 'all' },
                          { label: 'NewAPI', value: 'newapi' },
                          { label: 'Sub2API', value: 'sub2api' },
                          { label: 'CPA 号池', value: 'cli_proxy' }
                        ]}
                      />
                    </Space>
                  }
                >
                  {groupChannels ? (
                    <ChannelGroupList groups={visibleChannelGroups} columns={channelColumns} />
                  ) : (
                    <Table
                      rowKey="id"
                      columns={channelColumns}
                      dataSource={visibleChannels}
                      pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
                      size="middle"
                      scroll={{ x: 1340 }}
                      locale={{ emptyText: <Empty description="还没有渠道，先新增一个渠道上游" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                    />
                  )}
                </Card>
              </Flex>
            ) : null}

            {activeView === 'rates' ? (
              <RatesCard
                columns={rateColumns}
                groups={visibleRateGroups}
                rateFilter={rateFilter}
                setRateFilter={setRateFilter}
              />
            ) : null}

            {activeView === 'credentials' ? (
              <CredentialsView groups={credentialGroups} onEditGroup={openCredentialModal} />
            ) : null}

            {activeView === 'cpaPool' ? (
              <CpaPoolPanel
                data={cpaPool}
                loading={cpaPoolLoading}
                selectedChannelId={selectedCpaChannelId}
                onSelectChannel={setSelectedCpaChannelId}
                onRefresh={loadCpaPool}
              />
            ) : null}

            {activeView === 'alerts' ? (
              <AlertsView
                events={events}
                rules={alertRules}
                savingRuleType={savingAlertRuleType}
                onUpdateRule={updateAlertRule}
              />
            ) : null}
          </Content>
        </Layout>
      </Layout>

      <Modal
        title={
          <ModalTitle
            title={editingChannelId ? '配置渠道' : '新增渠道'}
            description="这里只配置渠道信息；Token、账号密码和测试统一在平台凭证里处理。"
          />
        }
        open={modalOpen}
        className="channel-modal"
        width={820}
        onCancel={() => {
          setModalOpen(false);
          setEditingChannelId(null);
          setCredentialTestResult(null);
          setUpstreamGroups([]);
          form.resetFields();
        }}
        onOk={saveChannel}
        okText={editingChannelId ? '保存' : '添加'}
        confirmLoading={savingChannel}
        cancelText="取消"
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            group: 'default',
            mainStationGroup: 'default',
            createMainStation: true,
            rechargeRatio: 1,
            priority: 50,
            weight: 0,
            skipLatencyDisable: false,
            enabled: true
          }}
          onValuesChange={(changed) => {
            if ('upstreamType' in changed) {
              setUpstreamTypeHint(null);
              setCredentialTestResult(null);
              setUpstreamGroups([]);
              form.setFieldValue('auth', isKnownUpstreamType(changed.upstreamType) ? defaultAuth(changed.upstreamType) : undefined);
              form.setFieldsValue({
                credential: undefined,
                credentialAccount: '',
                credentialPassword: ''
              });
              if (changed.upstreamType === 'cli_proxy') {
                form.setFieldsValue({
                  group: 'default',
                  keyName: '',
                  mainStationGroup: 'default',
                  rechargeRatio: 1,
                  skipLatencyDisable: false,
                  ...(inspection?.cpaPreferred ? { priority: 100, weight: 10 } : {})
                });
              }
              return;
            }

            if ('auth' in changed) {
              setCredentialTestResult(null);
              setUpstreamGroups([]);
              form.setFieldsValue({
                credential: undefined,
                credentialAccount: '',
                credentialPassword: ''
              });
              return;
            }

            if ('upstreamName' in changed) {
              setAutoFilledUpstreamName(false);
              autoFilledSiteUrlRef.current = '';
              setCredentialTestResult(null);
              setUpstreamGroups([]);
              return;
            }

            if ('upstreamBaseUrl' in changed) {
              setUpstreamTypeHint(null);
              setCredentialTestResult(null);
              setUpstreamGroups([]);
              form.setFieldsValue({
                upstreamType: 'unknown',
                auth: undefined
              });
            }

            if ('group' in changed) {
              setCredentialTestResult(null);
            }
          }}
        >
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="relayId" hidden>
            <Input />
          </Form.Item>
          <FormSection title="基本信息" description="平台分组从渠道名第一个 - 或 _ 自动拆；倍率分组不从名字猜，只用上游识别或手填。">
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
              {({ getFieldValue }) => {
                const isCliProxy = getFieldValue('upstreamType') === 'cli_proxy';

                return (
                  <Row gutter={12}>
                    <Col xs={24} md={isCliProxy ? 24 : 12}>
                      <Form.Item
                        name="upstreamName"
                        label="平台分组（列表分组）"
                        extra="输入上游地址后会自动填平台名；Key 名称仍然手动输入，例如 codex、claude。"
                        rules={[{ required: true, message: '请输入平台分组' }]}
                      >
                        <Input placeholder="例如 九秋" suffix={loadingSiteName ? <ReloadOutlined spin /> : null} />
                      </Form.Item>
                    </Col>
                    {isCliProxy ? null : (
                      <Col xs={24} md={12}>
                        <Form.Item
                          label="主站分组"
                          required
                          extra="写入主站渠道时使用；可从已同步主站分组里选择，也可以直接输入新分组。"
                        >
                          <Space.Compact className="full-width">
                            <Form.Item name="mainStationGroup" noStyle rules={[{ required: true, message: '请输入主站分组' }]}>
                              <AutoComplete
                                className="full-width"
                                options={mainStationGroupOptions}
                                placeholder="例如 default"
                                filterOption={autocompleteFilterOption}
                              />
                            </Form.Item>
                            <Button
                              htmlType="button"
                              icon={<PlusOutlined />}
                              loading={creatingMainStationGroup}
                              onClick={createMainStationGroup}
                            >
                              创建
                            </Button>
                          </Space.Compact>
                        </Form.Item>
                      </Col>
                    )}
                  </Row>
                );
              }}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
              {({ getFieldValue }) =>
                getFieldValue('upstreamType') === 'cli_proxy' ? (
                  <div className="form-note">
                    <Text type="secondary">CPA 是号池模式，没有上游 Key 名称和倍率分组，保存时只使用平台分组作为渠道名。</Text>
                  </div>
                ) : (
                  <Row gutter={12}>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="keyName"
                        label="Key 名称"
                        extra="同一个上游有多个 Key 时手动填写；保存后渠道名会是 平台分组-Key名称。"
                        rules={[{ required: true, message: '请输入 Key 名称' }]}
                      >
                        <Input placeholder="例如 codex 或 claude" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="group"
                        label="上游分组（倍率分组）"
                        extra="这是上游系统里的倍率分组；先读取上游分组后可下拉选择，识别不到仍可手动输入。"
                        rules={[{ required: true, message: '请输入上游分组' }]}
                      >
                        <AutoComplete
                          options={upstreamGroupOptions}
                          placeholder="例如 test"
                          filterOption={autocompleteFilterOption}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                )
              }
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamName !== next.upstreamName || prev.keyName !== next.keyName || prev.upstreamType !== next.upstreamType}>
              {({ getFieldValue }) => {
                const upstreamName = String(getFieldValue('upstreamName') ?? '').trim();
                const keyName = String(getFieldValue('keyName') ?? '').trim();
                const isCliProxy = getFieldValue('upstreamType') === 'cli_proxy';

                return (
                  <div className="form-note">
                    <Text type="secondary">
                      保存后渠道名：{upstreamName ? `${upstreamName}${!isCliProxy && keyName ? `-${keyName}` : ''}` : '等待平台分组'}
                    </Text>
                  </div>
                );
              }}
            </Form.Item>
          </FormSection>

          <FormSection title="上游连接" description="输入地址后自动填平台分组；识别成功会自动选中渠道类型，识别失败再手动选择。">
            <Form.Item label="上游 Base URL" required>
              <Space.Compact className="full-width">
                <Form.Item name="upstreamBaseUrl" noStyle rules={[{ required: true, message: '请输入上游地址' }]}>
                  <Input placeholder="https://relay.example.com" onBlur={() => void fillChannelNameFromUrl()} />
                </Form.Item>
                <Button htmlType="button" icon={<SearchOutlined />} loading={detectingUpstreamType} onClick={detectChannelUpstreamType}>
                  识别类型
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item
              name="upstreamType"
              label="渠道上游类型"
              rules={[
                {
                  validator: (_, value) => {
                    if (isKnownUpstreamType(value)) {
                      return Promise.resolve();
                    }

                    return Promise.reject(new Error(value === 'unknown' ? '未识别出类型，请手动选择' : '请先识别或选择上游类型'));
                  }
                }
              ]}
            >
              <Select
                placeholder="先输入地址识别，识别失败手动选择"
                options={[
                  { label: '未知（请手动选择）', value: 'unknown', disabled: true },
                  { label: 'NewAPI', value: 'newapi' },
                  { label: 'Sub2API', value: 'sub2api' },
                  { label: 'CPA（号池模式）', value: 'cli_proxy' }
                ]}
              />
            </Form.Item>
            <Form.Item name="auth" hidden>
              <Input />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType || prev.auth !== next.auth}>
              {({ getFieldValue }) => {
                const type = getFieldValue('upstreamType');
                if (!isKnownUpstreamType(type)) {
                  return (
                    <AuthHint
                      type={type}
                      auth={getFieldValue('auth')}
                      prefix={upstreamTypeHint?.type === 'unknown' ? '未识别出渠道类型，请手动选择。' : undefined}
                    />
                  );
                }

                const prefix = upstreamTypeHint && upstreamTypeHint.type !== 'unknown'
                  ? `已识别并选中：${upstreamProviderLabel(upstreamTypeHint.type)}。`
                  : undefined;

                return type === 'cli_proxy' ? (
                  <AuthHint type={type} auth={getFieldValue('auth')} prefix={prefix} />
                ) : (
                  <AuthHint
                    type={type}
                    auth={getFieldValue('auth')}
                    prefix={prefix}
                    suffix="渠道保存后到“平台凭证”配置认证方式、Token 或账号密码；同平台分组共用一套凭证。"
                  />
                );
              }}
            </Form.Item>
          </FormSection>

          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType || prev.auth !== next.auth}>
            {({ getFieldValue }) => {
              const type = getFieldValue('upstreamType') as ChannelFormUpstreamType | undefined;
              const auth = getFieldValue('auth') as string | undefined;

              if (!isKnownUpstreamType(type) || type === 'cli_proxy') {
                return null;
              }

              return (
                <FormSection title="识别凭证" description="用于新增时测试、读取上游分组；保存后归到平台凭证统一管理。">
                  <Form.Item name="auth" label="认证方式" rules={[{ required: true, message: '请选择认证方式' }]}>
                    <Select options={authOptions(type)} />
                  </Form.Item>
                  {type === 'newapi' && auth !== 'API Key' ? (
                    <Form.Item
                      name="upstreamUserId"
                      label="上游用户 ID"
                      extra="NewAPI 用户 Access Token 或管理 Token 读取余额和倍率时需要。"
                      rules={[{ required: true, message: '请输入上游用户 ID' }]}
                    >
                      <Input placeholder="例如 1" />
                    </Form.Item>
                  ) : null}
                  <AuthHint type={type} auth={auth} />
                  {type === 'sub2api' && auth === '用户登录' ? (
                    <Row gutter={12}>
                      <Col xs={24} md={12}>
                        <Form.Item name="credentialAccount" label="账号 / 邮箱" extra="仅用于识别和保存平台凭证，不在页面回显。">
                          <Input placeholder="例如 user@example.com" autoComplete="username" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item name="credentialPassword" label="密码" extra="保存后服务端加密存储。">
                          <Input.Password placeholder="请输入密码" autoComplete="current-password" />
                        </Form.Item>
                      </Col>
                    </Row>
                  ) : auth === '无鉴权' ? null : (
                    <Form.Item
                      name="credential"
                      label={credentialFieldLabel(type, auth)}
                      extra="可留空使用同平台分组已保存的凭证；新平台要测试或读分组必须填写。"
                    >
                      <Input.Password placeholder={credentialPlaceholder(type, auth)} autoComplete="new-password" />
                    </Form.Item>
                  )}
                  <Space size={8} wrap>
                    <Button htmlType="button" icon={<CheckCircleOutlined />} loading={testingCredential} onClick={testChannelCredential}>
                      测试凭证
                    </Button>
                    <Button htmlType="button" icon={<ReloadOutlined />} loading={loadingUpstreamGroups} onClick={loadChannelUpstreamGroups}>
                      读取上游分组
                    </Button>
                  </Space>
                  <CredentialTestPanel result={credentialTestResult} />
                  <UpstreamGroupsPanel
                    groups={upstreamGroups}
                    loading={loadingUpstreamGroups}
                    onFetch={loadChannelUpstreamGroups}
                    onAddChannel={applyUpstreamGroupToChannel}
                    actionLabel="填入"
                  />
                </FormSection>
              );
            }}
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
            {({ getFieldValue }) =>
              getFieldValue('upstreamType') === 'cli_proxy' ? (
                <FormSection title="号池管理" description="填写 CPA 管理密钥后，号池管理页可以读取账号成功/失败次数和用量队列。">
                  <Form.Item name="credential" label="CPA 管理密钥" extra="留空表示不修改；只保存在服务端内存，不在页面回显。">
                    <Input.Password placeholder="management key" autoComplete="new-password" />
                  </Form.Item>
                </FormSection>
              ) : null
            }
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
            {({ getFieldValue }) =>
              !editingChannelId && isKnownUpstreamType(getFieldValue('upstreamType')) && getFieldValue('upstreamType') !== 'cli_proxy' ? (
                <FormSection title="主站写入" description="新增渠道会同步提交到主站；这个 Key 是主站实际调用上游用的 Key，不作为平台凭证展示。">
                  <Form.Item
                    name="mainStationKey"
                    label="主站调用 Key"
                    extra="只在新增时提交给主站创建渠道；平台识别凭证仍由上面的认证信息管理。"
                    rules={[{ required: true, message: '请输入主站调用 Key' }]}
                  >
                    <Input.Password placeholder="sk-..." autoComplete="new-password" />
                  </Form.Item>
                  <Form.Item name="models" label="模型范围" extra="可选；留空使用主站默认模型配置。">
                    <Input placeholder="例如 gpt-4o,gpt-4o-mini" />
                  </Form.Item>
                </FormSection>
              ) : null
            }
          </Form.Item>

          <FormSection title="策略参数" description="这些值用于页面展示和主站渠道调度口径。">
            <Form.Item
              name="enabled"
              label="启用状态"
              valuePropName="checked"
              extra="关闭后会同步禁用主站渠道；CPA 号池只影响本地转发配置。"
            >
              <Switch checkedChildren="使用中" unCheckedChildren="禁用" />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
              {({ getFieldValue }) => {
                const type = getFieldValue('upstreamType');

                return !isKnownUpstreamType(type) || type === 'cli_proxy' ? null : (
                  <Form.Item
                    name="skipLatencyDisable"
                    label="延迟失败跳过禁用"
                    valuePropName="checked"
                    extra="主站渠道测试失败或超过阈值时仍记录巡检结果，但不自动禁用，也不把优先级和权重归零。"
                  >
                    <Switch checkedChildren="跳过" unCheckedChildren="执行" />
                  </Form.Item>
                );
              }}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
              {({ getFieldValue }) => {
                const type = getFieldValue('upstreamType');
                const isCliProxy = type === 'cli_proxy';

                return (
                  <Row gutter={12}>
                    <Col xs={24} md={isCliProxy ? 12 : 8}>
                      <Form.Item name="priority" label="优先级" extra="自动巡检按 1-100 回写；0 表示不参与调度。" rules={[{ required: true, message: '请输入优先级' }]}>
                        <InputNumber min={0} max={100} precision={0} className="full-width" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={isCliProxy ? 12 : 8}>
                      <Form.Item name="weight" label="权重" extra="新增默认 0；自动巡检按 1-10 回写。" rules={[{ required: true, message: '请输入权重' }]}>
                        <InputNumber min={0} max={10} precision={0} className="full-width" />
                      </Form.Item>
                    </Col>
                    {isCliProxy ? null : (
                      <Col xs={24} md={8}>
                        <Form.Item label="充值比例" extra="上游 1 元到账 10 额度就填 10。">
                          <Space.Compact className="full-width">
                            <Input value="1:" className="ratio-prefix" disabled />
                            <Form.Item
                              name="rechargeRatio"
                              noStyle
                              rules={[
                                { required: true, message: '请输入充值比例' },
                                {
                                  validator: (_, value) =>
                                    Number.isFinite(Number(value)) && Number(value) >= 0.01
                                      ? Promise.resolve()
                                      : Promise.reject(new Error('充值比例必须大于 0，最多两位小数'))
                                }
                              ]}
                            >
                              <InputNumber
                                min={0.01}
                                step={0.01}
                                precision={2}
                                className="ratio-input"
                                disabled={!isKnownUpstreamType(type)}
                              />
                            </Form.Item>
                          </Space.Compact>
                        </Form.Item>
                      </Col>
                    )}
                  </Row>
                );
              }}
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
              {({ getFieldValue }) =>
                getFieldValue('upstreamType') === 'cli_proxy' ? (
                  <div className="form-note">
                    <Text type="secondary">CPA 是号池模式，不读取余额、倍率和充值比例，只作为临时转发配置。</Text>
                  </div>
                ) : null
              }
            </Form.Item>
          </FormSection>
        </Form>
      </Modal>

      <Modal
        title={
          <ModalTitle
            title="配置平台凭证"
            description="只配置平台分组访问上游所需的认证信息；不会修改 Key、倍率分组、优先级或权重。"
          />
        }
        open={credentialModalOpen}
        className="channel-modal"
        width={680}
        onCancel={() => {
          setCredentialModalOpen(false);
          setEditingCredentialGroupKey(null);
          setCredentialTestResult(null);
          setUpstreamGroups([]);
          credentialForm.resetFields();
        }}
        footer={[
          <Button key="cancel" onClick={() => {
            setCredentialModalOpen(false);
            setEditingCredentialGroupKey(null);
            setCredentialTestResult(null);
            setUpstreamGroups([]);
            credentialForm.resetFields();
          }}>
            取消
          </Button>,
          <Button key="test" icon={<CheckCircleOutlined />} loading={testingCredential} onClick={testCredentialGroup}>
            测试凭证
          </Button>,
          <Button key="save" type="primary" onClick={saveCredentialGroup}>
            保存凭证
          </Button>
        ]}
        destroyOnHidden
      >
        {editingCredentialGroup ? (
          <Form
            form={credentialForm}
            layout="vertical"
            onValuesChange={(changed) => {
              setCredentialTestResult(null);
              setUpstreamGroups([]);
              if ('auth' in changed) {
                credentialForm.setFieldsValue({
                  credential: undefined,
                  credentialAccount: '',
                  credentialPassword: ''
                });
              }
            }}
          >
            <FormSection title="平台分组" description="同组渠道共用这一套凭证；渠道自己的 Key 和倍率分组保持不变。">
              <CredentialGroupSummary group={editingCredentialGroup} />
            </FormSection>

            <FormSection title="认证信息" description="保存后会同步到同平台分组的全部渠道。">
              <Form.Item name="auth" label="认证方式" rules={[{ required: true, message: '请选择认证方式' }]}>
                <Select options={authOptions(editingCredentialGroup.primary.upstreamType)} />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(prev, next) => prev.auth !== next.auth}>
                {({ getFieldValue }) =>
                  editingCredentialGroup.primary.upstreamType === 'newapi' && getFieldValue('auth') !== 'API Key' ? (
                    <Form.Item
                      name="upstreamUserId"
                      label="上游用户 ID"
                      extra="NewAPI 用户 Access Token 或管理 Token 读取余额和倍率时需要。"
                      rules={[{ required: true, message: '请输入上游用户 ID' }]}
                    >
                      <Input placeholder="例如 1" />
                    </Form.Item>
                  ) : null
                }
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(prev, next) => prev.auth !== next.auth}>
                {({ getFieldValue }) => (
                  <AuthHint type={editingCredentialGroup.primary.upstreamType} auth={getFieldValue('auth')} />
                )}
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(prev, next) => prev.auth !== next.auth}>
                {({ getFieldValue }) => {
                  const type = editingCredentialGroup.primary.upstreamType;
                  const auth = getFieldValue('auth') as string | undefined;
                  const required =
                    editingCredentialGroup.configuredCount !== editingCredentialGroup.channels.length ||
                    auth !== editingCredentialGroup.primary.auth;
                  const extra = required
                    ? '服务端 AES-GCM 加密保存；同平台分组共用，不在页面回显。'
                    : '留空表示不修改；填写后会同步到同平台分组的全部渠道。';

                  if (type === 'sub2api' && auth === '用户登录') {
                    return (
                      <Row gutter={12}>
                        <Col xs={24} md={12}>
                          <Form.Item
                            name="credentialAccount"
                            label="账号 / 邮箱"
                            extra={extra}
                            rules={[{ required, message: '请输入账号或邮箱' }]}
                          >
                            <Input placeholder="例如 user@example.com" autoComplete="username" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item
                            name="credentialPassword"
                            label="密码"
                            extra={extra}
                            rules={[{ required, message: '请输入密码' }]}
                          >
                            <Input.Password placeholder="请输入密码" autoComplete="current-password" />
                          </Form.Item>
                        </Col>
                      </Row>
                    );
                  }

                  if (auth === '无鉴权') {
                    return null;
                  }

                  return (
                    <Form.Item
                      name="credential"
                      label={credentialFieldLabel(type, auth)}
                      extra={extra}
                      rules={[{ required, message: `请输入${credentialFieldLabel(type, auth)}` }]}
                    >
                      <Input.Password
                        placeholder={required ? credentialPlaceholder(type, auth) : '留空表示不修改'}
                        autoComplete="new-password"
                      />
                    </Form.Item>
                  );
                }}
              </Form.Item>
              <CredentialTestPanel result={credentialTestResult} />
              <UpstreamGroupsPanel
                groups={upstreamGroups}
                loading={loadingUpstreamGroups}
                onFetch={loadCredentialGroupUpstreamGroups}
                onAddChannel={openChannelModalFromUpstreamGroup}
              />
            </FormSection>
          </Form>
        ) : null}
      </Modal>

      <Modal
        title="配置主站"
        open={relayModalOpen}
        className="relay-modal"
        onCancel={() => setRelayModalOpen(false)}
        onOk={saveRelay}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={relayForm} layout="vertical" initialValues={{ auth: '管理 Token' }}>
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="主站名称" rules={[{ required: true, message: '请输入主站名称' }]}>
            <Input placeholder="例如 主站" />
          </Form.Item>
          <Form.Item name="baseUrl" label="NewAPI 地址" rules={[{ required: true, message: '请输入 NewAPI 地址' }]}>
            <Input placeholder="https://newapi.example.com" />
          </Form.Item>
          <Form.Item name="auth" hidden>
            <Input />
          </Form.Item>
          <Text type="secondary">主站固定使用管理 Token，不需要选择认证类型。</Text>
          <Form.Item
            name="adminUserId"
            label="管理员用户 ID"
            extra="NewAPI 管理接口需要 New-Api-User header，一般是管理员账号的用户 ID。"
            rules={[{ required: true, message: '请输入管理员用户 ID' }]}
          >
            <Input placeholder="例如 1" />
          </Form.Item>
          <Form.Item
            name="adminToken"
            label="管理 Token"
            extra="保存后只记录已配置状态，不在页面回显 Token。"
            rules={[{ required: !selectedRelay?.tokenConfigured, message: '请输入管理 Token' }]}
          >
            <Input.Password placeholder={selectedRelay?.tokenConfigured ? '留空表示不修改' : 'sk-...'} autoComplete="new-password" />
          </Form.Item>
          <Text type="secondary">这里配置的是你自己的 NewAPI 主站，不是渠道上游。</Text>
        </Form>
      </Modal>
        </>
      )}
    </ConfigProvider>
  );
}

function AuthScreen({
  status,
  checking,
  onAuthenticated
}: {
  status: AuthStatus | null;
  checking: boolean;
  onAuthenticated: (username: string) => void;
}) {
  const [form] = Form.useForm<LoginForm>();
  const [busy, setBusy] = useState(false);
  const setupRequired = Boolean(status?.setupRequired);

  async function submit(values: LoginForm) {
    if (setupRequired && values.password !== values.confirmPassword) {
      form.setFields([{ name: 'confirmPassword', errors: ['两次密码不一致'] }]);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: values.username,
          password: values.password
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { username?: string; error?: string };

      if (!response.ok) {
        form.setFields([{ name: 'password', errors: [payload.error ?? '登录失败'] }]);
        return;
      }

      onAuthenticated(payload.username ?? values.username);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <Card className="auth-card">
        <div className="auth-brand">
          <Avatar shape="square" size={40} icon={<LockOutlined />} className="brand-avatar" />
          <div>
            <Title level={3}>{setupRequired ? '设置登录密码' : '登录 RelayDesk'}</Title>
            <Text type="secondary">
              {setupRequired ? '密码只保存 PBKDF2 哈希，不保存明文。' : '登录后才能访问主站、渠道和凭证管理。'}
            </Text>
          </div>
        </div>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ username: status?.username ?? 'admin' }}
          onFinish={submit}
        >
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete={setupRequired ? 'new-password' : 'current-password'} />
          </Form.Item>
          {setupRequired ? (
            <Form.Item
              name="confirmPassword"
              label="确认密码"
              rules={[{ required: true, message: '请再次输入密码' }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          ) : null}
          <Button type="primary" htmlType="submit" block loading={busy || checking}>
            {setupRequired ? '保存并登录' : '登录'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}

function OverviewView({
  selectedRelay,
  relayCount,
  channelCount,
  readableCount,
  limitedCount,
  pendingSyncCount,
  cliProxyCount,
  onConfigureRelay,
  channelColumns,
  channels,
  events
}: {
  selectedRelay?: RelayView;
  relayCount: number;
  channelCount: number;
  readableCount: number;
  limitedCount: number;
  pendingSyncCount: number;
  cliProxyCount: number;
  onConfigureRelay: () => void;
  channelColumns: ColumnsType<ChannelView>;
  channels: ChannelView[];
  events: EventItem[];
}) {
  return (
    <Flex vertical gap={16} className="full-width">
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="主站" value={relayCount} prefix={<ApiOutlined />} suffix={<Text type="secondary">个</Text>} />
            <Text type="secondary">当前只管理一个 NewAPI 主站</Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="渠道" value={channelCount} prefix={<CloudOutlined />} suffix={<Text type="secondary">个</Text>} />
            <Text type="secondary">{readableCount} 个可读取倍率和余额</Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="待同步渠道" value={pendingSyncCount} prefix={<FieldTimeOutlined />} />
            <Text type="secondary">新增或认证信息变更后需要同步</Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="受限渠道" value={limitedCount} prefix={<AlertOutlined />} />
            <Text type="secondary">API Key、CF Challenge；{cliProxyCount} 个仅转发</Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="overview-detail-row">
        <Col xs={24} xl={10}>
          <Card title="当前主站" className="overview-relay-card" extra={<Button size="small" icon={<SettingOutlined />} onClick={onConfigureRelay}>配置</Button>}>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: 'name', label: '名称', children: selectedRelay?.name ?? '-' },
                { key: 'type', label: '类型', children: <RelayTypeTag /> },
                { key: 'baseUrl', label: '地址', children: selectedRelay?.baseUrl ?? '-' },
                { key: 'adminUserId', label: '管理员用户', children: selectedRelay?.adminUserId || '-' },
                {
                  key: 'auth',
                  label: '管理 Token',
                  children: selectedRelay ? (
                    <Space size={6}>
                      <Text>{selectedRelay.auth}</Text>
                      <Tag color={selectedRelay.tokenConfigured ? 'green' : 'default'}>
                        {selectedRelay.tokenConfigured ? '已配置' : '未配置'}
                      </Tag>
                    </Space>
                  ) : (
                    '-'
                  )
                },
                { key: 'sync', label: '同步', children: selectedRelay?.sync ?? '-' },
                {
                  key: 'status',
                  label: '状态',
                  children: selectedRelay ? <StatusTag tone={selectedRelay.statusTone}>{selectedRelay.status}</StatusTag> : '-'
                }
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="最近事件" className="overview-events-card">
            <EventList events={events} />
          </Card>
        </Col>
      </Row>

      <Card title="渠道概览">
        <Table
          rowKey="id"
          columns={channelColumns}
          dataSource={channels}
          pagination={{ pageSize: 6, showSizeChanger: false, hideOnSinglePage: true }}
          size="middle"
          scroll={{ x: 1340 }}
          locale={{ emptyText: <Empty description="还没有渠道，新增渠道后这里会显示具体倍率归属" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Card>

      <Card title="处理原则">
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}>
            <RunbookItem icon={<DatabaseOutlined />} title="先同步主站">
              主站只负责导入渠道基础信息，渠道凭证统一在平台凭证里配置。
            </RunbookItem>
          </Col>
          <Col xs={24} lg={8}>
            <RunbookItem icon={<FieldTimeOutlined />} title="巡检看健康">
              延迟、失败次数和系统禁用会在渠道列表里直接显示，不需要去倍率页判断。
            </RunbookItem>
          </Col>
          <Col xs={24} lg={8}>
            <RunbookItem icon={<AlertOutlined />} title="告警看异常">
              倍率变化、余额低、延迟高和认证异常都走告警规则配置。
            </RunbookItem>
          </Col>
        </Row>
      </Card>
    </Flex>
  );
}

function ChannelGuide({
  inspection,
  inspectionBusy,
  onUpdateInspection,
  onRunInspection
}: {
  inspection: InspectionView | null;
  inspectionBusy: boolean;
  onUpdateInspection: (input: InspectionUpdate) => void;
  onRunInspection: () => void;
}) {
  return (
    <Card size="small" className="view-guide">
      <Flex vertical gap={12}>
        <div className="inspection-bar">
          <div className="inspection-summary">
            <Space size={8} wrap>
              <Text strong>自动巡检</Text>
              <StatusTag tone={inspection?.enabled ? 'ok' : 'limited'}>{inspection?.enabled ? '运行中' : '已暂停'}</StatusTag>
              <Text type="secondary">
                {inspection
                  ? `${inspection.activeUpstreamCount} 个上游，${inspection.dueUpstreamCount} 个到期，延迟禁用 ${inspection.latencyDisabledCount} 个`
                  : '读取中'}
              </Text>
            </Space>
            <Text type="secondary">
              {inspection?.lastResult ?? 'Worker 会按间隔自动提交同步任务。'}
              {inspection?.lastRunAt ? ` 上次检查：${formatDateTime(inspection.lastRunAt)}` : ''}
              {inspection?.lastError ? ` 错误：${inspection.lastError}` : ''}
            </Text>
          </div>
          <div className="inspection-actions">
            <div className="inspection-control-group">
              <Text type="secondary" className="inspection-control-title">巡检</Text>
              <Switch
                checked={Boolean(inspection?.enabled)}
                loading={inspectionBusy}
                checkedChildren="开"
                unCheckedChildren="关"
                onChange={(enabled) => onUpdateInspection({ enabled })}
              />
              <Select
                className="inspection-interval"
                value={inspection?.intervalMs ?? 900_000}
                disabled={inspectionBusy}
                onChange={(intervalMs) => onUpdateInspection({ intervalMs })}
                options={intervalOptions}
              />
              <div className="inspection-field">
                <Text type="secondary">并发</Text>
                <DebouncedInspectionNumber
                  className="inspection-field-input inspection-field-input-small"
                  min={1}
                  max={20}
                  value={inspection?.inspectionConcurrency ?? 3}
                  disabled={inspectionBusy}
                  onCommit={(inspectionConcurrency) => onUpdateInspection({ inspectionConcurrency })}
                />
              </div>
              <Button icon={<FieldTimeOutlined />} loading={inspectionBusy} onClick={onRunInspection}>
                立即巡检
              </Button>
            </div>
            <div className="inspection-control-group">
              <Text type="secondary" className="inspection-control-title">主站渠道测试</Text>
              <Switch
                checked={inspection?.latencyTestEnabled ?? true}
                loading={inspectionBusy}
                checkedChildren="开"
                unCheckedChildren="关"
                onChange={(latencyTestEnabled) => onUpdateInspection({ latencyTestEnabled })}
              />
              <Select
                className="inspection-interval"
                value={inspection?.latencyIntervalMs ?? 300_000}
                disabled={inspectionBusy}
                onChange={(latencyIntervalMs) => onUpdateInspection({ latencyIntervalMs })}
                options={[
                  { label: '1 分钟', value: 60_000 },
                  { label: '5 分钟', value: 300_000 },
                  { label: '15 分钟', value: 900_000 },
                  { label: '30 分钟', value: 1_800_000 }
                ]}
              />
              <div className="inspection-field">
                <Text type="secondary">超时(秒)</Text>
                <DebouncedInspectionNumber
                  className="inspection-field-input"
                  min={0.1}
                  max={120}
                  step={0.5}
                  value={msToSeconds(inspection?.latencyTimeoutMs ?? 10_000)}
                  disabled={inspectionBusy}
                  onCommit={(seconds) => onUpdateInspection({ latencyTimeoutMs: secondsToMs(seconds) })}
                />
              </div>
              <div className="inspection-field">
                <Text type="secondary">禁用阈值(秒)</Text>
                <DebouncedInspectionNumber
                  className="inspection-field-input"
                  min={0.1}
                  max={120}
                  step={0.5}
                  value={msToSeconds(inspection?.latencyDisableThresholdMs ?? 8_000)}
                  disabled={inspectionBusy}
                  onCommit={(seconds) => onUpdateInspection({ latencyDisableThresholdMs: secondsToMs(seconds) })}
                />
              </div>
              <div className="inspection-field">
                <Text type="secondary">失败次数</Text>
                <DebouncedInspectionNumber
                  className="inspection-field-input inspection-field-input-small"
                  min={1}
                  max={20}
                  value={inspection?.latencyFailureLimit ?? 3}
                  disabled={inspectionBusy}
                  onCommit={(latencyFailureLimit) => onUpdateInspection({ latencyFailureLimit })}
                />
              </div>
              <Select
                className="inspection-retest"
                value={inspection?.disabledRetestMs ?? 1_800_000}
                disabled={inspectionBusy}
                onChange={(disabledRetestMs) => onUpdateInspection({ disabledRetestMs })}
                options={[
                  { label: '禁用后 5 分钟复测', value: 300_000 },
                  { label: '禁用后 30 分钟复测', value: 1_800_000 },
                  { label: '禁用后 1 小时复测', value: 3_600_000 },
                  { label: '禁用后 6 小时复测', value: 21_600_000 }
                ]}
              />
            </div>
            <div className="inspection-control-group">
              <Text type="secondary" className="inspection-control-title">CPA 优先</Text>
              <Switch
                checked={inspection?.cpaPreferred ?? false}
                loading={inspectionBusy}
                checkedChildren="开"
                unCheckedChildren="关"
                onChange={(cpaPreferred) => onUpdateInspection({ cpaPreferred })}
              />
              <Text type="secondary" className="inspection-control-note">
                可用时优先级 100 / 权重 10
              </Text>
              <Text type="secondary" className="inspection-control-title">余额不足</Text>
              <Select
                className="inspection-action-select"
                value={inspection?.balanceLowAction ?? 'NONE'}
                disabled={inspectionBusy}
                onChange={(balanceLowAction) => onUpdateInspection({ balanceLowAction })}
                options={inspectionActionOptions}
              />
              <Text type="secondary" className="inspection-control-title">倍率上涨</Text>
              <Select
                className="inspection-action-select"
                value={inspection?.rateIncreaseAction ?? 'NONE'}
                disabled={inspectionBusy}
                onChange={(rateIncreaseAction) => onUpdateInspection({ rateIncreaseAction })}
                options={inspectionActionOptions}
              />
              <div className="inspection-field">
                <Text type="secondary">降到优/权</Text>
                <Space.Compact className="inspection-dispatch-inputs">
                  <DebouncedInspectionNumber
                    min={0}
                    max={100}
                    precision={0}
                    value={inspection?.ruleActionPriority ?? 10}
                    disabled={inspectionBusy}
                    onCommit={(ruleActionPriority) => onUpdateInspection({ ruleActionPriority })}
                  />
                  <DebouncedInspectionNumber
                    min={0}
                    max={10}
                    precision={0}
                    value={inspection?.ruleActionWeight ?? 0}
                    disabled={inspectionBusy}
                    onCommit={(ruleActionWeight) => onUpdateInspection({ ruleActionWeight })}
                  />
                </Space.Compact>
              </div>
            </div>
          </div>
        </div>
      </Flex>
    </Card>
  );
}

function DebouncedInspectionNumber({
  value,
  disabled,
  onCommit,
  debounceMs = 600,
  ...props
}: {
  value: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  debounceMs?: number;
  className?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
}) {
  const [draftValue, setDraftValue] = useState<number | null>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) {
      setDraftValue(value);
    }
  }, [value]);

  useEffect(() => () => clearDebouncedTimer(timerRef), []);

  function commit(nextValue: number | null, immediate = false) {
    clearDebouncedTimer(timerRef);

    if (typeof nextValue !== 'number' || !Number.isFinite(nextValue)) {
      if (immediate) {
        dirtyRef.current = false;
        setDraftValue(value);
      }
      return;
    }

    const run = () => {
      dirtyRef.current = false;
      if (nextValue !== value) {
        onCommit(nextValue);
      }
    };

    if (immediate) {
      run();
      return;
    }

    timerRef.current = setTimeout(run, debounceMs);
  }

  return (
    <InputNumber
      {...props}
      value={draftValue}
      disabled={disabled}
      onChange={(nextValue) => {
        const numericValue = typeof nextValue === 'number' ? nextValue : null;
        dirtyRef.current = true;
        setDraftValue(numericValue);
        commit(numericValue);
      }}
      onBlur={() => commit(draftValue, true)}
    />
  );
}

function clearDebouncedTimer(timerRef: { current: ReturnType<typeof setTimeout> | null }) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

function ChannelGroupList({ groups, columns }: { groups: ChannelGroup[]; columns: ColumnsType<ChannelView> }) {
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const allCollapsed = collapsedGroupKeys.size === groups.length;

  if (groups.length === 0) {
    return <Empty description="还没有渠道，先新增一个渠道上游" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  function toggleGroup(key: string) {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }

  function setAllCollapsed(collapsed: boolean) {
    setCollapsedGroupKeys(collapsed ? new Set(groups.map((group) => group.key)) : new Set());
  }

  return (
    <div className="channel-group-list">
      <div className="channel-group-list-toolbar">
        <Text type="secondary">{groups.length} 个平台分组</Text>
        <Space size={6}>
          <Button size="small" icon={<DownOutlined />} onClick={() => setAllCollapsed(false)} disabled={collapsedGroupKeys.size === 0}>
            全部展开
          </Button>
          <Button size="small" icon={<RightOutlined />} onClick={() => setAllCollapsed(true)} disabled={allCollapsed}>
            全部收起
          </Button>
        </Space>
      </div>
      {groups.map((group) => {
        const monitorableChannels = group.channels.filter((channel) => channel.upstreamType !== 'cli_proxy');
        const configuredCount = monitorableChannels.filter((channel) => channel.credentialConfigured).length;
        const pendingCount = monitorableChannels.filter((channel) => channel.statusTone !== 'ok').length;
        const providerTypes = uniqueValues(group.channels.map((channel) => channel.upstreamType));
        const collapsed = collapsedGroupKeys.has(group.key);

        return (
          <section className={`channel-group ${collapsed ? 'is-collapsed' : 'is-expanded'}`} key={group.key}>
            <div
              className="channel-group-header"
              role="button"
              tabIndex={0}
              onClick={() => toggleGroup(group.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleGroup(group.key);
                }
              }}
            >
              <span className="channel-group-toggle" aria-hidden="true">
                {collapsed ? <RightOutlined /> : <DownOutlined />}
              </span>
              <div className="channel-group-main">
                <Space size={8} wrap>
                  <span className="channel-group-label">平台分组</span>
                  <GroupWebsiteLink group={group} className="channel-group-title" />
                  {providerTypes.map((type) => (
                    <ProviderTag key={type} type={type} />
                  ))}
                  <Tag>{group.channels.length} 个渠道</Tag>
                  <Tag color="green">使用中 {group.channels.filter((channel) => channel.enabled).length}</Tag>
                  <Tag>禁用 {group.channels.filter((channel) => !channel.enabled).length}</Tag>
                </Space>
                <Space size={6} wrap>
                  {monitorableChannels.length > 0 ? (
                    <Tag color={configuredCount === monitorableChannels.length ? 'green' : 'gold'}>
                      凭证 {configuredCount}/{monitorableChannels.length}
                    </Tag>
                  ) : null}
                  {pendingCount > 0 ? <Tag color="blue">{pendingCount} 个待处理</Tag> : null}
                </Space>
              </div>
              <span className="channel-group-action">{collapsed ? '展开' : '收起'}</span>
            </div>
            {collapsed ? null : (
              <div className="channel-group-body">
                <div className="channel-group-body-label">分组下渠道</div>
                <Table
                  rowKey="id"
                  columns={columns}
                  dataSource={group.channels}
                  pagination={false}
                  size="small"
                  scroll={{ x: 1340 }}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function GroupWebsiteLink({ group, className }: { group: ChannelGroup; className?: string }) {
  const channel = group.channels.find((item) => normalizedExternalUrl(item.upstreamBaseUrl)) ?? group.channels[0];
  const href = channel ? normalizedExternalUrl(channel.upstreamBaseUrl) : null;
  const label = group.name;
  const title = channel ? `打开 ${displayEndpoint(channel.upstreamBaseUrl)}` : undefined;
  const classes = ['group-website-link', className].filter(Boolean).join(' ');

  if (!href) {
    return (
      <Text strong className={className}>
        {label}
      </Text>
    );
  }

  return (
    <a
      className={classes}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

function RatesCard({
  columns,
  groups,
  rateFilter,
  setRateFilter
}: {
  columns: ColumnsType<RateRow>;
  groups: RateGroup[];
  rateFilter: RateFilter;
  setRateFilter: (filter: RateFilter) => void;
}) {
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const allCollapsed = groups.length > 0 && collapsedGroupKeys.size === groups.length;
  const rowCount = groups.reduce((total, group) => total + group.rows.length, 0);

  function toggleGroup(key: string) {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }

  function setAllCollapsed(collapsed: boolean) {
    setCollapsedGroupKeys(collapsed ? new Set(groups.map((group) => group.key)) : new Set());
  }

  return (
    <Card
      title="倍率快照"
      extra={
        <Space size={8} wrap>
          <Text type="secondary">{groups.length} 个平台分组，{rowCount} 个 Key</Text>
          <Segmented
            value={rateFilter}
            onChange={(value) => setRateFilter(value as RateFilter)}
            options={[
              { label: '全部', value: 'all' },
              { label: '有变化', value: 'changed' },
              { label: '受限', value: 'limited' }
            ]}
          />
        </Space>
      }
    >
      {groups.length === 0 ? (
        <Empty description="还没有倍率快照，同步渠道后按平台分组显示" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="channel-group-list rate-group-list">
          <div className="channel-group-list-toolbar">
            <Text type="secondary">按平台分组查看每个 Key 的主站分组和倍率分组</Text>
            <Space size={6}>
              <Button size="small" icon={<DownOutlined />} onClick={() => setAllCollapsed(false)} disabled={collapsedGroupKeys.size === 0}>
                全部展开
              </Button>
              <Button size="small" icon={<RightOutlined />} onClick={() => setAllCollapsed(true)} disabled={allCollapsed}>
                全部收起
              </Button>
            </Space>
          </div>
          {groups.map((group) => {
            const collapsed = collapsedGroupKeys.has(group.key);
            const changedCount = group.rows.filter((row) => row.direction === 'up' || row.direction === 'down').length;
            const limitedCount = group.rows.filter((row) => row.direction === 'limited').length;

            return (
              <section className={`channel-group rate-group ${collapsed ? 'is-collapsed' : 'is-expanded'}`} key={group.key}>
                <div
                  className="channel-group-header"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(group.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleGroup(group.key);
                    }
                  }}
                >
                  <span className="channel-group-toggle" aria-hidden="true">
                    {collapsed ? <RightOutlined /> : <DownOutlined />}
                  </span>
                  <div className="channel-group-main">
                    <Space size={8} wrap>
                      <span className="channel-group-label">平台分组</span>
                      <Text strong className="channel-group-title">{group.name}</Text>
                      <ProviderTag type={group.upstreamType} />
                      <Tag>{group.rows.length} 个 Key</Tag>
                      {changedCount > 0 ? <Tag color="gold">{changedCount} 个变化</Tag> : null}
                      {limitedCount > 0 ? <Tag color="blue">{limitedCount} 个待同步</Tag> : null}
                    </Space>
                  </div>
                  <span className="channel-group-action">{collapsed ? '展开' : '收起'}</span>
                </div>
                {collapsed ? null : (
                  <div className="channel-group-body">
                    <div className="channel-group-body-label">分组下倍率快照</div>
                    <Table
                      rowKey="key"
                      columns={columns}
                      dataSource={group.rows}
                      pagination={false}
                      size="small"
                      scroll={{ x: 1120 }}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CredentialsView({
  groups,
  onEditGroup
}: {
  groups: CredentialGroup[];
  onEditGroup: (group: CredentialGroup) => void;
}) {
  const configuredCount = groups.reduce((total, group) => total + group.configuredCount, 0);
  const channelCount = groups.reduce((total, group) => total + group.channels.length, 0);
  const columns: ColumnsType<CredentialGroup> = [
    {
      title: '平台分组',
      key: 'group',
      width: 280,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <Badge status={record.configuredCount > 0 ? 'success' : 'processing'} />
            <GroupWebsiteLink group={record} />
            {record.providerTypes.map((type) => (
              <ProviderTag key={type} type={type} />
            ))}
          </Space>
          <Text type="secondary" className="truncate-text">
            {record.channels.length} 个渠道，使用中 {record.enabledCount} 个
          </Text>
        </Flex>
      )
    },
    {
      title: '共用认证方式',
      key: 'auth',
      width: 200,
      render: (_, record) => (
        <Space size={6} wrap>
          {record.authLabels.map((auth) => (
            <Tag key={auth}>{auth}</Tag>
          ))}
        </Space>
      )
    },
    {
      title: 'Key',
      key: 'keys',
      width: 260,
      render: (_, record) => (
        <Text type="secondary" className="truncate-text">
          {record.channels.map((channel) => channelKeyLabel(channel)).join(' / ')}
        </Text>
      )
    },
    {
      title: '凭证状态',
      key: 'status',
      width: 150,
      render: (_, record) => <GroupCredentialTag configured={record.configuredCount} total={record.channels.length} />
    },
    {
      title: '最近同步',
      key: 'sync',
      width: 120,
      render: (_, record) => <Text type="secondary">{record.latestSync}</Text>
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => onEditGroup(record)}>
          配置凭证
        </Button>
      )
    }
  ];

  return (
    <Card
      title="平台分组凭证管理"
      extra={
        <Space size={8} wrap>
          <Tag color="green">同平台分组共用</Tag>
          <Text type="secondary">
            服务端 {configuredCount}/{channelCount} 个渠道
          </Text>
        </Space>
      }
    >
      <Table
        rowKey="key"
        columns={columns}
        dataSource={groups}
        pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
        size="middle"
        scroll={{ x: 1050 }}
        locale={{
          emptyText: <Empty description="还没有可管理的平台分组凭证" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        }}
      />
    </Card>
  );
}

function CpaPoolPanel({
  data,
  loading,
  selectedChannelId,
  onSelectChannel,
  onRefresh
}: {
  data: CpaPoolView;
  loading: boolean;
  selectedChannelId?: string;
  onSelectChannel: (channelId: string) => void;
  onRefresh: () => void;
}) {
  const accounts = data.accounts;
  const normalCount = accounts.filter((account) => cpaAccountStatusTone(account.status) === 'ok').length;
  const abnormalCount = accounts.length - normalCount;
  const columns: ColumnsType<CpaPoolAccountView> = [
    {
      title: '账号',
      key: 'account',
      width: 260,
      fixed: 'left',
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main cpa-account-cell">
          <Space size={8} wrap>
            <Text strong>{record.name}</Text>
            <Tag color="blue">{record.provider}</Tag>
          </Space>
          <Text type="secondary" className="truncate-text">{record.account}</Text>
        </Flex>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value) => <StatusTag tone={cpaAccountStatusTone(String(value))}>{String(value)}</StatusTag>
    },
    {
      title: '成功',
      dataIndex: 'successCount',
      width: 96,
      render: (value) => <Text>{formatInteger(value)}</Text>
    },
    {
      title: '失败',
      dataIndex: 'failureCount',
      width: 96,
      render: (value) => <Text>{formatInteger(value)}</Text>
    },
    {
      title: '5小时限额',
      dataIndex: 'usage5h',
      width: 150,
      render: (value) => <UsagePercent value={value} />
    },
    {
      title: '周限用量',
      dataIndex: 'usage7d',
      width: 150,
      render: (value) => <UsagePercent value={value} />
    },
    {
      title: '额度刷新时间',
      key: 'refresh',
      width: 190,
      render: (_, record) => (
        <Flex vertical gap={4}>
          <Text>{formatOptionalTime(record.lastRefresh)}</Text>
          <Text type="secondary" className="table-subtle">
            文件 {formatOptionalTime(record.refreshTime)}
          </Text>
        </Flex>
      )
    }
  ];
  const channelOptions = data.channels.map((channel) => ({
    label: channel.credentialConfigured ? channel.name : `${channel.name}（未配置管理密钥）`,
    value: channel.id
  }));

  return (
    <Card
      className="cpa-pool-card"
      title={
        <Flex vertical gap={2}>
          <Text strong>CPA 号池账号</Text>
          <Text type="secondary" className="table-subtle">
            账号健康、调用次数和限额占用
          </Text>
        </Flex>
      }
      extra={
        <Space size={8} wrap className="toolbar-inline">
          <Select
            className="cpa-channel-select"
            value={selectedChannelId ?? data.channel?.id}
            placeholder="选择 CPA 渠道"
            options={channelOptions}
            onChange={onSelectChannel}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
            刷新
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        <div className="cpa-pool-summary">
          <Flex vertical gap={2} className="cpa-pool-endpoint">
            <Text strong>{data.channel?.name ?? '未选择号池'}</Text>
            <Text type="secondary" className="truncate-text">{data.channel?.baseUrl ?? '-'}</Text>
          </Flex>
          <Statistic title="账号" value={accounts.length} />
          <Statistic title="正常" value={normalCount} valueStyle={{ color: '#0f766e' }} />
          <Statistic title="非正常" value={abnormalCount} valueStyle={{ color: abnormalCount > 0 ? '#b42318' : '#667085' }} />
          {data.usageQueueError ? <Tag color="gold">用量队列未采集完整</Tag> : null}
          {data.refreshedAt ? <Tag>刷新 {formatDateTime(data.refreshedAt)}</Tag> : null}
        </div>
        <Table
          rowKey="key"
          loading={loading}
          columns={columns}
          dataSource={data.accounts}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          size="middle"
          scroll={{ x: 1060 }}
          locale={{ emptyText: <Empty description="没有读取到号池账号，先给 CPA 渠道配置管理密钥" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Flex>
    </Card>
  );
}

function AlertsView({
  events,
  rules,
  savingRuleType,
  onUpdateRule
}: {
  events: EventItem[];
  rules: AlertRuleView[];
  savingRuleType: AlertRuleType | null;
  onUpdateRule: (input: AlertRuleUpdate) => void;
}) {
  const columns: ColumnsType<AlertRuleView> = [
    {
      title: '规则',
      key: 'rule',
      width: 240,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <StatusTag tone={record.enabled ? severityTone(record.severity) : 'limited'}>{record.name}</StatusTag>
            <Text type="secondary">{alertRuleTypeLabel(record.type)}</Text>
          </Space>
          <Text type="secondary" className="table-subtle">
            {alertRuleDescription(record.type)}
          </Text>
        </Flex>
      )
    },
    {
      title: '启用',
      key: 'enabled',
      width: 82,
      render: (_, record) => (
        <Switch
          size="small"
          checked={record.enabled}
          loading={savingRuleType === record.type}
          onChange={(enabled) => onUpdateRule({ type: record.type, enabled })}
        />
      )
    },
    {
      title: '级别',
      key: 'severity',
      width: 126,
      render: (_, record) => (
        <Select
          size="small"
          value={record.severity}
          disabled={savingRuleType === record.type}
          onChange={(severity) => onUpdateRule({ type: record.type, severity })}
          options={[
            { label: '信息', value: 'INFO' },
            { label: '警告', value: 'WARNING' },
            { label: '严重', value: 'CRITICAL' }
          ]}
        />
      )
    },
    {
      title: '阈值',
      key: 'threshold',
      width: 190,
      render: (_, record) => (
        <AlertRuleThreshold
          rule={record}
          disabled={savingRuleType === record.type}
          onUpdateRule={onUpdateRule}
        />
      )
    },
    {
      title: '提醒方式',
      key: 'notificationMethods',
      width: 190,
      render: (_, record) => (
        <Select
          mode="multiple"
          allowClear
          size="small"
          className="full-width"
          maxTagCount="responsive"
          placeholder="仅事件流"
          value={normalizeNotificationMethods(record.notificationMethods)}
          disabled={savingRuleType === record.type}
          onChange={(notificationMethods) => onUpdateRule({ type: record.type, notificationMethods })}
          options={notificationMethodOptions}
        />
      )
    },
    {
      title: '冷却',
      key: 'cooldown',
      width: 140,
      render: (_, record) => (
        <Space.Compact className="alert-number">
          <InputNumber
            className="compact-number-input"
            size="small"
            min={1}
            max={1440}
            value={record.cooldownMinutes}
            disabled={savingRuleType === record.type}
            onChange={(cooldownMinutes) => {
              if (typeof cooldownMinutes === 'number') {
                onUpdateRule({ type: record.type, cooldownMinutes });
              }
            }}
          />
          <Input className="number-affix number-suffix" size="small" value="分钟" readOnly tabIndex={-1} />
        </Space.Compact>
      )
    }
  ];

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <Card
          title="告警规则"
          extra={
            <Space size={10} wrap>
              <Text type="secondary">提醒方式为空时只进事件流</Text>
              <Text type="secondary">{rules.filter((rule) => rule.enabled).length}/{rules.length} 启用</Text>
            </Space>
          }
        >
          <Table
            rowKey="type"
            columns={columns}
            dataSource={rules}
            pagination={false}
            size="middle"
            scroll={{ x: 970 }}
            locale={{ emptyText: <Empty description="正在读取告警规则" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <Card title="事件流">
          <EventList events={events} />
        </Card>
      </Col>
    </Row>
  );
}

function EventList({ events }: { events: EventItem[] }) {
  if (events.length === 0) {
    return <Empty description="暂无事件" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Timeline
      items={events.map((item) => ({
        color: item.status === 'error' ? 'red' : item.status === 'warning' ? 'gold' : 'green',
        content: (
          <div className="timeline-item">
            <Space>
              <Text strong>{item.title}</Text>
              <Text type="secondary">{item.time}</Text>
            </Space>
            <Text type="secondary">{item.detail}</Text>
          </div>
        )
      }))}
    />
  );
}

function AlertRuleThreshold({
  rule,
  disabled,
  onUpdateRule
}: {
  rule: AlertRuleView;
  disabled: boolean;
  onUpdateRule: (input: AlertRuleUpdate) => void;
}) {
  if (rule.type === 'RATE_INCREASE' || rule.type === 'RATE_DECREASE') {
    return (
      <Space.Compact className="alert-number">
        <InputNumber
          className="compact-number-input"
          size="small"
          min={0}
          max={1000}
          step={0.5}
          value={numericOrUndefined(rule.thresholdPercent)}
          disabled={disabled}
          onChange={(thresholdPercent) => {
            if (typeof thresholdPercent === 'number') {
              onUpdateRule({ type: rule.type, thresholdPercent });
            }
          }}
        />
        <Input className="number-affix number-suffix" size="small" value="%" readOnly tabIndex={-1} />
      </Space.Compact>
    );
  }

  if (rule.type === 'BALANCE_LOW') {
    return (
      <Space.Compact className="alert-number">
        <InputNumber
          className="compact-number-input"
          size="small"
          min={0}
          max={10_000_000}
          step={1}
          value={numericOrUndefined(rule.thresholdAmount)}
          disabled={disabled}
          onChange={(thresholdAmount) => {
            if (typeof thresholdAmount === 'number') {
              onUpdateRule({ type: rule.type, thresholdAmount });
            }
          }}
        />
        <Input className="number-affix number-suffix" size="small" value="余额" readOnly tabIndex={-1} />
      </Space.Compact>
    );
  }

  if (rule.type === 'LATENCY_HIGH') {
    return (
      <Space.Compact className="alert-number">
        <InputNumber
          className="compact-number-input"
          size="small"
          min={0.1}
          max={120}
          step={0.5}
          value={rule.thresholdMs === null || rule.thresholdMs === undefined ? undefined : msToSeconds(rule.thresholdMs)}
          disabled={disabled}
          onChange={(seconds) => {
            if (typeof seconds === 'number') {
              onUpdateRule({ type: rule.type, thresholdMs: secondsToMs(seconds) });
            }
          }}
        />
        <Input className="number-affix number-suffix" size="small" value="秒" readOnly tabIndex={-1} />
      </Space.Compact>
    );
  }

  if (rule.type === 'LATENCY_DISABLED' || rule.type === 'SYNC_ERROR' || rule.type === 'CREDENTIAL_EXPIRED') {
    return (
      <Space.Compact className="alert-number">
        <InputNumber
          className="compact-number-input"
          size="small"
          min={1}
          max={100}
          value={rule.failureLimit ?? undefined}
          disabled={disabled}
          onChange={(failureLimit) => {
            if (typeof failureLimit === 'number') {
              onUpdateRule({ type: rule.type, failureLimit });
            }
          }}
        />
        <Input className="number-affix number-suffix" size="small" value="次" readOnly tabIndex={-1} />
      </Space.Compact>
    );
  }

  return <Text type="secondary">无阈值</Text>;
}

function ModalTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="modal-title">
      <Text strong>{title}</Text>
      <Text type="secondary">{description}</Text>
    </div>
  );
}

function FormSection({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="form-section">
      <div className="form-section-title">
        <Text strong>{title}</Text>
        <br />
        <Text type="secondary">{description}</Text>
      </div>
      {children}
    </section>
  );
}

function CredentialGroupSummary({ group }: { group: CredentialGroup }) {
  const visibleChannels = group.channels.slice(0, 6);
  const hiddenCount = group.channels.length - visibleChannels.length;

  return (
    <div className="credential-group-panel">
      <div className="credential-group-head">
        <div>
          <Text type="secondary">平台分组</Text>
          <Title level={5}>
            <GroupWebsiteLink group={group} />
          </Title>
        </div>
        <Space size={6} wrap>
          {group.providerTypes.map((type) => (
            <ProviderTag key={type} type={type} />
          ))}
          <Tag>{group.channels.length} 个渠道</Tag>
          <Tag color="green">使用中 {group.enabledCount}</Tag>
          <GroupCredentialTag configured={group.configuredCount} total={group.channels.length} />
        </Space>
      </div>
      <div className="credential-channel-list">
        {visibleChannels.map((channel) => (
          <span key={channel.id} className="credential-channel-chip">
            <Text strong>{channelKeyLabel(channel)}</Text>
            <Text type="secondary">{channel.enabled ? '使用中' : '已禁用'}</Text>
          </span>
        ))}
        {hiddenCount > 0 ? <span className="credential-channel-chip">+{hiddenCount}</span> : null}
      </div>
    </div>
  );
}

function CredentialTestPanel({ result }: { result: CredentialTestResult | null }) {
  if (!result) {
    return null;
  }

  const tone: StatusTone = result.status === 'ok' ? 'ok' : result.status === 'error' ? 'error' : 'warn';
  const balance = result.balance === undefined ? '-' : formatAmount(result.balance);
  const groupRatio = result.groupRatio === null || result.groupRatio === undefined ? '-' : formatGroupRatio(result.groupRatio);
  const rechargeRatio =
    result.suggestedRechargeRatio === null || result.suggestedRechargeRatio === undefined
      ? '无法自动获取'
      : `1:${formatRatio(result.suggestedRechargeRatio)}`;

  return (
    <div className="credential-test-panel">
      <div className="credential-test-head">
        <StatusTag tone={tone}>{result.status === 'ok' ? '测试通过' : result.status === 'error' ? '测试失败' : '部分可读'}</StatusTag>
        <Text type="secondary">{result.message}</Text>
      </div>
      <div className="credential-test-grid">
        <span>
          <Text type="secondary">余额</Text>
          <Text strong>{balance}</Text>
        </span>
        <span>
          <Text type="secondary">倍率分组</Text>
          <Text strong>{groupRatio}</Text>
        </span>
        <span>
          <Text type="secondary">充值倍率</Text>
          <Text strong>{rechargeRatio}</Text>
        </span>
        <span>
          <Text type="secondary">来源</Text>
          <Text strong>{result.rateSource ?? '-'}</Text>
        </span>
      </div>
    </div>
  );
}

function UpstreamGroupsPanel({
  groups,
  loading,
  onFetch,
  onAddChannel,
  actionLabel = '建渠道'
}: {
  groups: UpstreamGroupInfo[];
  loading: boolean;
  onFetch: () => void;
  onAddChannel: (group: UpstreamGroupInfo) => void;
  actionLabel?: string;
}) {
  const columns: ColumnsType<UpstreamGroupInfo> = [
    {
      title: '分组',
      dataIndex: 'name',
      width: 150,
      render: (value) => <Text strong>{value}</Text>
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 180,
      render: (value) => <Text type={value ? undefined : 'secondary'}>{value || '-'}</Text>
    },
    {
      title: '倍率',
      dataIndex: 'ratio',
      width: 90,
      render: (value) => <Text>{value === null || value === undefined ? '-' : formatGroupRatio(value)}</Text>
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 90,
      render: (value) => <Text type="secondary">{value}</Text>
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_, record) => (
        <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => onAddChannel(record)}>
          {actionLabel}
        </Button>
      )
    }
  ];

  return (
    <div className="upstream-groups-panel">
      <div className="upstream-groups-head">
        <div>
          <Text strong>上游分组</Text>
          <Text type="secondary">读取上游全部分组，按分组快速新增一个渠道。</Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onFetch}>
          读取分组
        </Button>
      </div>
      {groups.length > 0 ? (
        <Table
          rowKey={(record) => record.id ?? record.name}
          columns={columns}
          dataSource={groups}
          pagination={false}
          size="small"
          scroll={{ x: 620 }}
        />
      ) : (
        <div className="upstream-groups-empty">
          <Text type="secondary">还没有读取分组。</Text>
        </div>
      )}
    </div>
  );
}

function AuthHint({ type, auth, prefix, suffix }: { type?: ChannelFormUpstreamType; auth?: string; prefix?: string; suffix?: string }) {
  let text = '先输入上游地址识别类型；识别不出来时手动选择 NewAPI、Sub2API 或 CPA 号池。';

  if (type === 'newapi') {
    text = '用户 Token 或管理 Token 可读取余额和倍率；普通 API Key 通常只能做受限监控。';
  }

  if (type === 'sub2api') {
    if (auth === '用户登录') {
      text = 'Sub2API 用户登录需要账号/邮箱 + 密码，才能读取余额、Key 用量和倍率。';
    } else if (auth === '用户 Token') {
      text = 'Sub2API 用户 Token 可读取余额、Key 用量和倍率。';
    } else {
      text = 'Sub2API 只支持用户登录或用户 Token，默认使用用户登录。';
    }
  }

  if (type === 'cli_proxy') {
    text = 'CPA 是号池模式，不读取余额和倍率，也不会写入 MySQL 的上游监控表。';
  }

  return (
    <div className="auth-hint">
      <Text type="secondary">{[prefix, text, suffix].filter(Boolean).join(' ')}</Text>
    </div>
  );
}

function RunbookItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Space align="start">
      <Avatar shape="square" size={32} icon={icon} className="runbook-avatar" />
      <div>
        <Text strong>{title}</Text>
        <Paragraph type="secondary" className="runbook-copy">
          {children}
        </Paragraph>
      </div>
    </Space>
  );
}

function UpstreamEndpoint({ channel }: { channel: ChannelView }) {
  const href = normalizedExternalUrl(channel.upstreamBaseUrl);
  const label = displayEndpoint(channel.upstreamBaseUrl);

  if (!href) {
    return <Text strong>{label}</Text>;
  }

  return (
    <Tooltip title="点击打开上游官网">
      <a className="upstream-link" href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    </Tooltip>
  );
}

function displayEndpoint(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value || '-';
  }
}

function ProviderTag({ type }: { type: UpstreamProvider }) {
  const config = {
    newapi: { color: 'green', label: 'NewAPI' },
    sub2api: { color: 'blue', label: 'Sub2API' },
    cli_proxy: { color: 'default', label: 'CPA 号池' }
  }[type];

  return <Tag color={config.color}>{config.label}</Tag>;
}

function RelayTypeTag() {
  return <Tag color="green">NewAPI 主站</Tag>;
}

function StatusTag({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const color = tone === 'ok' ? 'green' : tone === 'warn' ? 'gold' : tone === 'error' ? 'red' : 'blue';
  return <Tag color={color}>{children}</Tag>;
}

function UsagePercent({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return <Text type="secondary">-</Text>;
  }

  const percent = Math.max(0, Math.min(100, Number(value)));

  return (
    <Flex vertical gap={4} className="usage-percent">
      <Progress
        percent={percent}
        size="small"
        showInfo={false}
        strokeColor={percent >= 90 ? '#d92d20' : percent >= 70 ? '#d97706' : '#0f766e'}
      />
      <Text>{formatPercent(percent)}</Text>
    </Flex>
  );
}

function cpaAccountStatusTone(value: string): StatusTone {
  const normalized = value.trim().toLowerCase();

  if (/正常|可用|ready|ok|active|healthy|success/.test(normalized)) {
    return 'ok';
  }
  if (/刷新|等待|pending|loading|refresh|wait/.test(normalized)) {
    return 'warn';
  }
  if (/异常|错误|失败|error|failed|fail|invalid|expired/.test(normalized)) {
    return 'error';
  }

  return 'limited';
}

function CfTag({ value }: { value: string }) {
  const color = value === 'Challenge' ? 'blue' : value === '无防护' ? 'green' : value === '待检测' ? 'default' : 'gold';
  return <Tag color={color}>{value}</Tag>;
}

function CredentialTag({ mode }: { mode: CredentialMode }) {
  if (mode === 'server') {
    return <Tag color="green">服务端</Tag>;
  }

  return <Tag>未配置</Tag>;
}

function GroupCredentialTag({ configured, total }: { configured: number; total: number }) {
  if (configured === 0) {
    return <Tag>未配置</Tag>;
  }

  if (configured === total) {
    return <Tag color="green">已配置</Tag>;
  }

  return <Tag color="gold">部分配置 {configured}/{total}</Tag>;
}

function ChannelEnabledTag({ channel }: { channel: ChannelView }) {
  if (channel.disabledByLatency) {
    return <Tag color="red">系统禁用</Tag>;
  }

  return <Tag color={channel.enabled ? 'green' : 'default'}>{channel.enabled ? '使用中' : '已禁用'}</Tag>;
}

function BalanceValue({ channel }: { channel: ChannelView }) {
  if (channel.upstreamType === 'cli_proxy') {
    return <Text type="secondary">不适用</Text>;
  }

  const parsed = parseNumericText(channel.balance);
  if (parsed !== null) {
    const normalized = normalizeByRechargeRatio(parsed, channel.rechargeRatio);
    const title =
      safeRechargeRatio(channel.rechargeRatio) === 1
        ? undefined
        : `原始 ${channel.balance}，按 1:${formatRatio(channel.rechargeRatio)} 折算`;

    return <Text title={title}>{formatAmount(normalized)}</Text>;
  }

  return (
    <Tooltip title={balanceHint(channel)}>
      <Text type={channel.balance === '不可见' ? 'secondary' : undefined}>{channel.balance}</Text>
    </Tooltip>
  );
}

function RechargeRatioValue({ value, ignored }: { value: number; ignored?: boolean }) {
  if (ignored) {
    return <Text type="secondary">不适用</Text>;
  }

  return <Text>1:{formatRatio(value)}</Text>;
}

function RateValue({
  value,
  ratio,
  muted,
  ignored
}: {
  value: number | null;
  ratio?: number;
  muted?: boolean;
  ignored?: boolean;
}) {
  if (ignored) {
    return <Text type="secondary">不适用</Text>;
  }

  if (value === null) {
    return <Text type="secondary">-</Text>;
  }

  const normalized = normalizeByRechargeRatio(value, ratio);
  const title = safeRechargeRatio(ratio) === 1 ? undefined : `原始 ${formatRateNumber(value)}x，按 1:${formatRatio(ratio)} 折算`;

  return (
    <Text type={muted ? 'secondary' : undefined} title={title}>
      {formatRateNumber(normalized)}x
    </Text>
  );
}

function RateChange({
  current,
  previous,
  ratio,
  ignored
}: {
  current: number | null;
  previous: number | null;
  ratio?: number;
  ignored?: boolean;
}) {
  if (ignored) {
    return <Text type="secondary">不适用</Text>;
  }

  if (current === null || previous === null || previous === 0) {
    return <Text type="secondary">待同步</Text>;
  }

  const normalizedCurrent = normalizeByRechargeRatio(current, ratio);
  const normalizedPrevious = normalizeByRechargeRatio(previous, ratio);
  const change = ((normalizedCurrent - normalizedPrevious) / normalizedPrevious) * 100;

  if (change > 0) {
    return <Text type="danger">+{change.toFixed(1)}%</Text>;
  }

  if (change < 0) {
    return <Text type="success">{change.toFixed(1)}%</Text>;
  }

  return <Text type="secondary">0.0%</Text>;
}

function badgeStatus(tone: StatusTone) {
  if (tone === 'ok') {
    return 'success';
  }

  if (tone === 'warn') {
    return 'warning';
  }

  if (tone === 'error') {
    return 'error';
  }

  return 'processing';
}

function groupChannelsByPlatform(channels: ChannelView[]): ChannelGroup[] {
  const groups = new Map<string, ChannelGroup>();

  for (const channel of sortChannelsById(channels)) {
    const name = channelPlatformGroup(channel);
    const key = name.toLowerCase();
    const group = groups.get(key);

    if (group) {
      group.channels.push(channel);
    } else {
      groups.set(key, { key, name, channels: [channel] });
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    channels: sortChannelsById(group.channels)
  }));
}

function buildCredentialGroups(channels: ChannelView[]): CredentialGroup[] {
  const groups = new Map<string, ChannelGroup>();

  for (const channel of sortChannelsById(channels.filter((item) => item.upstreamType !== 'cli_proxy'))) {
    const name = channelPlatformGroup(channel);
    const key = `${name.toLowerCase()}::${channel.upstreamType}`;
    const group = groups.get(key);

    if (group) {
      group.channels.push(channel);
    } else {
      groups.set(key, { key, name, channels: [channel] });
    }
  }

  return [...groups.values()].map((group) => {
    const sortedChannels = sortChannelsById(group.channels);

    return {
      ...group,
      channels: sortedChannels,
      primary: sortedChannels[0],
      configuredCount: sortedChannels.filter((channel) => channel.credentialConfigured).length,
      enabledCount: sortedChannels.filter((channel) => channel.enabled).length,
      authLabels: uniqueValues(sortedChannels.map((channel) => channel.auth)),
      providerTypes: uniqueValues(sortedChannels.map((channel) => channel.upstreamType)),
      latestSync: groupSyncLabel(sortedChannels)
    };
  });
}

function uniqueValues<T>(values: T[]) {
  return [...new Set(values)];
}

function buildMainStationGroupOptions(
  channels: ChannelView[],
  mainStationGroups: MainStationGroupInfo[],
  editingChannel?: ChannelView | null
): AutocompleteOption[] {
  const values = new Set<string>(['default']);
  const optionMeta = new Map<string, string>();

  for (const group of mainStationGroups) {
    const name = group.name.trim();
    if (!name) {
      continue;
    }

    values.add(name);
    optionMeta.set(
      name.toLowerCase(),
      group.ratio === null || group.ratio === undefined ? group.source : `倍率 ${formatGroupRatio(group.ratio)} / ${group.source}`
    );
  }

  if (editingChannel) {
    addGroupCandidates(values, editingChannel.mainStationGroup);
  }

  for (const channel of channels) {
    addGroupCandidates(values, channel.mainStationGroup);
  }

  return [...values].filter(Boolean).sort(compareText).map((value) => ({
    value,
    label: optionMeta.has(value.toLowerCase()) ? `${value}（${optionMeta.get(value.toLowerCase())}）` : value,
    searchText: `${value} ${optionMeta.get(value.toLowerCase()) ?? ''}`
  }));
}

function buildMainStationGroupFilterOptions(
  channels: ChannelView[],
  mainStationGroups: MainStationGroupInfo[]
) {
  const values = new Set<string>();

  for (const group of mainStationGroups) {
    addGroupCandidates(values, group.name);
  }
  for (const channel of channels) {
    addGroupCandidates(values, mainStationGroupLabel(channel));
  }

  return [
    { label: '全部主站分组', value: MAIN_STATION_GROUP_ALL },
    ...[...values].filter(Boolean).sort(compareText).map((value) => ({
      label: value === '-' ? '未分组' : value,
      value
    }))
  ];
}

function mergeMainStationGroupState(current: MainStationGroupInfo[], group: MainStationGroupInfo) {
  const next = new Map(current.map((item) => [item.name.trim().toLowerCase(), item]));
  next.set(group.name.trim().toLowerCase(), group);

  return [...next.values()].sort((left, right) => compareText(left.name, right.name));
}

function buildUpstreamGroupOptions(
  upstreamGroups: UpstreamGroupInfo[],
  channels: ChannelView[],
  context: { upstreamName?: string; upstreamType?: ChannelFormUpstreamType; editingChannel?: ChannelView | null }
): AutocompleteOption[] {
  const options = new Map<string, AutocompleteOption>();

  addAutocompleteOption(options, 'default');

  for (const group of upstreamGroups) {
    const name = group.name.trim();
    if (!name) {
      continue;
    }

    const meta = [
      group.id && group.id !== name ? `ID ${group.id}` : undefined,
      group.remark?.trim(),
      group.ratio === null || group.ratio === undefined ? undefined : `倍率 ${formatGroupRatio(group.ratio)}`,
      group.source
    ].filter(Boolean);
    addAutocompleteOption(options, name, {
      label: meta.length > 0 ? `${name}（${meta.join(' / ')}）` : name,
      searchText: `${name} ${meta.join(' ')}`
    });
  }

  const targetName = context.upstreamName?.trim().toLowerCase();
  const targetType = isKnownUpstreamType(context.upstreamType) ? context.upstreamType : undefined;

  if (context.editingChannel) {
    addAutocompleteOption(options, context.editingChannel.group);
  }

  for (const channel of channels) {
    if (targetType && channel.upstreamType !== targetType) {
      continue;
    }
    if (targetName && channelPlatformGroup(channel).trim().toLowerCase() !== targetName) {
      continue;
    }

    addAutocompleteOption(options, channel.group);
  }

  return [...options.values()].sort((left, right) => {
    if (left.value === 'default') {
      return -1;
    }
    if (right.value === 'default') {
      return 1;
    }

    return compareText(left.value, right.value);
  });
}

function reconcileChannelGroupField(groups: UpstreamGroupInfo[], form: FormInstance<ChannelForm>) {
  const current = form.getFieldValue('group');
  const canonical = canonicalUpstreamGroupName(current, groups);

  if (canonical !== String(current ?? '').trim()) {
    form.setFieldValue('group', canonical);
  }
}

function canonicalUpstreamGroupName(value: unknown, groups: UpstreamGroupInfo[]) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return 'default';
  }

  const matched = groups.find((group) => {
    const name = group.name.trim().toLowerCase();
    const id = String(group.id ?? '').trim().toLowerCase();
    const target = raw.toLowerCase();

    return name === target || Boolean(id && id === target);
  });

  return matched?.name.trim() || raw;
}

function addGroupCandidates(values: Set<string>, rawValue?: string | null) {
  const value = rawValue?.trim();

  if (!value || value === '-') {
    return;
  }

  values.add(value);
  for (const part of value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)) {
    values.add(part);
  }
}

function addAutocompleteOption(
  options: Map<string, AutocompleteOption>,
  rawValue?: string | null,
  overrides: Partial<Pick<AutocompleteOption, 'label' | 'searchText'>> = {}
) {
  const value = rawValue?.trim();

  if (!value || value === '-') {
    return;
  }

  const key = value.toLowerCase();
  if (options.has(key)) {
    return;
  }

  options.set(key, {
    value,
    label: overrides.label ?? value,
    searchText: overrides.searchText ?? value
  });
}

function autocompleteFilterOption(inputValue: string, option?: DefaultOptionType) {
  const input = inputValue.trim().toLowerCase();

  if (!input) {
    return true;
  }

  const searchText = String((option as AutocompleteOption | undefined)?.searchText ?? option?.value ?? '').toLowerCase();
  return searchText.includes(input);
}

function compareText(left: string, right: string) {
  return channelIdCollator.compare(left, right);
}

function groupSyncLabel(channels: ChannelView[]) {
  const syncLabels = uniqueValues(channels.map((channel) => channel.sync));

  if (syncLabels.length === 0) {
    return '尚未同步';
  }

  return syncLabels.length === 1 ? syncLabels[0] : '多渠道';
}

function channelPlatformGroup(channel: ChannelView) {
  const upstreamName = channel.upstreamName?.trim();
  const name = channel.name?.trim();
  const inferred = inferPlatformGroupName(name);

  if (upstreamName && upstreamName !== name) {
    return upstreamName;
  }

  return inferred || upstreamName || '未分组';
}

function inferPlatformGroupName(name?: string) {
  const normalized = name?.trim();
  const split = normalized ? splitByNameSuffix(normalized) : null;

  if (!split) {
    return normalized;
  }

  return split.prefix;
}

function channelKeyLabel(channel: ChannelView) {
  return channel.keyName?.trim() || inferKeyName(channel.name) || channel.name;
}

function channelKeyDisplay(channel: ChannelView) {
  if (channel.upstreamType === 'cli_proxy') {
    return '号池模式';
  }

  const configuredKeyName = channel.keyName?.trim();
  const inferredKeyName = inferKeyName(channel.name);

  if (configuredKeyName) {
    return `上游 Key：${configuredKeyName}`;
  }

  if (inferredKeyName) {
    return `名称后缀：${inferredKeyName}`;
  }

  return '名称后缀：未拆分';
}

function inferKeyName(name?: string) {
  const normalized = name?.trim();

  return normalized ? splitByNameSuffix(normalized)?.suffix : undefined;
}

function splitByNameSuffix(value: string) {
  const index = value.search(/[-_]/);

  if (index < 1) {
    return null;
  }

  const prefix = value.slice(0, index).trim();
  const suffix = value.slice(index + 1).trim();

  return prefix && suffix ? { prefix, suffix } : null;
}

function rateGroupLabel(channel: ChannelView) {
  if (channel.upstreamType === 'cli_proxy') {
    return '不适用';
  }

  const group = channel.group?.trim();
  const mainStationGroup = channel.mainStationGroup?.trim();

  if (!group || group === 'default' || group === mainStationGroup) {
    return '未识别';
  }

  return group;
}

function mainStationGroupLabel(channel: ChannelView) {
  if (channel.upstreamType === 'cli_proxy') {
    return '不适用';
  }

  return channel.mainStationGroup?.trim() || '-';
}

function sortChannelsById(channels: ChannelView[]) {
  return [...channels].sort((left, right) => compareChannelId(left.id, right.id));
}

function compareChannelId(left: string, right: string) {
  return channelIdCollator.compare(left, right);
}

function buildRateRows(channels: ChannelView[], relays: RelayView[]): RateRow[] {
  return channels.filter((channel) => channel.upstreamType !== 'cli_proxy').map((channel) => {
    const relay = relays.find((item) => item.id === channel.relayId);
    const direction = rateDirection(channel.currentRate, channel.previousRate, channel.rechargeRatio);

    return {
      key: channel.id,
      relayName: relay?.name ?? 'NewAPI 主站',
      channelName: channel.name,
      upstreamName: channel.upstreamName,
      upstreamType: channel.upstreamType,
      keyName: channel.keyName?.trim() || channel.name,
      group: rateGroupLabel(channel),
      input: channel.groupRatio === null ? '上游分组倍率待同步' : `上游分组倍率 ${formatGroupRatio(channel.groupRatio)}`,
      output: channel.rateSource || '待同步',
      currentRate: channel.currentRate,
      previousRate: channel.previousRate,
      direction
    };
  });
}

function groupRateRowsByUpstream(rows: RateRow[]): RateGroup[] {
  const groups = new Map<string, RateGroup>();

  for (const row of rows) {
    const name = row.upstreamName?.trim() || '未分组';
    const key = `${name.toLowerCase()}::${row.upstreamType}`;
    const group = groups.get(key);

    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, {
        key,
        name,
        upstreamType: row.upstreamType,
        rows: [row]
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      rows: group.rows.sort((left, right) => compareChannelId(left.key, right.key))
    }))
    .sort((left, right) => channelIdCollator.compare(left.name, right.name));
}

function rechargeRatioForRate(channelId: string, channels: ChannelView[]) {
  return channels.find((channel) => channel.id === channelId)?.rechargeRatio ?? 1;
}

function normalizeByRechargeRatio(value: number, ratio: number | undefined) {
  return value / safeRechargeRatio(ratio);
}

function safeRechargeRatio(value: number | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.01 ? Math.round(parsed * 100) / 100 : 1;
}

function normalizeSuggestedRechargeRatio(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.01 ? Math.round(parsed * 100) / 100 : null;
}

function formatRatio(value: number | undefined) {
  return safeRechargeRatio(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatGroupRatio(value: number | null) {
  if (value === null) {
    return '待同步';
  }

  return `${formatRateNumber(value)}x`;
}

function formatRateNumber(value: number) {
  if (Math.abs(value) >= 100) {
    return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function parseNumericText(value: string) {
  const normalized = value.replace(/,/g, '').trim().match(/^-?\d+(\.\d+)?/)?.[0] ?? '';
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAmount(value: number) {
  return value.toFixed(2);
}

function numericOrUndefined(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeNotificationMethods(value: AlertRuleView['notificationMethods']): AlertNotificationMethod[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const allowed = new Set(notificationMethodOptions.map((option) => option.value));
  const normalized: AlertNotificationMethod[] = [];

  for (const rawValue of rawValues) {
    const method = String(rawValue).trim().toLowerCase() as AlertNotificationMethod;
    if (!allowed.has(method) || normalized.includes(method)) {
      continue;
    }

    normalized.push(method);
  }

  return normalized;
}

function alertRuleTypeLabel(type: AlertRuleType) {
  return {
    RATE_INCREASE: '倍率上涨',
    RATE_DECREASE: '倍率下降',
    BALANCE_LOW: '余额',
    LATENCY_HIGH: '延迟',
    LATENCY_DISABLED: '系统禁用',
    SYNC_ERROR: '同步',
    CHALLENGE_REQUIRED: '上游防护',
    CREDENTIAL_EXPIRED: '认证'
  }[type];
}

function alertRuleDescription(type: AlertRuleType) {
  return {
    RATE_INCREASE: '当前倍率相比上次快照超过阈值时记录事件。',
    RATE_DECREASE: '倍率下降通常是成本改善，默认关闭，需要时再打开。',
    BALANCE_LOW: '余额低于阈值时提醒补充上游账号余额。',
    LATENCY_HIGH: '延迟超过阈值但尚未禁用时提醒。',
    LATENCY_DISABLED: '延迟失败或超阈值导致系统禁用时提醒。',
    SYNC_ERROR: '主站或渠道同步失败时提醒。',
    CHALLENGE_REQUIRED: '上游返回 CF、验证码或 Challenge 时提醒。',
    CREDENTIAL_EXPIRED: 'Token、账号密码失效或权限不足时提醒。'
  }[type];
}

function severityTone(severity: AlertSeverity): StatusTone {
  if (severity === 'CRITICAL') {
    return 'error';
  }

  if (severity === 'WARNING') {
    return 'warn';
  }

  return 'limited';
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp));
}

function formatOptionalTime(value?: string | null) {
  return value ? formatDateTime(value) : '-';
}

function formatInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed).toLocaleString('zh-CN') : '-';
}

function formatPercent(value: number) {
  return `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function msToSeconds(value: number) {
  return Number((value / 1000).toFixed(2));
}

function secondsToMs(value: number) {
  return Math.round(value * 1000);
}

function formatLatencySeconds(value: number) {
  const seconds = value / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : Number(seconds.toFixed(2))}秒`;
}

function rateDirection(current: number | null, previous: number | null, ratio?: number): RateRow['direction'] {
  if (current === null || previous === null || previous === 0) {
    return 'limited';
  }

  const normalizedCurrent = normalizeByRechargeRatio(current, ratio);
  const normalizedPrevious = normalizeByRechargeRatio(previous, ratio);

  if (normalizedCurrent > normalizedPrevious) {
    return 'up';
  }

  if (normalizedCurrent < normalizedPrevious) {
    return 'down';
  }

  return 'stable';
}

function filterRateRows(rows: RateRow[], filter: RateFilter) {
  if (filter === 'changed') {
    return rows.filter((row) => row.direction === 'up' || row.direction === 'down');
  }

  if (filter === 'limited') {
    return rows.filter((row) => row.direction === 'limited');
  }

  return rows;
}

function isKnownUpstreamType(value: unknown): value is UpstreamProvider {
  return value === 'newapi' || value === 'sub2api' || value === 'cli_proxy';
}

function upstreamProviderLabel(type: UpstreamProvider) {
  if (type === 'newapi') {
    return 'NewAPI';
  }

  if (type === 'sub2api') {
    return 'Sub2API';
  }

  return 'CPA（号池）';
}

function authOptions(type?: ChannelFormUpstreamType): Array<{ label: string; value: string }> {
  if (type === 'sub2api') {
    return [
      { label: '用户登录（账号/邮箱 + 密码）', value: '用户登录' },
      { label: '用户 Token', value: '用户 Token' }
    ];
  }

  if (type === 'cli_proxy') {
    return [
      { label: '无鉴权', value: '无鉴权' },
      { label: 'API Key', value: 'API Key' },
      { label: 'Bearer Token', value: 'Bearer Token' }
    ];
  }

  if (type === 'newapi') {
    return [
      { label: '用户 Access Token', value: '用户 Access Token' },
      { label: '管理 Token', value: '管理 Token' },
      { label: 'API Key', value: 'API Key' }
    ];
  }

  return [];
}

function defaultAuth(type: UpstreamProvider) {
  if (type === 'sub2api') {
    return '用户登录';
  }

  if (type === 'cli_proxy') {
    return '无鉴权';
  }

  return '用户 Access Token';
}

function normalizeAuthForType(type?: UpstreamProvider, auth?: string) {
  if (!type) {
    return auth;
  }

  const options = authOptions(type).map((option) => option.value);

  return auth && options.includes(auth) ? auth : defaultAuth(type);
}

function credentialFieldLabel(type?: UpstreamProvider, auth?: string) {
  if (type === 'newapi') {
    if (auth === '管理 Token') {
      return '管理 Token';
    }
    if (auth === 'API Key') {
      return 'API Key';
    }
    return '用户 Access Token';
  }

  if (type === 'sub2api') {
    return '用户 Token';
  }

  if (auth === 'Bearer Token') {
    return 'Bearer Token';
  }

  return '上游认证信息';
}

function credentialPlaceholder(type?: UpstreamProvider, auth?: string) {
  if (type === 'sub2api') {
    return '请输入用户 Token';
  }

  if (type === 'newapi' && auth === '管理 Token') {
    return 'sk-...';
  }

  return '请输入认证信息';
}

function credentialInputExtra(editing: boolean) {
  return editing
    ? '留空表示不修改；填写后会同步到同平台分组的全部渠道。'
    : '服务端 AES-GCM 加密保存；同平台分组共用，不在页面回显。';
}

function displayChannelStatusLabel(status: string) {
  if (status === '待配置凭据' || status === '待配置认证信息') {
    return '待配置认证信息';
  }

  return status;
}

function monitorDetailLabel(channel: ChannelView) {
  if (channel.upstreamType === 'cli_proxy') {
    return '不做余额/倍率巡检';
  }

  const latencyDetail = latencyInspectionLabel(channel);
  if (latencyDetail) {
    return latencyDetail;
  }

  const value = channel.rateSource || '待同步';

  if (value === '待同步') {
    return '倍率：待同步';
  }
  if (value === '待配置认证信息') {
    return '认证：待配置';
  }
  if (value === '不适用') {
    return '倍率：不适用';
  }
  if (value.startsWith('/')) {
    return `来源：${value}`;
  }

  return value;
}

function latencyInspectionLabel(channel: ChannelView) {
  if (channel.upstreamType === 'cli_proxy') {
    return null;
  }

  const parts: string[] = [];

  if (channel.disabledByLatency) {
    parts.push('延迟禁用');
  }
  if (channel.skipLatencyDisable) {
    parts.push('跳过禁用');
  }
  if (typeof channel.latencyMs === 'number') {
    parts.push(`延迟 ${formatLatencySeconds(channel.latencyMs)}`);
  }
  if ((channel.latencyFailureCount ?? 0) > 0) {
    parts.push(`失败 ${channel.latencyFailureCount}`);
  }

  if (parts.length > 0) {
    return parts.join(' / ');
  }

  if (channel.latencyCheckedAt) {
    return `延迟正常 / ${formatDateTime(channel.latencyCheckedAt)}`;
  }

  return null;
}

function canReadRateAndBalance(channel: ChannelView) {
  return (
    channel.upstreamType !== 'cli_proxy' &&
    channel.credentialConfigured &&
    channel.auth !== 'API Key' &&
    channel.statusTone !== 'limited'
  );
}

function balanceHint(channel: ChannelView) {
  if (channel.balance === '待同步') {
    return '已配置可读取余额的认证信息，点击同步后读取余额。';
  }

  if (channel.status === '待配置凭据' || channel.status === '待配置认证信息') {
    return '需要在渠道配置里填写对应认证信息。';
  }

  if (channel.auth === 'API Key') {
    if (channel.upstreamType === 'sub2api') {
      return 'Sub2API 已不使用 API Key 认证，请改为用户登录或用户 Token。';
    }

    return channel.upstreamType === 'newapi'
      ? 'NewAPI 的 sk-模型调用 Key 通常不能读取账号余额；请改用用户 Access Token 并填写上游用户 ID。'
      : 'API Key 只能转发调用，不能读取账号余额。';
  }

  if (channel.status === '余额读取失败') {
    return channel.rateSource || '访问令牌或上游用户 ID 校验失败。';
  }

  if (channel.status === '余额不可见') {
    return channel.upstreamType === 'newapi'
      ? '已读到倍率，但 /api/user/self 没返回余额。请确认填写的是 NewAPI 用户 Access Token 和上游用户 ID。'
      : '已读到倍率，但 /api/v1/auth/me 没返回余额。请确认填写的是 Sub2API 用户 JWT。';
  }

  return channel.rateSource || channel.status;
}

function normalizedExternalUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') {
    return null;
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    return new URL(candidate).href;
  } catch {
    return null;
  }
}

function credentialMode(channel: ChannelView): CredentialMode {
  if (channel.credentialConfigured) {
    return 'server';
  }

  return 'none';
}

function viewTitle(view: View) {
  return {
    overview: '运营总览',
    channels: '渠道管理',
    rates: '倍率快照',
    credentials: '平台凭证',
    cpaPool: '号池管理',
    alerts: '告警事件'
  }[view];
}

function viewDescription(view: View) {
  return {
    overview: '看主站状态、渠道健康和最近同步结果。',
    channels: '新增上游渠道，凭证在平台凭证里统一配置。',
    rates: '查看按渠道保存的倍率快照和变化。',
    credentials: '按平台分组管理 Token 或账号/密码凭证，同组渠道共用一套。',
    cpaPool: '查看 CPA 号池账号成功、失败和近期开销。',
    alerts: '查看同步失败、倍率变化和受限监控事件。'
  }[view];
}
