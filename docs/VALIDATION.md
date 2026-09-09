# Gateway 重构验收记录

2026-09-09 完成代码集成、Auth0 配置和生产切换。此记录描述本次实际执行结果，不代替后续线上巡检。

## 已交付边界

- 公网仅 `eastmoney.hasbai.xyz/*` → `eastmoney-gateway`，路由 `request_limit_fail_open=false`；旧 Data 更具体路由已删除。
- Dashboard/Data 没有公网 route 或 Custom Domain，workers.dev 与 preview 均关闭，默认 fetch 404。携带伪造上下文的 Data version preview 请求也返回 404。
- Gateway 通过命名 `GatewayDashboard` / `GatewayData` 分发；Dashboard 的私有目录/角色配置调用 `IdentityService`，Dashboard/Ingest 原 `InternalData` 保持不变。
- Auth0 web callback 仅本站 `/auth/callback`，logout 仅本站根地址。登录 Action 的 API email claim 已发布并回读；角色及成员关系未修改。
- 本站 Access 应用已删除，旧 Quant Access Service Token 经检查无其他应用引用后撤销。Quant `.env` 已迁移为独立 Auth0 机器凭据。
- Dashboard 不再持有任何 Auth0 var 或管理 Secret；权限 Hyperdrive 仅由 Gateway 使用，已核对 `caching.disabled=true`。
- `AUTHORIZATION_MODE=beta-open` 保持原状。本次不将内测账号成功解释为正式多角色矩阵的真实账号验收。

## 实际验证

| 层次 | 结果 |
|---|---|
| Gateway | typegen、typecheck、38 项单元测试、部署 dry-run、diff 检查通过 |
| Dashboard | typecheck、441 项测试、生产构建、diff 检查通过 |
| Data | typegen、OpenAPI、typecheck、54 项测试、dry-run、CPU benchmark、startup profile、diff 检查通过 |
| Quant | 87 项测试、compileall、两组 Ruff、数据安全与 diff 检查通过 |
| Gateway → SvelteKit/Data | 32 项真实 handler 联调通过；外部服务模拟 |
| Gateway → 融资业务 | 40 项真实构建/PGlite 联调通过；角色配置、409、记录归属和 RLS 通过；47 次连接全部关闭，峰值 1 |
| 真实用户 | `test@18.cn` 经 Auth0 HTTP 表单完成登录；64 个匿名/登录只读探针通过，账号资料确认成功，有效权限 58 |
| 真实机器 | Quant 客户端 CSS/CTR 缺参数请求返回 422；机器访问 `/api/profile`、`/data/camel` 返回 403，没有消费 Choice 查询额度 |
| 退出与绕过 | 固定 Auth0 logout target、忽略外部 returnTo、清除会话 Cookie；两个默认 workers.dev 与 Data version preview 均 404 |
| VPC | DM 网络可达，未带业务凭据的 smoke 返回上游 401；Choice health 200 / `choice.rpc.v1`；CAMEL login 200；临时 smoke Worker 已删除 |

权限验收全程程序化 HTTP、单元测试或 CLI，未使用 browser/Chrome/Playwright。没有执行模型更新、真实业务写入、发送测试邮件或调整用户角色。Data CPU profile 是本机启动测量，未据此宣称生产路由 CPU 达标。

## 切换版本与提交

- Gateway 首轮生产版本：`f79b53e1-de4a-43e0-9bf2-db379153aa4a`。
- Dashboard 首轮私有入口版本：`a03ad712-0a31-49ef-ae13-14612f5910b6`；随后删除旧 Secret，核对到版本 `c0f6cddd-911d-42d9-afb6-c73183bc0b4b`。
- Data 首轮私有入口版本：`601ed222-1ffa-43a7-b8b8-434d361ccafb`；后续生产回读核对到版本 `50260df3-284e-4623-af7c-a845bec70f48`。
- 代码提交：Gateway `3e02f17`，Dashboard `8a61ef9`，Data `eeaeed3`，Quant `86abbd6`；后续文档和运维脚本整理单独提交。四个仓库均已推送 main，项目组共享文档另在非 Git 根目录更新。

生产版本会随后续 Git 构建变化，以上是本次有回读证据的版本，不代表永久固定版本。
