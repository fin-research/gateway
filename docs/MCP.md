# Eastmoney MCP

## 当前统一入口

客户端直接连接 `https://eastmoney.hasbai.xyz/mcp`，使用 Streamable HTTP 与 Auth0 OAuth 授权码/PKCE。此链路不经过 Cloudflare MCP Portal，不加 `dashboard_` 前缀。连接配置与发布目录由 [Dashboard MCP](../../dashboard/docs/MCP.md) 维护。

Gateway 的 `/.well-known/oauth-protected-resource/mcp` 及根路径发现文档公开本站 API resource 与真实 Auth0 issuer。未登录 MCP 请求返回 401 和指向该文档的 `WWW-Authenticate`。Auth0 负责授权和 token；Gateway 不代理登录或签发 token。ChatGPT 和 Codex 自动使用已登记的官方 CIMD，不填写 client ID 或 secret。Auth0 原生开启 CIMD discovery 与 RFC9207，成功和错误回调均返回 issuer。动态 CIMD 与 DCR 保持关闭。

ChatGPT 新建 OAuth 连接只填写上述 MCP URL，高级 OAuth 设置留空。Codex 仅配置 `mcp_servers.eastmoney.url` 后执行 `codex mcp login eastmoney`；删除旧的显式 `oauth.client_id`、`callback_port` 配置。

精确客户端为 `https://chatgpt.com/oauth/client.json`（Auth0 内部 `tpc_a7WD9gnnwfLwzjTcG3aN8m`，ChatGPT 官方 private-key JWT）和 `https://chatgpt.com/oauth/codex/client.json`（`tpc_2WkMuCZoYq49waTvQZjJHK`，public PKCE）。ChatGPT 固定回调为 `https://chatgpt.com/connector_platform_oauth_redirect`；Codex 按 RFC8252 使用动态端口 loopback `/callback`。

两个第三方客户端分别拥有本站 API 的 user grant，不开放全体第三方默认授权。`eastmoney-email` 提升至 domain connection，本组织允许 third-party user flow，两个客户端仍强制组织登录。refresh token 轮换，最长30天、闲置7天。

Auth0 第三方 access token 会过滤保留字段 `email`；当前 `auth0/actions/login-claims.cjs` 对两个内部客户端 ID 写入签名的 `https://eastmoney.hasbai.xyz/identity`，校验组织、连接、18.cn 和邮箱验证。Gateway 仅在 `/mcp` 按两精确外部 `azp` 读取该身份，无顶层字段回退。网站仍使用原顶层声明。旧固定 MCP client 不再接受，新 CIMD 不准入普通 REST 或 `/data/mcp`。

程序化验收：`AUTH_TEST_ENV_FILE=<项目组.env> node --use-env-proxy scripts/verify-mcp-oauth.mjs`，覆盖发现、CIMD、成功/错误 issuer、真实账号 PKCE、签名身份、刷新、38工具及只读调用、普通 REST/Data 拒绝。二级池先读取可用日期，再查询当前年度可用区间；设置 `MCP_EVIDENCE_DIR` 可保存目录和二级池业务回包，不保存身份或凭据。ChatGPT private-key exchange 须由 ChatGPT 主机完成，HTTP 脚本仅验证其真实授权与回调。

标准点评统一为 `/api/commentaries`，读权限为 `research.policy:read`，人工写入保留既有 `research.policy_commentary:update`。旧 tracking 与政策点评接口移除，无别名。MCP 只提供已审核业务数据与人工操作，不发布 AI 生成工具；网站显式生成继续受原权限约束。

Gateway 使用无状态 MCP SDK 聚合 Dashboard 16 项与 Data 22 项候选工具，按应用返回的当前用户权限筛选目录；Schema 和业务执行留在应用层，通过 `GatewayDashboard` / `GatewayData` 命名 Service Binding 调用。二级池 `bond_ledger` 只读查询复用 `/bond` 的 `bond.ledger:read`，目录按权限筛选且执行时重新检查，不发布生成、写入或下载工具。Data 资讯列表命名 `news_list`，不发布 health、config、stock_summary。旧公网 `/api/mcp`、`/data/mcp` 返回410，无别名或重定向。内部应用路径仅供绑定调用。用户 token 不进入应用层，Data 使用 Gateway 注入的已验证用户与 Choice 准入上下文，不使用 InternalData、机器身份或 CAMEL 上下文。

## Cloudflare 门户历史配置

以下记录此前门户链路与资源配置，不作为当前 Dashboard 连接方式。

