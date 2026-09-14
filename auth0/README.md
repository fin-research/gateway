# Auth0 配置

Auth0 的本站应用 `eastmoney` 使用自定义登录域 `auth.hasbai.xyz`；管理 API 使用原租户域 `hasbai.eu.auth0.com`。Gateway 拥有 `/auth/login`、`/auth/callback` 和退出流程，Auth0 API audience 为 `https://eastmoney.hasbai.xyz/`。API 不接受 ID token 或 Cloudflare Access JWT。

`actions/eastmoney-login.cjs` 保留 18.cn、迁移账号邮箱绑定、未验证邮箱提示与禁止旧事务 continue 的规则；向 API token 添加 `user` 对象，包含 `roles`、`profile`、`email`；Gateway 使用 Auth0 原始签名 token，并通过 `user.email` 核对回调身份。`sub` 使用 Auth0 原生主键。

其余注册 Action、中文主题、Hosted Form 与提示文案保留原业务流程。`eastmoney-signup-profile` 仍只处理新账号 pending 标记；姓名和部门不会授予权限或自动关联业务负责人。

租户声明配置先按共享 AUTH 显式 export/plan/apply，禁止删除其他资源。常规 Action 发布只变更目标 code，保留当前 Secret、依赖和 post-login 绑定；凭据合并使用下述专用流程，禁止覆盖其他未发布草稿。部署前后读取当前配置验证，不能以本地 Action 文件推断线上状态。

Quant 使用独立机器应用 `eastmoney quant gateway`；只授予 Gateway API 的 `data.choice:read`，不授予 Auth0 Management API 或用户角色。Secret 不进入 Git、文档、浏览器或日志。

具体发布与回退见 [DEVELOPMENT](../docs/DEVELOPMENT.md)。

## 登录时长与弹窗

本站 API `https://eastmoney.hasbai.xyz/` 的 `token_lifetime`、`token_lifetime_for_web` 为 `86400` 秒；Gateway 会话最长 24 小时且不超过 Access Token 的有效期。既有 token/cookie 不追溯延长，下一次登录生效。该 API 的机器 token 使用同一个 lifetime 配置，机器访问范围与客户端白名单保持原边界。

`/auth/login?popup=<32–64 位随机 ID>` 将 popup ID 与 state、nonce、PKCE 一起写入加密事务。回调仅从已验证事务读取 ID；成功设置 HttpOnly Cookie，再输出无凭据的 HTML 完成通知。回调页面使用 nonce CSP、no-store 和 no-referrer，清除地址栏 OAuth 参数；父页校验消息后重新读取 `/auth/session`。普通直接访问的重定向登录流程继续可用。

令牌时长变更使用 Deploy CLI 导出 `resourceServers`，只修改本站 API 两个 lifetime 字段，保留导出中其他 API 原配置；plan 确認仅本站 API 更新后 apply，并再次 export 回读。

## Eastmoney 组织隔离

网站与 MCP 用户登录绑定 `org_6yvoRRCkzk3eGkBS`，Gateway 校验 `org_id`；账号目录和成员角色使用本组织范围。当前套餐不支持 M2M Organizations，Quant 保留单独 Choice 白名单。应用盘点、迁移、套餐限制与回退见 [组织与应用边界](../docs/AUTH0_ORGANIZATIONS.md)。

## 统一 Gateway M2M

`eastmoney gateway management` 复用原 Gateway identity management 的 client ID 和 Secret，声明为 `gateway-management-client.yaml`。Gateway 的 `AUTH0_MANAGEMENT_*`、登录 Action 的 `ROLES_CLIENT_*`、注册资料 Action 的 `PROFILE_CLIENT_*` 使用同一凭据。Secret 名保留以兼容现有 Action；Secret 值不写入声明文件。

合并流程（在 Gateway 工作树运行，根 `.env` 通过 `AUTH_TEST_ENV_FILE` 指定）：

1. 显式 `auth0:export -- --include=clients,clientGrants,actions,forms,flows,flowVaultConnections --output=.auth0-deploy/m2m-before`，再执行 `node --use-env-proxy scripts/consolidate-management-clients.mjs plan` 保存无 Secret 快照。
2. 对 `auth0/gateway-management-client.yaml` 执行 `auth0:plan` / `auth0:apply -- --include=clients,clientGrants`，回读确认复用原 client ID。
3. 执行 `consolidate-management-clients.mjs switch` 预览，再加 `--apply`。脚本使用 Deploy CLI 仅导入两个 Action；Secret 从管理 API 读入进程内，通过 keyword mappings 环境变量传入，文件只有占位符。保留代码、Form、依赖和绑定顺序。
4. 运行 `node --use-env-proxy scripts/verify-management-client.mjs`。它使用 test@18.cn 和统一凭据读取目录，并用线上 Action 代码调用真实管理 API：重复授予已有基础角色、按原值保存姓名部门，回读确认资料和角色不变。该验证不是完整 Hosted Form 提交。随后运行 `pnpm auth:verify -- --refresh-permissions` 验证真实 HTTP 登录和 Gateway 权限。
5. `consolidate-management-clients.mjs disable` 检查验证证据；对 `.auth0-deploy/m2m/disable.yaml` 执行显式 clients/clientGrants plan/apply。停用后运行 `verify-management-client.mjs --retired`，确认旧应用 token 被拒绝、新会话真实登录正常；全部通过才运行 `consolidate-management-clients.mjs delete` 预览并加 `--apply` 删除这两个精确 ID。全租户删除开关始终关闭。

`prepare-organization-migration.mjs` 保留历史实现但入口已退役，运行会在生成配置前终止，防止迁移前快照重新创建旧应用。当前 RBAC 和登录发布脚本只引用统一应用。Dashboard 的旧注册发布入口退役，后续注册资料配置归 Gateway 管理。

旧应用删除前可按快照恢复其 grant_types/scopes 并回切两个 Action；删除后旧 client ID 无法恢复，应修复统一应用或重新创建凭据并同步 Action。已经签发的旧管理 token 按其原有效期自然失效。
