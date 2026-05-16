'use client';

import {
  AlertOutlined,
  ApiOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloudOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import {
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
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  theme
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { MenuProps } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

const { Header, Sider, Content } = Layout;
const { Text, Title, Paragraph } = Typography;

type View = 'overview' | 'relays' | 'channels' | 'rates' | 'credentials' | 'alerts';
type RelayType = 'newapi';
type UpstreamProvider = 'newapi' | 'sub2api' | 'cli_proxy';
type StatusTone = 'ok' | 'warn' | 'limited' | 'error';
type RateFilter = 'all' | 'changed' | 'limited';
type ProviderFilter = 'all' | UpstreamProvider;

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
  upstreamType: UpstreamProvider;
  upstreamName: string;
  upstreamBaseUrl: string;
  upstreamUserId?: string;
  keyName?: string;
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
  sync: string;
};

type RateRow = {
  key: string;
  relayName: string;
  channelName: string;
  upstreamName: string;
  upstreamType: UpstreamProvider;
  model: string;
  group: string;
  input: string;
  output: string;
  currentRate: number | null;
  previousRate: number | null;
  direction: 'up' | 'down' | 'limited' | 'stable';
};

type EventItem = {
  title: string;
  detail: string;
  time: string;
  status: 'error' | 'success' | 'warning';
};

type ChannelForm = {
  id?: string;
  relayId: string;
  name: string;
  group: string;
  upstreamType: UpstreamProvider;
  upstreamName: string;
  upstreamBaseUrl: string;
  upstreamUserId?: string;
  keyName?: string;
  auth: string;
  credential?: string;
  rechargeRatio: number;
  priority: number;
  weight: number;
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
    name: '主中转站',
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

export default function DashboardPage() {
  const [activeView, setActiveView] = useState<View>('overview');
  const [rateFilter, setRateFilter] = useState<RateFilter>('all');
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncingChannelId, setSyncingChannelId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [relayModalOpen, setRelayModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeRelayId, setActiveRelayId] = useState(initialRelays[0].id);
  const [relays, setRelays] = useState(initialRelays);
  const [channels, setChannels] = useState(initialChannels);
  const [events, setEvents] = useState(initialEvents);
  const [form] = Form.useForm<ChannelForm>();
  const [relayForm] = Form.useForm<RelayForm>();
  const [messageApi, contextHolder] = message.useMessage();

  const selectedRelay = useMemo(
    () => relays.find((relay) => relay.id === activeRelayId) ?? relays[0],
    [activeRelayId, relays]
  );
  const normalizedSearch = search.trim().toLowerCase();
  const activeChannels = channels.filter((channel) => !selectedRelay || channel.relayId === selectedRelay.id);

  const visibleChannels = useMemo(() => {
    return activeChannels.filter((channel) => {
      const matchesProvider = providerFilter === 'all' || channel.upstreamType === providerFilter;
      const matchesSearch =
        !normalizedSearch ||
        [
          channel.name,
          channel.group,
          channel.upstreamType,
          channel.upstreamName,
          channel.upstreamBaseUrl,
          channel.auth,
          channel.status
        ].some((value) => value.toLowerCase().includes(normalizedSearch));

      return matchesProvider && matchesSearch;
    });
  }, [activeChannels, normalizedSearch, providerFilter]);

  const rateRows = useMemo(() => buildRateRows(activeChannels, relays), [activeChannels, relays]);
  const visibleRates = useMemo(() => {
    return filterRateRows(rateRows, rateFilter).filter((row) => {
      if (!normalizedSearch) {
        return true;
      }

      return [row.relayName, row.channelName, row.upstreamName, row.upstreamType, row.model, row.group].some((value) =>
        value.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [normalizedSearch, rateFilter, rateRows]);

  const readableCount = activeChannels.filter((channel) => canReadRateAndBalance(channel)).length;
  const cliProxyCount = activeChannels.filter((channel) => channel.upstreamType === 'cli_proxy').length;
  const limitedCount = activeChannels.filter(
    (channel) => channel.upstreamType !== 'cli_proxy' && channel.statusTone === 'limited'
  ).length;
  const pendingSyncCount = activeChannels.filter(
    (channel) =>
      channel.upstreamType !== 'cli_proxy' && (channel.sync === '尚未同步' || channel.sync === '等待同步' || channel.status === '待同步')
  ).length;

  useEffect(() => {
    void loadDashboard();
  }, []);

  async function loadDashboard() {
    const [relayResponse, channelResponse, eventResponse] = await Promise.all([
      fetch('/api/relays', { cache: 'no-store' }),
      fetch('/api/channels', { cache: 'no-store' }),
      fetch('/api/events', { cache: 'no-store' })
    ]);

    const relayPayload = (await relayResponse.json()) as { relays: RelayView[] };
    const channelPayload = (await channelResponse.json()) as { channels: ChannelView[] };
    const eventPayload = (await eventResponse.json()) as { events: EventItem[] };

    setRelays(relayPayload.relays);
    setChannels(channelPayload.channels);
    setEvents(eventPayload.events);

    if (!relayPayload.relays.some((relay) => relay.id === activeRelayId) && relayPayload.relays[0]) {
      setActiveRelayId(relayPayload.relays[0].id);
    }
  }

  const menuItems: MenuProps['items'] = [
    { key: 'overview', icon: <DashboardOutlined />, label: '总览' },
    { key: 'relays', icon: <ApiOutlined />, label: '中转站' },
    { key: 'channels', icon: <CloudOutlined />, label: '渠道管理' },
    { key: 'rates', icon: <ThunderboltOutlined />, label: '倍率快照' },
    { key: 'credentials', icon: <KeyOutlined />, label: '凭据' },
    { key: 'alerts', icon: <BellOutlined />, label: '告警' }
  ];

  const relayColumns: ColumnsType<RelayView> = [
    {
      title: '中转站',
      dataIndex: 'name',
      width: 300,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <Badge status={badgeStatus(record.statusTone)} />
            <Text strong>{record.name}</Text>
            <RelayTypeTag />
          </Space>
          <Text type="secondary" className="truncate-text">
            {record.baseUrl}
          </Text>
        </Flex>
      )
    },
    {
      title: '管理凭据',
      dataIndex: 'auth',
      width: 140,
      render: (_, record) => (
        <Space size={6}>
          <Text>{record.auth}</Text>
          <Tag color={record.tokenConfigured ? 'green' : 'default'}>{record.tokenConfigured ? '已配置' : '未配置'}</Tag>
        </Space>
      )
    },
    {
      title: '余额',
      dataIndex: 'balance',
      width: 120
    },
    {
      title: '渠道数',
      dataIndex: 'channelCount',
      width: 100,
      align: 'right'
    },
    {
      title: '同步',
      dataIndex: 'sync',
      width: 120
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (_, record) => <StatusTag tone={record.statusTone}>{record.status}</StatusTag>
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_, record) => (
        <Button type="link" size="small" onClick={() => openRelayModal(record)}>
          配置
        </Button>
      )
    }
  ];

  const channelColumns: ColumnsType<ChannelView> = [
    {
      title: '渠道',
      dataIndex: 'name',
      width: 184,
      fixed: 'left',
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <Badge status={badgeStatus(record.statusTone)} />
            <Text strong>{record.name}</Text>
            <ProviderTag type={record.upstreamType} />
          </Space>
          <Text type="secondary">{record.sync}</Text>
        </Flex>
      )
    },
    {
      title: '上游 / Key',
      key: 'upstreamKey',
      width: 168,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <UpstreamLink channel={record} />
          <Text type="secondary" className="truncate-text">
            {record.keyName || record.auth}
          </Text>
        </Flex>
      )
    },
    {
      title: 'Key 分组',
      key: 'keyGroup',
      width: 148,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={6} wrap className="center-wrap">
            <Tag>{record.group}</Tag>
            <CredentialTag configured={record.credentialConfigured} />
          </Space>
          <Space size={6} className="center-wrap">
            <GroupRatioValue value={record.groupRatio} ignored={record.upstreamType === 'cli_proxy'} />
            <RechargeRatioValue value={record.rechargeRatio} ignored={record.upstreamType === 'cli_proxy'} />
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
      title: '调度',
      key: 'dispatch',
      width: 76,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Text>{record.priority}</Text>
          <Text type="secondary">权 {record.weight}</Text>
        </Flex>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 112,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <StatusTag tone={record.statusTone}>{record.status}</StatusTag>
          <Text type="secondary" className="table-subtle">
            {record.rateSource}
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
            disabled={record.upstreamType === 'cli_proxy'}
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
      title: '模型',
      dataIndex: 'model',
      width: 360,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Space size={8} wrap>
            <ProviderTag type={record.upstreamType} />
            <Text code>{record.model}</Text>
          </Space>
          <Text type="secondary">
            {record.channelName} / {record.group}
          </Text>
        </Flex>
      )
    },
    {
      title: '来源',
      key: 'source',
      width: 260,
      render: (_, record) => (
        <Flex vertical gap={4} className="cell-main">
          <Text>{record.upstreamName}</Text>
          <Text type="secondary">{record.relayName}</Text>
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
      const payload = (await response.json()) as { relays: RelayView[]; channels: ChannelView[]; events: EventItem[] };
      setRelays(payload.relays);
      setChannels(payload.channels);
      setEvents(payload.events);
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

  function openChannelModal(channel?: ChannelView) {
    setEditingChannelId(channel?.id ?? null);
    form.resetFields();
    form.setFieldsValue({
      id: channel?.id,
      relayId: channel?.relayId ?? selectedRelay?.id ?? activeRelayId,
      name: channel?.name,
      group: channel?.group ?? 'default',
      upstreamType: channel?.upstreamType ?? 'newapi',
      upstreamName: channel?.upstreamName,
      upstreamBaseUrl: channel?.upstreamBaseUrl,
      upstreamUserId: channel?.upstreamUserId ?? '',
      keyName: channel?.keyName ?? '',
      auth: channel?.auth ?? defaultAuth(channel?.upstreamType ?? 'newapi'),
      credential: undefined,
      rechargeRatio: channel?.rechargeRatio ?? 1,
      priority: channel?.priority ?? 50,
      weight: channel?.weight ?? 0
    });
    setModalOpen(true);
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
    const values = await relayForm.validateFields();
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

  async function saveChannel() {
    const values = await form.validateFields();
    const response = await fetch('/api/channels', {
      method: editingChannelId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...values, id: editingChannelId ?? values.id })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (payload.error === 'credential is required for this upstream auth mode') {
        form.setFields([{ name: 'credential', errors: ['请输入上游 Key / Token'] }]);
      }
      messageApi.error(payload.error ?? '渠道保存失败');
      return;
    }
    await loadDashboard();
    setModalOpen(false);
    setEditingChannelId(null);
    setActiveView('channels');
    form.resetFields();
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
              <Text type="secondary">当前先管理 NewAPI 中转站；渠道上游支持 NewAPI、Sub2API 和 CLI Proxy API。</Text>
            </Space>
          </Card>
        </Sider>

        <Layout className="app-main">
          <Header className="app-header">
            <div className="header-title">
              <Title level={3}>{viewTitle(activeView)}</Title>
            </div>
            <div className="header-actions">
              <Select
                aria-label="当前中转站"
                className="relay-select"
                value={selectedRelay?.id}
                options={relays.map((relay) => ({ label: relay.name, value: relay.id }))}
                onChange={(value) => setActiveRelayId(value)}
              />
              <Input
                prefix={<SearchOutlined />}
                placeholder="搜索渠道、上游、模型"
                className="search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                allowClear
              />
              <Button icon={<BellOutlined />} onClick={() => setActiveView('alerts')} />
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
                rateColumns={rateColumns}
                visibleRates={visibleRates}
                events={events}
                rateFilter={rateFilter}
                setRateFilter={setRateFilter}
              />
            ) : null}

            {activeView === 'relays' ? (
              <Card title="中转站">
                <Table rowKey="id" columns={relayColumns} dataSource={relays} pagination={false} size="middle" scroll={{ x: 860 }} />
              </Card>
            ) : null}

            {activeView === 'channels' ? (
              <Card
                title={`${selectedRelay?.name ?? 'NewAPI 中转站'} / 渠道管理`}
                extra={
                  <Segmented
                    value={providerFilter}
                    onChange={(value) => setProviderFilter(value as ProviderFilter)}
                    options={[
                      { label: '全部', value: 'all' },
                      { label: 'NewAPI 上游', value: 'newapi' },
                      { label: 'Sub2API 上游', value: 'sub2api' },
                      { label: 'CLI Proxy API', value: 'cli_proxy' }
                    ]}
                  />
                }
              >
                <Table
                  rowKey="id"
                  columns={channelColumns}
                  dataSource={visibleChannels}
                  pagination={{ pageSize: 6, showSizeChanger: false, hideOnSinglePage: true }}
                  size="middle"
                  scroll={{ x: 1026 }}
                  locale={{ emptyText: <Empty description="还没有渠道，先新增一个渠道上游" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                />
              </Card>
            ) : null}

            {activeView === 'rates' ? (
              <RatesCard
                columns={rateColumns}
                rows={visibleRates}
                rateFilter={rateFilter}
                setRateFilter={setRateFilter}
              />
            ) : null}

            {activeView === 'credentials' ? <CredentialsView /> : null}

            {activeView === 'alerts' ? <AlertsView events={events} /> : null}
          </Content>
        </Layout>
      </Layout>

      <Modal
        title={editingChannelId ? '配置渠道' : '新增渠道'}
        open={modalOpen}
        className="channel-modal"
        width={720}
        onCancel={() => {
          setModalOpen(false);
          setEditingChannelId(null);
          form.resetFields();
        }}
        onOk={saveChannel}
        okText={editingChannelId ? '保存' : '添加'}
        cancelText="取消"
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            group: 'default',
            upstreamType: 'newapi',
            auth: '用户 Access Token',
            rechargeRatio: 1,
            priority: 50,
            weight: 0
          }}
          onValuesChange={(changed) => {
            if ('upstreamType' in changed) {
              form.setFieldValue('auth', defaultAuth(changed.upstreamType));
              if (changed.upstreamType === 'cli_proxy') {
                form.setFieldValue('rechargeRatio', 1);
              }
            }
          }}
        >
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="relayId" label="所属中转站" rules={[{ required: true, message: '请选择中转站' }]}>
            <Select options={relays.map((relay) => ({ label: relay.name, value: relay.id }))} />
          </Form.Item>
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: '请输入渠道名称' }]}>
            <Input placeholder="例如 Claude 东京高价池" />
          </Form.Item>
          <Form.Item
            name="group"
            label="Key 所属分组"
            extra="同步倍率时按这个分组读取分组倍率；Sub2API 可填分组名或分组 ID。"
            rules={[{ required: true, message: '请输入 Key 所属分组' }]}
          >
            <Input placeholder="default" />
          </Form.Item>
          <Form.Item name="upstreamType" label="渠道上游类型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'NewAPI 上游', value: 'newapi' },
                { label: 'Sub2API 上游', value: 'sub2api' },
                { label: 'CLI Proxy API', value: 'cli_proxy' }
              ]}
            />
          </Form.Item>
          <Form.Item name="upstreamName" label="上游名称" rules={[{ required: true, message: '请输入上游名称' }]}>
            <Input placeholder="例如 Sub2API 东京池" />
          </Form.Item>
          <Form.Item name="upstreamBaseUrl" label="上游 Base URL" rules={[{ required: true, message: '请输入上游地址' }]}>
            <Input placeholder="https://relay.example.com" />
          </Form.Item>
          <Form.Item name="keyName" label="上游 Key 名称" extra="可选；Sub2API 用户 Token 模式会优先用它匹配具体 Key，再取该 Key 绑定的分组。">
            <Input placeholder="例如 claude-code-default" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType || prev.auth !== next.auth}>
            {({ getFieldValue }) =>
              getFieldValue('upstreamType') === 'newapi' && getFieldValue('auth') !== 'API Key' ? (
                <Form.Item
                  name="upstreamUserId"
                  label="上游用户 ID"
                  extra="NewAPI 安全设置访问令牌必须同时提供数字用户 ID；它会作为 New-Api-User header 发送，不是用户名。"
                  rules={[{ required: true, message: '请输入上游用户 ID' }]}
                >
                  <Input placeholder="例如 1" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="priority" label="优先级" rules={[{ required: true, message: '请输入优先级' }]}>
                <InputNumber precision={0} className="full-width" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="weight" label="权重" rules={[{ required: true, message: '请输入权重' }]}>
                <InputNumber precision={0} className="full-width" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
            {({ getFieldValue }) => (
              <Form.Item name="auth" label="上游认证方式" rules={[{ required: true }]}>
                <Select options={authOptions(getFieldValue('upstreamType')).map((value) => ({ label: value, value }))} />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType || prev.auth !== next.auth}>
            {({ getFieldValue }) => {
              const type = getFieldValue('upstreamType') as UpstreamProvider | undefined;
              const auth = getFieldValue('auth') as string | undefined;
              const required = editingChannelId === null && requiresCredential(type, auth);

              return (
                <Form.Item
                  name="credential"
                  label="上游 Key / Token"
                  extra={editingChannelId ? '留空表示不修改；未配置时不能读取余额和倍率。' : '用于读取该渠道上游的余额和倍率，不会在页面回显。'}
                  rules={[{ required, message: '请输入上游 Key / Token' }]}
                >
                  <Input.Password
                    placeholder={editingChannelId ? '留空表示不修改' : 'sk-...'}
                    autoComplete="new-password"
                    disabled={type === 'cli_proxy' && auth === '无鉴权'}
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
            {({ getFieldValue }) => (
              <Form.Item label="充值比例" extra="例如上游 1 元到账 10 额度，填 10；页面会按 1:1 口径折算倍率。">
                <Space.Compact className="full-width">
                  <Input value="1:" className="ratio-prefix" disabled />
                  <Form.Item
                    name="rechargeRatio"
                    noStyle
                    rules={[
                      { required: true, message: '请输入充值比例' },
                      {
                        validator: (_, value) =>
                          Number.isInteger(Number(value)) && Number(value) >= 1
                            ? Promise.resolve()
                            : Promise.reject(new Error('充值比例必须是正整数'))
                      }
                    ]}
                  >
                    <InputNumber
                      min={1}
                      step={1}
                      precision={0}
                      className="ratio-input"
                      disabled={getFieldValue('upstreamType') === 'cli_proxy'}
                    />
                  </Form.Item>
                </Space.Compact>
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.upstreamType !== next.upstreamType}>
            {({ getFieldValue }) =>
              getFieldValue('upstreamType') === 'cli_proxy' ? (
                <div className="form-note">
                  <Text type="secondary">CLI Proxy API 不读取余额和倍率，只作为渠道上游配置保存。</Text>
                </div>
              ) : null
            }
          </Form.Item>
        </Form>
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
            <Input placeholder="例如 主中转站" />
          </Form.Item>
          <Form.Item name="baseUrl" label="NewAPI 地址" rules={[{ required: true, message: '请输入 NewAPI 地址' }]}>
            <Input placeholder="https://newapi.example.com" />
          </Form.Item>
          <Form.Item name="auth" label="管理凭据" rules={[{ required: true, message: '请选择管理凭据' }]}>
            <Select options={[{ label: '管理 Token', value: '管理 Token' }]} />
          </Form.Item>
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
          <Text type="secondary">这里配置的是你自己的 NewAPI 中转站，不是渠道上游。</Text>
        </Form>
      </Modal>
    </ConfigProvider>
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
  rateColumns,
  visibleRates,
  events,
  rateFilter,
  setRateFilter
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
  rateColumns: ColumnsType<RateRow>;
  visibleRates: RateRow[];
  events: EventItem[];
  rateFilter: RateFilter;
  setRateFilter: (filter: RateFilter) => void;
}) {
  return (
    <Flex vertical gap={16} className="full-width">
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title="中转站" value={relayCount} prefix={<ApiOutlined />} suffix={<Text type="secondary">个</Text>} />
            <Text type="secondary">当前仅启用 NewAPI 类型</Text>
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
            <Text type="secondary">新增或凭据变更后需要同步</Text>
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
          <Card title="当前中转站" className="overview-relay-card" extra={<Button size="small" icon={<SettingOutlined />} onClick={onConfigureRelay}>配置</Button>}>
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
                  label: '凭据',
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
          scroll={{ x: 1026 }}
          locale={{ emptyText: <Empty description="还没有渠道，新增渠道后这里会显示具体倍率归属" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <RatesCard columns={rateColumns} rows={visibleRates} rateFilter={rateFilter} setRateFilter={setRateFilter} />
        </Col>
        <Col xs={24} xl={8}>
          <Card title="处理原则" className="full-height">
            <Flex vertical gap={14}>
              <RunbookItem icon={<DatabaseOutlined />} title="快照优先">
                渠道上游倍率先记录为快照和事件，是否改线上配置需要人工确认。
              </RunbookItem>
              <RunbookItem icon={<CheckCircleOutlined />} title="层级清晰">
                NewAPI 是中转站；NewAPI / Sub2API / CLI Proxy API 是渠道上游来源。
              </RunbookItem>
              <RunbookItem icon={<AlertOutlined />} title="CF 降级">
                遇到 Challenge 只标记受限，不做绕过。
              </RunbookItem>
            </Flex>
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}

function RatesCard({
  columns,
  rows,
  rateFilter,
  setRateFilter
}: {
  columns: ColumnsType<RateRow>;
  rows: RateRow[];
  rateFilter: RateFilter;
  setRateFilter: (filter: RateFilter) => void;
}) {
  return (
    <Card
      title="倍率快照"
      extra={
        <Segmented
          value={rateFilter}
          onChange={(value) => setRateFilter(value as RateFilter)}
          options={[
            { label: '全部', value: 'all' },
            { label: '有变化', value: 'changed' },
            { label: '受限', value: 'limited' }
          ]}
        />
      }
    >
      <Table
        rowKey="key"
        columns={columns}
        dataSource={rows}
        pagination={false}
        size="middle"
        scroll={{ x: 1120 }}
        locale={{ emptyText: <Empty description="还没有倍率快照，同步渠道后按渠道显示" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      />
    </Card>
  );
}

function CredentialsView() {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card title="NewAPI 中转站" extra={<Tag color="green">当前范围</Tag>}>
          <CapabilityTimeline
            items={[
              '管理 Token：读取中转站渠道和启停状态',
              '同步失败保留最后一次渠道快照',
              '后续多中转站按实例隔离凭据和任务'
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="NewAPI 渠道上游" extra={<Tag color="green">可读取</Tag>}>
          <CapabilityTimeline
            items={[
              '用户 Access Token：读取余额、Key 列表和分组倍率',
              '管理 Token：可读取账号接口时同样支持',
              '普通 API Key：不能读取余额，只能尽量按公开定价读取分组倍率',
              '倍率变化写入渠道维度快照'
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="Sub2API 渠道上游" extra={<Tag color="blue">用户身份</Tag>}>
          <CapabilityTimeline
            items={[
              '用户 Token / 登录态：尽量读取余额、Key 用量、分组倍率',
              '普通 API Key：不能可靠读取余额和倍率',
              'CF Challenge：标记受限，不自动绕过'
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="CLI Proxy API" extra={<Tag>仅转发</Tag>}>
          <CapabilityTimeline
            items={[
              '不读取余额和倍率',
              '只记录上游地址、认证方式和所属渠道',
              '同步主站渠道时保留手动配置的类型'
            ]}
          />
        </Card>
      </Col>
    </Row>
  );
}

function AlertsView({ events }: { events: EventItem[] }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={16}>
        <Card title="告警规则">
          <Timeline
            items={[
              ['渠道上游倍率上涨超过 3%', '生成高优先级事件，提示人工确认是否调整 NewAPI 渠道成本。'],
              ['中转站同步失败', '保留上次渠道快照，并标记该 NewAPI 中转站需要检查管理凭据。'],
              ['Cloudflare Challenge', '渠道降级为受限监控，提示改用可读取的用户身份或管理 token。']
            ].map(([title, detail]) => ({
              content: (
                <div className="timeline-item">
                  <Text strong>{title}</Text>
                  <Text type="secondary">{detail}</Text>
                </div>
              )
            }))}
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

function CapabilityTimeline({ items }: { items: string[] }) {
  return (
    <Timeline
      items={items.map((item) => ({
        color: 'green',
        content: <Text>{item}</Text>
      }))}
    />
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

function UpstreamLink({ channel }: { channel: ChannelView }) {
  const href = normalizedExternalUrl(channel.upstreamBaseUrl);

  if (!href) {
    return <Text strong>{channel.upstreamName}</Text>;
  }

  return (
    <Tooltip title="点击打开上游官网">
      <a className="upstream-link" href={href} target="_blank" rel="noreferrer">
        {channel.upstreamName}
      </a>
    </Tooltip>
  );
}

function ProviderTag({ type }: { type: UpstreamProvider }) {
  const config = {
    newapi: { color: 'green', label: 'NewAPI 上游' },
    sub2api: { color: 'blue', label: 'Sub2API 上游' },
    cli_proxy: { color: 'default', label: 'CLI Proxy API' }
  }[type];

  return <Tag color={config.color}>{config.label}</Tag>;
}

function RelayTypeTag() {
  return <Tag color="green">NewAPI 中转站</Tag>;
}

function StatusTag({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const color = tone === 'ok' ? 'green' : tone === 'warn' ? 'gold' : tone === 'error' ? 'red' : 'blue';
  return <Tag color={color}>{children}</Tag>;
}

function CfTag({ value }: { value: string }) {
  const color = value === 'Challenge' ? 'blue' : value === '无防护' ? 'green' : value === '待检测' ? 'default' : 'gold';
  return <Tag color={color}>{value}</Tag>;
}

function CredentialTag({ configured }: { configured: boolean }) {
  return <Tag color={configured ? 'green' : 'default'}>{configured ? '已配置' : '未配置'}</Tag>;
}

function GroupRatioValue({ value, ignored }: { value: number | null; ignored?: boolean }) {
  if (ignored) {
    return <Text type="secondary">忽略</Text>;
  }

  if (value === null) {
    return <Text type="secondary">待同步</Text>;
  }

  return <Text>{value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}x</Text>;
}

function BalanceValue({ channel }: { channel: ChannelView }) {
  if (channel.upstreamType === 'cli_proxy') {
    return <Text type="secondary">忽略</Text>;
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
    return <Text type="secondary">-</Text>;
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
    return <Text type="secondary">忽略</Text>;
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
    return <Text type="secondary">忽略</Text>;
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

function buildRateRows(channels: ChannelView[], relays: RelayView[]): RateRow[] {
  return channels.filter((channel) => channel.upstreamType !== 'cli_proxy').map((channel) => {
    const relay = relays.find((item) => item.id === channel.relayId);
    const direction = rateDirection(channel.currentRate, channel.previousRate, channel.rechargeRatio);

    return {
      key: channel.id,
      relayName: relay?.name ?? 'NewAPI 中转站',
      channelName: channel.name,
      upstreamName: channel.upstreamName,
      upstreamType: channel.upstreamType,
      model: modelNameForChannel(channel),
      group: channel.group,
      input: channel.groupRatio === null ? '分组倍率待同步' : `分组倍率 ${formatGroupRatio(channel.groupRatio)}`,
      output: channel.rateSource || '待同步',
      currentRate: channel.currentRate,
      previousRate: channel.previousRate,
      direction
    };
  });
}

function rechargeRatioForRate(channelId: string, channels: ChannelView[]) {
  return channels.find((channel) => channel.id === channelId)?.rechargeRatio ?? 1;
}

function normalizeByRechargeRatio(value: number, ratio: number | undefined) {
  return value / safeRechargeRatio(ratio);
}

function safeRechargeRatio(value: number | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

function formatRatio(value: number | undefined) {
  return String(safeRechargeRatio(value));
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
  const normalized = value.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAmount(value: number) {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
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

function authOptions(type?: UpstreamProvider) {
  if (type === 'sub2api') {
    return ['用户 Token', '用户登录', 'API Key', '手动 Session'];
  }

  if (type === 'cli_proxy') {
    return ['API Key', 'Bearer Token', '无鉴权'];
  }

  return ['用户 Access Token', '管理 Token', 'API Key'];
}

function defaultAuth(type?: UpstreamProvider) {
  if (type === 'sub2api') {
    return '用户 Token';
  }

  if (type === 'cli_proxy') {
    return 'API Key';
  }

  return '用户 Access Token';
}

function requiresCredential(type?: UpstreamProvider, auth?: string) {
  return type !== 'cli_proxy' && auth !== '无鉴权';
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
    return '已配置账号级凭据，点击同步后读取余额。';
  }

  if (channel.status === '待配置凭据') {
    return '需要在渠道配置里填写上游账号级 Token。';
  }

  if (channel.auth === 'API Key') {
    return channel.upstreamType === 'newapi'
      ? 'NewAPI 的 sk-模型调用 Key 通常不能读取账号余额；请改用用户 Access Token 并填写上游用户 ID。'
      : 'API Key 只能转发调用，不能读取账号余额。';
  }

  if (channel.status === '余额读取失败') {
    return channel.rateSource || '访问令牌或上游用户 ID 校验失败。';
  }

  if (channel.status === '余额不可见') {
    return channel.upstreamType === 'newapi'
      ? '已读到分组倍率，但 /api/user/self 没返回余额。请确认填写的是 NewAPI 用户 Access Token 和上游用户 ID。'
      : '已读到分组倍率，但 /api/v1/auth/me 没返回余额。请确认填写的是 Sub2API 用户 JWT。';
  }

  return channel.rateSource || channel.status;
}

function relayName(relayId: string, relays: RelayView[]) {
  return relays.find((relay) => relay.id === relayId)?.name ?? 'NewAPI 中转站';
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

function modelNameForChannel(channel: ChannelView) {
  return channel.keyName ? `${channel.keyName} / ${channel.group}` : `分组 ${channel.group}`;
}

function viewTitle(view: View) {
  return {
    overview: '运营总览',
    relays: '中转站',
    channels: '渠道管理',
    rates: '倍率快照',
    credentials: '凭据与权限',
    alerts: '告警事件'
  }[view];
}
