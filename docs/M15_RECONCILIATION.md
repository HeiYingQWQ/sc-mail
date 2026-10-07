# 邮件恢复与对账

当前同步以文件夹 UID/UIDVALIDITY 游标和 pg-boss 持久轮询运行，无独立常驻 IDLE。首次历史导入保存 historicalImport=true，始终静默；增量恢复、对账重扫不能把它变成新邮件通知。架构见 [开发依据](../PROJECT_DEVELOPMENT.md#同步恢复与删除)。

## 处理与恢复

EmailMessage 与 ProcessingRecord 同事务建立，处理记录只是索引。单文件夹失败仍处理其他文件夹；首轮 failed/interrupted 或超时无进度从检查点恢复，页回写有版本保护。UIDVALIDITY 变化重建命名空间游标，在配置历史窗口补拉。确定性分类、CRM/项目归属与人工复核不等待模型。

通知分流在独立持久队列执行，不是所有商务或 UNKNOWN 直接唤醒。白名单确定真人建立必通知事件，普通真人经可信可行动意图分流；UNKNOWN/低置信入复核，机器/噪音静默。完整矩阵见 [规则](M20_SENDER_RULES.md)。机器资料见 [提取契约](M22_MACHINE_MAIL_DETAILS.md)，按需完整分析见 [AI](AI_ANALYSIS_API.md)。

## 对账范围与接口

每账号 MailReconciliationCheckpoint 保存范围、文件夹页游标和 15 分钟租约。首次从已有 SyncCheckpoint.fromDate 开始，没有检查点按历史配置回看；后续从上次审计完成向前重叠一小时。每批最多 20 页，未完成保存 running，继续时不重置游标。

worker 每分钟检查；默认 BUSINESS_TIMEZONE 每日 05:00，MAIL_RECONCILIATION_ENABLED 默认 true，MAIL_RECONCILIATION_TIME 可改。需同一 IMAP 与加密密钥配置。

- GET `/api/v1/mail/reconciliation/status`：进度、导入/修复/复核数，不返回租约或凭据。
- POST `/api/v1/mail/reconciliation/run`：手动启动或继续有界批次；running 不能称完整审计结束。
- 认证见 [共用契约](M13_AGENT_INTEGRATION.md#authentication)。Agent 仅在用户明确要求对账时手动触发。

审计补漏邮件和处理记录，重跑幂等确定性分类/CRM resolver，保护人工分类、项目与 Topic。真正近期漏收可经恢复分流建立逐封事件，来源与实际收件时间保留；首次恢复窗口为最近 24 小时，历史标记优先保持静默。

发生实际导入/处理索引/CRM 修复时另建一条 MAIL_RECONCILIATION_CORRECTED 汇总事件；只有未解决复核而无新修复不重复建汇总。汇总与近期漏收分流不同，不能写成“对账永不产生逐封候选”。对账不自动应用 AI 业务建议。

已确认 invitations.mailinblack.com 人机验证挑战为 SYSTEM_NOTIFICATION；自动清理由此域独自产生的临时联系人/复核及自动关联，保留人工确认的分类和归属。

## 验证

领域/隔离用例覆盖缺处理记录、IMAP 故障续跑、重复审计、租约互斥、超过 20 页续跑和初始历史恢复静默。实际执行及部署状态以 [README](../README.md) 和 [修复记录](REVIEW_FIXES_2026-10-01.md) 为准，旧扫描数量见 [历史验收](archive/ACCEPTANCE_2026-09-28.md)。删除核对是独立流程，见 [运维](M14_OPERATIONS.md#邮箱删除同步与旧命名空间核查)。