Eastmoney MCP 统一入口为 `https://eastmoney-mcp.hasbai.xyz/mcp`，由 Cloudflare MCP Portals 托管。`https://mcp.hasbai.xyz/mcp` 现由北极小站使用。
Gateway 不再聚合 MCP。旧 `https://eastmoney.hasbai.xyz/mcp` 返回 410 和新端点提示，不转发工具或登录凭据。
Data 单资源 MCP 保留在 `https://eastmoney.hasbai.xyz/data/mcp`，作为门户上游。REST、OpenAPI 和 MCP 复用 Data 的资源 Schema。

## 资源与认证

| 资源 | 地址/ID | 边界 |
|---|---|---|
| 托管门户 | `eastmoney-mcp.hasbai.xyz/mcp`。portal `eastmoney` | Cloudflare Access managed OAuth，允许已登录的 18.cn 账号 |
| Data 上游 | `eastmoney.hasbai.xyz/data/mcp`。server `data` | Auth0 逐用户 OAuth，`on_behalf=true`。Gateway 验证当前账号状态 |
| Dashboard 上游 | `eastmoney.hasbai.xyz/api/mcp`。server `dashboard` | Auth0 逐用户 OAuth，`on_behalf=true`。业务查询、修改与 AI 生成按当前用户路由权限执行 |
| 研究库上游 | `research.hasbai.xyz/mcp`。server `research` | AI Search research。不接入 credit 私密材料库 |
| 授信公开材料上游 | `eastmoney-credit-search.hasbai.xyz/mcp`。server `credit` | AI Search credit 的原生 `credit_search`。`on_behalf=false`，当前索引仅含 `credit/public/**` |

独立 Auth0 客户端 `eastmoney MCP portal`（`M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV`）用于门户 IdP
和 Data 上游授权。Auth0 post-login Action 对其应用本站相同的邮箱验证和 18.cn 限制。
Gateway 仅在 `/data/mcp` 和 Dashboard 业务 MCP `/api/mcp` 接受此客户端的 API JWT，不扩大到网站普通 REST、CAMEL 或管理接口。
既有网页客户端权限保持原范围。Quant 机器客户端已退役，Gateway 白名单为空。旧站点 Access 应用不恢复。

门户配置独立 IdP `Eastmoney MCP Auth0`。Data、Dashboard、research、credit 各有 `mcp` 类型 Access 应用，
通过 `via_mcp_server_portal` destination 约束门户内的工具访问，不在 Data 公网路径外再加 Access。
门户使用 `mcp_portal` 应用及 managed OAuth。动态客户端注册支持 localhost/loopback 回调，
Access token 15 分钟、grant session 14 天。ChatGPT 允许官方固定回调
`https://chatgpt.com/connector_platform_oauth_redirect` 和按连接器分配的
`https://chatgpt.com/connector/oauth/*`。通配仅限这个专用 OAuth 路径。

其他远端客户端需登记精确 HTTPS 回调。

Data 上游的 manual OAuth 配置通过 authorization endpoint 的 audience 参数请求本站 API token，
并使用 `openid profile email offline_access`。API 允许 offline access，门户客户端使用有期限的 refresh token。
普通网页客户端没有新增 refresh_token grant。门户保存的客户端 Secret 不回读、不写本地文件。

Code Mode 当前关闭。工具定义和执行由 Cloudflare 转发。研究查询由调用方显式提供
`published_at` 的 Unix 毫秒硬过滤和 `max_num_results=50`，遵循共享 AI 规范。
原生 `credit_search` 直接返回 AI Search 已索引片段，不经过 Dashboard `credit_public_search` 的
目录二次筛选、12 条结果上限和跨年度 ROE 核验。AI Search 的 R2 数据源必须持续限定为 `credit/public/**`。
门户 Access 应用只约束门户内的 Credit 工具，不代替原生自定义域名的独立访问保护。

## 配置所有权

