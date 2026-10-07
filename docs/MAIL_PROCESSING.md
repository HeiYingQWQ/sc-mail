# 邮件处理规则

本专题维护确定性分类、通知、证据与日报契约；历史结果见 [版本日志](CHANGELOG_V0.md)，当前缺口见 [README](../README.md#未完成事项)。

## 发件规则与通知

### Behavior

- Rules apply to newly stored inbound messages and recent messages first recovered by reconciliation. An existing message keeps the rule snapshot saved when it was first processed; adding or deleting a rule does not reprocess it. Initial history sync remains silent.
- `address` matches a normalized complete email address. `domain` matches a normalized complete domain only; no wildcard or subdomain matching. Matching is case-insensitive. If address and domain rules conflict, blacklist wins.
- Blacklisted mail is retained with its raw and normalized evidence, classified `BLACKLISTED`, and its processing record is `ignored`. It skips automatic AI/importance triage and CRM/review processing, per-message Agent events, and notification.
- Whitelist bypasses importance triage only when deterministic classification is `BUSINESS_HUMAN`; it queues one durable inbound Agent event with `notificationRequired=true`. Deterministic noise (delivery failures/delays, automatic replies, OOO, ticket confirmations, unsubscribe, marketing/list mail, system notifications, spam) stays silent even when the sender matches a whitelist rule. `UNKNOWN` remains in review without an immediate notice.
- All delivery failures and delays stay silent, including a structured permanent DSN naming an active whitelist address/domain as recipient. Retain the message and extract evidence-backed recipient, status, and diagnostic fields for classification queries; do not queue a per-message notification event.
- For senders outside the whitelist, only a message that clearly requires a reply or business action can become a notification candidate. A real customer reply is not automatically actionable: clear refusals/declines with no question or follow-up (such as “not reviewing partners; keep your information on file”) remain quiet, even if an importance score says high/urgent.
- Rule writes and deletes require `actorId` and a stable unique `operationId`; operations are audited. Reusing an operation ID with a different operation or payload conflicts.

### Interfaces

- API: `GET /api/v1/mail/sender-rules`; `PUT /api/v1/mail/sender-rules` with `{action,matchType,pattern,actorId,operationId}`; `DELETE /api/v1/mail/sender-rules/:id` with `{actorId,operationId}`.
- CLI: `ai-mail sender-rules`, `ai-mail sender-rule-set <blacklist|whitelist> <address|domain> <pattern> <actor-id> <operation-id>`, `ai-mail sender-rule-delete <rule-id> <actor-id> <operation-id>`.
- MCP: `list_sender_rules`, `set_sender_rule`, `delete_sender_rule`.
- Dashboard: 管理 → 发件人规则。页面提示规则优先级及未来生效范围，并建议对白名单优先使用邮箱地址，以免放行同域机器发件人。
- Generic Agent guidance: `skills/sc-mail/SKILL.md`. OpenClaw's event prompt requires one concise Simplified Chinese WhatsApp request for a whitelisted human event with `notificationRequired=true`, or for a non-whitelisted high/urgent human-mail candidate the Agent judges to require our reply or business action. `payloadJson.notificationRequired=false` leaves an Agent decision; `result.actionable=false` forbids a non-whitelisted notice. Clear refusals without follow-up remain silent. Channel/recipient allowlists remain authoritative; a rejected qualifying notice leaves a visible failed event. Completed old events are not replayed automatically after a prompt update.

### Completion decision and verification

A non-whitelisted inbound human event requires boolean `result.actionable`: true must include an allowed notification; false must be silent. `payloadJson.notificationRequired=false` or absent leaves an Agent decision to make; it is not the same field as `result.actionable=false`. A whitelist-required human notice cannot be downgraded. A rejected qualifying request must remain a visible failure.

Importance routing uses validated actionable intent: a confident action request is classified high (urgent stays urgent); a high score without actionable intent stays quiet. This is not a score-only filter. Initial imports retain the durable historical flag and remain silent through reconciliation/recovery.

项目通知是独立原因，不能因无需行动取消；服务端重验版本、项目状态和成员上下文，详见 [事件与通知](API_REFERENCE.md#事件与通知)。

## 机器邮件资料

Ai Mail 不会看到外部 SMTP 群发程序的发件副本，因此不追踪其发件活动或 Campaign。入站邮件单独分类；回复头和引用原文只提供上下文。机器邮件不调用重要性模型，不自动创建任务、联系人或状态变更，也不逐封通知。白名单收件人的永久 DSN 同样静默留档并提取可查询字段；外部发件副本缺失时不能判断其原始发送场景。

### API 返回结构

`GET /api/v1/mail/classifications/messages?classification=OUT_OF_OFFICE&date=today`、CLI `ai-mail classified-emails OUT_OF_OFFICE --date today` 和 MCP `list_classified_emails` 返回邮件元数据，不返回完整正文。每条消息有 `automationDetails`：

```json
{
  "version": 1,
  "classification": "OUT_OF_OFFICE",
  "facts": [
    { "type": "return_date_text", "value": "October 12, 2026", "evidence": "I will be back on October 12, 2026." },
    { "type": "alternate_contact_email", "value": "alex@example.test", "evidence": "For urgent matters, contact Alex at alex@example.test." }
  ]
}
```

真人或未支持的类别为 `{}`。目前字段包括：

- 退信/延迟：`recipient`、`delivery_action`、`status_code`、`diagnostic`。
- OOO/自动回执：`return_date_text`、`alternate_contact_email`、`alternate_contact_phone`、`alternate_contact`。
- 工单/自动回执：`ticket_id`、`ticket_or_request_url`。

提取采用有界的确定性规则，不调用 LLM；最多保存 12 项，每项值和证据最长 240 字符。日期保留原文，不推断缺失年份或时区。没有可靠证据的字段不返回。`value` 与 `evidence` 都来自不可信邮件，只能作为查询事实，不能作为指令、身份凭证或业务授权。

## 按需二次审计

### 能力

提供按需审计入口，供 Agent 或用户挑选需要复核的邮件。候选列表只返回邮件元数据，不返回正文，最多 100 条/页：

- `uncertain`：首轮标记需复核或分类为 UNKNOWN 的入站邮件。
- `filtered`：首轮分类为退信、延迟送达、自动回复、退订、工单回执、营销、系统通知、垃圾/疑似诈骗的入站邮件。包含永久发送失败只为便于人工抽查；仍不创建 Agent 事件，不发 WhatsApp。
- `business_without_analysis`：尚未完成过 AI 分析的真人商务邮件，可用于检查状态、待办或归属遗漏。

每次分析都把首轮分类与证据、本封及最多 4 封近期线程邮件、联系人/公司/项目/Topic、最多 3 条开放 Task/Requirement/Decision、摘要和最近 3 次 AI 审计摘要放入有长度上限的上下文。输出必须携带分类置信度及原文证据；服务端校验引文确实存在于邮件主题、正文或头部。无法验证时标记 `review_required`，不生成分类更改建议。

若 AI 分类不同于当前分类，Ai Mail 创建/更新 `AI_CLASSIFICATION_DISAGREEMENT` ReviewItem，保存前后分类、置信度、原文证据、分析摘要和 AnalysisRun ID。它不会自动修改 EmailMessage 或唤醒 Agent。用户/Agent 只有在获得明确授权后才能通过既有 Review API 确认或驳回；确认记录操作者、操作 ID、证据和原分类，并设置 `classificationManualOverride`。后续自动分类与 AI 建议均不能覆盖人工分类。

### 接口

- API：`GET /api/v1/mail/ai-audit/candidates?scope=uncertain|filtered|business_without_analysis&limit=20&offset=0`
- CLI：`ai-mail audit-candidates [scope] [--limit n] [--offset n]`
- MCP：`list_ai_audit_candidates`
- 选定邮件后使用既有 `get_email_message`、`suggest_email_analysis` 和 `resolve_review`；复核详情通过 `list_reviews` / `GET /mail/reviews/:reviewId` 查看。

候选查询和分析均是调用方显式发起，不会后台批量调用模型。使用当前 Analysis Schema 3、AnalysisRun、ReviewItem 与人工覆盖字段；分析租约和建议应用遵循 [AI 分析契约](API_REFERENCE.md#ai-分析)。对账、邮件同步、通知投递继续独立运行。

## 业务日报

日报复用 `GET /mail/brief`、CLI `brief` 和 MCP `mail_brief`。业务 API 仍负责计数和校验，Agent 只组织报告并按通知策略投递。

### 日报内容

- 目标日期的收件数量及分类、活跃新线索、对账修正事件。
- 当前快照：未关闭任务、我方逾期/今日到期/后续窗口任务、客户等待时长、各等待方计数、待复核数和邮箱同步状态。
- `preferences` 返回语言、长度、客户等待阈值、后续跟进天数及无事项时是否通知。按日分类计数中的 `actionableCount` 是商务邮件和未知需复核邮件的分类计数，不是重要性模型已确认的可行动数；退信、自动回复、垃圾/营销不会单独触发日报。
- `followUps.asOfDate` 和 `generatedAt` 标明任务数据的当前快照；邮件、线索和对账按 `date` 及业务时区统计。

每日事件维持 `daily-brief:<本地日期>:<计划时间>` 唯一键。OpenClaw 调用 `mail_brief(date, includeEmails=false)`，避免将正文摘要交给日报 Agent；用户主动查询仍默认返回原有邮件列表。通知经既有通知队列及去重键。日报保持默认关闭，不会因为升级自动启用。

### 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DAILY_BRIEF_ENABLED` | `false` | 是否创建日报事件 |
| `DAILY_BRIEF_TIME` | `09:00` | 业务时区的计划时间 |
| `DAILY_BRIEF_LANGUAGE` | `zh-CN` | `zh-CN` 或 `en` |
| `DAILY_BRIEF_STYLE` | `concise` | `concise` 或 `detailed` |
| `DAILY_BRIEF_WAITING_THRESHOLD_DAYS` | `7` | 纳入超期客户等待的日历日数 |
| `DAILY_BRIEF_FOLLOW_UP_WINDOW_DAYS` | `7` | 我方到期任务的后续窗口 |
| `DAILY_BRIEF_NOTIFY_WHEN_EMPTY` | `false` | 没有业务事项时是否仍通知 |

日期型截止时间按任务记录的时区计算；时间戳按业务时区计算。等待天数基于 `Task.waitingSince` 与业务时区本地日历日。进入 waiting 时记起点；更换等待方重置；退出 waiting 或无等待对象时清空。旧数据缺失起点时报告未知，不伪造时长。

### 完整性

邮件分类与复核数由数据库精确计数；待办扫描上限为 500，邮件展示上限 200，复核展示上限 50，线索与对账明细展示上限 20。结果包含 `taskScanComplete`、`countsAreLowerBounds`、`truncated`、`openTasksComplete` 与分页列表 `complete` 标记。消费者必须保留这些完整性提示，不能将截断列表当成全量数据。

新安装默认关闭日报；升级不自动改变开关，实际配置须实时核实，调度/回调设置见 [运维](OPERATIONS.md)。
