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
