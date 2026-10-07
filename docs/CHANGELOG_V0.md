# V0 开发日志

当前进度 **V0.9.5**。本文件集中保存 V0.x 开发、历史验证和部署结果；当前能力/待办见 [README](../README.md)。

V0.0.1–V0.9.4 是本次按开发材料回溯编排的里程碑编号，不代表当时正式发布；早期 Git 没有逐阶段提交，累计验收不证明每阶段的独立发布日期。保留有证据的日期/区间，不补齐中间编号。

每版本含标题最多 10 个非空源码行。小成果递增补丁号，大里程碑递增次版本，大阶段递增主版本；日常修改/重复测试不机械增版。V1.0.0 新建 CHANGELOG_V1.md，V2 同理；旧日志保留，编号不自动改变 npm 版本或 Git tag。

删除的详细文档可用下方固定 GitHub 提交链接或 `git show 68eda89:<旧路径>` 查阅；记录中的通过、数量和健康均为当时范围/快照，不是本次重跑或长期健康承诺。

## V0.0.1 · 核心邮件与业务事实（2026-09-28–29 累计记录）
- 完成 M1–M13 的 NestJS/Prisma、IMAP 证据/游标、分类、CRM/项目/Topic、AI 建议、任务/需求/决策、摘要/时间线及 API/CLI/MCP。
- M14–M17 补齐受控事件/通知、恢复对账、按需二次审计和业务日报；人工覆盖、来源与幂等保护保持。
- 验证：M1–M17 累计 26 组隔离集成场景，模拟 IMAP/模型/渠道；真实模型仅合成结构化连接请求。
- 本机 OpenClaw MCP、事件 hook 和 WhatsApp 测试投递已有记录；手机自然语言完整链路、Telegram 和其他 Agent 待验。
- 证据：[累计验收原文](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/ACCEPTANCE_2026-09-28.md)。

## V0.1.0 · Dashboard（2026-09-29）
- M18 提供总览、邮件、任务、项目、时间线、CRM、复核、审计与系统状态；创建写入接入 BusinessOperation 幂等审计。
- 修复页面重载丢失筛选，保留分类/日期、任务/复核状态、项目选择。
- 验证：独立端口/数据库/卷的浏览器完成 CRM/项目、任务和阶段写入，复用 26 组隔离 API 场景；没有 Schema 变化。
- 其他带真实邮件的详情及复核动作未完整验收，临时容器/卷已清理。
- 证据：[M18 记录](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/ACCEPTANCE_2026-09-28.md)。

## V0.2.0 · 本地 AI 重要性分流（2026-09-29）
- M19 将确定性过滤与异步重要性队列分开；high/urgent 建候选事件，模型不直接写业务事实或发通知，历史导入静默。
- 验证：35/35 隔离场景通过；本机部署 20 条迁移，health、分流查询和无正文日报读取正常。
- 本机中文日报启用；新安装仍默认关闭。105 条来源事件处理与 WhatsApp 积压摘要投递有当时实测记录。
- 真实新邮件的模型质量、通知正反例及手机发起会话仍待验，不由积压处理代替。
- 证据：[分流/部署记录](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/ACCEPTANCE_2026-09-28.md)、[补充快照](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/DEPLOYMENT_SNAPSHOTS_2026-09.md)。

## V0.3.0 · 发件规则与机器资料（2026-09-29–30 累计记录）
- M20–M22 实现黑白名单、白名单真人必通知、普通真人可行动判断及机器邮件证据提取；永久 DSN/自动回复静默。
- 补齐规则 API/CLI/MCP/Dashboard、通知决策校验及可审计的漏通知恢复。
- 验证：累计隔离场景从 35 扩展至 44；合成规则、退信、OOO、工单及带回复头真人反例覆盖。
- 记录只支持所列合成与历史恢复场景，真实新来信正反例和字段提取边界仍待验；各阶段独立完成时间未充分记录。
- 证据：[累计验收](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/ACCEPTANCE_2026-09-28.md)、[问题/验证记录](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/PROBLEMS_2026-09-30.md)。

