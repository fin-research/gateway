# Gateway 开发与交付

Gateway 是独立 Hono Worker。用户、角色与成员关系属于 Auth0；JWT、浏览器会话、缓存授权、账号目录与角色权限查询由 Gateway 维护。业务侧保留记录归属、业务状态、输入白名单与 RLS。共享协议和权限清单见 [AUTH](../../eastmoney/docs/AUTH.md)。

## 代码与契约

- `src/app.ts`：Hono 路由、公开/保护分流、SvelteKit 数据请求错误协议。
- `src/tokens.ts` / `session.ts`：固定 Auth0 JWKS、RS256/issuer/audience/azp/时效、PKCE/state/nonce、加密 Cookie、退出。
- `src/lib/server/authorization.ts`：JWT 角色快照与正常权限检查；授权 JSON 缓存见 `permission-cache.ts`。
- `src/lib/permissions.ts` / `route-permissions.ts` / `server/permission-policy.ts`：唯一权限目录及路由策略。前两份通过 `scripts/sync-dashboard-contracts.mjs` 同步到 Dashboard 供菜单与导航使用。
- `src/identity-service.ts`：私有 `IdentityService`，账号目录与角色配置；角色授权只读；编辑统一在 Auth0。
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

Worker Secret：`AUTH0_CLIENT_SECRET`、`AUTH0_MANAGEMENT_CLIENT_SECRET`、`SESSION_SECRET`。会话密钥为 32 字节随机值的 Base64URL；仅保存在受限部署文件与 Worker Secret。Gateway 不再绑定权限数据库；使用命名 Cache API `eastmoney-permissions-v1`，不需要 KV、Durable Object 或数据库 migration。

生产公开 origin、Auth0 issuer/API audience、用户 client ID 和机器 client ID allowlist 均在 Wrangler vars。机器 scope 限 `data.choice:read`；Quant 凭据只在其未跟踪 `.env` 中。JWT 保存登录时的角色 ID/名称与资料，不含应用有效权限快照；每个受保护请求按 JWT 角色读取缓存授权并检查路由权限，只有 `enforce` 模式可用。角色成员变更在重新登录或个人资料页“刷新登录角色”取得新 token 后生效。

## Auth0 配置

按共享 AUTH 使用显式资源 `auth0:export` / `auth0:plan` / `auth0:apply`；默认禁止删除、不导出 Secret。`scripts/prepare-gateway-tenant.mjs` 从受限导出生成本次 web callback、API audience 与 Quant 机器应用配置；先审阅计划再 apply。保留现有角色、角色成员、注册 Form 和迁移账号例外。

登录 Action 为 `auth0/actions/eastmoney-login.cjs`，给本站 API access token 添加 namespaced email、roles 与 profile；Auth0 原生 `sub` 即用户主键。Action 在登录时从事件取得角色名称，通过专用 `eastmoney-login-roles` 机器应用解析稳定角色 ID，并给未持有 `authenticated` 的本组织用户增量分配基础角色；该应用仅有 `read:roles` 与 `create:organization_member_roles`。声明配置见 `auth0/login-role-client.yaml`；`scripts/publish-login-claims.mjs` 先 plan、再 `--apply`，受控更新代码及角色查询 Secrets，保留依赖与绑定并回读 deployed version。旧 token 缺少角色声明时要求重新登录。确认 Gateway 切换完成后移除本站应用的旧 Access callback/logout 白名单。

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

`authorization-migrations/0001_permissions.sql` 与 `permission-repository.ts` 保留用于历史回溯；现行授权不再读写这些表，不删除旧数据、不执行 schema 变更。Auth0 权限目录与角色授权成为唯一配置来源。

## 发布与证据

只提交本次文件，推送并核对远端。Gateway 手动部署已获重构任务授权；Dashboard 默认 Git 自动部署，必要手动部署也已授权；Data 按其开发文档部署，Quant 仅提交客户端，无部署。发布后必须核对配置和请求，不能把本地通过当作线上成功。

## MCP 与错误语义

统一入口由 Cloudflare MCP Portals 提供；端点、Auth0 和 Keychain 配置见 [MCP](MCP.md)。Gateway 的旧 `/mcp` 已退役。`pnpm auth:verify` 含真实 MCP 初始化、工具目录、只读调用和输入错误探针。匿名保护请求先返回 401；已登录的未登记入口返回 403 `ROUTE_NOT_REGISTERED`，账号拒绝仍为 `ACCESS_DENIED`。

## 身份接口限流恢复

