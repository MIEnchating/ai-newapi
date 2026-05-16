# 架构说明

## 目标

平台负责管理 NewAPI 和 Sub2API 上游，并持续记录可见的余额、分组倍率、模型倍率、渠道价格和风控状态。核心原则是先形成可审计快照，再由人工或策略确认是否修改本平台计费配置。

## 服务划分

```text
apps/web
  管理后台。展示上游、余额、倍率快照、涨跌事件、CF 状态和接入能力。

apps/api
  管理 API。负责上游 CRUD、凭据加密存储、同步任务入队、倍率事件查询。

apps/worker
  BullMQ Worker。定时同步上游，调用不同适配器，写入快照并生成涨跌事件。

packages/shared
  共享类型、上游适配器接口、倍率 diff 工具。
```

## 上游能力矩阵

| 上游 | 认证模式 | 余额 | API Key 用量 | 分组倍率 | 模型/渠道价格 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| NewAPI | 管理 Token | 可见 | 可见 | 可见 | 可见 | 适合自建或已授权上游 |
| NewAPI | 普通 API Key | 不稳定 | 不稳定 | 不可见 | 不可见 | 只能做调用探测 |
| Sub2API | 用户登录/JWT | 可见 | 可见 | 可见 | 取决于 channels/available 开关 | 推荐用户级 token 替代密码登录 |
| Sub2API | 普通 API Key | 不可见 | 不可见 | 不可见 | 不可见 | 只能做可用性和延迟监控 |
| Sub2API | Session | 可见 | 可见 | 可见 | 取决于上游 | 遇到 CF/MFA 时可能失效 |

## Cloudflare 策略

系统不尝试绕过 Cloudflare Challenge、Turnstile、CAPTCHA 或设备指纹校验。适配器遇到 challenge 页面时抛出明确错误，Worker 将上游状态标记为 `CHALLENGE_REQUIRED`，前端提示用户切换到用户级官方 token、手动授权或 API Key 受限监控。

## 同步流程

```text
1. API 创建上游并加密保存凭据
2. Worker 周期扫描需要同步的上游
3. 适配器读取账户状态和倍率数据
4. 写入 rate_snapshots
5. 和上一条快照对比
6. 写入 rate_change_events
7. 告警模块后续按事件推送 Telegram/飞书/邮件
```

## 后续优先级

1. 接入真实 NewAPI/Sub2API 实例，校准返回字段。
2. 增加告警渠道表和通知 Worker。
3. 增加“待确认变更”，允许管理员确认后再应用到本平台计费配置。
4. 增加上游调用探测任务，统计延迟、错误率和模型可用性。
