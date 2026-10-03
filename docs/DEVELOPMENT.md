# Gateway 开发与交付

Gateway 是独立 Hono Worker。用户、角色与成员关系属于 Auth0；JWT、缓存授权、账号目录与角色权限查询由 Gateway 维护。业务侧保留记录归属、业务状态、输入白名单与 RLS。共享协议和权限清单见 [AUTH](../../eastmoney/docs/AUTH.md)。

`/financing-model/research` 是融资模型页的只读研究文档，由 `policy.ts` 映射到既有 `/financing-model` 路由权限，复用 `model.financing:read` 的 GET/HEAD；授权成功后，`QUANT_REPORT: ResearchReport` 命名绑定仅读取 Quant Worker 的 `/REPORT.html`。报告不由 Dashboard 处理，不暴露 Quant 原始产物或默认入口。权限与请求凭据剥离沿用原 Gateway 过程。

## 代码与契约

- `src/app.ts`：Hono 路由、公开/保护分流、SvelteKit 数据请求错误协议。
- `src/tokens.ts` / `session.ts`：固定 Auth0 JWKS、RS256/issuer/audience/azp/时效、浏览器 Bearer token、退役 Cookie 清理。
- `src/lib/server/authorization.ts`：JWT 角色快照与正常权限检查；授权 JSON 缓存见 `permission-cache.ts`。
- `src/lib/permissions.ts` / `route-permissions.ts` / `server/permission-policy.ts`：唯一权限目录及路由策略。前两份通过 `scripts/sync-dashboard-contracts.mjs` 同步到 Dashboard 供菜单与导航使用。
- `src/identity-service.ts`：私有 `IdentityService`，账号目录、MCP 业务调用路由授权桥接与角色配置；保留原人员编辑私有入口供旧版本过渡。公网 `/api/management/people` 由 Gateway 直接处理管理员姓名、部门读取和写入，不经过 Dashboard。
- `/api/management/people` 的 GET 读取姓名、部门等资料；先读取组织成员 ID，再用 Auth0 用户搜索聚合读取资料，并只返回组织成员与本站连接的交集。完整私有目录还从组织成员列表聚合读取角色并按本站角色过滤。聚合搜索缺少成员或不可用时，仅对缺漏成员以最多四人一批读取；权限缓存冷加载仍以最多四角色一批并行读取。管理员资料 PATCH 成功后按已校验请求返回字段，不依赖 Auth0 返回完整用户结构。
- `src/data.ts`：Data 公开资源、GraphQL 执行操作/别名/片段的 Choice 字段判定和机器作用域。
- `src/forward.ts`：删除外部凭据/身份头，生成版本化 UTF-8 Base64URL 上下文。传输头不是认证凭据，信任来自命名 Service Binding 的可达性。

Dashboard 只在 `GatewayDashboard` 解析上下文并注入请求内 env；默认入口固定 404。Data 只在 `GatewayData` 消费授权结果，原 `InternalData` 供 Dashboard/Ingest 机器调用。两后端不得恢复公网 routes、workers.dev、preview 或 Custom Domain。

`POST /api/ai/responses` 只向已登录用户放行，并执行站点写操作的同源校验。Dashboard 将流式 Responses 请求转发到固定 Cloudflare AI Gateway 模型，Gateway 与浏览器均不接触上游密钥；浏览器用本站 Bearer token 调用。

## 配置与本地验证

```sh
pnpm install
pnpm check
pnpm deploy:dry
git diff --check
```

先构建 Dashboard，再在此运行 `node scripts/verify-integration.mjs` 验证 Bearer、新声明与实际 CSR 外壳边界。默认同级 Dashboard/Data；工作树通过 `DASHBOARD_CHECKOUT` / `DATA_CHECKOUT` 指定。该脚本执行真实 SvelteKit/Data handler，但 Auth0、数据库和业务上游使用模拟实现。权限验收禁止 browser。