Auth0 Management API 的账号、角色读取及管理 token 获取遇到 429 时，在当前请求内按 `Retry-After` / `X-RateLimit-Reset` 退避并加入抖动；最多重试四次，总等待不超过十秒。上游要求的等待超出预算时直接返回可重试的 `IDENTITY_RATE_LIMITED`，不提前再次冲击上游。此退避仅用于实际资料、目录及角色管理操作；普通业务准入不调用 Management API。账号状态与角色成员关系在 Auth0 签发新 token 时检查；既有 JWT 按其有效期使用，角色权限通过 Cache API JSON 缓存逐请求检查。修改资料、角色等写操作不自动重放。日志只记阶段、次数、等待时长和状态码，不记录凭据或个人信息。

## Eastmoney 组织隔离

网站与 MCP 用户登录绑定 `org_6yvoRRCkzk3eGkBS`，Gateway 校验 `org_id`；账号目录和成员角色使用本组织范围。当前套餐不支持 M2M Organizations，Quant 保留单独 Choice 白名单。应用盘点、迁移、套餐限制与回退见 [组织与应用边界](AUTH0_ORGANIZATIONS.md)。

## Auth0 RBAC 与授权缓存

- `scripts/prepare-rbac.mjs plan` 从受限 Deploy CLI 导出生成 Gateway API 权限目录、登录角色 client grant 和增量角色/成员计划。`auth0:plan/apply --include=resourceServers,clientGrants` 只更新显式资源，禁止删除。当前 Deploy CLI 的 roles export 仅包含 tenant roles，组织角色及成员通过脚本 `apply` 增量补齐，再 `verify` 回读；已有其他 audience 权限保留。
- 本站 58 项业务权限注册到 Gateway audience；API 启用 RBAC，但 `token_dialect=access_token`，不启用 Add Permissions in the Access Token。用户 JWT 只声明身份与角色，机器 Choice scope 保持不变。
- 内测给所有本站组织成员配置 `authenticated`，给本站全部角色授予全部已登记权限。新用户通过登录 Action 自动获得基础角色。结束内测时在 Auth0 调整角色权限，无需改变鉴权代码。
- Gateway 将本站角色目录与授权序列化为一个 JSON Response，保存在命名 Cloudflare Cache API 中。TTL 为 3600 秒；请求命中时不查询 Auth0，缺失/过期时完整读取并替换；读取失败返回 503，不使用过期或半份授权。
- Cache API 按 Cloudflare 节点存储，无后台定时器。所谓一小时同步为按需过期更新；手动刷新只影响当前节点，其他节点到期后各自更新。
- `GET /auth/permissions`：仅登录，返回当前角色合并后的 `permissions` 与 `updatedAt`，读取缓存，不强制同步 Auth0；无权限用户也能查询自己，机器身份拒绝。
- `POST /auth/permissions/refresh`：同源且具备 `auth.permission:update`，同步 Auth0 并更新当前节点缓存；不修改 Auth0 配置。权限响应一律 private/no-store。
- Dashboard 个人页和管理角色视图复用 `PermissionExplorer`，按 scope/resource/action 分级展示。个人“刷新我的权限”重新读取缓存；“刷新登录角色”走标准授权码流程更新 JWT 角色。角色管理页面仅链接 Auth0 编辑并提供缓存刷新，不保留本地授权编辑器。

### 2026-09-13 发布验收

实现提交：Gateway `4bc18c1`、Dashboard `908e3f0`，均已合入并回读远端 main。Gateway 发布版本 `21b50794-9945-42fe-8a24-a8734ee25a98`；Dashboard 自动部署未反映到线上时，使用同一已验证提交手动发布，版本 `964ed834-b766-4ed5-a242-797a6852a826`。登录 Action 当前绑定版本 `f9e468ae-0045-4e54-8960-c1911cfe536a`；首次发布 503 后先回读确认仅有草稿，再重试并验证绑定。

- Auth0 回读：9 名组织成员均有 authenticated，5 个本站角色各具备 58 项 Gateway 权限。API RBAC 开启、token dialect 为 access_token，不附加完整 permissions。
- Gateway check 65 项通过、deploy dry-run 通过；Dashboard typecheck、536 项测试与 build 通过；真实 SvelteKit/Data handler 联调 32 项通过（外部服务模拟）。
- test@18.cn 真实 HTTP 登录和 72 项匿名/用户访问探针全部通过；手动缓存刷新 HTTP 200，个人缓存返回 58 权限和 authenticated。Data MCP 23 工具、health 及错误输入检查通过。
- Quant 真实机器 token 获取成功；Choice 缺参 422，profile/CAMEL/MCP 全部 403。个人页、角色页 HTTP 200，线上 HTML 包含 scope/resource/action 分层组件和缓存刷新入口，无旧权限编辑表单。
- 按规范未使用浏览器、截图或人工视觉验收。缓存跨节点传播与一小时过期语义以 Cache API 契约及单元测试覆盖，未等待一小时做线上到期实验。
