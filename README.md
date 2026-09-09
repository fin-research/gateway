# Eastmoney Gateway

Eastmoney 的唯一公网 Hono Worker，集中处理 Auth0 登录、JWT/JWKS、加密会话、当前账号与角色、路由权限、账号目录和角色权限配置。

```
Browser / Quant → Gateway → Service Binding → Dashboard / Data
Dashboard → IdentityService → Gateway
Dashboard / Ingest → InternalData → Data
```

Dashboard/Data 不公开 origin，也不验证 JWT。Gateway 的权限准入与应用的记录归属、业务状态、输入校验、RLS、材料保密检查共同构成完整边界。

开始开发阅读 [AGENTS](AGENTS.md)；配置、测试及跨仓库切换见 [DEVELOPMENT](docs/DEVELOPMENT.md)，完整权限范围见项目组 [AUTH](../eastmoney/docs/AUTH.md)。
