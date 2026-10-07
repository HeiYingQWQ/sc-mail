> **归档，非当前规范。** 历史验收快照（正文记录跨 2026-09-28 至 2026-09-30）；不证明最新版本已部署或检查通过。

# 当前实现验收 · 2026-09-29

## 范围与结论

本次回归验收覆盖 M1–M17 的 26 组隔离集成场景，并补做 M18 Dashboard 浏览器写入验收；M19 工作区代码通过 35/35 隔离验收后，于 2026-09-29 部署到本机 Docker。M19 隔离测试使用独立数据库、合成邮件和模拟模型，未改动真实邮箱业务记录；本次部署应用 20/20 个迁移，health/API 正常。真实邮件的模型分流与重要邮件 WhatsApp 链路仍未用实际来信验收。WhatsApp 手机自然语言对话的 MCP 操作仍未验收。测试结果只代表列明的环境和场景，不保证不存在其他缺陷。

集成验收在 Docker 内创建独立 PostgreSQL 数据库并应用全部迁移，使用真实 Nest HTTP、业务服务、CLI、MCP 与 pg-boss。邮件、IMAP 故障及分析结果使用合成输入；Agent/Telegram 网络传输使用模拟响应。结束后删除本次临时库，不改真实邮箱业务记录、不向客户发信。

## 验收覆盖

| 范围 | 已通过场景 |
| --- | --- |
| M1–M2 | HTTP 认证、参数错误、读取接口；密码随机加密与篡改拒绝 |
| M3–M5 | 导入事务回滚、重复扫描、历史邮件静默、商务/需复核未知到件事件去重、永久退信仅存档不唤醒、自动回复/广告/疑似钓鱼不唤醒、UIDVALIDITY 恢复保留人工分类；真实 pg-boss 重启后任务恢复、失败重试 |
| M4–M7 | 验证域名显示名称伪装防误判；联系人/公司/项目/Topic 解析、复核去重及人工归属保留；清理保留共享及人工实体 |
| M8–M11 | AI 结构校验、来源证据、显式应用、操作幂等、人工覆盖保护、错误输出拒绝；Task/Requirement/Decision、并发版本冲突、双方等待、Summary 回滚、时间线与阶段审计 |
| M12 | 事件并发领取、租约恢复、单事件重试上限、通知 allowlist、完成回执重复提交 |
| M13 | HTTP/CLI/MCP 一致性及冲突传播；分类汇总/列表查询一致；独立用户任务进入 brief；发件人先筛选再分页；Europe/Rome 夏令时 23/25 小时日期边界 |
| M14 | 模拟 webhook 503 重试及稳定幂等键；日报去重；Telegram 成功不重发、429 退避、网络结果不明不盲目重发；WhatsApp E.164 格式、成功回执；入站权限与消息去重 |
| M15 | 处理记录缺失补回、模拟 IMAP 中断重试、修复计数持久化、重复审计不重复纠错、人工项目保留、租约互斥、21 页跨批次续跑 |
| M16 | API/CLI/MCP 候选结果一致且不含正文、分类证据必须可在原文验证、分歧仅创建待复核建议、人工确认保留证据/历史并防止后续重分类覆盖 |
| M17 | waitingSince 进入/保留/等待方变更/退出；目标日期和当前任务快照分离；逾期任务、客户等待、新线索、复核、对账纠正摘要；HTTP/CLI/MCP 可选择不返回邮件摘要；日报偏好透传及计划事件去重 |

上述覆盖归为 26 组；检查名及断言见 `scripts/acceptance.cjs`。

## 修复的问题

1. Mailinblack 识别可能误读显示名称中的地址；改为仅使用解析后的实际地址，精确匹配域名。
2. 自动分类并发更新缺少人工覆盖条件；补充写入条件，并将验证邮件清理置于最终分类之后。
3. 验证通知清理可能关闭同源的共享联系人复核；缩小清理范围，保留其他待复核状态，清理事务使用可串行化隔离。
4. brief 先截断再筛发件人会遗漏当日较早匹配邮件；改为先筛选并统计全部匹配邮件。独立用户任务也纳入 brief。
5. Agent 事件完成重放受 JSON 对象字段顺序影响；改用稳定排序比较。租约过期按各事件的 `maxAttempts` 结束重试。
6. 对账补回处理记录后遇到中断可能丢失修复计数；补建和计数同事务保存，并在扫描前补齐。分类忙碌时重试，未发生新修复时不再重复发纠错事件。
7. WhatsApp E.164 校验正则多转义了一层，导致合法号码被拒；修正格式校验并添加成功/拒绝格式的回归覆盖。
8. 入站邮件此前在分类前创建 Agent 唤醒，导致自动回复、退信也逐封交给 OpenClaw；改为先在 Ai Mail 本地分类，仅商务邮件和需复核邮件创建实时事件，退信留存并可查询但不建事件、不发 WhatsApp。增加普通文本退信、自动回执/退订、营销、凭据钓鱼信号及分类汇总/列表 API、CLI、MCP，并向 MCP/CLI 开放按需 AI 建议；通知模板改为简体中文短报。
9. Dashboard 写操作复核发现 CRM 与项目创建缺少业务操作审计和重放幂等；现在创建公司、联系人、项目会记录操作者、操作编号、输入摘要和前后值。同一请求重放返回原记录，重复使用编号提交不同内容返回冲突。表单保存期间禁用重复提交；API 对象错误和版本冲突改为可读中文提示。

