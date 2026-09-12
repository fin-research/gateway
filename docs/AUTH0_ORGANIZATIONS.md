# Eastmoney Auth0 组织与应用边界

Eastmoney 在现有 `hasbai.eu.auth0.com` 租户内使用组织 `org_6yvoRRCkzk3eGkBS`（东方财富证券）。这是业务身份隔离；管理 API、签名密钥、登录域名、邮件提供方、套餐和租户管理员仍共用，不能视为独立 Auth0 租户。

## 应用盘点（2026-09-12）

| Application | 处置与用途 |
|---|---|
| eastmoney | 保留；网站授权码 + PKCE；必须在 Eastmoney 组织登录 |
| eastmoney MCP portal | 保留；Cloudflare 门户 IdP 和 Data 逐用户 OAuth；必须在 Eastmoney 组织登录 |
| eastmoney quant gateway | 保留；只有 Gateway API 的 `data.choice:read`，没有 Management API 权限 |
| eastmoney identity management | 保留；Gateway 资料与组织目录；`read:users`、`update:users`、`read:roles`、`read:organization_members`、`read:organization_member_roles` |
| eastmoney signup profile | 保留；Hosted Form 保存新账号资料；仅 `update:users` |
| eastmoney-login-roles | 保留；登录 Action 查询角色 ID；仅 `read:roles` |
| eastmoney dashboard profile | 退役；`grant_types=[]`、Management API `scope=[]`，标记 `lifecycle=retired`。保留应用 ID 供可逆回退，没有永久删除 |
| cli | 共用 Deploy CLI 管理工具；当前审计也依赖它。保留，不合并到业务运行时凭据 |
| All Applications | Auth0 系统管理上下文；无普通 app_type，留存日志为后台管理事件，未修改 |
| 北极小站 | 审计期间新增的 Hasbai 应用；未修改其配置或凭据 |

旧 profile 应用在当前六仓库中无引用，Dashboard 生产 bindings 已无 Auth0 凭据，Gateway 使用另一管理 client ID，且留存日志无调用。三项证据共同支持停用。日志最早可见时间为 2026-09-11 07:47 UTC，不能仅凭这一短窗口认定应用无用；Quant/MCP 虽无该窗口内调用，仍有生产引用，予以保留。

独立注册资料和角色查询应用只持有各自所需权限，不与 Gateway 管理凭据合并。共用 `cli` 仍是租户级管理权限，不受业务组织限制；没有为了减少应用数量把该权限放入运行时。

## 用户与权限

- 网站登录固定传入 Eastmoney `organization`，不接受 URL 中的组织覆盖；回调校验 ID token 和 API access token 的 `org_id`，所有用户 API token 必须属于本组织。
- 登录 Action 仅处理网站与专用 MCP client ID，同时校验组织、`eastmoney-email`、18.cn 邮箱、账号状态和既有邮箱验证例外；其他应用的登录 Action 行为保持原样。
- 9 个现有 Eastmoney 账号加入组织，保留 `sub`、密码、资料和验证状态。原有 6 条租户级角色分配迁为组织成员角色，不给无角色用户补权限。
- 三个既有 `financing:*` 角色定义及 ID 继续作为权限数据库的稳定键；成员分配使用组织 endpoint。组织拥有的 `financing` 角色也保留。目录只展示本组织自有角色和这三个历史角色，不展示 Hasbai 或其他租户角色。
- 组织内启用专用 `eastmoney-email` 连接，保持注册入口；此连接仅允许网站和 MCP 两个用户应用。新账号通过该连接登录时加入组织，18.cn 限制与资料 Form 继续执行。
- Google 和默认密码连接只移除 Eastmoney 客户端关联，保留 Hasbai/其他客户端及所有共享连接选项。对专用 Eastmoney 连接移除其他应用关联，避免跨用 Eastmoney 账号库。
- 租户管理员仍可通过管理 API 操作整个租户；应用内组织校验不构成管理员权限隔离。

