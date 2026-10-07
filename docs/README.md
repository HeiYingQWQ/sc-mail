# 文档目录

更新：2026-10-07。当前架构、接口、操作和历史各有入口，其他文件引用，不重复维护部署结论。

| 内容 | 主要依据 |
| --- | --- |
| 实现、部署状态、启动 | [根 README](../README.md) |
| 当前架构、数据与执行顺序 | [开发依据](../PROJECT_DEVELOPMENT.md) |
| 工作区规则 | [AGENTS](../AGENTS.md) |
| 未完成项 | [Problem](../Problem.md) |
| 手动 CRM、AI 项目归类/总结与通知的需求及验收状态 | [功能变更文档](MANUAL_CRM_PROJECT_REQUIREMENTS.md) |
| API/CLI/MCP、正文导航与分页 | [Agent 接口](M13_AGENT_INTEGRATION.md) |
| Provider、Schema 3、分析租约 | [AI 分析](AI_ANALYSIS_API.md) |
| 人工修改与分析应用 | [业务事实](BUSINESS_RECORDS_API.md) |
| 摘要版本、回滚与项目状态 | [摘要与时间线](SUMMARY_TIMELINE_API.md) |
| 事件领取/完成与通知状态 | [事件接口](AGENT_EVENTS_API.md) |
| 回调、删除、备份和恢复 | [运维](M14_OPERATIONS.md) |
| 对账与近期漏收 | [对账](M15_RECONCILIATION.md) |
| 按需审计与分类分歧 | [AI 二次审计](M16_AI_SECOND_AUDIT.md) |
| 日报结构和默认配置 | [业务日报](M17_DAILY_BUSINESS_BRIEF.md) |
| 黑白名单与可行动通知 | [发件规则](M20_SENDER_RULES.md) |
| 机器邮件证据字段 | [机器资料](M22_MACHINE_MAIL_DETAILS.md) |
| 投递失败报告与系统发件地址 | [投递报告 API](DELIVERY_FAILURES_API.md) |
| Docker Desktop OpenClaw 接入 | [本机教程](OPENCLAW_INTEGRATION_GUIDE.md) |
| 同一 Linux Docker 主机接入 | [部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md) |
| Agent 运行使用指导 | [SC-Mail Skill](../skills/sc-mail/SKILL.md) |
| OpenClaw 文件与助手模板安装 | [桥接目录](../openclaw-stack/README.md) |

保留 M13 等文件名兼容旧链接，它们是持续更新的专题契约。配置键/默认值以 [.env.example](../.env.example)、配置校验和 Compose 为准，数据库字段以 [Prisma Schema](../prisma/schema.prisma) 为准。

## 变更与历史

- [2026-10-07 CRM CLI 与 OpenClaw 接入验收](ACCEPTANCE_CRM_CLI_2026-10-07.md)：软删除、完整 CLI/MCP HTTP 流程、并发保护、受限工具授权和备份证据。
- [2026-10-02 手动 CRM、项目 AI 与投递报告扩展验收](ACCEPTANCE_MANUAL_CRM_PROJECT_AI_2026-10-02.md)：分别保留 migration 26/27 快照、浏览器与数据库证据、备份状态及 OpenClaw/移动端缺口。
- [2026-10-01 本机验收与清理](ACCEPTANCE_2026-10-01.md)：升级、53/53 隔离验收、真实服务/页面、缓存清理及剩余缺口。
- [2026-10-01 修复](REVIEW_FIXES_2026-10-01.md)：12 项问题与正文/导航实现；专用升级步骤保留在此，后续部署结果见验收记录。
- [Dashboard 隔离验收 fixture](../scripts/run-ui-crm-acceptance.cjs)：合成 CRM/项目邮件及投递报告浏览器验证入口；浏览器证据和剩余复验项见扩展验收记录。
- [归档](archive/README.md)：旧设计、验收与问题快照，仅作背景与证据；历史次数、数量和容器状态不代表当前结果。
- openclaw-stack/agent-files 的 Markdown 与 memory 是助手模板、偏好和记忆种子，不是架构文档；技术清理不删除用户记忆或承诺。

新行为写对应专题，部署结论只更新根 README，旧快照进入归档并注明范围。规划不混入已实现能力。
