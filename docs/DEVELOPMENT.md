# Gateway 开发与交付

Gateway 是独立 Hono Worker。用户、角色与成员关系属于 Auth0；JWT、浏览器会话、实时授权、账号目录与角色权限配置由 Gateway 维护。业务侧保留记录归属、业务状态、输入白名单与 RLS。共享协议和权限清单见 [AUTH](../../eastmoney/docs/AUTH.md)。

## 代码与契约

- `src/app.ts`：Hono 路由、公开/保护分流、SvelteKit 数据请求错误协议。
- `src/tokens.ts` / `session.ts`：固定 Auth0 JWKS、RS256/issuer/audience/azp/时效、PKCE/state/nonce、加密 Cookie、退出。
- `src/lib/server/authorization.ts`：实时账号/角色、beta-open/enforce、无缓存权限查询。
- `src/lib/permissions.ts` / `route-permissions.ts` / `server/permission-policy.ts`：唯一权限目录及路由策略。前两份通过 `scripts/sync-dashboard-contracts.mjs` 同步到 Dashboard 供菜单与导航使用。
- `src/identity-service.ts`：私有 `IdentityService`，账号目录与角色配置；角色保存保留事务、角色锁、版本比对和严格白名单。
- `src/data.ts`：Data 公开资源、GraphQL 执行操作/别名/片段的 Choice 字段判定和机器作用域。
- `src/forward.ts`：删除外部凭据/身份头，生成版本化 UTF-8 Base64URL 上下文。传输头不是认证凭据，信任来自命名 Service Binding 的可达性。

Dashboard 只在 `GatewayDashboard` 解析上下文并注入请求内 env；默认入口固定 404。Data 只在 `GatewayData` 消费授权结果，原 `InternalData` 供 Dashboard/Ingest 机器调用。两后端不得恢复公网 routes、workers.dev、preview 或 Custom Domain。

## 配置与本地验证

```sh
pnpm install
pnpm check
pnpm deploy:dry
git diff --check
```

先构建 Dashboard，再在此运行 `node scripts/verify-integration.mjs`。默认同级 Dashboard/Data；工作树通过 `DASHBOARD_CHECKOUT` / `DATA_CHECKOUT` 指定。该脚本执行真实 SvelteKit/Data handler，但 Auth0、数据库和业务上游使用模拟实现。权限验收禁止 browser。

`pnpm auth:verify` 使用项目组根 `.env` 的 `test@18.cn` 做真实 HTTP 登录和只读探针。`AUTH_TEST_ENV_FILE` 可指定文件；密码只向固定 Auth0 登录 origin 提交一次。验证码/MFA/验证邮箱阻断必须报告，不关闭保护或用机器身份替代。

Worker Secret：`AUTH0_CLIENT_SECRET`、`AUTH0_MANAGEMENT_CLIENT_SECRET`、`SESSION_SECRET`。会话密钥为 32 字节随机值的 Base64URL；仅保存在受限部署文件与 Worker Secret。Gateway 唯一权限 binding `AUTHORIZATION_DB` 必须关闭 Hyperdrive 查询缓存，不使用 Dashboard 的业务缓存连接。

生产公开 origin、Auth0 issuer/API audience、用户 client ID 和机器 client ID allowlist 均在 Wrangler vars。机器 scope 限 `data.choice:read`；Quant 凭据只在其未跟踪 `.env` 中。JWT 不含应用有效权限快照，权限每个受保护请求读取当前状态。

## Auth0 配置

按共享 AUTH 使用显式资源 `auth0:export` / `auth0:plan` / `auth0:apply`；默认禁止删除、不导出 Secret。`scripts/prepare-gateway-tenant.mjs` 从受限导出生成本次 web callback、API audience 与 Quant 机器应用配置；先审阅计划再 apply。保留现有角色、角色成员、注册 Form 和迁移账号例外。

登录 Action 为 `auth0/actions/eastmoney-login.cjs`，给本站 API access token 添加 namespaced email；Auth0 原生 `sub` 即用户主键。发布只修改该 Action 的 code，保留 Secrets、依赖与绑定，并回读 deployed version。确认 Gateway 切换完成后移除本站应用的旧 Access callback/logout 白名单。

## 生产切换

此次是跨 Worker 边界迁移，先部署无公网路由的 Gateway（提供 `IdentityService`），再为 Dashboard/Data 安装私有 entrypoint。Gateway 和后端的循环 Service Binding 可用临时无 downstream binding 的 Gateway 配置引导；不得让临时配置取得公网路由。

1. 各仓库独立通过默认测试、类型、构建/dry-run；程序化联调确认公开、保护、GraphQL 和 SvelteKit 协议。
2. 配置 Auth0 callback、API、机器 grant 与 token claims，验证配置回读；准备 Gateway Secrets。此阶段保留旧 Access 应用，旧登录流程继续工作。
3. 上传/部署私有 Gateway、Dashboard/Data 的新版本，核对命名 binding、静态资产与原 Workflow/Cron/DO 均保留。默认入口拒绝确保切换期间失败关闭。
4. 将唯一 `eastmoney.hasbai.xyz/*` 路由交给 Gateway，移除旧 `/data*` 路由；关闭两个后端 workers.dev 和 preview，确认无 Custom Domain。只移除本站 `eastmoney` Access 应用，不修改其他 Access 应用或团队配置。
5. 程序化验证公开行情、匿名拒绝、测试账号登录/profile/session/权限页面、Quant 机器 Choice 缺参数 422、拒绝机器访问 Dashboard、退出及 origin 绕过。核对线上 Worker version 与 Git 提交。
6. 移除旧 Access callback/logout、Dashboard 不再使用的 Auth0 Secret 和 Quant `.env` 的旧 Access 凭据。原 Access Service Token 只有核对已无调用方后才撤销。

切换可以短暂返回拒绝或服务不可用；不得为了连续可用而开启匿名保护旁路。恢复旧版本时必须先恢复其 Access 应用保护及配套配置，再恢复公网 route；不能只恢复可绕过 Gateway 的 origin。恢复配置使用受限的部署前快照，不写凭据到 Git。

## 权限 migration

`authorization-migrations/0001_permissions.sql` 是既有基线；本次不改 schema、不重播种角色。后续 migration 在本仓库追加，继续登记 `authorization.schema_migration`。Dashboard 保留历史跨 schema 初始化和 RLS 夹具，但不新增权限库运行时读写。数据库变更遵守共享 DATABASE。

## 发布与证据

只提交本次文件，推送并核对远端。Gateway 手动部署已获重构任务授权；Dashboard 默认 Git 自动部署，必要手动部署也已授权；Data 按其开发文档部署，Quant 仅提交客户端，无部署。发布后必须核对配置和请求，不能把本地通过当作线上成功。

## MCP 与错误语义

统一入口由 Cloudflare MCP Portals 提供；端点、Auth0 和 Keychain 配置见 [MCP](MCP.md)。Gateway 的旧 `/mcp` 已退役。`pnpm auth:verify` 含真实 MCP 初始化、工具目录、只读调用和输入错误探针。匿名保护请求先返回 401；已登录的未登记入口返回 403 `ROUTE_NOT_REGISTERED`，账号拒绝仍为 `ACCESS_DENIED`。
