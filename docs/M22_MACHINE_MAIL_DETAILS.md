# 机器邮件信息查询

Ai Mail 不会看到外部 SMTP 群发程序的发件副本，因此不追踪其发件活动或 Campaign。入站邮件单独分类；回复头和引用原文只提供上下文。机器邮件不调用重要性模型，不自动创建任务、联系人或状态变更，也不逐封通知。白名单收件人的永久 DSN 同样静默留档并提取可查询字段；外部发件副本缺失时不能判断其原始发送场景。

## API 返回结构

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

## 验收范围

隔离验收覆盖纯文本退信收件人及诊断、OOO 返回日期/替代联系人、工单编号/链接持久化后经分类列表返回，以及带回复头且引用 OOO 文本的真人邮件仍分类为真人。当前运行/验收结果见 [README](../README.md)。真实新退信、OOO、工单字段提取和静默边界仍见 [未完成项](../Problem.md)。
