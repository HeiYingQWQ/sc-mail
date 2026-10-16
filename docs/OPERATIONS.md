# 运维、恢复与开发验证

本专题维护现行操作契约，当前能力与待办见 [README](../README.md)，历史结果只见 [版本日志](CHANGELOG_V0.md)。操作前实时检查服务、配置和备份。

## 进程、配置与升级

backend 提供 HTTP/Dashboard，worker 同一应用上下文执行后台队列、分流、对账、删除核对和 outbox。默认按单 worker 部署。配置键/范围以 [.env.example](../.env.example)、AppModule 校验和 Compose 为准。

检查 `docker compose ps`、`GET /health`、认证的 `/api/v1/mail/sync/status`、`/reconciliation/status` 与 `/integrations/status`；队列配置成功不证明外部模型、手机或 sender 已实测。IMAP 默认持久轮询 60 秒，近实时不等于 IDLE 推送。

已有安装先备份并停旧 backend/worker，完成隔离验收，再按下方“迁移及升级”应用迁移/启动。不要让旧 worker 与新 Schema 回填同时工作。

## Agent 事件回调

worker 对 AGENT_EVENT_WEBHOOK_URL 发送 POST，AGENT_WEBHOOK_TOKEN 为 Bearer，Idempotency-Key 为 ai-mail-event-事件ID：

```json
{"protocol":"ai-mail.agent.v1","type":"events_ready","eventId":"...","eventKey":"...","eventType":"INBOUND_EMAIL_RECEIVED","apiBaseUrl":"https://mail.example/api/v1"}
```

接收端快速响应 2xx、异步启动 Agent，按 key 去重。Agent 用业务 API Token 通过 MCP 领取指定 eventId；正常聊天不认领后台事件。回调只传元数据，不传正文/执行指令，Agent 按 sourceMessageId 读取有界详情。

