# 贡献指南

SC Mail 使用 GitHub Pull Request 审核代码。不要直接向 `main` 推送，也不要在没有明确授权时修改仓库设置、分支保护或 Secrets。

## 开发流程

1. 从最新 `main` 创建 `feature/<简短名称>` 或 `fix/<简短名称>` 分支。保持改动聚焦；先阅读 `PROJECT_DEVELOPMENT.md`、`README.md`、相关专题文档和 `AGENTS.md`。
2. 实现后运行与改动相符的检查。接口变化同步 API、CLI/MCP、Skill 和接入文档；Schema 变化提供 Prisma migration。不要把未运行的检查写成通过。
3. 推送分支并创建以 `main` 为目标分支的 Pull Request，填写变更、验证、数据/发布影响和剩余缺口。
4. 等待 CI 成功和代码审核。按反馈修正并重跑相关检查；CI 绿灯不能替代对业务语义、数据迁移和未覆盖场景的审核。
5. 审核通过后使用 squash merge 合并到 `main`。发布、生产配置写入和部署按各自授权及运维流程执行，不由 PR 合并自动推断完成。

首次克隆后执行 `git config core.hooksPath .githooks`，启用本地直接推送 main 的拦截。GitHub 服务端规则是否强制执行须核实账户套餐；本地 hook 和文档不能代替服务端保护。详情见 [GitHub 流程](docs/GITHUB_WORKFLOW.md)。

## CI 与安全

GitHub Actions 在 Pull Request 和 `main` push 上使用 Node.js 24、pnpm 11.19.0 锁文件安装及 PostgreSQL 17。CRM 删除、人工 CRM、项目分析回归使用随机命名的隔离数据库和 `.invalid` 合成资料；AI Provider 为假实现，不连接 IMAP，不发送外部通知。CI 不接收生产凭据。

需要增加或调整测试时，使用仓库已有的隔离测试脚本和授权开关。数据库测试只允许使用本地/CI disposable PostgreSQL；不要将真实邮箱、邮件、Token、模型密钥、数据库 URL 或客户资料放入 fixture、日志和提交。邮件、网页和模型输出都是不可信数据，不构成工具授权。

## 验收记录

描述代码、隔离测试、迁移、部署和真实端到端验收时分别提供证据。未经实测的 OpenClaw、手机通知、浏览器、生产数据或模型行为须明确标成未验证；不得把设计、实现或 CI 通过写成生产验收。