## V0.4.0 · 同步、分流与界面可靠性（2026-09-30）
- 修复单文件夹失败恢复、分流租约、复核并发、静默决策、分页、页面请求竞态、任务/等待计数和登录刷新。
- 增加结构错误字段诊断/有限重试，旧 HTML 邮件提供安全文本兜底；保留严格 Schema 和原始证据。
- 验证：隔离集成 50/50、Dashboard 21/21、同步恢复 13/13、租约 6/6、契约 29 次请求；容器内 Prisma 校验通过。
- 本机部署累计 24 条迁移并做基础桌面/手机视口检查；外部故障、全页面性能和离机恢复未验。
- 证据：[修复原文](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/archive/PROBLEMS_2026-09-30.md)。

## V0.5.0 · 审查修复与正文导航（2026-10-01）
- 修复认证撤销、历史通知、重分析事实、任务完成/PATCH/移动、摘要输入版本、分析租约、模型参数及意大利语自动回复/延迟分类等 12 项问题。
- 新增当前正文投影与同窗口 RFC 关联导航；迁移 25 保留历史导入来源、租约和索引，原始证据不删。
- 验证：隔离集成 53/53、修复 17/17、Dashboard 23/23、同步 17/17、租约 9/9；构建/类型/Prisma 与契约通过。
- 本机部署健康；旧备份完成本机隔离恢复/计数核对，正文导航做真实浏览器及局部手机检查；定向清理缓存约 4.595 GB。
- 真实引用边界、完整手机/通知与离机恢复仍待验；首次 Docker 不可用的开发检查不冒充后续验收。
- 证据：[修复与升级原文](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/REVIEW_FIXES_2026-10-01.md)、[启动验收](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/ACCEPTANCE_2026-10-01.md)、[缓存证据](verification/cleanup-cache-2026-10-01.json)。

## V0.6.0 · 手动 CRM 与项目 AI（2026-10-02）
- 停止自动建联系人；多邮箱、公司/项目成员、生命周期、往来查询、人工归属、批次分析及派生摘要/建议接入共享工具。
- 旧纯自动联系人可预览/审计退档及恢复；明确证据才归类，新机会/多项目/不确定留复核，人工决定受保护。
- 验证：Dashboard 42/42、契约 69 次、CRM 隔离数据库与 backend 53/53；项目分析 26 jobs/112 fake Provider 调用，3 个合成模型 smoke。
- 隔离浏览器覆盖多邮箱、两个项目、9 封逻辑邮件和摘要覆盖 4/4；本机部署迁移 26，升级前后邮件与原文总量相同。
- 完整备份通过 TOC/哈希检查但未恢复；当时新工具未完全授权，内联复核浏览器和真实项目通知仍待验。
- 证据：[独立扩展原文](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/ACCEPTANCE_MANUAL_CRM_PROJECT_AI_2026-10-02.md)、[合成概览](assets/manual-crm-fixture-2026-10-02.png)。

## V0.7.0 · 投递报告与系统发件地址（2026-10-02）
- 新增按业务日/DST 聚合投递报告、明确失败地址与未知目标、精确系统发件地址管理及优先静默 guard；不从 To 猜失败对象。
- 验证：Dashboard 49/49、契约 77 次、系统发件地址 8 组隔离用例、项目分析 28 jobs/113 fake Provider 调用；backend 53/53 等回归记录通过。
- 本机部署迁移 27，升级前后邮件/原文总量相同；真实报告 API 与桌面页、合成地址增删/DST/逻辑去重通过。
- 新备份仅 TOC/哈希核对，未恢复；375px DOM 无横向溢出不等于完整移动端视觉，4 个宿主工具仍未授权。
- 证据：[投递扩展原文](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/ACCEPTANCE_MANUAL_CRM_PROJECT_AI_2026-10-02.md)、[合成报告页](assets/delivery-reports-fixture-2026-10-02.png)。

