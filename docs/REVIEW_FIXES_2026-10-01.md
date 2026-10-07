# 2026-10-01 代码审查修复

本轮按用户授权修复 12 项发现，并增加邮件正文去历史及详情窗口前后导航。开发阶段 Docker Linux Engine 不可用，下方“开发阶段验证”保留当时检查范围；随后已恢复 Docker、完成 53/53 数据库隔离验收、应用迁移并本机部署。当前实际结果见 [启动验收与清理](ACCEPTANCE_2026-10-01.md)。

| 项目 | 实现 |
| --- | --- |
| 1 默认模型不兼容 reasoning | GPT-4.x / GPT-4o / GPT-3.5 请求省略 reasoning；推理模型保留配置 |
| 2 撤销会话缓存竞态 | 删除会话缓存的认证权威；每次授权查询数据库，撤销后的零行更新拒绝认证，首次改密要求适用于显式会话 Token |
| 3 历史导入被恢复通知 | 保存 historicalImport；初始补拉始终静默，近期真正漏收仍可恢复分流；旧记录只依据初始检查点及实时来源证据回填 |
| 4 重分析重复事实 | 未变提案（含置信度变化）复用原记录及通知；首次同封多事项保留独立记录；措辞、证据或内容变化无法确定映射时返回 409 并创建来源复核，不按标题/数组位置猜测 |
| 5 readiness 假完成 | 完成证据需对应任务对象及动作；准备好不等于发送完成；支持英/意/中文保守判断，排除否定、未来意图与仍待执行请求 |
| 6 任务移动后原项目状态陈旧 | 同一事务重算原项目与新项目；脱离项目也清理原等待状态和时间线 |
| 7 PATCH 只校验局部 | 合并当前状态后校验项目/Topic、期限/时区及日期一致性；区分 omitted 与 null，无效日期返回 400 |
| 8 意大利语自动回复 | 识别 Risposta automatica / fuori ufficio 前缀；普通真人正文提及休假仍正常分类 |
| 9 旧 HTML 邮件 AI 缺正文 | 业务分析与重要性分流使用共享 HTML 兜底和当前正文投影；模型证据不能来自隐藏的旧历史 |
| 10 摘要输入版本丢失 | 保存 summaryInputVersions，含不存在的版本 0；过时或无快照分析不能通过更改 expectedVersion 覆盖新摘要 |
| 11 AnalysisRun 永久 processing | 持久化租约及所有者 Token；过期读取显示 AI_ANALYSIS_INTERRUPTED，可原操作 ID 重试；迟到工作者无法覆盖恢复结果 |
| 12 暂时投递失败错分类 | 暂时延迟规则优先于通用 delivery failure，永久退信与结构化 DSN 保持原逻辑 |

## 本封正文与关联邮件

本轮新增详情当前正文投影、quotedHistoryRemoved 与 threadNavigation，以及 Dashboard 同窗口上一封/下一封切换。原始 MIME、完整文本/HTML 保留；仅主题相同不建立关联。完整参数、返回结构、副本/账号规则与无法可靠分离的边界，统一见 [邮件详情契约](M13_AGENT_INTEGRATION.md#本封正文与关联邮件)，不在修复记录重复维护。

## 迁移及升级

新增 `20261001120000_review_reliability`：historicalImport、分析租约和账号/RFC ID 索引。旧 processing 分析变为可重试中断状态；有初始导入证据的旧邮件保持静默，尚未发送的误恢复事件/通知保留审计行并停止重试。已经投递的通知不会撤回。没有可证明初始来源的旧记录保留原恢复资格。

Docker Desktop 启动后，先停业务进程、保留数据库并完成隔离验收，再升级：

```powershell
docker compose stop backend worker
docker compose up --detach postgres
docker compose build backend worker
pnpm verify:integration
# 验收通过后应用迁移并启用新版本
docker compose run --rm --no-deps backend pnpm db:migrate:deploy
docker compose up --detach backend worker
Invoke-RestMethod http://localhost:3000/health
```

执行前按现有运维流程备份。隔离验收使用独立临时数据库、合成邮件/AI/通知边界，不连接真实 IMAP 或发送真实通知。本机已按此顺序升级，后续安装仍需按步骤验证。

## 开发阶段验证

- `pnpm prisma:validate`、`pnpm prisma:generate`、`pnpm typecheck`、`pnpm build` 通过。
- `pnpm verify:review-fixes`：17/17 场景；会话撤销竞态、正文上下/行内回复、旧 HTML 分析/分流、重分析事实、完整 PATCH、双项目状态、摘要输入版本、分析租约与迟到回写、意大利语自动回复及延迟退信。
- `pnpm verify:dashboard`：23/23；含前后邮件切换和无关联邮件按钮禁用。
- `pnpm verify:sync-recovery`：17/17；包含初始近期历史被对账再扫描时仍不分流、不唤醒。
- 分流租约 9/9；其余标准化、业务分类、游标、联系人、项目复核、AI 分析、重要性路由、任务状态及 CLI/MCP 契约回归通过。
- `pnpm verify:integration` 未通过启动阶段：找不到 Docker Desktop Linux Engine 管道。新增 PostgreSQL 导航/复制/账号隔离、撤销会话竞态、任务移动等验收用例已保存，但未声称执行通过。迁移的数据回填和实际递归 SQL 尚待此验收。
- README 及 AGENTS.md 均小于 5 KB；本轮无生产数据库、真实邮箱或通知写入。
