# 通知资格查询

Dashboard 私有 IdentityService GET `/directory/notification-users` 返回当前有效组织成员的通知类别。可重复指定 `userId`，最多 100 个 `auth0|...` subject；缺省继续返回完整目录，空值或非法参数返回 400，不回退全量。

限定查询仍实时读取组织成员关系，随后只读取指定成员的账号状态与组织角色，使用现有权限快照判定类别。不读取无关成员资料，不缓存用户资格，不放宽组织、账号或管理员边界。不存在或已退出组织的用户不返回；查询失败仍关闭。

Messenger 对实际订阅者分批查询，发送前对单一收件人重新查询。发布顺序为 Gateway → Dashboard 转发 → Messenger 消费；旧调用不带过滤参数仍兼容。
