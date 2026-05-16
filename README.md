# AI 中转管理平台

面向 NewAPI 和 Sub2API 上游的中转管理平台骨架。当前工程包含管理后台、API 服务、倍率同步 Worker、共享类型契约、PostgreSQL/Redis 本地运行配置。

## 模块

- `apps/web`: Next.js 管理后台，包含上游接入、倍率快照、涨跌事件、余额和 CF 状态视图。
- `apps/api`: NestJS API，负责上游配置、同步任务入队、倍率事件查询。
- `apps/worker`: BullMQ Worker，负责定时或手动同步上游余额、分组倍率、模型价格。
- `packages/shared`: 上游适配器契约和共享类型。
- `docs/architecture.md`: 能力矩阵、同步流程、Cloudflare 降级策略。

## 本地启动

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm dev
```

默认端口：

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

详细架构见 `docs/architecture.md`。

## 上游接入策略

Sub2API 的普通 `sk-xxx` 只能作为模型调用凭证，不能稳定读取余额和倍率。平台按接入能力分级：

- `api_key`: 仅做模型可用性、延迟、成功率探测。
- `password`: 使用用户账号登录，读取 `/auth/me`、`/keys`、`/groups/available`、`/groups/rates`、`/channels/available`。
- `user_token`: 用户级官方查询 token，推荐方式。
- `session`: 用户手动完成 CF/验证码后保存会话，稳定性取决于上游风控。
- `admin_token`: 自建或授权 NewAPI/Sub2API 管理接口。

遇到 Cloudflare Challenge 时，平台不会尝试绕过。同步任务会把上游标记为 `challenge_required`，并降级到 API Key 可用性监控或提示用户改用官方 token。

## 数据重点

倍率监控不是实时抓价格页，而是保存可审计快照：

- `rate_snapshots`: 每次同步的模型/分组/渠道价格与倍率。
- `rate_change_events`: 和上一版快照比对后的上涨、下降、新增、下架事件。
- `upstreams`: 上游配置、认证模式、余额、CF 状态、最后同步错误。
- `credentials`: 加密后的登录凭据或 token 引用。
