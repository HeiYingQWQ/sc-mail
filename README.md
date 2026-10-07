# SC Mail

当前开发进度 **V0.9.5**。独立商务邮件服务：TypeScript/NestJS、PostgreSQL、Prisma、pg-boss、自建 IMAP。产品及 Dashboard 使用 SC Mail；`ai-mail` CLI/API/Agent 标识保留兼容。首版不自动向客户发信。

## 当前能力

- 初始/增量同步、确定性分类、异步重要性分流、恢复对账与删除核对；原始邮件、业务事实和审计持久化。
- 手动多邮箱 CRM、公司成员、项目/Topic、任务/需求/决策、人工复核、来源证据、AI 建议、摘要版本、时间线及业务日报。
- Dashboard 支持 CRM、项目分析与详情分区、正文/关联导航、投递失败报告和系统发件地址管理。API/CLI/MCP 共用业务规则；联系人/公司/项目支持受控增删改查，软删除保留邮件证据。
- OpenClaw MCP、事件 hook 与受控 WhatsApp relay 已有本机实测；CRM/项目/分析工具已接入，4 项投递报告工具仍被宿主过滤。手机对话有可用反馈，完整链路仍待独立验收。Hermes、Codex、Claude 未验证；Telegram 为可选桥接。
- IMAP 默认持久轮询 60 秒，尚无常驻 IDLE；对账默认业务时区每日 05:00，删除同步启用时默认每 4 小时。时间存 UTC，业务时区默认 Europe/Rome。已发与往来查询只覆盖受管 IMAP 副本，外部 SMTP 无副本不可见。

当前代码包含 27 条迁移；部署健康必须实时查询。历史开发、验证与部署结果只维护在 [版本日志](docs/CHANGELOG_V0.md)，不代表当前持续健康或完整生产验收。

## 启动与配置

需要 Docker Desktop/Compose v2、Node.js 22.12+、pnpm 11.19.0。新安装从仓库根目录执行：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 编辑 .env，填写数据库、IMAP、加密密钥、API Token、初始账户和 AI 配置
pnpm install --frozen-lockfile
pnpm prisma:generate
docker compose up --build --detach
docker compose ps
Invoke-RestMethod http://localhost:3000/health
```

Compose backend 自动迁移，数据保存在 postgres_data 卷。已有安装先按 [升级顺序](docs/OPERATIONS.md#迁移及升级) 备份、停止旧业务进程、隔离验收，再迁移/启动。停止保留数据用 `docker compose down`，不要加 `-v`。

配置以 [.env.example](.env.example) 为准。IMAP 密码 AES-256-GCM 加密，密钥/Token 不提交或打印。默认 OpenAI Responses / gpt-4.1-mini，兼容端点需实测；SMTP 不用于发信。

Dashboard：`http://localhost:3000/dashboard/`。DASHBOARD_INITIAL_EMAIL/PASSWORD 只初始化一次；首次需改密，已有账户不重置。会话 7 天，改密/退出撤销；HTTPS 设置 DASHBOARD_SECURE_COOKIE=true。

API：`http://localhost:3000/api/v1`，Bearer IMAP_API_TOKEN。CLI 使用 AI_MAIL_API_URL/AI_MAIL_API_TOKEN，如 `pnpm ai-mail -- tasks --status active`；MCP 用 `node scripts/ai-mail-mcp.mjs`。安装 Skill 不启动服务或建立事件唤醒。

## 未完成事项

- 真实新邮件通知正例、拒绝/机器邮件静默反例、黑白名单边界及项目通知 E2E；手机查询、受控修改、失败反馈和整套 CRM 建档的独立端到端验收。
- OpenClaw 投递报告工具授权、其他 Agent 兼容性、Linux 服务器部署及真实模型端点的独立验证。
- 旧项目复核内联确认流程的浏览器复验；全页面响应式/移动端视觉、长地址溢出、慢网络及规模性能观察。局部手机布局通过不代表全页面通过。
- 真实上下/行间回复、父邮件缺失和引用改写样本；当前正文投影存在无法可靠分离历史的边界。
- IMAP/Agent 离线、重启、慢模型与多 worker 演练；当前按单 worker，Telegram 扩副本前需 leader 锁。
- 离机备份、完整恢复及连续运行观察；新备份可读/哈希一致不等于恢复成功，流式备份缺少总时限和进度报告。
- NestJS 旧 wildcard 路由启动警告；人工复核和历史失败需按实际状态处理，不直接清空或重放。
- 待规划：需求/决策及 AI 建议界面、故障恢复入口、复核可读说明、契约一致性、对账成本测量、Campaign 兼容核查和 IMAP IDLE。待办不构成新开发授权。

## 文档与验证

[架构与规则](PROJECT_DEVELOPMENT.md) · [文档目录](docs/README.md) · [开发/GitHub 流程](AGENTS.md)。验证命令、隔离数据库要求及 UI fixture 启动见 [运维与验证](docs/OPERATIONS.md#开发验证与-ci复现)；接口见 [API](docs/API_REFERENCE.md)，OpenClaw 安装见 [Agent 接入](docs/AGENT_INTEGRATION.md)。
