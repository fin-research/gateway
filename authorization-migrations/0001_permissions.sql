CREATE SCHEMA IF NOT EXISTS "authorization";
CREATE TABLE "authorization".permission (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'),
  label text NOT NULL,
  description text NOT NULL,
  sort_order integer NOT NULL
);
CREATE TABLE "authorization".role_permission (
  auth0_role_id text NOT NULL CHECK (auth0_role_id ~ '^rol_[A-Za-z0-9]+$'),
  permission_code text NOT NULL REFERENCES "authorization".permission(code) ON DELETE CASCADE,
  granted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text CHECK (updated_by IS NULL OR updated_by ~ '^auth0\|[^[:space:]]+$'),
  PRIMARY KEY (auth0_role_id, permission_code)
);
COMMENT ON TABLE "authorization".permission IS 'Application permission catalogue; users and roles exist only in Auth0';
COMMENT ON TABLE "authorization".role_permission IS 'Auth0 role IDs mapped to application permissions; no local role or user records';
REVOKE ALL ON "authorization".permission, "authorization".role_permission FROM PUBLIC, anonymous, authenticated;

-- Only the trusted Worker can populate transaction-local identity and effective permissions.
CREATE OR REPLACE FUNCTION "authorization".has_permission(required_permission text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(NULLIF(current_setting('request.auth.user_id', true), '') ~ '^auth0\|[^[:space:]]+$', false)
    AND COALESCE(NULLIF(current_setting('request.auth.permissions', true), '')::jsonb, '[]'::jsonb) ? required_permission;
$$;
REVOKE ALL ON FUNCTION "authorization".has_permission(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA "authorization" TO authenticated;
GRANT EXECUTE ON FUNCTION "authorization".has_permission(text) TO authenticated;

INSERT INTO "authorization".permission (code, label, description, sort_order) VALUES
  ('research.market_report:read', '市场点评', '读取市场点评及报告行情', 0),
  ('research.market_report:generate', '生成市场点评', '调用模型生成今日聚焦', 1),
  ('research.market_report:update', '保存市场点评', '保存市场点评定稿', 2),
  ('research.hotspot:read', '市场热点', '读取市场热点快照', 3),
  ('research.hotspot:generate', '生成市场热点', '调用模型生成热点快照', 4),
  ('research.policy:read', '政策跟踪', '读取政策与关联研报', 5),
  ('research.policy:update', '维护政策研报', '修改政策关联研报', 6),
  ('research.policy:generate', '生成政策点评', '调用模型生成政策点评', 7),
  ('research.policy_commentary:update', '保存政策点评', '修改政策点评内容', 8),
  ('research.article:read', '新闻与研报', '读取新闻、研报和研究点评', 9),
  ('research.workspace:read', '交易研究工作台', '进入交易研究总览及研究辅助', 10),
  ('research.economic_indicator:read', '经济指标', '读取经济观测和趋势', 11),
  ('bond.ledger:read', '二级池台账', '读取二级池台账与周报', 12),
  ('bond.ledger:import', '导入二级池台账', '上传 Excel 并发起台账导入', 13),
  ('bond.ledger:delete', '删除二级池台账', '删除指定日期的台账', 14),
  ('credit.institution:read', '授信数据', '读取授信一览、日历和周报', 15),
  ('credit.institution:update', '维护授信数据', '修改机构授信资料', 16),
  ('credit.assistant:read', '授信问答会话', '读取会话、消息与材料', 17),
  ('credit.assistant:ask', '授信问答', '发送问题并调用模型', 18),
  ('credit.material:upload', '授信材料上传', '上传及解析授信材料', 19),
  ('credit.material:delete', '删除授信材料', '删除材料与相关索引', 20),
  ('credit.assistant:delete', '删除授信会话', '删除会话与消息', 21),
  ('fund.report:read', '资金日报', '读取资金日报', 22),
  ('fund.report:upload', '上传资金日报', '上传或覆盖资金日报', 23),
  ('model.financing:read', '融资择时模型', '读取模型结果与决策', 24),
  ('model.conclusion:update', '维护融资结论', '修改融资择时整体结论', 25),
  ('model.decision:create', '记录融资决策', '追加融资决策记录', 26),
  ('model.sell_side:generate', '生成卖方观点', '检索研报并生成卖方观点', 27),
  ('model.sell_side:update', '维护卖方观点', '修改卖方观点内容', 28),
  ('financing.overview:read', '融资总览', '读取融资指标与日历', 29),
  ('financing.project:read', '融资项目', '读取融资项目、成员和任务', 30),
  ('financing.project:create', '新建融资项目', '创建项目并套用 SOP', 31),
  ('financing.project:update', '修改融资项目', '修改项目资料与负责人', 32),
  ('financing.project:delete', '删除融资项目', '删除项目及关联任务', 33),
  ('financing.task:create', '新增项目任务', '向融资项目添加任务节点', 34),
  ('financing.task:update', '修改项目任务', '修改任务资料、执行人与状态', 35),
  ('financing.task:update_own', '办理本人任务', '仅更新分配给本人的任务状态', 36),
  ('financing.sop:read', '融资 SOP', '读取模板、节点与提醒规则', 37),
  ('financing.sop:create', '新增 SOP', '创建 SOP 模板', 38),
  ('financing.sop:update', '维护 SOP', '修改模板与节点、调整顺序和启停', 39),
  ('financing.sop:delete', '删除 SOP 节点', '删除模板中的节点', 40),
  ('financing.reminder:read', '提醒记录', '读取邮件提醒规则与投递状态', 41),
  ('financing.reminder:create', '配置提醒', '创建节点邮件提醒规则', 42),
  ('financing.data:read', '融资台账', '读取融资明细及数据后台', 43),
  ('financing.data:create', '新增融资数据', '在白名单数据表中新增记录', 44),
  ('financing.data:update', '修改融资数据', '在白名单数据表中修改记录', 45),
  ('financing.data:delete', '删除融资数据', '在白名单数据表中删除记录', 46),
  ('financing.data:import', '导入融资台账', '上传并导入借入资金台账', 47),
  ('financing.report:read', '负债周报', '读取负债周报及快照', 48),
  ('financing.report:generate', '生成负债周报', '生成或覆盖负债周报快照', 49),
  ('account.profile:read', '个人信息', '读取本人 Auth0 资料和应用权限', 50),
  ('account.profile:update', '修改个人信息', '修改本人资料或请求密码重置', 51),
  ('auth.permission:read', '角色权限查询', '读取 Auth0 角色及应用权限配置', 52),
  ('auth.permission:update', '角色权限配置', '保存 Auth0 角色的应用权限', 53),
  ('data.resource:read', '数据服务', '读取 Data REST 数据资源', 54),
  ('data.graphql:read', '数据 GraphQL', '查询 Data GraphQL 资源', 55),
  ('data.choice:read', 'Choice 数据', '查询 Choice 指标', 56),
  ('data.camel:read', '资金系统数据', '查询 CAMEL 资金系统数据', 57);
