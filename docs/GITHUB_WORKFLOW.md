# GitHub CI 与 Pull Request 流程

仓库正式开发以 `main` 为集成分支。贡献者在 `feature/<名称>` 或 `fix/<名称>` 分支工作，通过目标为 `main` 的 Pull Request 合并。合并前要求 CI 通过、审核完成，随后 squash merge。具体协作要求见 [CONTRIBUTING](../CONTRIBUTING.md)。首次 `main` 仅包含已审核流程骨架；业务代码通过 `feature/initial-import` 的 PR 导入。

2026-10-07 创建私有仓库 `HeiYingQWQ/sc-mail`。GitHub Rulesets 页面明确提示当前私有仓库的规则集不会被强制执行，需升级对应套餐。因此目前不宣称服务端已强制 PR/CI 门禁，不自动升级付费套餐或公开仓库。仓库中的 `AGENTS.md`、PR 模板和 CI 规定审查流程；本地运行 `git config core.hooksPath .githooks` 后，pre-push 会拦截直接推送 main。该本地检查可被人为绕过，不能替代服务端权限保护。

## CI 覆盖

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 在 Pull Request 和推送到 `main` 时运行，使用 `contents: read` 权限、Node.js 24、pnpm 11.19.0 以及 `pnpm-lock.yaml` 冻结安装。

流水线先生成并校验 Prisma Client/schema，再执行 TypeScript 检查和 Nest 构建。其后运行共享 CLI/MCP 工具契约、Dashboard、审查修复、联系人解析、项目复核策略和项目分析证据等合成回归。

CRM 删除、手动 CRM 和项目邮件分析测试连接 GitHub Actions 提供的 PostgreSQL 17 service。每个脚本使用 `*_ALLOW_LOCAL_DB_CREATE=1` 开关创建自己的随机命名数据库，在其 `finally` 清理；测试只使用 `.invalid` 账号、合成邮件和 synthetic AI Provider。CI 也直接启动隔离 Nest fixture，执行真实 CLI/MCP → HTTP → PostgreSQL 的 33 项验证并自动清理。工作流不运行 Docker Compose wrapper，不提供生产数据库或 IMAP/AI/通知凭据，外部地址和通知入口通过空凭据/不可用本机 API URL关闭。不要在这些变量中加入任何生产配置。

这组 CI 证明已覆盖脚本在给定构建环境下通过，不证明部署、生产迁移、真实模型质量、真实邮箱同步、OpenClaw allowlist、手机通知或全页面人工体验已验收。每次 PR 应在描述中列明实际执行的其他验证与剩余风险。

## 本地复现

静态和合成检查：

```sh
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:validate
pnpm typecheck
pnpm build
pnpm verify:tool-contracts
pnpm verify:dashboard
pnpm verify:review-fixes
pnpm verify:contact-resolver
pnpm verify:project-review
pnpm verify:project-analysis-evidence
```

隔离 PostgreSQL 检查需要一个可丢弃、仅本机可达、允许 `CREATEDB` 的 PostgreSQL 17 实例。将 `DATABASE_URL` 指向该实例的管理数据库，并分别设置三个专用开关后，脚本会各自创建随机数据库并清理：

```sh
CRM_DELETE_ALLOW_LOCAL_DB_CREATE=1 pnpm verify:crm-delete
MANUAL_CRM_ALLOW_LOCAL_DB_CREATE=1 pnpm verify:manual-crm
PROJECT_ANALYSIS_ALLOW_LOCAL_DB_CREATE=1 pnpm verify:project-analysis
```

PowerShell 可用 `$env:...='1'` 设置对应开关。**不要**把 `DATABASE_URL` 指向生产、共享或含客户资料的数据库；测试脚本具有创建和删除数据库的权限。
