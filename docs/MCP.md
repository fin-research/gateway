# Cloudflare MCP 门户

项目唯一统一入口为 `https://mcp.hasbai.xyz/mcp`，由 Cloudflare MCP Portals 托管。
Gateway 不再聚合 MCP；旧 `https://eastmoney.hasbai.xyz/mcp` 返回 410 和新端点提示，不转发工具或登录凭据。
Data 单资源 MCP 保留在 `https://eastmoney.hasbai.xyz/data/mcp`，作为门户上游；REST、OpenAPI 和 MCP 复用 Data 的资源 Schema。

## 资源与认证

| 资源 | 地址/ID | 边界 |
|---|---|---|
| 托管门户 | `mcp.hasbai.xyz/mcp`；portal `eastmoney` | Cloudflare Access managed OAuth，允许已登录的 18.cn 账号 |
| Data 上游 | `eastmoney.hasbai.xyz/data/mcp`；server `data` | Auth0 逐用户 OAuth，`on_behalf=true`；Gateway 验证当前账号状态 |
| 研究库上游 | `research.hasbai.xyz/mcp`；server `research` | AI Search research；不接入 credit 私密材料库 |

独立 Auth0 客户端 `eastmoney MCP portal`（`M1a5PF3UJaFIZv1k4HO4IV06Z5fXQBHV`）用于门户 IdP
和 Data 上游授权。Auth0 post-login Action 对其应用本站相同的邮箱验证和 18.cn 限制。
Gateway 仅在 `/data/mcp` 接受此客户端的 API JWT，不扩大到 Dashboard、CAMEL 或通用 REST。
既有网页客户端和 Quant 机器权限保持原范围；旧站点 Access 应用不恢复。

门户配置独立 IdP `Eastmoney MCP Auth0`。Data、research 各有 `mcp` 类型 Access 应用，
通过 `via_mcp_server_portal` destination 约束门户内的工具访问，不在 Data 公网路径外再加 Access。
门户使用 `mcp_portal` 应用及 managed OAuth；动态客户端注册支持 localhost/loopback 回调，
Access token 15 分钟、grant session 14 天。其他远端客户端需登记精确 HTTPS 回调。

Data 上游的 manual OAuth 配置通过 authorization endpoint 的 audience 参数请求本站 API token，
并使用 `openid profile email offline_access`。API 允许 offline access，门户客户端使用有期限的 refresh token；
普通网页客户端没有新增 refresh_token grant。门户保存的客户端 Secret 不回读、不写本地文件。

Code Mode 当前关闭。工具定义和执行由 Cloudflare 转发；研究查询由调用方显式提供
`published_at` 的 Unix 毫秒硬过滤和 `max_num_results=50`，遵循共享 AI 规范。

## 配置所有权

- `scripts/configure-mcp-portal.mjs upstreams` 创建独立 IdP 与 Data manual OAuth 上游。
- `scripts/configure-mcp-portal.mjs applications` 建立门户及上游 Access 策略、映射和 DNS。
- DNS 为 proxied CNAME `mcp.hasbai.xyz` → `gateway.agents.cloudflare.com`。
- Auth0 配置经显式资源 Deploy CLI export/plan/apply；数据库连接仅追加门户客户端，保留已有客户端。
- Auth0 Action 发布只 patch code，保留 Secret、依赖和绑定；MCP client ID 与 Wrangler 配置同步。

Cloudflare 凭据遵循项目组 AGENTS 的 Keychain 规则。`scripts/cloudflare-task-session.py` 只用账户级
Root Token 管理短期任务 Token，资源操作由子进程环境中的派生 Token 完成；所有值只驻留进程内存。
脚本接受 stdin JSON 的 `run` / `api` 命令，收到 `close` 或 EOF 撤销 Token。禁止把任何 Cloudflare
Token 写入 `.env`、命令参数或临时文件。`mcp-portal-preflight.mjs` 从派生子进程环境读取 Token。

## 验证

