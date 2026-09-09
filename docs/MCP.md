# MCP 入口

`https://eastmoney.hasbai.xyz/mcp` 聚合 Data 与研究库 AI Search，独立 Data 入口为
`https://eastmoney.hasbai.xyz/data/mcp`。使用 Hono MCP 的 Streamable HTTP、无状态 JSON
响应。每次请求重新验证 Auth0 账号；所有有效登录用户均可访问。Quant 机器 scope 不扩展到 MCP。

客户端携带本站 Auth0 API Bearer JWT，或 Gateway 会话 Cookie（POST 必须带本站 Origin）。
没有开放动态 OAuth 客户端注册，不能假定只粘贴 URL 就能交互登录。GET/DELETE 在认证后
返回 405，通知返回 202，请求体上限 64 KiB。

| 前缀 | 端点 | 边界 |
|---|---|---|
| `data_` | DATA → GatewayData `/data/mcp` | 命名 binding 和 verdict；不走公网回环 |
| `search_` | `https://research.hasbai.xyz/mcp` | research 的 search；不转发用户凭据，不接入 credit |

工具定义从上游动态读取；来源前缀防止重名，调用保留上游参数 Schema。禁止客户端指定上游
URL，连接/调用分别限时 60 秒，分页有界。列表失败显式报错，执行失败返回 `isError`。
研究查询按共享 AI 规范提供 `published_at` 硬过滤及 `max_num_results=50`。

## 托管门户目标与阻断

用户指定 `mcp.hasbai.xyz`，客户端目标 `https://mcp.hasbai.xyz/mcp`。Cloudflare 托管门户
依赖独立 Access 应用，不恢复本站旧 Access 应用，也不移动站点现有 Worker 路由。

- 门户 ID `eastmoney`，proxied CNAME `mcp.hasbai.xyz` → `gateway.agents.cloudflare.com`。
- 上游 `data`：本站 `/data/mcp`，用户 Auth0 OAuth，mapping `on_behalf: true`；禁止长期保存短期用户 JWT 或改成匿名。
- 上游 `research`：`https://research.hasbai.xyz/mcp`，保留上游域名限制。
- 门户及两项服务器的 Access 策略允许已登录 `18.cn` 用户。
- Data OAuth 尚需配置 API audience、客户端、精确 portal callback 和 discovery，再通过程序化 HTTP 验证；Cookie 不跨域复用。

2026-09-09 实测：旧 `search.hasbai.xyz/mcp` 返回 Cloudflare 1014；AI Search 实例已绑定
`research.hasbai.xyz` 且关闭默认域名，新地址 initialize/tools/list 均为 200。
根目录两枚旧 Cloudflare Token 的 verify 均返回 401 `Invalid API Token`；Wrangler OAuth
可读取 Workers/AI Search，但门户和 DNS API 返回 403/10000。尚未创建托管门户、DNS 或其 Access 应用。

有效 Token 放在项目组未跟踪 `.env` 的 `CLOUDFLARE_MCP_API_TOKEN`，权限包括 MCP Portals
Write、MCP Servers Write、Access 应用/策略编辑和 hasbai.xyz DNS 编辑。
运行 `node --use-env-proxy scripts/mcp-portal-preflight.mjs` 只读盘点；工作树设置 `EASTMONEY_ENV_FILE`。

参考：[Cloudflare MCP portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)、
[Create portal](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/ai_controls/subresources/mcp/subresources/portals/methods/create/)、
[AI Search MCP](https://developers.cloudflare.com/ai-search/api/search/mcp/)。
