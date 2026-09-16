# Gateway 测试

测试取舍遵循[项目组测试规范](../../eastmoney/docs/TESTING.md)。以下为 2026-09-16 本地离线审计；覆盖率只代表注明的执行范围。

```bash
pnpm test:coverage
```

Node 24 内置 coverage，控制台表格及 `coverage/lcov.info`；只包含已加载的 `src/**/*.ts/js`，未加载 entrypoint/repository 不在分母内。73 测试，本轮观测行覆盖 94.15%、分支 89.57%，不能称为全部源码覆盖。

`profile.test.mjs` 将重复 redirect 代表值合并，并不再重复 429 真实退避：重试次数/等待由 `auth0-rate-limit.test.mjs` 注入 waitImpl 验证。profile 组由约 8.17 秒降至 0.10 秒，整套约 1 秒。保留 JWT issuer/audience/时效、PKCE/state/nonce、组织隔离、机器 scope、Cookie 与访问拒绝。

路由权限目录矩阵是安全边界；多入口测试不盲目去重。`identity-service.ts` 私有入口和 `auth-navigation.ts` 仍需针对行为补测，不能通过排除它们提高数字。真实 Auth0 登录仍为单独程序化验收，本次没有执行。