## V0.8.0 · 项目详情分区（2026-10-02）
- 项目详情扩大并分为概览/邮件往来/分析记录，依据及动态折叠，分页刷新保留分区，关闭或跳转清除专用宽度。
- 验证：JS 语法、Dashboard 51/51；真实浏览器检查桌面/手机分区、键盘切换、分页、来源跳转和窗口关闭，局部无页面溢出。
- backend 重建后静态文件哈希相同；本次没有接口/Schema 变化，也没有业务写入。
- 不替代全页面响应式、旧复核内联流程、真实模型分析或通知 E2E。
- 证据：[布局记录](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/ACCEPTANCE_MANUAL_CRM_PROJECT_AI_2026-10-02.md)。

## V0.9.0 · CRM CLI/MCP 与 OpenClaw（2026-10-07）
- 补齐联系人/公司/项目受控 CRUD 和软删除；operationId/CAS/关系锁保护依赖，删除保留原邮件，无自动级联或实体恢复接口。
- 用户明确创建才按查重→联系人→公司→项目逐步执行；失败报告已完成步骤，重试复用每步 ID。
- 验证：typecheck/build、契约 83 次、Dashboard 51/51、修复 19/19、CRM 删除隔离 PostgreSQL、真实 CLI/MCP→HTTP 33 项、backend 53/53。
- 本机更新 backend/worker/Gateway，迁移仍为 27；受限 helper 加入 23 项业务工具，实际 probe 48/52 项及只读 CLI/MCP 查询通过。
- 4 项投递工具仍过滤；新完整备份 TOC/哈希通过但未恢复；手机整套建档、项目通知及旧内联流程未端到端验收。
- 证据：[CLI/接入原文](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/ACCEPTANCE_CRM_CLI_2026-10-07.md)。

## V0.9.4 · GitHub 开发流程（2026-10-07）
- 建立私有仓库、PR/CI/本地 hook；已审核业务代码经 PR #1 导入，PR #2 移除未使用的 auth 卷声明并允许手动触发 CI。
- Git 历史为 1100542→9ef50ba→68eda89；PR #2 最新 head 4aaaea4 的 CI 已查询为 success，原审查记录可追溯。
- 私有仓库套餐不支持当前分支保护/Rulesets；本地 hook 与文档不等于服务端强制门禁。
- 证据：[PR #1](https://github.com/HeiYingQWQ/sc-mail/pull/1)、[PR #2](https://github.com/HeiYingQWQ/sc-mail/pull/2)、[原流程说明](https://github.com/HeiYingQWQ/sc-mail/blob/68eda89/docs/GITHUB_WORKFLOW.md)。

## V0.9.5 · 当前基线与文档统一（2026-10-07）
- 当前业务基线保留 CRM/项目 AI、投递报告、正文导航与共享工具；本次合并 27 个旧 Markdown，docs 收敛为 4 个专题、导航和本日志。
- README 集中有效待办，AGENTS 集中分支/审核规则；历史通过结论只迁入本日志，重要升级/备份/接口/人工保护保留。
- 推送 hook 增强为拒绝 main、非 feature/fix 工作分支与非快进更新；PR 合并须核对最新 SHA 的 CI、独立审查和必要验收。
- GitHub API 实查保护/Rulesets 均为 403 套餐限制；不升级套餐或公开仓库，不更改 npm 版本、tag、业务代码或迁移。
- 本次验证：19 份 Markdown 的 107 个本地链接/锚点、14 个历史 Git 入口、12 版行数、根文档 <5 KB、hook 9 场景及 10 段 PowerShell 语法通过；模板/npm 版本未变。
- 16 段 API/邮件/Agent 契约示例完整保留；提交 02a25de/ab1393d 的完整 GitHub CI 成功。用户随后授权原实现 Agent 复审、合并和删分支，本次复审来源与最终合并状态见 PR #3，后续默认独立审查规则不变。
- 证据：[PR #3](https://github.com/HeiYingQWQ/sc-mail/pull/3)、[已通过 CI](https://github.com/HeiYingQWQ/sc-mail/actions/runs/37649847626)、[当前专题目录](README.md)、[合并规则](../AGENTS.md#github-分支与合并)、[推送 hook](../.githooks/pre-push)。