- `scripts/configure-mcp-portal.mjs upstreams` 创建独立 IdP 与 Data manual OAuth 上游。
- `scripts/configure-mcp-portal.mjs applications` 建立门户及上游 Access 策略、映射和 DNS。
- `scripts/configure-mcp-portal.mjs client-redirects` 为已有门户补齐 ChatGPT DCR 回调白名单，保留完整应用配置、原白名单和登录策略。
- `scripts/configure-mcp-portal.mjs credit-plan/credit` 只读盘点或幂等登记原生授信搜索、18.cn Access 应用与 `on_behalf=false` 映射，保留其他上游设置。
- DNS 为 proxied CNAME `eastmoney-mcp.hasbai.xyz` → `gateway.agents.cloudflare.com`。
- Auth0 配置按[共享 AUTH](../../eastmoney/docs/AUTH.md#auth0-本地租户管理) 使用 Auth0 skill 和 CLI。数据库连接只针对门户客户端修改，保留已有客户端。
- Auth0 Action 发布只 patch code，保留 Secret、依赖和绑定。MCP client ID 与 Wrangler 配置同步。

Cloudflare 凭据按[项目组规则](../../eastmoney/docs/CLOUDFLARE.md)使用根目录未跟踪 `.env` 的
`CLOUDFLARE_API_TOKEN`。Node 脚本使用 `--env-file=../eastmoney/.env` 读取。不输出 Token。

## 验证

`pnpm check`、`pnpm deploy:dry`、Gateway 联调和真实账号 HTTP 验证覆盖旧入口退役、Data 用户
和机器边界。Cloudflare 门户需要单独验证 managed OAuth、上游用户授权和工具发现/调用。
没有执行的交互层、浏览器或生产 CPU 检查不能由配置成功替代。

ChatGPT 创建连接器报 `invalid_client_metadata: redirect_uri is not allowed by the account configuration`
表示 Cloudflare managed OAuth 的 DCR 回调白名单不包含 ChatGPT。使用具备
`Access: Apps and Policies Write` 权限的项目凭据运行 `client-redirects`。随后执行
`node --use-env-proxy scripts/verify-mcp-registration.mjs` 验证官方两类回调注册成功，
陌生域名、ChatGPT 非回调路径和相似前缀被拒绝。此操作更新门户 Access 应用的
`oauth_configuration.dynamic_client_registration.allowed_uris`，不修改 Auth0 上游回调。
HTTP 注册检查不等同于 ChatGPT 界面内完整连接验收。

2026-09-10 实测两类 ChatGPT 回调在修复前均复现上述 400。补齐白名单后均返回 201。
四项越界回调探针继续返回 400，原 18.cn/指定 IdP 策略和 15 分钟/14 天授权期限回读一致。

官方回调规范：[OpenAI Authentication](https://developers.openai.com/plugins/build/auth#redirect-url)。
白名单配置：[Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings)。

官方依据：[MCP Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)、
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。

## 2026-09-09 历史验收

以下结果记录当时 `mcp.hasbai.xyz` 承载 Eastmoney MCP 的状态。域名已迁至 `eastmoney-mcp.hasbai.xyz`；旧地址现由北极小站使用，以下地址和结果仅作历史证据。

- 门户服务器身份为 `cloudflare-mcp-portal`。匿名 `/mcp` 返回 401 和标准 OAuth metadata。
- `test@18.cn` 通过真实 Auth0 登录、Cloudflare managed OAuth PKCE 和 Data 逐用户授权。
- 门户列出 27 个工具：23 个 `data_*`、`research_search` 和 3 个 Cloudflare 管理工具。
- 经门户调用 `data_health` 返回 `ok`，`research_search` 在日期硬过滤和 50 条上限下返回成功。
- `scripts/verify-managed-mcp.mjs` 可复现以上流程。只使用程序化 HTTP，不执行浏览器。客户端公有 ID 可以在 `.ops` 缓存，Cookie、code、JWT、Secret 仅驻留进程内存。
- 本机代理曾对当时的 `mcp.hasbai.xyz` 产生 TLS 连接失败。直接连接已验证正常。该代理记录仅对应历史域名。
- Data 69 项、Gateway 44 项检查和真实后端处理器 32 项联调通过。自建聚合代码及依赖已移除，旧站点 `/mcp` 返回 410 和新地址。
- Cloudflare 先发送 `server/discover` / `2026-07-28`。当前 Hono MCP 返回 404 协商旧协议。Data 现保留该协议响应，不再误转换为 503，门户可回退并正常连接。
- 当次凭据可管理门户、Access、DNS 和 Gateway 发布。Data 手动发布曾因 VPC 权限返回 10196。修复经 Git 自动部署上线，最终以真实工具调用验收。
- 生产 Data MCP 已观测到冷请求 CPU 超过 Free 10ms 的样本，不能标记为 Free CPU 安全。本地基准不能替代这一结论。

### 首次连接状态恢复

初次配置时 Data 用户授权遇到协议错误。修复后已有授权会话可以列出和调用工具，但管理 API
仍为 `authentication_status=manual`、`status=waiting`、零工具且无成功同步时间。
普通重连复用已有授权，未补齐首次工具同步。`POST .../servers/data/sync` 对 manual OAuth
返回 `success=false`、`status=waiting`。此模式应重新完成上游用户授权，不能套用自动 OAuth 的管理员凭据同步流程。

2026-09-09 15:51:37 UTC，程序化退出 `test@18.cn` 的 Data 上游授权并重新授权后，管理 API
已回读 `status=ready`、23 个工具和成功同步时间。统一门户仍返回 27 个工具，`data_health`
与 `research_search` 实际调用成功。Data 保留逐用户 OAuth，门户 `on_behalf=true`，未写入共享用户 JWT。

恢复命令（仅重建测试账号的 Data 授权）：

```sh
NO_PROXY=eastmoney-mcp.hasbai.xyz node --env-file=../eastmoney/.env --use-env-proxy scripts/verify-managed-mcp.mjs --reauthorize-data --check-catalog
```

通过 Node 的 `--env-file` 执行上述命令，并对进程设置 `NO_PROXY`。
`--check-catalog` 需要 `MCP Portals Read` 或 `Write` 权限：核对后台 Ready、成功同步时间及实时工具目录。

Cloudflare 的 manual OAuth 能力快照只在首位用户授权时捕获，后续同步不会刷新。Data 和 Dashboard
后台快照与当前用户目录的差异会明确报告，但不作为用户调用失败。原生 Credit 的后台目录则须与实时目录一致。
密码、Cookie、OAuth code 和 Token 仅在进程内存中处理。不要退出其他用户、关闭 Require user auth，
或把用户 JWT 写成共享管理员凭据来消除 Waiting。

依据：[manual OAuth 首次授权与同步限制](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#configure-manual-oauth-credentials)。

## Dashboard 业务上游

Dashboard 使用 SvelteKit + Cloudflare Agents MCP SDK v2，接口与工具目录由 [Dashboard MCP](../../dashboard/docs/MCP.md) 维护。Gateway `src/mcp-bridge.ts` 通过既有 IDENTITY 私有 binding 接收 `/mcp/policies` 和 `/mcp/dispatch`。每次按当前角色缓存和真实 route/action policy 校验，再经 `GatewayDashboard` 执行原业务 handler。没有新服务账户、JWT 转发或公开桥接入口。匿名/Quant 拒绝。专用 Portal JWT 的范围仅新增 `/api/mcp`。

运行 `node --env-file=../eastmoney/.env --use-env-proxy scripts/configure-mcp-portal.mjs dashboard` 可幂等添加上游、其 18.cn/专用 IdP Access 应用和 `on_behalf=true` 映射。保留现有 Data/研究库和工具策略。Gateway 授权桥接先发布，再发布 Dashboard，最后配置门户。

程序化验收：`AUTH_TEST_ENV_FILE` 指向项目组未跟踪 `.env`，运行 `NO_PROXY=eastmoney-mcp.hasbai.xyz node --use-env-proxy scripts/verify-managed-mcp.mjs --dashboard --check-catalog`。检查 managed OAuth、三个上游、Dashboard 业务读取、无效写入拒绝和后台 Ready。这个只读/无效输入验收不等于真实写入或每个 AI 工具逐项执行。

## Credit AI Search 原生上游

2026-09-27 接入独立 `credit` MCP server，门户工具名为 `credit_search`。配置前盘点 `credit` AI Search
的 13 个索引 Item、512 个分块均来自 R2 `eastmoney/credit/public/**`，其他前缀为零。索引范围变化时须重查。
上游使用原生搜索而非 Dashboard 包装工具，因此返回的是检索片段，不代表已核实主体、报告期、口径或页码。

`credit-plan` 只读核对现有 server、Access 应用和门户映射。`credit` 幂等新增缺失配置，并回读确认
Data、Dashboard、research 映射不变。门户内 Credit Access 应用允许通过专用 IdP 登录的 18.cn 账号。
当前原生自定义域名没有独立 Access 应用。此前未认证命令行请求收到 Cloudflare 1010 浏览器签名拦截，
这不是身份认证证明。直接访问边界须按公开 PDF 范围维护，不得把私密授信材料加入该实例。

在 Gateway 仓库使用程序化登录验收：

```sh
NO_PROXY=eastmoney-mcp.hasbai.xyz node --env-file=../eastmoney/.env --use-env-proxy scripts/verify-managed-mcp.mjs --dashboard --credit --check-catalog
```

该命令确认四个上游连接、
`credit_search` 工具发现和只读检索、Credit 后台 Ready 且目录与用户目录一致。检索片段正文不写日志。
Data/Dashboard manual OAuth 的后台能力快照可滞后于用户目录。例如 Data 后台仍为 2026-09-09 的
23 项，当前用户可见 25 项，新增的是 `data_trading_days`、`data_chinamoney_shibor`。