## 机器身份限制

实际设置 Quant `default_organization` 时，Auth0 返回 HTTP 403 / `feature_not_enabled`：当前订阅未启用 M2M Organizations。没有升级套餐；最终未设置默认机器组织，也没有改动 Quant grant 或客户端凭据。

只有 allowlist 中的 Quant 客户端，在 `gty=client-credentials`、`sub=azp@clients` 且缺少 `org_id` 时，可以通过组织字段检查；随后仍必须通过固定 issuer/audience/RS256、客户端白名单、Choice scope 和路由检查。其他机器客户端、Hasbai 组织 token、用户缺失组织的 token 全部拒绝。Quant 不能访问 Dashboard、CAMEL 或 MCP。

## 发布与维护

1. `pnpm auth0:export` 显式导出 `clients,clientGrants,organizations,roles,connections`，数据库连接另导出 `databases`。快照仅在忽略的 `.auth0-deploy` 内，目录 0700，不导出 Secret。
2. `scripts/prepare-organization-migration.mjs` 从迁移前快照生成 prepare/lock 配置；显式 plan/apply，始终禁止资源删除，Hasbai 和共用 cli 不放入写入配置。
3. 用户数据不由 Deploy CLI 管理。`scripts/migrate-organization-members.mjs plan` 保存成员/角色快照；`apply` 增量添加、保留既有角色；网站/MCP 验证后才 `remove-global` 移除已在组织内确认存在的旧分配。
4. `scripts/configure-mcp-portal.mjs organization-plan` / `organization` 只更新专用 IdP 及 Data manual OAuth 的 organization 参数，保留 audience、逐用户授权和回调；通过 Keychain 派生的任务 Token 执行。
5. 组织连接必须显式设置 `is_enabled=true`；当前 SDK 的 connections endpoint 可以创建未启用的关联，旧 enabled_connections endpoint 不会返回它。包装器在独立进程 preview 后重新加载原文件 import，避免复用被规范化的内存对象；回读必须同时核对关联和启用状态。
6. `cleanup-application-connections.mjs` 先 plan 再 `--apply`。Deploy CLI 的 enabled_clients 是整表替换；这里有意使用官方 `PATCH connections/{id}/clients` 逐项撤销，避免覆盖审计期间新增的 Hasbai 关联。没有修改共享连接的 options、密码策略或用户。
7. Gateway 通过 `pnpm check`、`pnpm deploy:dry`、32 项实际后端处理器联调后发布；再更新并发布仅网站/MCP 命中的登录 Action、将两个用户客户端锁为 `organization_usage=require`。
8. `pnpm auth:verify` 验证真实测试账号和只读业务探针。`verify-managed-mcp.mjs --reauthorize-data --check-catalog` 只更新测试账号的旧 Data 授权，验证完整门户及目录。旧网站会话需要重新登录；其他 MCP 用户可能需要重新连接 Data 上游以取得组织 token。

迁移期保持 `AUTHORIZATION_MODE=beta-open`，没有以修改角色或切换模式来让测试通过。组织成员/角色改变随新 token 生效，已签发用户 token 保持原有最长 24 小时时效。

## 回退

保留 `.auth0-deploy/organization-before`、`database-before` 和 `organization-members.json` 受限快照。回退先恢复必要旧角色分配和应用配置、MCP authorize 参数，再恢复 Gateway/Action 版本，按依赖顺序执行。旧 profile 应用可从快照恢复 grant_types/scopes；不需要重建账号或 Secret。不要把整份旧租户导入覆盖 Hasbai 的后续改动。

依据：[Organizations 与应用行为](https://auth0.com/docs/manage-users/organizations/configure-organizations/define-organization-behavior)、[Organizations 概览](https://auth0.com/docs/manage-users/organizations/organizations-overview)、[Management API schema](https://auth0.com/docs/oas/management/v2/management-api-oas.json)。本次按实际 API 回读校验套餐能力和连接/角色关联。
