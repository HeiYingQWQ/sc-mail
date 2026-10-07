# 按需 AI 二次审计

## 能力

提供按需审计入口，供 Agent 或用户挑选需要复核的邮件。候选列表只返回邮件元数据，不返回正文，最多 100 条/页：

- `uncertain`：首轮标记需复核或分类为 UNKNOWN 的入站邮件。
- `filtered`：首轮分类为退信、延迟送达、自动回复、退订、工单回执、营销、系统通知、垃圾/疑似诈骗的入站邮件。包含永久发送失败只为便于人工抽查；仍不创建 Agent 事件，不发 WhatsApp。
- `business_without_analysis`：尚未完成过 AI 分析的真人商务邮件，可用于检查状态、待办或归属遗漏。

每次分析都把首轮分类与证据、本封及最多 4 封近期线程邮件、联系人/公司/项目/Topic、最多 3 条开放 Task/Requirement/Decision、摘要和最近 3 次 AI 审计摘要放入有长度上限的上下文。输出必须携带分类置信度及原文证据；服务端校验引文确实存在于邮件主题、正文或头部。无法验证时标记 `review_required`，不生成分类更改建议。

若 AI 分类不同于当前分类，Ai Mail 创建/更新 `AI_CLASSIFICATION_DISAGREEMENT` ReviewItem，保存前后分类、置信度、原文证据、分析摘要和 AnalysisRun ID。它不会自动修改 EmailMessage 或唤醒 Agent。用户/Agent 只有在获得明确授权后才能通过既有 Review API 确认或驳回；确认记录操作者、操作 ID、证据和原分类，并设置 `classificationManualOverride`。后续自动分类与 AI 建议均不能覆盖人工分类。

## 接口

- API：`GET /api/v1/mail/ai-audit/candidates?scope=uncertain|filtered|business_without_analysis&limit=20&offset=0`
- CLI：`ai-mail audit-candidates [scope] [--limit n] [--offset n]`
- MCP：`list_ai_audit_candidates`
- 选定邮件后使用既有 `get_email_message`、`suggest_email_analysis` 和 `resolve_review`；复核详情通过 `list_reviews` / `GET /mail/reviews/:reviewId` 查看。

候选查询和分析均是调用方显式发起，不会后台批量调用模型。使用当前 Analysis Schema 3、AnalysisRun、ReviewItem 与人工覆盖字段；分析租约和建议应用遵循 [AI 分析契约](AI_ANALYSIS_API.md)。对账、邮件同步、通知投递继续独立运行。

## 验收边界

隔离验收覆盖：候选查询在 API/CLI/MCP 的结果一致且不泄漏正文；伪造引文不能生成分类复核；真实引文产生待确认分歧记录；确认后保留证据和历史；确定性重分类和后续模型分析不能更改人工决定。验收使用合成邮件和模型响应，不代表模型对真实邮箱的召回率或分类准确率已经评估。

隔离与实际部署结果统一见 [README](../README.md)，不以本专题的覆盖说明声称最新数据库用例已通过。
