# SC Mail

独立商务邮件服务：TypeScript/NestJS、PostgreSQL、Prisma、pg-boss、自建 IMAP。Dashboard 和产品为 SC Mail，ai-mail CLI/API/Agent 标识保留兼容。外部 Agent 可替换，首版不自动向客户发信。

## 实际状态

仓库包含初始/增量同步、分类与恢复对账、CRM、项目/Topic、人工复核、任务/需求/决策、来源证据、AI 建议、摘要版本、时间线、受控通知、业务日报，以及 Dashboard、API/CLI/MCP/Skill。M15–M22 经授权扩展；架构见 [PROJECT_DEVELOPMENT](PROJECT_DEVELOPMENT.md)。

- Dashboard 支持 CRM、项目、复核与投递失败报告；可维护系统发件地址，投递页桌面流程已验收。
- 2026-10-07 CLI/MCP 已补齐联系人/公司/项目增删改查，OpenClaw CRM/分析工具已授权并通过实际查询。仅用户明确指令才创建，可按联系人→公司→项目完成整套；软删除保留邮件证据。
- Dashboard 51/51、fake API 83、真实 CLI/HTTP 33 项、backend 53/53 通过；backend/postgres healthy、worker running，迁移仍为 27。见 [CLI 接入验收](docs/ACCEPTANCE_CRM_CLI_2026-10-07.md)。项目通知、手机全套建档与旧复核内联浏览器验收待完成。
- IMAP 持久轮询默认 60 秒，无独立常驻 IDLE。对账默认每日 05:00；删除同步启用时默认每 4 小时；日期查询默认 Europe/Rome。
- 已发与联系人往来仅覆盖受管 IMAP 副本；外部 SMTP 无副本不可见。
- OpenClaw MCP、事件 hook 和受控 WhatsApp 通知已有本机实测；用户反馈手机对话可用，独立端到端验收仍待完成。Hermes、Codex、Claude 未验证，Telegram 为可选桥接。
- 历史部署：[2026-10-01 修复与清理](docs/ACCEPTANCE_2026-10-01.md)、[2026-10-02 CRM/投递报告与项目详情](docs/ACCEPTANCE_MANUAL_CRM_PROJECT_AI_2026-10-02.md)，独立保留当次验证快照。
- 验收快照中 backend/postgres healthy、worker running；本机中文日报每天 09:00，新安装默认关闭。手机完整链路、真实通知正反例和全页面响应式仍待验收，不把本机快照当长期健康承诺。

## 启动与配置

需要 Docker Desktop/Compose v2、Node.js 22.12+、pnpm 11.19.0。新安装：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 先编辑 .env，填写数据库、IMAP、加密密钥、API Token、初始账户和 AI 配置
pnpm install
pnpm prisma:generate
docker compose up --build --detach
docker compose ps
Invoke-RestMethod http://localhost:3000/health
```

Compose backend 自动迁移，数据存 postgres_data 卷。已有安装升级本轮版本应先备份、停旧 backend/worker、隔离验收，再迁移，按 [升级顺序](docs/REVIEW_FIXES_2026-10-01.md#迁移及升级) 操作。停止保留数据用 `docker compose down`，不要加 `-v`。

配置以 [.env.example](.env.example) 为准。IMAP 密码 AES-256-GCM 加密，密钥/Token 不提交或打印。默认 OpenAI Responses / gpt-4.1-mini，兼容端点需实测。TSnet/Zimbra 为 imap.tsnet.it:993 TLS，SMTP 不用于发信。

Dashboard：`http://localhost:3000/dashboard/`。DASHBOARD_INITIAL_EMAIL/PASSWORD 仅初始化一次；首次需改密，已有账户不重置。会话 7 天，改密/退出撤销；HTTPS 设置 DASHBOARD_SECURE_COOKIE=true。

API：`http://localhost:3000/api/v1`，Bearer IMAP_API_TOKEN。CLI 设置 AI_MAIL_API_URL/AI_MAIL_API_TOKEN，如 `pnpm ai-mail -- tasks --status active`；MCP 用 `node scripts/ai-mail-mcp.mjs`。安装 sc-mail Skill 不启动服务或建立唤醒。

## 验证与文档

```powershell
pnpm prisma:validate
pnpm typecheck
pnpm build
pnpm verify:review-fixes
pnpm verify:dashboard
pnpm verify:tool-contracts
# Docker/PostgreSQL 可用后运行，隔离测试不代替真实邮箱/手机验收
pnpm verify:integration
# 手动 CRM/项目分析 Dashboard 隔离 fixture：按需编译后，以 loopback:3001 打开浏览器
$env:UI_CRM_ALLOW_LOCAL_DB_CREATE='1'; $env:UI_CRM_SKIP_BUILD='1'; node scripts/run-ui-crm-acceptance.cjs
```

UI fixture 仅使用随机本地数据库和 `.invalid` 邮件；禁用 IMAP/外部通知。浏览器验证了项目邮件导航和投递报告/DST、地址增删；复核内联流程待验，不代表真实模型、通知或移动端完整视觉验收。

[文档目录](docs/README.md) 包含各专题；[运维](docs/M14_OPERATIONS.md) 说明备份/恢复，[OpenClaw 教程](docs/OPENCLAW_INTEGRATION_GUIDE.md) 说明接入，[Problem](Problem.md) 列未完成项。[AGENTS](AGENTS.md) 规定协作规则，历史记录不作为当前架构和实时部署依据。
