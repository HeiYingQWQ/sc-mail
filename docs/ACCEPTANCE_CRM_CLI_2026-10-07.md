# 2026-10-07 CRM CLI 与 OpenClaw 接入验收

## 范围与执行规则

按用户授权补齐联系人、公司、项目的 API/CLI/MCP 软删除，并启用 OpenClaw 对这些实体的查询、创建、修改、删除、邮件关联和项目分析工具。原有创建、查询、修改及分析接口继续复用；没有新增 Schema 或 Migration，仍为 27 条迁移。

用户明确要求：只有用户说“创建”才创建，一般按联系人 → 公司 → 项目完成整套。Agent 先查重，复用明确匹配的已有记录；缺少必要资料再询问。每步使用独立稳定 operationId，重试复用该步 ID；失败如实报告已完成步骤。新邮件、模型建议和后台事件不构成创建授权。整套创建是顺序操作，不承诺跨三个实体的原子事务。

删除要求 operationId、expectedVersion，可记录 actorId。通过 status=deleted 隐藏实体，保留邮箱所有权、原始邮件、历史关系和业务证据；没有实体恢复接口。联系人仍属公司或有效项目时拒绝删除；公司仍有有效项目时拒绝；无项目的公司删除会解除联系人成员归属并递增联系人版本。项目有 pending/processing 分析任务或 open/in_progress/waiting 待办时拒绝。不会为了完成删除而自动删除、取消或完成依赖。

已删除项目不能接收新任务、事实、归类、Topic 或摘要写入，也不能被阶段更新重新启用。相关写事务与删除共享关系/项目锁；序列化或死锁冲突返回 409 CONCURRENT_UPDATE，其他数据库错误不伪装成版本冲突。

## 代码与隔离验证

- `pnpm typecheck`、`pnpm build` 通过。
- `pnpm verify:tool-contracts` 通过：83 次 fake API 请求，核对 CLI/MCP 路径、参数、CAS、错误、删除及 scoped OpenClaw helper。helper 只改三个工具白名单，验证备份、重复运行和拒绝错误配置。
- `pnpm verify:dashboard` 51/51；修正一个依赖真实当天日期的旧分页测试，未改本轮 Dashboard 产品代码。
- `pnpm verify:review-fixes` 19/19；补全旧 fake client 对新增关系锁的模拟，原断言保留。
- `verify-crm-delete.cjs` 真实隔离 PostgreSQL 通过：CAS、审计、幂等回执、依赖拦截、项目 → 公司 → 联系人删除、目录隐藏及原始 MIME 字节保留。首次运行发现的返回结构、无效版本 fixture 与 Buffer/Uint8Array 比较问题均只修改测试后复验。
- `pnpm verify:crm-cli-http` 通过 33 项检查：真实 Node CLI/MCP 子进程 → Nest HTTP → 独立随机 PostgreSQL。覆盖整套 CRM 创建/修改、联系人邮件查询、项目邮件归属、fake Provider 项目分析完成、删除、鉴权及并发 task-create/project-delete。初轮发现 raw SQL 序列化冲突返回 500，修正共享错误映射后复验通过。原邮件逐字节保留，测试库自动删除。
- `pnpm verify:integration` 53/53，临时库自动删除。

上述分析仅使用合成 `.invalid` 数据和 fake Provider。没有为验收新增、修改或删除真实 CRM 资料，没有发手机测试消息或通知。该记录不代表真实模型摘要性能或手机自然语言整套建档流程已经端到端验收。

## 本机部署与 OpenClaw

backend/worker 镜像构建成功并已更新；backend/PostgreSQL healthy、worker running，GET /health 为 200。OpenClaw Gateway 已重建以加载 CLI/helper 的只读挂载和更新的 SC-Mail Skill，原状态卷保留；Docker 状态 healthy，镜像自身 docker-healthcheck.js 手动运行也为 exit 0。

通过 `enable-crm-tools.mjs` 将共享注册表中的 23 项 CRM/项目/分析工具合并到既有全局 allow、ai-mail agent allow 和 Ai Mail MCP include。没有运行宽范围的 configure-mcp。写入前原配置备份到 OpenClaw 状态卷；与备份做结构比较，除这三个列表外其余设置严格相同，通知 relay 仍只有 session_status，API Token 仍用环境引用。

OpenClaw 自身 `mcp probe ai-mail --json` 返回实际可用 48 项工具（之前 29），含三个实体的 create/update/delete 及项目分析/归属；diagnostics 为空。MCP 总清单 52 项，另 4 项投递报告/系统发件地址工具继续过滤。Gateway 内真实 CLI 与 MCP list_projects 均查询成功；只输出成功标志和数量，未展示邮件、联系人或凭据。

随机 CRM 删除、HTTP fixture 和 acceptance 测试数据库只读清点为空。本轮临时探针、本地探针源与容器备份副本已删除；完整备份保留。

## 备份与操作入口

升级前完整数据库备份：`backups/ai-mail-pre-crm-cli-2026-10-07.dump`，956875518 bytes。容器与本地 SHA-256 均为 `ab2ea365f4d98d5aebeb7720fec5ff0f507bd14bc9bd4243ed487811bf9a2a37`；`pg_restore --list` 可读，TOC Entries 338。没有执行本次备份恢复演练。

CLI 帮助：`node scripts/ai-mail.mjs --help`。创建/更新/删除支持 JSON 或 `@file`，版本修改/删除先 GET 当前版本。参数见 [Agent 契约](M13_AGENT_INTEGRATION.md)、[业务记录 API](BUSINESS_RECORDS_API.md)，接入命令见 [OpenClaw 教程](OPENCLAW_INTEGRATION_GUIDE.md)。旧项目通知 E2E、手机会话及其他独立待验收项仍见 [Problem](../Problem.md)，不由工具接通替代。
