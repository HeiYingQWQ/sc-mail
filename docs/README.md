# 文档目录

[当前能力、启动与待办](../README.md) · [架构与业务规则](../PROJECT_DEVELOPMENT.md) · [开发/GitHub 流程](../AGENTS.md)

| 专题 | 内容 |
| --- | --- |
| [API_REFERENCE](API_REFERENCE.md) | 认证、查询/分页、CLI/MCP、CRM/事实、AI、摘要、事件与投递报告 |
| [MAIL_PROCESSING](MAIL_PROCESSING.md) | 发件规则、重要性与通知、机器资料、二次审计和日报 |
| [OPERATIONS](OPERATIONS.md) | 升级、同步恢复/对账、回调、删除、备份恢复及开发验证 |
| [AGENT_INTEGRATION](AGENT_INTEGRATION.md) | 固定版本 OpenClaw 的 Docker Desktop 安装、MCP/Skill、WhatsApp 和排错 |
| [CHANGELOG_V0](CHANGELOG_V0.md) | V0.x 开发里程碑与历史验收；当前 V0.9.5 |

工具指导见 [sc-mail Skill](../skills/sc-mail/SKILL.md)，Linux 同机部署见 [部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md)，模板安装见 [OpenClaw 桥接目录](../openclaw-stack/README.md)。安装 Skill 不等于服务、自动唤醒或渠道已接通。

配置以 [.env.example](../.env.example)、校验代码和 Compose 为准，数据库以 [Prisma Schema](../prisma/schema.prisma) 为准。开发历史只维护版本日志；专题不复制验收快照。删除的旧设计/详细验收可用日志中的固定提交链接或 `git show <提交>:<旧路径>` 追溯，不能据此推断当前能力。
