# 业务日报

日报复用 `GET /mail/brief`、CLI `brief` 和 MCP `mail_brief`。业务 API 仍负责计数和校验，Agent 只组织报告并按通知策略投递。

## 日报内容

- 目标日期的收件数量及分类、活跃新线索、对账修正事件。
- 当前快照：未关闭任务、我方逾期/今日到期/后续窗口任务、客户等待时长、各等待方计数、待复核数和邮箱同步状态。
- `preferences` 返回语言、长度、客户等待阈值、后续跟进天数及无事项时是否通知。按日分类计数中的 `actionableCount` 是商务邮件和未知需复核邮件的分类计数，不是重要性模型已确认的可行动数；退信、自动回复、垃圾/营销不会单独触发日报。
- `followUps.asOfDate` 和 `generatedAt` 标明任务数据的当前快照；邮件、线索和对账按 `date` 及业务时区统计。

每日事件维持 `daily-brief:<本地日期>:<计划时间>` 唯一键。OpenClaw 调用 `mail_brief(date, includeEmails=false)`，避免将正文摘要交给日报 Agent；用户主动查询仍默认返回原有邮件列表。通知经既有通知队列及去重键。日报保持默认关闭，不会因为升级自动启用。

## 配置

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

## 完整性

邮件分类与复核数由数据库精确计数；待办扫描上限为 500，邮件展示上限 200，复核展示上限 50，线索与对账明细展示上限 20。结果包含 `taskScanComplete`、`countsAreLowerBounds`、`truncated`、`openTasksComplete` 与分页列表 `complete` 标记。消费者必须保留这些完整性提示，不能将截断列表当成全量数据。

新安装默认关闭日报；已有安装不会因升级被自动关闭或开启。实际本机配置与部署快照见 [README](../README.md)，调度/回调设置见 [运维](M14_OPERATIONS.md)。