10. Dashboard 页面切换时先清空旧内容，筛选函数随后从已移除的控件读取值，导致查询后回到默认选项。将收件箱分类/日期、任务和复核状态、时间线项目选择存入页面内存状态，并用合成任务/项目复验查询结果与选择保留。

本次没有 Schema 变化，没有新增迁移。

M17 维护任务 waitingSince 并扩展结构化日报，无新增数据库表或迁移。旧任务缺少等待起点时显示未知；日报 MCP 可排除邮件主题和摘要，只返回业务计数。

M18 本轮只扩展既有 BusinessOperation 审计表，无 Schema 变化或新增迁移。隔离 API 验收复用现有 26 组集成场景，通过真实 Nest HTTP 路由创建 CRM/项目记录，并检查幂等重放、操作者记录、前后值和操作编号冲突。随后在独立临时 Docker Compose 项目（端口 3001、独立 PostgreSQL 卷）通过 Dashboard 浏览器完成公司创建、联系人关联公司、项目关联公司、任务创建及状态编辑、项目阶段更新；总览、收件箱、待办、项目、时间线、联系人、公司、复核、审计、系统状态页面均加载成功。验收发现筛选后页面重载会丢失选择，现将收件箱分类/日期、任务状态、复核状态和时间线项目保存在页面状态，并通过筛选重载复验。临时容器和卷已清理；未操作 3000 主服务、真实邮箱或真实业务记录。其他含邮件数据的详情和复核动作未做真实数据验收。

## M19 本机部署与隔离验收

M19 本地 AI 邮件分流代码独立数据库合成邮件/模拟模型隔离验收 35/35 通过，覆盖噪音静默、重要等级事件、重试/复核、迁移和日报三类计数与正文排除。部署前经业务 API 只读检查，旧版 `mail-arrival` 的 pending/processing/failed 事件均为 0，其他 AgentEvent pending/processing 也均为 0。随后停止 backend/worker，部署新镜像并应用 20/20 个迁移，再按健康依赖启动 worker；PostgreSQL 数据卷保留。部署后 health、importance-triage API 和 Brief 均正常；当前分流 `pending/review/failed` 计数为 0，`includeEmails=false` 返回聚合计数且不含正文。用户选择启用现有简体中文日报（09:00 Europe/Rome）；今日日报 AgentEvent 完成、无错误，通知汇总记录新增已投递状态。未查看通知文案、未发送人工测试消息。真实模型对真实重要邮件的分类准确性与对应 WhatsApp 通知仍未验收；手机 WhatsApp 自然语言→MCP 对话仍未验收。

## 实际检查记录

