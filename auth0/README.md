# Auth0 配置

Auth0 的本站应用 `eastmoney` 使用自定义登录域 `auth.hasbai.xyz`；管理 API 使用原租户域 `hasbai.eu.auth0.com`。Dashboard 客户端拥有 `/auth/login`、`/auth/callback` 和退出页面，Auth0 SPA SDK 执行 PKCE，Gateway 只验签及授权，Auth0 API audience 为 `https://eastmoney.hasbai.xyz/`。API 不接受 ID token 或 Cloudflare Access JWT。

当前 post-login 绑定为注册资料 Action 和 `login claims`（`35884b07-e1f4-4ab8-b66c-0325d5a055e4`）。后者添加顶层 `username`、`email`、`role` 字符串、`_roles` 角色名称数组，以及本站组织可选的 `department`、`picture`；拒绝封禁账号和未验证邮箱。`role` 供数据库使用，不用于 Gateway 业务授权；`_roles` 在 Gateway 按组织权限缓存解析为角色 ID。Gateway 接收 `Authorization: Bearer` 中的 Auth0 原始签名 token，`sub` 使用 Auth0 原生主键。

`actions/eastmoney-login.cjs` 和 `scripts/publish-login-claims.mjs` 保留旧 nested `user` 协议的历史实现；不要重新发布或恢复旧绑定。旧 nested `user` 和 URL namespace token 一律拒绝。基础角色由 Auth0 成员关系管理，当前 Action 不自动分配。

其余注册 Action、中文主题、Hosted Form 与提示文案保留原业务流程。`eastmoney-signup-profile` 仍只处理新账号 pending 标记；姓名和部门不会授予权限或自动关联业务负责人。

本地租户管理按[共享 AUTH](../../eastmoney/docs/AUTH.md#auth0-本地租户管理) 使用 Auth0 skill 和 `auth0` CLI，先复用已有授权、读取目标当前配置，再执行精确变更并回读。常规 Action 发布只变更目标 code，保留当前 Secret、依赖和 post-login 绑定；禁止覆盖其他会话的未发布草稿。不能以本地 Action 文件推断线上状态。

Quant 旧机器应用 `eastmoney quant gateway` 已退役；Gateway 的机器客户端白名单为空。若将来恢复机器 Choice 调用，须重新建立精确的应用、scope 和白名单，并验证 Quant 调用链；Secret 不进入 Git、文档、浏览器或日志。

具体发布与回退见 [DEVELOPMENT](../docs/DEVELOPMENT.md)。

## SPA 登录与 token

现有 `eastmoney` 客户端改为 `spa`、`token_endpoint_auth_method=none`，没有 M2M grant。保留本站 callback、logout URL、web origins、organization 和授权码 grant。Auth0 SPA SDK 负责 PKCE/state/nonce、弹窗与重定向登录，token 仅在浏览器内存中；刷新后尝试 Auth0 静默恢复，失败则重新登录。用户 token 时长由 API 配置控制，Gateway 依签名 `exp` 校验。

Gateway 不再保存或消费 `__Host-eastmoney_session`，不再提供 `/auth/session`。`/auth/permissions` 返回有效权限和缓存时间；姓名、邮箱、部门、头像及 `_roles` 展示从当前 JWT 解析。旧 Cookie 仅在后续响应清理，不能创建登录身份。

切换需先通过 Dashboard 构建、Gateway 检查和真实 handler 集成，先部署已合并 Dashboard 并核对线上版本及 CSR 页面，再部署已验证 Gateway，最后精确更新 Auth0 客户端公开 SPA 配置并回读，运行公开客户端 PKCE 的 HTTP Bearer 登录验收。若需回退，先恢复 Gateway 的保护边界，再回退 Dashboard。不得重放旧 Action 或全租户导出。

## Eastmoney 组织隔离

网站与 MCP 用户登录绑定 `org_6yvoRRCkzk3eGkBS`，Gateway 校验 `org_id`；账号目录和成员角色使用本组织范围。当前套餐不支持 M2M Organizations；旧 Quant Choice 白名单已清空。应用盘点、迁移、套餐限制与回退见 [组织与应用边界](../docs/AUTH0_ORGANIZATIONS.md)。

## 统一 Gateway M2M

`eastmoney gateway management` 复用原 Gateway identity management 的 client ID 和 Secret，声明为 `gateway-management-client.yaml`。Gateway 的 `AUTH0_MANAGEMENT_*` 与注册资料 Action 的 `PROFILE_CLIENT_*` 使用同一凭据；历史登录 Action 的 `ROLES_CLIENT_*` 已不在当前登录链路。Secret 名保留以兼容现有 Action；Secret 值不写入声明文件。

以下是已完成的历史合并流程，依赖当时的 Deploy CLI 机器凭据，不是新的租户管理入口；不得用它重新导入旧快照（当时在 Gateway 工作树运行，根 `.env` 通过 `AUTH_TEST_ENV_FILE` 指定）：

1. 显式 `auth0:export -- --include=clients,clientGrants,actions,forms,flows,flowVaultConnections --output=.auth0-deploy/m2m-before`，再执行 `node --use-env-proxy scripts/consolidate-management-clients.mjs plan` 保存无 Secret 快照。
2. 对 `auth0/gateway-management-client.yaml` 执行 `auth0:plan` / `auth0:apply -- --include=clients,clientGrants`，回读确认复用原 client ID。
3. 执行 `consolidate-management-clients.mjs switch` 预览，再加 `--apply`。脚本使用 Deploy CLI 仅导入两个 Action；Secret 从管理 API 读入进程内，通过 keyword mappings 环境变量传入，文件只有占位符。保留代码、Form、依赖和绑定顺序。
4. 运行 `node --use-env-proxy scripts/verify-management-client.mjs`。它使用 test@18.cn 和统一凭据读取目录，并用线上 Action 代码调用真实管理 API：重复授予已有基础角色、按原值保存姓名部门，回读确认资料和角色不变。该验证不是完整 Hosted Form 提交。随后运行 `pnpm auth:verify -- --refresh-permissions` 验证真实 HTTP 登录和 Gateway 权限。
5. `consolidate-management-clients.mjs disable` 检查验证证据；对 `.auth0-deploy/m2m/disable.yaml` 执行显式 clients/clientGrants plan/apply。停用后运行 `verify-management-client.mjs --retired`，确认旧应用 token 被拒绝、新会话真实登录正常；全部通过才运行 `consolidate-management-clients.mjs delete` 预览并加 `--apply` 删除这两个精确 ID。全租户删除开关始终关闭。

`prepare-organization-migration.mjs` 保留历史实现但入口已退役，运行会在生成配置前终止，防止迁移前快照重新创建旧应用。当前 RBAC 工具引用统一应用；旧登录发布脚本属于历史实现。Dashboard 的旧注册发布入口退役，后续注册资料配置归 Gateway 管理。

旧应用删除前可按快照恢复其 grant_types/scopes 并回切两个 Action；删除后旧 client ID 无法恢复，应修复统一应用或重新创建凭据并同步 Action。已经签发的旧管理 token 按其原有效期自然失效。