`pnpm check`、`pnpm deploy:dry`、Gateway 联调和真实账号 HTTP 验证覆盖旧入口退役、Data 用户
和机器边界。Cloudflare 门户需要单独验证 managed OAuth、上游用户授权和工具发现/调用。
没有执行的交互层、浏览器或生产 CPU 检查不能由配置成功替代。

官方依据：[MCP Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)、
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、
[账户 Token 签发](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)。

## 2026-09-09 实际验收

- 门户服务器身份为 `cloudflare-mcp-portal`；匿名 `/mcp` 返回 401 和标准 OAuth metadata。
- `test@18.cn` 通过真实 Auth0 登录、Cloudflare managed OAuth PKCE 和 Data 逐用户授权。
- 门户列出 27 个工具：23 个 `data_*`、`research_search` 和 3 个 Cloudflare 管理工具。
- 经门户调用 `data_health` 返回 `ok`，`research_search` 在日期硬过滤和 50 条上限下返回成功。
- `scripts/verify-managed-mcp.mjs` 可复现以上流程；只使用程序化 HTTP，不执行浏览器。客户端公有 ID 可以在 `.ops` 缓存，Cookie、code、JWT、Secret 仅驻留进程内存。
- 本机代理曾对新域名产生 TLS 连接失败；直接连接已验证正常。必要时仅对子进程设置 `NO_PROXY=mcp.hasbai.xyz`，不改门户配置绕过认证。
- Data 69 项、Gateway 44 项检查和真实后端处理器 32 项联调通过。自建聚合代码及依赖已移除，旧站点 `/mcp` 返回 410 和新地址。
- Cloudflare 先发送 `server/discover` / `2026-07-28`；当前 Hono MCP 返回 404 协商旧协议。Data 现保留该协议响应，不再误转换为 503，门户可回退并正常连接。
- 短期账户 Token 可管理门户、Access、DNS 和 Gateway 发布。Data 手动发布曾因 VPC 权限返回 10196；修复经 Git 自动部署上线，最终以真实工具调用验收。
- 生产 Data MCP 已观测到冷请求 CPU 超过 Free 10ms 的样本，不能标记为 Free CPU 安全；本地基准不能替代这一结论。

### 首次连接状态恢复

初次配置时 Data 用户授权遇到协议错误；修复后已有授权会话可以列出和调用工具，但管理 API
仍为 `authentication_status=manual`、`status=waiting`、零工具且无成功同步时间。
普通重连复用已有授权，未补齐首次工具同步；`POST .../servers/data/sync` 对 manual OAuth
返回 `success=false`、`status=waiting`。此模式应重新完成上游用户授权，不能套用自动 OAuth 的管理员凭据同步流程。

2026-09-09 15:51:37 UTC，程序化退出 `test@18.cn` 的 Data 上游授权并重新授权后，管理 API
已回读 `status=ready`、23 个工具和成功同步时间；统一门户仍返回 27 个工具，`data_health`
与 `research_search` 实际调用成功。Data 保留逐用户 OAuth，门户 `on_behalf=true`，未写入共享用户 JWT。

恢复命令（仅重建测试账号的 Data 授权）：

```sh
NO_PROXY=mcp.hasbai.xyz node --use-env-proxy scripts/verify-managed-mcp.mjs --reauthorize-data --check-catalog
```

通过 `cloudflare-task-session.py` 的 `run` 子进程执行上述 Node 命令，并以 `env` 设置 `NO_PROXY`。
`--check-catalog` 使用派生 Token 的 `MCP Portals Read` 或 `Write` 权限，只读核对后台 Ready、
成功同步时间及目录与当前用户工具是否一致；平时可单独使用该选项，省略 `--reauthorize-data`。
密码、Cookie、OAuth code 和 Token 仅在进程内存中处理。不要退出其他用户、关闭 Require user auth，
或把用户 JWT 写成共享管理员凭据来消除 Waiting。

依据：[manual OAuth 首次授权与同步限制](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#configure-manual-oauth-credentials)。