- Prisma Schema 校验、TypeScript 检查与生产构建通过。
- 7 项规则检查通过：normalizer、business-gate、sync-cursor、contact-resolver、project-review、ai-analysis、task-state（含 M17 waitingSince fixtures）。
- 隔离数据库集成验收：26 组通过、0 失败，临时库已清理。当前受限 PowerShell 环境下 `pnpm verify:integration` 包装脚本无法 spawn Docker（EPERM）；用等价 Docker Compose 命令直接运行同一验收脚本通过。
- 实际数据库备份恢复到临时库：通过，核对 27 张表、17 条迁移、1,475 封邮件及 44 条事件；临时库已清理。此为演练时快照计数。
- 真实模型调用：配置的 `gpt-5.6-sol`、`high` 成功返回合成结构化检查结果，未发送真实邮件内容。
- M16 隔离验收使用合成邮件/模型结果验证分类证据、旧审计上下文、ReviewItem 人工确认与人工覆盖保护；未将真实候选邮件送入模型。
- OpenClaw：官方 Docker Gateway `2026.9.6` 在本机运行并健康；控制台只绑定 `127.0.0.1:18789`。使用同一 OpenAI 兼容接口，OpenClaw 通过 MCP 调用 Ai Mail `list_tasks(status=open)`，返回 0，端到端回合成功；本次未读取邮件正文。MCP 工具令牌和模型密钥由专用本地 env 文件提供，OpenClaw JSON 配置只存 env 引用。
- WhatsApp 通知：真实 Ai Mail 事件领取/完成接口入队，worker 经独立 OpenClaw hook relay 向本地 allowlist 中指定收件人投递一条不含邮件内容的测试通知；通知记录为 `delivered`，OpenClaw run 为 `status=ok`。测试事件与通知记录已删除。Relay 仅开放 `session_status`，邮件/业务 MCP 工具不可用。
- OpenClaw 事件接入：MCP 支持事件列表、领取、续租、完成、失败、通知状态及按源邮件 ID 读取最多 8,000 字符正文；邮件正文标记为不可信。2026-09-29 worker 实际唤醒并处理 105 条来源事件（104 条入站邮件、1 条对账纠错），全部完成、失败 0。队列终态后通过 `BACKLOG_REVIEW_SUMMARY` 让 OpenClaw 生成验收摘要；WhatsApp 通知经 Ai Mail allowlist 与 worker 投递，状态 `delivered`。事件 outbox 保持启用。
- 部署前真实 API 读取成功：8 个文件夹首轮导入完成，同步错误 0，对账 completed；今日 brief 返回 57 封，未截断。实时计数会继续变化。
- 修复已用 `docker compose up --build --detach backend worker` 部署到本地。部署后 backend/PostgreSQL 健康、worker 运行，17 条迁移全部应用；IMAP 自动轮询恢复 connected，8 个文件夹无同步错误，队列失败 0，最新成功同步为 `2026-09-28T19:08:07.018Z`。今日 brief 为 60 封，未截断。
- 2026-09-29 通过 Ai Mail 的确定性分类接口重跑 1,536 封本地邮件；实时快照（00:24:55Z）显示 812 封入站邮件全部有分类，0 封未分类：商务邮件 262、发送失败/退信 185、自动休假回复 88、自动回执 216、工单确认 36、营销广告 1、系统通知 15、垃圾/疑似诈骗 9。8 封风险邮件保留复核标记；待判断为 0。此操作只更新分类元数据，没有建立 Agent 事件或发送 WhatsApp。
- 修复 OpenClaw 2026.9 多 Agent 配置兼容项后，Gateway 健康，`mcp doctor --probe` 显示 Ai Mail `ok`。M16 更新后启用 21 个 Ai Mail MCP 工具（另有受限的 `session_status`），凭据通过环境变量引用配置。历史快照曾确认 812/812 已分类、复核 8、事件待处理 0；M16 候选接口本次返回 8 条待复核邮件元数据，未读正文、未运行模型。Doctor 仍对敏感变量名给出告警，但已核实配置文件只存 `${AI_MAIL_API_TOKEN}` 引用，未保存令牌明文。
- 审核最近实时事件发现一封中文客户咨询被 OpenClaw 判断为可行动，但通知因请求含不支持字段被拒；事件随后无通知完成。已修正事件提示：此类咨询即使不紧急也必须通知，通知对象严格限制为 `requestKey`、`channel`、`recipientRef`、`content`；拒绝后修正重试，仍失败则保留失败事件。历史事件不会自动重放；本次未手动触发 OpenClaw 或 WhatsApp。
- 真实库当前没有 Task/Requirement/Decision/Project；这些写入流程通过隔离数据验收，不表示真实邮件已全部完成 AI 业务分析。
- M18 浏览器验收使用合成测试数据；公司、联系人、项目、任务均在隔离数据库内可见，任务从待处理更新为处理中，项目从潜在客户更新为规划。筛选复验在合成记录上检查任务状态结果，并确认收件箱分类/日期、复核状态、时间线项目在重载后保留。未连接真实 IMAP/通知；测试环境停止后数据库卷删除，Compose 列表确认只剩主服务与 OpenClaw。
- M17 历史部署检查曾配置 `DAILY_BRIEF_ENABLED=false`。2026-09-29 M19 上线后，用户选择启用日报；当前本机配置为简体中文简洁风格、09:00 Europe/Rome、空日报不通知。部署触发今日日报事件完成并留下已投递记录，未人工查看其正文或发送测试通知。

## 复现

在已配置且 PostgreSQL 运行的工作区执行：

```powershell
pnpm prisma:validate
pnpm typecheck
pnpm build
pnpm verify:normalizer
pnpm verify:business-gate
pnpm verify:sync-cursor
pnpm verify:contact-resolver
pnpm verify:project-review
pnpm verify:ai-analysis
pnpm verify:task-state
pnpm verify:integration
pnpm verify:backup-restore
```

集成验收需要已构建的 backend Docker 镜像；以当前 `dist` 和脚本只读挂载运行，使用临时数据库。备份恢复演练会读取当前业务库并创建临时恢复库。检查实际服务时可将 `scripts/verify-live.cjs` 通过标准输入传入 `docker compose exec -T backend node`，默认只读；仅显式设置 `ACCEPTANCE_MODEL_SMOKE=true` 时会另发一次合成模型请求。

## 尚未完成的外部验收

- OpenClaw 本机 MCP、真实事件 hook→MCP、105 条来源事件处理及 WhatsApp 摘要投递已实测。WhatsApp 手机自然语言→MCP 对话仍待端到端验收；Hermes、Claude 等其他 Agent 的兼容性仍待实测。
- 可选 Telegram 手机桥未配置。WhatsApp 手机对话和断线重连尚未验收。
- 当前实现采用 IMAP 轮询；M15 对账修复导入、处理记录及基础 CRM，AI 业务建议仍需显式分析和应用。

因此本地核心可继续使用；完整产品验收尚有上述外部链路，不自动进入下一阶段开发。
