# Auth0 配置

Auth0 的本站应用 `eastmoney` 使用自定义登录域 `auth.hasbai.xyz`；管理 API 使用原租户域 `hasbai.eu.auth0.com`。Gateway 拥有 `/auth/login`、`/auth/callback` 和退出流程，Auth0 API audience 为 `https://eastmoney.hasbai.xyz/`。API 不接受 ID token 或 Cloudflare Access JWT。

`actions/eastmoney-login.cjs` 保留 18.cn、迁移账号邮箱绑定、未验证邮箱提示与禁止旧事务 continue 的规则；向 API token 添加 `https://eastmoney.hasbai.xyz/email`，Gateway 用它与当前 Auth0 账号匹配。`sub` 使用 Auth0 原生主键。

其余注册 Action、中文主题、Hosted Form 与提示文案保留原业务流程。`eastmoney-signup-profile` 仍只处理新账号 pending 标记；姓名和部门不会授予权限或自动关联业务负责人。

租户声明配置先按共享 AUTH 显式 export/plan/apply，禁止删除其他资源。Action 发布只变更目标 code，保留当前 Secret、依赖和 post-login 绑定；禁止覆盖其他未发布草稿。部署前后读取当前配置验证，不能以本地 Action 文件推断线上状态。

Quant 使用独立机器应用 `eastmoney quant gateway`；只授予 Gateway API 的 `data.choice:read`，不授予 Auth0 Management API 或用户角色。Secret 不进入 Git、文档、浏览器或日志。

具体发布与回退见 [DEVELOPMENT](../docs/DEVELOPMENT.md)。