未处理事件约每 5 分钟可重新唤醒，最多 10 次；事件领取/完成有另一套租约与重试，见 [事件接口](API_REFERENCE.md#事件与通知)。Webhook 接受不等于事件完成，更不等于通知投递。

远程回调使用 HTTPS；代码允许本机 Docker Desktop host.docker.internal 和服务器专用私网 sc-mail-openclaw 的 HTTP。所有 webhook 需至少 24 字符独立 token，不能复用 Dashboard 密码。AI_MAIL_PUBLIC_API_URL 必须是 Agent 可访问的 API 基址。

## OpenClaw WhatsApp 与通知

手机消息进入 OpenClaw 原生 WhatsApp，再调用 MCP，也不代表同步客户 WhatsApp 历史。本机安装步骤统一见 [教程](AGENT_INTEGRATION.md)，Linux 同机私网见 [部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md)。

NotificationDelivery 仅支持 OpenClaw WhatsApp sender。WhatsApp 需要 OPENCLAW_WHATSAPP_NOTIFY_URL、AGENT_WEBHOOK_TOKEN、允许渠道与精确 E.164 收件人。relay ai-mail-notify 只有 session_status，不具备邮件/业务 MCP。事件 Agent 的通知请求由服务端策略、allowlist 和 requestKey 校验；正文规则见 [发件规则](MAIL_PROCESSING.md#发件规则与通知)。

只在 OpenClaw 明确报告完成且渠道接受时标 delivered；providerDeliveryId 记录 hook runId，非 WhatsApp 消息 ID。结果不明标 unknown 禁止自动重发；delivered 不表示用户已读。更改 Skill/提示不会重放已完成旧事件。

### 受控漏通知恢复

维护脚本 scripts/recover-missed-actionable-event.cjs 只接受明确 event-id 与唯一 operation-id，默认 dry-run。仅严格合格、已完成且 actionable=true 的 high/urgent 真人事件可恢复；检查来源、分流、黑名单与既有通知，拒绝已有投递记录，写 BusinessOperation 审计。

```sh
node scripts/recover-missed-actionable-event.cjs --event-id <id> --operation-id <unique-id>
# 核查 dry-run 后，仅对已授权目标恢复
node scripts/recover-missed-actionable-event.cjs --event-id <id> --operation-id <same-id> --apply
```

需 DATABASE_URL、构建 dist 与 Prisma Client。脚本不扫描或重放其他事件；恢复后看通知记录，不假定投递。队列全部终态后可 POST `/api/v1/mail/agent-events/review-summary`，body 为 operationId，幂等建立 BACKLOG_REVIEW_SUMMARY；有 pending/processing 会拒绝，payload 只有计数不含正文。

## WhatsApp 升级注意事项

Telegram 通知、轮询及聊天回调已移除。旧安装移除 TELEGRAM_BOT_TOKEN、TELEGRAM_ALLOWED_CHAT_IDS/USER_IDS、AGENT_CHAT_WEBHOOK_URL，设置 NOTIFICATION_ALLOWED_CHANNELS=whatsapp（空字符串关闭通知）。不自动迁移收件人：WhatsApp 仍需精确 E.164 allowlist、relay URL 与 webhook token。旧 channel=telegram 会被拒绝；历史表和投递记录保留但不消费，不重发或转投。集成状态不再返回 telegram / telegramSenderConfigured。

## 日报

新安装默认关闭；开启需 DAILY_BRIEF_ENABLED=true、可用事件回调及通知策略。默认计划 09:00，按 BUSINESS_TIMEZONE；停机错过时刻当天补建，键 daily-brief:本地日期:计划时刻 防重。避免 Agent 宿主重复创建日报调度。

Agent 调 mail_brief(date, includeEmails=false)，不把正文/主题交日报模型。字段、阈值、时区与完整性见 [日报契约](MAIL_PROCESSING.md#业务日报)。实际是否开启从状态 API/配置核实，不以文档默认或过去快照判断。

## 邮箱删除同步与旧命名空间核查

MAIL_DELETION_SYNC_ENABLED=true 时，默认每 4 小时（配置允许 1–24）取每个受管文件夹完整 UID 快照，范围不受日期限制。\Deleted 或移出受管文件夹可视为本地来源删除。只有成功快照、相同 UIDVALIDITY、UID 不超快照 UIDNEXT 上界才删除缺失本地邮件；失败不等于空文件夹，已验证空文件夹可清理。

删除在线库邮件原文/正文/行，保留已形成业务资料并标来源删除；最小墓碑阻止并发旧页复活。用户已授权此行为。备份不会自动改写，按保留策略管理。

GET `/api/v1/mail/sync/deletion/legacy-audit` 是维护只读入口，不向 CLI/MCP 暴露；sync/status 的 deletionSync.legacyNamespace 显示未核实旧记录数。要求受管游标健康，读稳定完整未删除快照，用原始 MIME SHA-256 精确比较旧命名空间记录，按重复指纹出现次数计数。任一文件夹失败或变化使整次审计失败。结果不返回正文、地址、指纹，不写业务、墓碑或通知；无精确匹配不等于已删除。

相关验证：build 后 `node scripts/verify-legacy-uidvalidity.cjs`，Docker 可用后 integration；真实 IMAP 特殊场景须另外验收。

## 备份和恢复

原始 MIME、CRM、事件及队列都在 PostgreSQL 卷。`pnpm backup -- <输出路径>` 创建 custom-format 全库备份，默认 backups/ai-mail-时间.dump；保密备份及 .env，并保留受控离机副本。

备份默认总时限 15 分钟、每 5 秒报告阶段/累计处理字节/耗时；BACKUP_TIMEOUT_MS 与 BACKUP_PROGRESS_MS 可设正整数毫秒。失败、取消或超时不会发布完成文件，已有备份拒绝覆盖。

恢复必须提供可信的已保存 custom-format 文件；不再从在线库重新 dump。先核实目标是隔离 PostgreSQL，再执行：

```powershell
$env:BACKUP_RESTORE_ALLOW_LOCAL_DB_CREATE = '1'
pnpm verify:backup-restore -- backups/your-saved-file.dump
```

脚本检查 PGDMP/TOC，计算文件 SHA-256，将原文件恢复到随机 aimail_restore_check_* 空库，核对迁移和邮件/CRM/任务/事件/通知表可读并输出计数。成功或失败均清理该临时库；清理另有 30 秒预算，清理失败或创建结果不明会报告唯一库名以便核查，不删除应用库。进度字节为各读取阶段累计值，不是百分比。恢复不启动 worker、不连接 IMAP、不投递通知；必须另外验收密钥、完整应用、离机介质和 RPO/RTO。

默认使用当前 Compose 的 postgres；BACKUP_PG_MODE=container 加 BACKUP_PG_CONTAINER 可选显式容器，CI 仅使用其 PostgreSQL 17 服务。native 模式使用本机 pg 工具和 loopback DATABASE_URL（可设 BACKUP_PG_BIN）；连接密码仅经环境传递。恢复工具有建库权限，不能恢复不可信来源的 dump。

### Windows Docker Desktop 流式备份停滞时的替代方法

脚本已提供限时和进度。若 Docker 传输仍异常，失败应记为未完成，partial 文件不是有效备份。可在同一 Compose 项目根目录把 dump 先写到 PostgreSQL 容器内，再用 Docker CLI 复制到受保护的本机 `backups` 目录。命令使用容器内的现有 `POSTGRES_USER` / `POSTGRES_DB`，不会在本机 shell、参数或输出中展开数据库凭据：

```powershell
$backupName = 'ai-mail-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$destination = Join-Path 'backups' "${backupName}.dump"
$containerDump = "/tmp/${backupName}.dump"
if (Test-Path -LiteralPath $destination) { throw 'Refusing to overwrite an existing backup.' }
New-Item -ItemType Directory -Force -Path 'backups' | Out-Null
docker compose exec -T postgres sh -lc 'test ! -e "$1"' sh $containerDump
if ($LASTEXITCODE -ne 0) { throw 'Refusing to overwrite an existing container dump.' }
docker compose exec -T postgres sh -lc 'set -eu; umask 077; pg_dump --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --file="$1"' sh $containerDump
if ($LASTEXITCODE -ne 0) { throw 'Container pg_dump failed.' }
$postgresContainers = @(docker compose ps -q postgres | Where-Object { $_.Trim() })
if ($LASTEXITCODE -ne 0 -or $postgresContainers.Count -ne 1) { throw 'Expected exactly one running postgres container.' }
$postgresContainer = $postgresContainers[0].Trim()
docker cp "${postgresContainer}:${containerDump}" $destination
if ($LASTEXITCODE -ne 0) { throw 'Docker copy failed.' }
Get-Item -LiteralPath $destination | Select-Object FullName, Length
docker compose exec -T postgres pg_restore --list $containerDump | Measure-Object -Line
if ($LASTEXITCODE -ne 0) { throw 'Container pg_restore --list failed.' }
$containerHashOutput = docker compose exec -T postgres sha256sum $containerDump
if ($LASTEXITCODE -ne 0) { throw 'Container SHA-256 failed.' }
$containerHash = ($containerHashOutput.Trim() -split '\s+')[0].ToLowerInvariant()
$localHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($containerHash -ne $localHash) { throw 'Container and local backup hashes differ.' }
docker compose exec -T postgres rm -f $containerDump
if ($LASTEXITCODE -ne 0) { throw 'Container temporary dump cleanup failed.' }
```

这是一组分步示例，不代表每行都已作为整体演练。检查目标文件大小、容器内 `pg_restore --list` 和两端 SHA-256 一致后，可记录备份文件和复制完整性检查通过；这仍不能证明文件可恢复。恢复演练需另行在唯一隔离数据库运行 `pnpm verify:backup-restore -- <已保存备份文件>`，不得对生产库执行恢复。复用此示例时，目标文件或容器内临时路径已存在就换一个新名称，并同步修改命令中的对应路径；不要覆盖已留存备份。无需在本机安装 PostgreSQL 客户端。


灾难恢复先停应用、保留损坏卷副本，在隔离空库恢复并验收后再切换。Docker CLI 必须可用，Windows 可用 DOCKER_BIN 指定 docker.exe。停止 Compose 保留数据，不执行 down -v。

## 迁移及升级


旧安装首次应用 `20261001120000_review_reliability` 时，回填 historicalImport、分析租约和账号/RFC ID 索引：旧 processing 分析变为可重试中断状态；有初始导入证据的邮件保持静默，尚未发送的误恢复事件/通知保留审计行并停止重试。已经投递的通知不会撤回；无初始来源证据的旧记录保留原恢复资格。

以下命令从仓库根目录执行；先备份，再停旧业务进程、保留数据库并完成隔离验收，随后升级：

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

执行前按现有运维流程备份。隔离验收使用独立临时数据库、合成邮件/AI/通知边界，不连接真实 IMAP 或发送真实通知。每次安装仍需按步骤验证。


## 同步恢复与对账

当前同步以文件夹 UID/UIDVALIDITY 游标和 pg-boss 持久轮询运行，无独立常驻 IDLE。首次历史导入保存 historicalImport=true，始终静默；增量恢复、对账重扫不能把它变成新邮件通知。架构见 [开发依据](../PROJECT_DEVELOPMENT.md#同步恢复与删除)。

### 处理与恢复

EmailMessage 与 ProcessingRecord 同事务建立，处理记录只是索引。单文件夹失败仍处理其他文件夹；首轮 failed/interrupted 或超时无进度从检查点恢复，页回写有版本保护。UIDVALIDITY 变化重建命名空间游标，在配置历史窗口补拉。确定性分类、CRM/项目归属与人工复核不等待模型。

通知分流在独立持久队列执行，不是所有商务或 UNKNOWN 直接唤醒。白名单确定真人建立必通知事件，普通真人经可信可行动意图分流；UNKNOWN/低置信入复核，机器/噪音静默。完整矩阵见 [规则](MAIL_PROCESSING.md#发件规则与通知)。机器资料见 [提取契约](MAIL_PROCESSING.md#机器邮件资料)，按需完整分析见 [AI](API_REFERENCE.md#ai-分析)。

### Dashboard 恢复与人工复核

在“分类与审计 → 邮件处理与恢复”查看重要性判断的失败、待复核、排队及处理中记录；“系统状态”也提供入口。列表按状态分页，读取失败与空记录分别显示，刷新只读数据。

先阅读来源、原因和技术信息，按提示检查模型配置、网络或 worker。仅 failed/review 提供“重新判断此邮件”；内联确认后，复用现有 `/mail/importance-triage/:id/retry`，以 operationId 对单条记录审计重新排队。页面会在本次登录会话内为同一状态快照复用未确认请求的操作编号，避免网络响应丢失后重复提交；完整重载浏览器后先刷新状态核查结果。状态已变化时按提示刷新，不批量清空或重试。

重新排队会再次调用模型，合格的新来信可能按现有规则创建 Agent 事件并通知 WhatsApp；初始历史仍静默，人工分类/归属保护不撤销。“已提交”只确认请求被接受，不代表判断完成或通知送达。pending/processing 不提供此操作；项目分析的取消/重试仍在项目详情进行。Agent 失败在此只读，不重放事件；通知 unknown 仍禁止自动重发。

“人工复核”列表与详情解释已知复核原因、建议下一步，并将原始建议/原因码折叠在技术信息中；未知原因不推断业务事实。建议不是自动应用结果，分类/项目等修改仍需已有确认流程；重分析事项在对应业务记录手动更正。来源已删除时不能打开来源或修改其项目归属，保留或忽略复核需按实际情况决定。

### 对账范围与接口

每账号 MailReconciliationCheckpoint 保存范围、文件夹页游标和 15 分钟租约。首次从已有 SyncCheckpoint.fromDate 开始，没有检查点按历史配置回看；后续从上次审计完成向前重叠一小时。每批最多 20 页，未完成保存 running，继续时不重置游标。

worker 每分钟检查；默认 BUSINESS_TIMEZONE 每日 05:00，MAIL_RECONCILIATION_ENABLED 默认 true，MAIL_RECONCILIATION_TIME 可改。需同一 IMAP 与加密密钥配置。

- GET `/api/v1/mail/reconciliation/status`：进度、导入/修复/复核数，不返回租约或凭据。
- POST `/api/v1/mail/reconciliation/run`：手动启动或继续有界批次；running 不能称完整审计结束。
- 认证见 [共用契约](API_REFERENCE.md#authentication)。Agent 仅在用户明确要求对账时手动触发。

审计补漏邮件和处理记录，重跑幂等确定性分类/CRM resolver，保护人工分类、项目与 Topic。真正近期漏收可经恢复分流建立逐封事件，来源与实际收件时间保留；首次恢复窗口为最近 24 小时，历史标记优先保持静默。

发生实际导入/处理索引/CRM 修复时另建一条 MAIL_RECONCILIATION_CORRECTED 汇总事件；只有未解决复核而无新修复不重复建汇总。汇总与近期漏收分流不同，不能写成“对账永不产生逐封候选”。对账不自动应用 AI 业务建议。

已确认 invitations.mailinblack.com 人机验证挑战为 SYSTEM_NOTIFICATION；自动清理由此域独自产生的临时联系人/复核及自动关联，保留人工确认的分类和归属。

## 旧自动联系人整理

仅用户明确授权时执行旧自动联系人整理；先备份并读取 `GET /api/v1/mail/crm/contacts/legacy-audit` 预览，再使用对应 retire/restore 维护入口。维护请求的 operationId 和回滚目标须按当前 controller/service 校验，不用正常 CRM 软删除代替旧退档恢复。

保留人工创建/确认/修改、合并或有业务依赖的记录；纯自动且无依赖的记录可审计退档，不能清空 provisional、联系人、邮件或其他复核。退档不删除原始邮件；恢复只针对对应操作，不能越权夺回后续已人工登记的邮箱。物理删除另需具体清单与授权。

## 需求、决策与 AI 建议操作

Dashboard 的“需求”“决策”按项目筛选、分页，详情读取当前版本和来源；新建可选项目/Topic，邮件详情可带真实来源创建。编辑只提交正文、状态与 expectedVersion，保留关联；冲突后关闭表单、刷新最新记录再决定，不用新版本盲目覆盖。决策 proposed 表示待确认，不能当成已接受的共识。项目概览也提供创建、详情及查看全部入口。

“AI 建议”展示分析候选，已有记录可从任意来源邮件进入；读取历史不调用模型。确认新分析后只保存建议/可能的复核，业务写入必须再逐条确认。保存/应用会按原业务实现产生事实、审计及业务事件，后续可能按既有策略通知 WhatsApp；隔离 fixture 始终禁用渠道。中断可恢复原分析编号；网络结果不明重试复用原编号，先刷新历史核查。失败/复核/旧 Schema 不能应用，目标人工保护与来源新鲜度仍由服务端校验。每次仅应用一条，失败不会把其他建议一起提交；摘要、分类和项目/Topic 建议仅供参考。会话内“已处理”反馈不代替持久审计，完整重载后服务端仍负责幂等。

## 开发验证与 CI复现

[CI](../.github/workflows/ci.yml) 在 PR、main push 和手动触发时运行，权限为 contents:read，使用 Node.js 24、pnpm 11.19.0、PostgreSQL 17 与冻结锁文件。验证 Prisma、类型/构建、适配与 UI、审查修复、CRM/项目分析及真实 CLI/MCP→HTTP→隔离 PostgreSQL。CI 只使用合成邮件、fake Provider 和无生产凭据的环境，不能代表真实通知或部署验收。合并规则见 [AGENTS](../AGENTS.md#github-分支与合并)。


静态和合成检查：

```sh
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:validate
pnpm typecheck
pnpm build
pnpm verify:tool-contracts
pnpm verify:openclaw-delivery
pnpm verify:logging
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

UI fixture 使用随机本地数据库、合成 `.invalid` 邮件、fake Provider，禁用 IMAP/外部通知。先编译，然后从项目根目录运行：

```powershell
$env:UI_CRM_ALLOW_LOCAL_DB_CREATE = '1'
$env:UI_CRM_SKIP_BUILD = '1'
node scripts/run-ui-crm-acceptance.cjs
```

浏览器入口为 `http://127.0.0.1:3001/dashboard/`，凭据按 fixture 本地输出使用；不要将输出提交。进程退出时清理它创建的隔离库。CLI/HTTP suite 用 `pnpm verify:crm-cli-http`。如需复现 CI 的 fixture，使用工作流的 `UI_CRM_RUN_CLI_SUITE=1` 设置。

恢复/复核界面验收可在启动前额外设置 `$env:UI_CRM_RECOVERY_FIXTURES='1'`、`$env:UI_CRM_RUN_CLI_SUITE='0'`；添加两条合成重要性记录和两条复核，不运行重要性 worker，通知允许列表为空。检查筛选/刷新、来源阅读、取消确认不写入、单条确认后排队及桌面/窄屏文案；不能把排队视为处理成功。自动化 `pnpm verify:dashboard` 覆盖失联重试、并发与迟到响应、跨会话 401、错误/空态、未知原因和不可信文本，沿用现有 CI 执行。

需求/决策/建议的浏览器复现可在 UI fixture 启动前设置 `$env:UI_CRM_BUSINESS_FIXTURES='1'` 和 `$env:UI_CRM_RUN_CLI_SUITE='0'`：种入两条带来源的合成业务记录，并仅在 fake Provider 边界生成有真实合成原文引用的需求/决策提案。模型不出网，通知关闭；不自动应用提案。`verify:dashboard` 验证界面确认、版本/重复/迟到响应与安全文本，`verify:integration-local` 验证真实 HTTP/隔离库的详情、历史分页、跨邮箱拒绝和幂等；两者均沿用现有 CI。

### P0 隔离恢复及完整回归

CI 增加同步恢复、分流租约、规则/Schema/任务、系统发件人、完整合成集成与备份故障回归。集成入口为 INTEGRATION_ALLOW_LOCAL_DB_CREATE=1 pnpm verify:integration-local；模型与渠道均 mock。pnpm verify:backup 不连接数据库，验证覆盖保护、超时、失败清理和输入拒绝。

pnpm verify:backup-postgres 要求 DATABASE_URL 指向独立本机 sc_mail_ci 和 BACKUP_RESTORE_ALLOW_LOCAL_DB_CREATE=1。它创建合成源库、保存/复制文件、删除源库，再恢复原文件并核对 MIME、CRM/任务来源、通知 unknown 状态；损坏文件须失败，临时库/文件自动清理。

本机可用 docker compose -p sc-mail-p0-tests -f scripts/fixtures/p0-postgres.yml up -d --wait 创建专用 PostgreSQL 17（127.0.0.1:55439，tmpfs，无生产卷）。将 COMPOSE_FILE 设为该文件绝对路径，COMPOSE_PROJECT_NAME=sc-mail-p0-tests，DATABASE_URL=postgresql://postgres:isolated-test-only@127.0.0.1:55439/sc_mail_ci。测试完成用相同 -p/-f 执行 down。该口令仅用于合成可丢弃实例；不得复用到生产。完整应用/外部渠道灾难恢复仍另行验收。

投递工具隔离回归仅改写临时 OpenClaw 合成配置，保留原 deny/relay/模型/其他 Agent；真实 MCP 子进程只连接本机 HTTP fixture。日志回归启动无数据库的最小 Nest/Express 服务，验证根/嵌套路由、health、GET/POST、404 和敏感字段脱敏，并拒绝旧 wildcard 转换警告；不启动主应用或读取生产配置。两项均纳入 CI。