`pnpm auth:verify` 使用项目组根 `.env` 的 `test@18.cn` 做真实 HTTP 登录和只读探针。`AUTH_TEST_ENV_FILE` 可指定文件；密码只向固定 Auth0 登录 origin 提交一次。验证码/MFA/验证邮箱阻断必须报告，不关闭保护或用机器身份替代。

Worker 运行时仅需要 `AUTH0_MANAGEMENT_CLIENT_SECRET`；旧 `AUTH0_CLIENT_SECRET`、`SESSION_SECRET` 不再由代码读取。Gateway 不再绑定权限数据库；使用命名 Cache API `eastmoney-permissions-v1`，不需要 KV、Durable Object 或数据库 migration。

生产公开 origin、Auth0 issuer/API audience、用户 client ID 和机器 client ID allowlist 均在 Wrangler vars。Quant 机器应用退役后 allowlist 为空；重新开放机器访问须另行审查 client、scope 和调用链。JWT 保存登录时的角色名称与资料，不含应用有效权限快照；每个受保护请求按 JWT 角色读取缓存授权并检查路由权限，只有 `enforce` 模式可用。角色成员变更在重新登录或个人资料页“刷新登录角色”取得新 token 后生效。

公开首页保留匿名访问，账号与入口可见性由客户端 JWT 展示和 `/auth/permissions` 结果初始化。Dashboard 根 layout 不再从 SSR 注入登录快照。Gateway 对显式带 Bearer 的首页仍验签和检查当前授权；读取失败以匿名首页继续，不向后端传递部分授权。

## 浏览器 Bearer 登录

浏览器使用 Auth0 SPA SDK、授权码 + PKCE；token 只存内存，通过 `Authorization: Bearer <JWT>` 调用站点。现有 `eastmoney` 客户端为 SPA、token endpoint auth method `none`，client ID 与 audience、organization、已登记 callback/origin 保持一致。Gateway 不交换浏览器授权码，不签发、读取登录 Cookie，不接受旧 nested `user` 或 URL namespace token。旧站点 Cookie 仅清理，不作鉴权来源。

Dashboard 在 SvelteKit client init 中处理 callback、恢复 token 并安装同源 Bearer fetch。受保护页面 `ssr=false`，Gateway 仅按 `CLIENT_PAGE_ROUTES` 精确允许匿名 HTML 外壳；`__data.json`、业务 API、actions、材料和报告文件继续验签及授权。未登录的深链先进入 Auth0，无法静默恢复时交互登录；普通公开页面保持既有加载模式。文件下载使用授权 fetch，HTML 报告由 sandbox iframe 预览。token 不写 localStorage、URL、SSR HTML、日志或后端请求。

当前 token 仅接受顶层 `username`、`email`、`role`、`_roles`，本站还有可选 `department`、`picture`。`role` 是数据库角色字符串，不授予业务权限；`_roles` 是名称数组，Gateway 用组织权限缓存精确解析 ID，角色匹配和权限检查共用一份快照。缺失、重复、未知和歧义角色拒绝；不存在旧字段回退。姓名等客户端展示直接解析 JWT，并在 `/auth/permissions` 接受 token 后建立登录展示；该接口仅返回当前 `permissions` 与 `updatedAt`。`/auth/session` 已移除，返回 404。

## Auth0 配置

