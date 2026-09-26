# Eastmoney Gateway

Eastmoney 的唯一公网 Hono Worker，集中处理 Auth0 登录、JWT/JWKS、签名 JWT 会话、当前账号与角色、路由权限、账号目录和角色权限配置。

```
Browser / Quant → Gateway → Service Binding → Dashboard / Data
Dashboard → IdentityService → Gateway
Dashboard / Ingest → InternalData → Data
```

Dashboard/Data 不公开 origin，也不验证 JWT。Gateway 负责权限准入；应用分别校验记录归属、业务状态、输入、RLS 和材料访问等领域规则。

开发约定见 [AGENTS](AGENTS.md)，配置与验证见 [DEVELOPMENT](docs/DEVELOPMENT.md)，共享认证边界见项目组 [AUTH](../eastmoney/docs/AUTH.md)。具体权限与路由以 [Gateway 目录](src/lib/permissions.ts) 和 [路由策略](src/lib/route-permissions.ts) 为准。
