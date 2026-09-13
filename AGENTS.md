# Eastmoney Gateway

本站唯一公网 Worker，负责 Auth0 登录、JWT、会话、账号目录、角色权限和路由准入。Dashboard 与 Data 仅通过命名 Service Binding 接收 Gateway 请求；应用不校验 JWT。

## Rules

- 遵循 [项目组入口](../eastmoney/AGENTS.md)、[共享 AUTH](../eastmoney/docs/AUTH.md) 和 [架构](../eastmoney/docs/ARCHITECTURE.md)。
- 用户、角色、成员关系及角色权限统一由 Auth0 管理。Gateway 维护路由权限目录，并用 Cloudflare Cache API 缓存授权 JSON（1 小时）；不得加入内测鉴权旁路。历史权限 migration 保留，不用于运行时授权。
- JWT 只接受配置的 Auth0 issuer、API audience 和 RS256。不能接受 ID token、Access JWT、任意邮箱或身份头。
- 浏览器使用授权码 + PKCE、state、nonce；会话 Cookie 直接保存 Auth0 RS256 签名 JWT，设置 Secure/HttpOnly/SameSite；仅对含 PKCE verifier 的临时登录事务加密。Cookie、token、code、Secret 不进入日志。
- 公网请求不能选中内部 entrypoint；转发前移除身份头与凭据，重新生成可信上下文。默认拒绝未知路由、方法、重复 action。
- Gateway 控制路由和权限；记录归属、输入白名单、业务状态、RLS 和材料保密检查留在业务层。
- 权限验收只使用程序化 HTTP/单元测试/CLI，禁止 browser。新增用户身份仅匿名与 `test@18.cn`；凭据读取项目组未跟踪 `.env`。
- 修改前检索已有实现，保留其他任务改动。不得删除测试或关闭检查；迁移测试随所有权移动。
- 绑定类型使用 `pnpm typegen` 生成。交付运行 `pnpm check`、`pnpm deploy:dry`、`git diff --check`；跨仓库集成后验证公网绕过、真实登录和机器凭据。
- Auth0 配置使用显式资源 Deploy CLI export/plan/apply。生产切换先验证 Gateway 和私有后端，再切换路由并移除本站 Access 规则；其他 Access 应用不变。
- 只提交任务文件，推送并回读远端。部署和发布后只读检查已由重构任务授权。

具体命令和切换顺序见 [DEVELOPMENT](docs/DEVELOPMENT.md)。
