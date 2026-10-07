# 运维、回调与恢复

本文维护操作契约。最新部署/验收状态见 [README](../README.md)，当前待完成项见 [Problem](../Problem.md)，旧验收快照见 [归档](archive/README.md)。本文不证明服务正在运行。

## 进程、配置与升级

backend 提供 HTTP/Dashboard，worker 同一应用上下文执行后台队列、分流、对账、删除核对和 outbox。默认按单 worker 部署。配置键/范围以 [.env.example](../.env.example)、AppModule 校验和 Compose 为准。

检查 `docker compose ps`、`GET /health`、认证的 `/api/v1/mail/sync/status`、`/reconciliation/status` 与 `/integrations/status`；队列配置成功不证明外部模型、手机或 sender 已实测。IMAP 默认持久轮询 60 秒，近实时不等于 IDLE 推送。

已有安装升级 2026-10-01 修复，先备份并停旧 backend/worker，完成隔离数据库验收，再迁移/启动；完整步骤见 [修复升级](REVIEW_FIXES_2026-10-01.md#迁移及升级)。不要让旧 worker 与新 Schema 回填同时工作，也不要用旧部署通过次数替代最新验收。

## Agent 事件回调

worker 对 AGENT_EVENT_WEBHOOK_URL 发送 POST，AGENT_WEBHOOK_TOKEN 为 Bearer，Idempotency-Key 为 ai-mail-event-事件ID：

```json
{"protocol":"ai-mail.agent.v1","type":"events_ready","eventId":"...","eventKey":"...","eventType":"INBOUND_EMAIL_RECEIVED","apiBaseUrl":"https://mail.example/api/v1"}
```

接收端快速响应 2xx、异步启动 Agent，按 key 去重。Agent 用业务 API Token 通过 MCP 领取指定 eventId；正常聊天不认领后台事件。回调只传元数据，不传正文/执行指令，Agent 按 sourceMessageId 读取有界详情。

未处理事件约每 5 分钟可重新唤醒，最多 10 次；事件领取/完成有另一套租约与重试，见 [事件接口](AGENT_EVENTS_API.md)。Webhook 接受不等于事件完成，更不等于通知投递。

远程回调使用 HTTPS；代码允许本机 Docker Desktop host.docker.internal 和服务器专用私网 sc-mail-openclaw 的 HTTP。所有 webhook 需至少 24 字符独立 token，不能复用 Dashboard 密码。AI_MAIL_PUBLIC_API_URL 必须是 Agent 可访问的 API 基址。

## OpenClaw WhatsApp 与通知

手机消息进入 OpenClaw 原生 WhatsApp，再调用 MCP，不经过 Ai Mail Telegram poller，也不代表同步客户 WhatsApp 历史。本机安装步骤统一见 [教程](OPENCLAW_INTEGRATION_GUIDE.md)，Linux 同机私网见 [部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md)。

NotificationDelivery 支持 Telegram 和可选 OpenClaw WhatsApp sender。WhatsApp 需要 OPENCLAW_WHATSAPP_NOTIFY_URL、AGENT_WEBHOOK_TOKEN、允许渠道与精确 E.164 收件人。relay ai-mail-notify 只有 session_status，不具备邮件/业务 MCP。事件 Agent 的通知请求由服务端策略、allowlist 和 requestKey 校验；正文规则见 [发件规则](M20_SENDER_RULES.md)。

只在 OpenClaw 明确报告完成且渠道接受时标 delivered；providerDeliveryId 记录 hook runId，非 WhatsApp 消息 ID。结果不明标 unknown 禁止自动重发；delivered 不表示用户已读。更改 Skill/提示不会重放已完成旧事件。

### 受控漏通知恢复

维护脚本 scripts/recover-missed-actionable-event.cjs 只接受明确 event-id 与唯一 operation-id，默认 dry-run。仅严格合格、已完成且 actionable=true 的 high/urgent 真人事件可恢复；检查来源、分流、黑名单与既有通知，拒绝已有投递记录，写 BusinessOperation 审计。

```sh
node scripts/recover-missed-actionable-event.cjs --event-id <id> --operation-id <unique-id>
# 核查 dry-run 后，仅对已授权目标恢复
node scripts/recover-missed-actionable-event.cjs --event-id <id> --operation-id <same-id> --apply
```

需 DATABASE_URL、构建 dist 与 Prisma Client。脚本不扫描或重放其他事件；恢复后看通知记录，不假定投递。队列全部终态后可 POST `/api/v1/mail/agent-events/review-summary`，body 为 operationId，幂等建立 BACKLOG_REVIEW_SUMMARY；有 pending/processing 会拒绝，payload 只有计数不含正文。

## 可选 Telegram 桥接

启用聊天需 TELEGRAM_BOT_TOKEN、精确 TELEGRAM_ALLOWED_CHAT_IDS/USER_IDS、AGENT_CHAT_WEBHOOK_URL 及独立 webhook token，缺项不长轮询。worker 存 update 与唯一游标，再发聊天回调：

```json
{"protocol":"ai-mail.agent.v1","type":"telegram_message","updateId":"123","idempotencyKey":"telegram:123","user":{"id":"..."},"chat":{"id":"..."},"message":{"id":"...","text":"...","untrusted":true},"apiBaseUrl":"https://mail.example/api/v1"}
```

Agent 接收器响应 text，worker 回复原会话。接收器按 Idempotency-Key 去重并检查用户业务授权。回复结果不明为 unknown，不自动重发；处理终态会话 30 天后清理。

Telegram long poll/chat processor 假设单 worker，多副本前必须加 leader/advisory lock。主动通知另需允许 channel=telegram、精确 chat ID。确定性 429/5xx 有界退避；成功保存 Telegram message ID。不要把 bot token 放参数、Skill 或日志。

## 日报

新安装默认关闭；开启需 DAILY_BRIEF_ENABLED=true、可用事件回调及通知策略。默认计划 09:00，按 BUSINESS_TIMEZONE；停机错过时刻当天补建，键 daily-brief:本地日期:计划时刻 防重。避免 Agent 宿主重复创建日报调度。

Agent 调 mail_brief(date, includeEmails=false)，不把正文/主题交日报模型。字段、阈值、时区与完整性见 [日报契约](M17_DAILY_BUSINESS_BRIEF.md)。实际是否开启从状态 API/配置核实，不以文档默认或过去快照判断。

## 邮箱删除同步与旧命名空间核查

MAIL_DELETION_SYNC_ENABLED=true 时，默认每 4 小时（配置允许 1–24）取每个受管文件夹完整 UID 快照，范围不受日期限制。\Deleted 或移出受管文件夹可视为本地来源删除。只有成功快照、相同 UIDVALIDITY、UID 不超快照 UIDNEXT 上界才删除缺失本地邮件；失败不等于空文件夹，已验证空文件夹可清理。

删除在线库邮件原文/正文/行，保留已形成业务资料并标来源删除；最小墓碑阻止并发旧页复活。用户已授权此行为。备份不会自动改写，按保留策略管理。

GET `/api/v1/mail/sync/deletion/legacy-audit` 是维护只读入口，不向 CLI/MCP 暴露；sync/status 的 deletionSync.legacyNamespace 显示未核实旧记录数。要求受管游标健康，读稳定完整未删除快照，用原始 MIME SHA-256 精确比较旧命名空间记录，按重复指纹出现次数计数。任一文件夹失败或变化使整次审计失败。结果不返回正文、地址、指纹，不写业务、墓碑或通知；无精确匹配不等于已删除。

相关验证：build 后 `node scripts/verify-legacy-uidvalidity.cjs`，Docker 可用后 integration；真实 IMAP 特殊场景须另外验收。

## 备份和恢复

原始 MIME、CRM、事件及队列都在 PostgreSQL 卷。`pnpm backup -- <输出路径>` 创建 custom-format 全库备份，默认 backups/ai-mail-时间.dump；保密备份及 .env，并保留受控离机副本。

`pnpm verify:backup-restore` 在 Compose PostgreSQL 建唯一临时库，将源 pg_dump 流式恢复并比对表/迁移/邮件/事件数量，只删除脚本创建的临时库，不覆盖应用库。可用 pg_restore --list 检查文件。演练只验证结构和关键行数，不等于完整应用恢复。

### Windows Docker Desktop 流式备份停滞时的替代方法

当前 `scripts/backup.mjs` 与 `scripts/verify-backup-restore.mjs` 没有总时限和进度报告，Docker/PowerShell 调用可能无限等待。Windows 上流式备份被取消后以 exit 1（`pipeclosed`）结束；运行期间的文件大小观察不可靠，不能据此断定是否有数据流，也没有确认本次停滞的根因。若进程长时间无可见进度，取消后将其记为未完成，并把生成的 partial 视作无效备份。可在同一 Compose 项目根目录把 dump 先写到 PostgreSQL 容器内，再用 Docker CLI 复制到受保护的本机 `backups` 目录。命令使用容器内的现有 `POSTGRES_USER` / `POSTGRES_DB`，不会在本机 shell、参数或输出中展开数据库凭据：

```powershell
$destination = 'backups/ai-mail-pre-crm-2026-10-02.dump'
if (Test-Path -LiteralPath $destination) { throw 'Refusing to overwrite an existing backup.' }
New-Item -ItemType Directory -Force -Path 'backups' | Out-Null
docker compose exec -T postgres sh -lc 'test ! -e /tmp/aimail-pre-crm-20261002-2239.dump'
if ($LASTEXITCODE -ne 0) { throw 'Refusing to overwrite an existing container dump.' }
docker compose exec -T postgres sh -lc 'set -eu; umask 077; pg_dump --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --file=/tmp/aimail-pre-crm-20261002-2239.dump'
if ($LASTEXITCODE -ne 0) { throw 'Container pg_dump failed.' }
$postgresContainers = @(docker compose ps -q postgres | Where-Object { $_.Trim() })
if ($LASTEXITCODE -ne 0 -or $postgresContainers.Count -ne 1) { throw 'Expected exactly one running postgres container.' }
$postgresContainer = $postgresContainers[0].Trim()
docker cp "${postgresContainer}:/tmp/aimail-pre-crm-20261002-2239.dump" $destination
if ($LASTEXITCODE -ne 0) { throw 'Docker copy failed.' }
Get-Item -LiteralPath $destination | Select-Object FullName, Length
docker compose exec -T postgres pg_restore --list /tmp/aimail-pre-crm-20261002-2239.dump | Measure-Object -Line
if ($LASTEXITCODE -ne 0) { throw 'Container pg_restore --list failed.' }
$containerHashOutput = docker compose exec -T postgres sha256sum /tmp/aimail-pre-crm-20261002-2239.dump
if ($LASTEXITCODE -ne 0) { throw 'Container SHA-256 failed.' }
$containerHash = ($containerHashOutput.Trim() -split '\s+')[0].ToLowerInvariant()
$localHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($containerHash -ne $localHash) { throw 'Container and local backup hashes differ.' }
docker compose exec -T postgres rm -f /tmp/aimail-pre-crm-20261002-2239.dump
if ($LASTEXITCODE -ne 0) { throw 'Container temporary dump cleanup failed.' }
```

这是一组分步示例，不代表每行都已作为整体演练。检查目标文件大小、容器内 `pg_restore --list` 和两端 SHA-256 一致后，可记录备份文件和复制完整性检查通过；这仍不能证明文件可恢复。恢复演练需另行在唯一隔离数据库运行 `pnpm verify:backup-restore`，不得对生产库执行恢复。复用此示例时，目标文件或容器内临时路径已存在就换一个新名称，并同步修改命令中的对应路径；不要覆盖已留存备份。无需在本机安装 PostgreSQL 客户端。

2026-10-02 本机检查记录：有效备份为 `backups/ai-mail-pre-crm-2026-10-02.dump`，829044321 bytes；容器源与本地副本 SHA-256 均为 `887cf391a5629e1424c0917628de7bade2eef460491d85ed2cb396068acb54fd`，`pg_restore --list` 得到 319 行。容器内临时 dump 已删除。此前未完成的 526638814-byte partial 与空目标文件已删除。该次新备份没有做恢复演练；2026-10-01 的旧备份恢复结果不覆盖此缺口。

灾难恢复先停应用、保留损坏卷副本，在隔离空库恢复并验收后再切换。Docker CLI 必须可用，Windows 可用 DOCKER_BIN 指定 docker.exe。停止 Compose 保留数据，不执行 down -v。
