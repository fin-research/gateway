# Gateway 测试

测试取舍遵循[项目组测试规范](../../eastmoney/docs/TESTING.md)。本地覆盖率执行 `pnpm test:coverage`；Node 内置 coverage 只统计已加载的 `src/**/*.ts/js`，未加载入口和 repository 不在分母内，不能把结果称为全部源码覆盖。

路由权限、匿名与登录身份、组织隔离、机器 scope、JWT、PKCE、Cookie 和拒绝路径属于安全边界，测试合并不能削弱这些行为。真实 Auth0 登录和生产路由绕过仍按 [共享 AUTH](../../eastmoney/docs/AUTH.md#程序化权限测试) 单独用程序化 HTTP 验收。
