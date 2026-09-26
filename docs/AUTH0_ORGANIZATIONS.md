# Eastmoney Auth0 组织与应用边界

Eastmoney 在共享租户 `hasbai.eu.auth0.com` 内使用组织 `org_6yvoRRCkzk3eGkBS`。组织限定业务用户身份；管理 API、签名密钥、登录域名、邮件服务、套餐和租户管理员仍由整个租户共用。账号与权限的当前规则见 [共享 AUTH](../../eastmoney/docs/AUTH.md)。

## 用户应用

- 网站 `eastmoney` 使用授权码 + PKCE；统一 MCP portal 使用逐用户 OAuth。两者必须在 Eastmoney 组织登录，Gateway 校验签名 token 的 `org_id`，不接受调用方覆盖网站的组织参数。
- 登录 Action 只处理网站和 MCP 客户端，校验组织、`eastmoney-email` 连接、`18.cn` 邮箱及账号状态。新用户增量获得 `authenticated` 基础角色；角色权限由 Auth0 管理，Gateway 按已验证角色读取授权缓存。
- 专用 `eastmoney-email` 连接只关联网站和 MCP 用户应用。Google 和默认密码连接保留其他业务应用，不为组织隔离修改其共享配置。
- `eastmoney gateway management` 机器应用供 Gateway 身份服务、登录角色解析和注册资料保存。Deploy CLI 使用独立租户管理应用；不得把其权限并入业务运行时凭据。旧 profile 应用仅供可逆回退，不再参与当前身份服务。

## 机器身份

Quant 使用单独的 `eastmoney quant gateway` 客户端，仅授予 Gateway API 的 `data.choice:read`。当前 Auth0 套餐不支持 M2M Organizations，因此 Quant token 可以不含 `org_id`；Gateway 仅对固定客户端白名单、`gty=client-credentials`、机器 subject、audience、scope 和 Choice 路由同时满足的请求放行。用户 token 缺少本组织 `org_id`、其他机器客户端及跨组织 token 均拒绝。

## 配置与验证

租户配置通过显式资源 Deploy CLI export/plan/apply 管理，默认禁止删除和导出 Secret；用户及组织成员操作使用有界的 Management API 脚本。每次只提交本任务所需资源，回读组织连接是否启用、角色成员与授权是否符合预期。受限导出留在忽略的 `.auth0-deploy/`，不提交用户资料或凭据。

变更网站、MCP 或组织关联时，按 [Gateway 交付](DEVELOPMENT.md) 做程序化登录与只读探针；Quant 机器 token 单独验证 Choice 范围和对 Dashboard、CAMEL、MCP 的拒绝。回退使用变更前的受限快照，逐项恢复受影响应用和成员关系，避免整租户导入覆盖其他应用的后续改动。