当前本地租户管理按[共享 AUTH](../../eastmoney/docs/AUTH.md#auth0-本地租户管理) 使用 Auth0 skill 和 `auth0` CLI：先检查现有授权，再读取目标资源、执行精确变更并回读。`scripts/prepare-gateway-tenant.mjs` 是初次迁移时从受限导出生成配置的历史脚本，不应重跑以覆盖现有角色、成员、注册 Form 或迁移账号例外。

线上登录声明以当前已绑定、已部署的 `login claims` Action 为准；通过 Auth0 CLI 读取绑定与 deployed version 核对。`auth0/actions/eastmoney-login.cjs` 和 `scripts/publish-login-claims.mjs` 是旧 nested `user` 协议的历史实现，不能重新发布或恢复旧绑定。基础角色由 Auth0 成员关系管理，当前通用 Action 不自动分配角色。Gateway 身份服务与注册资料 Action 仍使用 `eastmoney gateway management` 应用，配置见 `auth0/gateway-management-client.yaml`。

## 生产交付

先验证私有后端、Gateway 路由与 Auth0 配置，再切换生产入口。只有 Gateway 持有 `eastmoney.hasbai.xyz/*`；Dashboard/Data 的默认入口保持 404。发布后以程序化 HTTP 检查公开访问、匿名拒绝、测试账号、已退役机器客户端的拒绝和后端 origin 绕过，并回读 Worker 版本。当前命名 binding、路由与回退顺序以 [共享架构](../../eastmoney/docs/ARCHITECTURE.md) 和配置为准。

若回退到旧公网入口，必须先恢复其 Access 应用保护及配套配置，再恢复 route；不得只恢复可绕过 Gateway 的 origin。使用受限的部署前快照逐项回退，不导入整租户或提交凭据。

## 权限 migration

`authorization-migrations/0001_permissions.sql` 与 `permission-repository.ts` 保留用于历史回溯；现行授权不再读写这些表，不删除旧数据、不执行 schema 变更。Auth0 权限目录与角色授权成为唯一配置来源。

## 发布与证据

只提交本次文件，推送并核对远端。Gateway 手动部署已获重构任务授权；Dashboard 默认 Git 自动部署，必要手动部署也已授权；Data 按其开发文档部署，Quant 仅提交客户端，无部署。发布后必须核对配置和请求，不能把本地通过当作线上成功。

## MCP 与错误语义

统一入口由 Cloudflare MCP Portals 提供；端点、Auth0 和 Cloudflare 凭据配置见 [MCP](MCP.md)。Gateway 的旧 `/mcp` 已退役。`pnpm auth:verify` 含真实 MCP 初始化、工具目录、只读调用和输入错误探针。匿名保护请求先返回 401；已登录的未登记入口返回 403 `ROUTE_NOT_REGISTERED`，账号拒绝仍为 `ACCESS_DENIED`。

## 身份接口限流恢复

Auth0 Management API 的账号、角色读取及管理 token 获取遇到 429 时，在当前请求内按 `Retry-After` / `X-RateLimit-Reset` 退避并加入抖动；最多重试四次，总等待不超过十秒。上游要求的等待超出预算时直接返回可重试的 `IDENTITY_RATE_LIMITED`，不提前再次冲击上游。此退避仅用于实际资料、目录及角色管理操作；普通业务准入不调用 Management API。账号状态与角色成员关系在 Auth0 签发新 token 时检查；既有 JWT 按其有效期使用，角色权限通过 Cache API JSON 缓存逐请求检查。修改资料、角色等写操作不自动重放。日志只记阶段、次数、等待时长和状态码，不记录凭据或个人信息。

## Eastmoney 组织隔离

网站与 MCP 用户登录绑定 `org_6yvoRRCkzk3eGkBS`，Gateway 校验 `org_id`；账号目录和成员角色使用本组织范围。当前套餐不支持 M2M Organizations；Quant 旧 Choice 白名单已清空。应用盘点、迁移、套餐限制与回退见 [组织与应用边界](AUTH0_ORGANIZATIONS.md)。

## Auth0 RBAC 与授权缓存

- 历史 RBAC 迁移使用 `scripts/prepare-rbac.mjs` 和受限 Deploy CLI 导出；不要重放旧导出。后续 API scope、角色和成员调整按共享 AUTH 的 CLI 流程逐项读取、修改并回读，保留其他 audience 权限。
- 本站业务权限注册到 Gateway audience；API 启用 RBAC，但 `token_dialect=access_token`，不启用 Add Permissions in the Access Token。用户 JWT 只声明身份与角色；旧机器 Choice scope 保留为历史 API 定义，不构成客户端授权。
- 内测给所有本站组织成员配置 `authenticated`，但授信维护权限仅对当前 Auth0 目录确认的 `credit` 或全站 `admin` 角色生效。新用户的基础角色通过 Auth0 组织成员关系分配；`credit` 角色须由组织管理员明确分配。其它权限仍按现有角色授权。
- `node --use-env-proxy scripts/provision-credit-role.mjs plan/apply/verify` 仅建立本站组织 `credit` 角色、授予授信读写并移除其它非管理员角色的授信更新授权；不自动分配成员。运行前后核对输出，角色成员通过 Auth0 组织成员管理。
- Gateway 将本站角色目录与授权序列化为一个 JSON Response，保存在命名 Cloudflare Cache API 中。TTL 为 3600 秒；请求命中时不查询 Auth0，缺失/过期时完整读取并替换；读取失败返回 503，不使用过期或半份授权。
- Cache API 按 Cloudflare 节点存储，无后台定时器。所谓一小时同步为按需过期更新；手动刷新只影响当前节点，其他节点到期后各自更新。
- `GET /auth/permissions`：仅登录，返回当前角色合并后的 `permissions` 与 `updatedAt`，读取缓存，不强制同步 Auth0；无权限用户也能查询自己，机器身份拒绝。
- `POST /auth/permissions/refresh`：同源且具备 `auth.permission:update`，同步 Auth0 并更新当前节点缓存；不修改 Auth0 配置。权限响应一律 private/no-store。
- Dashboard 个人页和管理角色视图复用 `PermissionExplorer`，按 scope/resource/action 分级展示。个人“刷新我的权限”重新读取缓存；“刷新登录角色”走标准授权码流程更新 JWT 角色。角色管理页面仅链接 Auth0 编辑并提供缓存刷新，不保留本地授权编辑器。

## 交易流程配置权限

`GET /api/trading-workflow/config` 使用 `research.workspace:read`，`PUT` 使用 `research.workflow:update`。Gateway 仅执行路由准入与同源校验，Dashboard 校验节点树和配置版本；每日启用、完成与分支状态经 `/api/trading-workflow/day` 按用户及上海日期保存到 Dashboard D1；询价行、名单和备注留在浏览器。新增业务权限时按共享 AUTH 的 CLI 流程精确更新 Gateway API scope 和本站角色授权；发布后运行 `auth:verify -- --refresh-permissions` 并读取受影响接口，其他 Cloudflare 节点按现有缓存 TTL 更新。

## 测试分层与覆盖率

测试规范与覆盖率口径见 [TESTING](TESTING.md)。

## 全站管理员与通知

Auth0 本组织角色 `admin` 为全站管理员；`scripts/provision-site-admin.mjs plan/apply/verify` 精确定位 shiyue@18.cn 的现有组织成员，创建组织角色、赋予全部本站 scope 并核对该角色唯一成员。脚本保留其他角色/成员，不改变登录 Action、机器应用或 API audience。新角色在重新登录后进入签名 JWT；Gateway 同时要求角色 ID 出现在当前角色目录，普通角色的广泛 scope 不构成管理员身份。

管理个人页面 `/management/me`、`/management/permissions`、`/management/notifications` 和本人通知设置/设备 API 仅要求登录；原后台管理、权限缓存刷新和资金日报上传要求 admin。未知路由仍失败关闭。manifest、Service Worker、离线页与两张 PWA 图标使用精确公开白名单。

消息投递仅依据 Messenger D1 中保存的订阅、联系方式和设备；Gateway 不提供通知资格查询。通知设置页面的登录与角色边界仍由本站既有会话和路由管理，发送时不回查 Auth0。

## 融资客户名单

`/financing/clients` 的 GET 与 create/update named actions 复用 `financing.data:read/create/update`。借入资金导入仍使用 POST `/financing/data/import` 与 `financing.data:import`，旧 Workflow 状态路由已退役。Dashboard 负责字段、客户归属、并发与事务校验。
