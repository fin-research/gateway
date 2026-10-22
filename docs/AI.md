# 通用 Responses API

`POST https://eastmoney.hasbai.xyz/api/ai/responses` 由 Gateway 直接处理。OpenAI 兼容客户端的 base URL 为 `https://eastmoney.hasbai.xyz/api/ai`。

必须携带 `Authorization: Bearer <本站用户 Access JWT>`。沿用本站 Auth0 issuer、audience、客户端、组织、用户和角色校验，不要求额外业务权限。匿名、过期 token、ID token、机器 token 和 Cookie 身份均拒绝。

允许任意来源 CORS，包括 `Origin: null`。预检 OPTIONS 无需 token，返回 204；实际 POST 必须携带本站 Bearer。响应回显 Origin 并允许 credentials，兼容 `credentials:"include"`；Cookie 仍不用于认证。程序调用可省略 Origin。此规则仅适用于本接口，其他写接口保持同源要求。

请求必须使用 `Content-Type: application/json`，不兼容 `text/plain`；即使正文是 JSON 字符串，使用 `text/plain;charset=UTF-8` 仍返回 415。

```sh
curl https://eastmoney.hasbai.xyz/api/ai/responses \
  -H "Authorization: Bearer $SITE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6-luna","input":"你好","stream":false}'
```

## 参数与响应

| 字段 | 契约 |
| --- | --- |
| `input` | 必填；字符串或 Responses 输入数组。完整消息、函数调用及函数结果由调用方传入 |
| `model` | 可省略，固定 `gpt-6-luna`，Provider 为 `custom-codex` |
| `stream` | 默认 JSON；`true` 返回原生 Responses SSE |
| `instructions` / `text` | 原生指令与输出格式，支持 `json_schema` |
| `tools` | `function`、`web_search`。函数由调用方执行，Gateway 不执行工具 |
| `tool_choice` / `parallel_tool_calls` | 原生工具选择与并行控制 |
| `reasoning` | effort 默认 `xhigh`，允许 `none/minimal/low/medium/high/xhigh`，具体模型支持情况以上游为准。固定 summary=`auto`、context=`current_turn` |
| 其他 | 支持 `metadata`、`prompt_cache_key`、`service_tier`、`include`、`truncation:"disabled"` |

兼容 SDK 的 `store:false`、`background:false`、空 `previous_response_id` / `conversation`，这些字段不发送上游。移除 SDK 自动添加的 `reasoning.encrypted_content` include。

拒绝远端会话、托管 Prompt、`item_reference`、Provider `file_id`、其他托管工具、`max_output_tokens` 和未登记顶层字段，防止引用共享 Provider 账户对象。

请求 JSON 最多 1 MiB，JSON 响应及单个 SSE 事件最多 16 MiB。超限失败，不截断内容。完整模型调用限时 5 分钟；调用方取消会中止上游。

JSON/SSE 保留 Responses 成功结构和工具循环事件。HTTP 200 中仍可能有 `response.failed` / `error`，调用方必须检查终态。

本站 token 不转发上游。上游 HTTP 401/403 和重定向映射为 502，其余 HTTP 错误保留状态。HTTP 错误正文及 JSON/SSE 的错误字段返回稳定公开信息；可用时保留 `cf-aig-log-id`。响应为 private/no-store/no-transform，不转发上游 Cookie、Location 或身份头。

通用转发不自动重试，调用方按业务幂等性决定重试。Dashboard/Ingest/Data 业务适配器的重试规则保持原有契约。

## 配置与验证

Wrangler vars 为 `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID`；Worker Secret 为 `CF_AIG_TOKEN`。Provider 密钥及 base URL 由 Cloudflare AI Gateway 的 BYOK 管理。`enable_request_signal` 支持客户端断连取消上游。应用日志不记录凭据及完整输入输出。

验证命令见 [DEVELOPMENT](DEVELOPMENT.md)。发布后执行 `pnpm auth:verify -- --ai`，复用一次真实本站登录，检查跨域预检、匿名/无效 token 拒绝、text/plain 的 415，以及跨域结构化 JSON 和两轮原生 SSE 函数调用。此选项会执行三次小型模型生成，不访问外部工具或写入业务数据。
