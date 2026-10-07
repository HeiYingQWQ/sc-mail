# 2026-10-02 手动 CRM 与项目 AI 扩展验收记录

本记录覆盖已授权的手动多邮箱 CRM、项目生命周期/成员、项目邮件分析与摘要、CLI/MCP/Skill 适配。上一轮已部署版本及正文导航验收保留在 [2026-10-01 记录](ACCEPTANCE_2026-10-01.md)，不作为本扩展的部署证据。当前代码与部署分别记录；运行结果不自动表示已部署。

## 代码与工作树验证

- Dashboard 行为回归：42/42 通过；包含公司成员管理、项目详情公司按钮、项目邮件 From/To/CC/BCC 参与人和来源证据、分析范围日期显示、联系人往来、摘要建议、生命周期、项目分析取消和复核处理等路径。
- CLI/MCP 共享契约：69 个合成 API 请求通过，包含参数/错误/分页/日期/CAS/幂等校验；未连接生产数据库。
- 手动 CRM 隔离 PostgreSQL 回归通过。测试在独立随机数据库执行并清理；没有本记录可引用的 case 数量。
- Backend integration：53/53 通过；sync-recovery：17/17 通过；project-evidence：PASS。
- 末轮修复：地址若仅属于经审计退档的纯自动联系人，用户显式 POST/PATCH 时可将地址接管登记为手动联系人，不会合并旧联系人或夺取 confirmed/manual/业务依赖联系人的邮箱。独立真实 PostgreSQL 测试覆盖多旧来源地址的 POST、现有 confirmed 目标 PATCH、未选邮箱和原始/弱关系保留、来源 CAS/审计/幂等、恢复时防止越权夺回、人工备注保护及退档恢复后的再次登记；schema 未变。修复后 `pnpm build`、`pnpm verify:contact-resolver`、`pnpm verify:manual-crm` 通过，Backend integration 重新验证 53/53；验收库清理成功。
- 项目分析隔离 PostgreSQL 最终 suite：26 个实际 job、28 个业务场景（场景主题数，不是断言计数），fake Provider 共 112 次调用（归类 60、摘要 39、reducer 13），退出码 0，临时数据库自动清理。
- Provider smoke：3 个合成场景通过，覆盖 2026 德国项目更新、节日问候和与候选项目无关的 2027 新合作。未提供真实生产邮件给模型。此 smoke 不等于完整项目分析或外部通知验收。
- UI fixture 在独立随机数据库运行真实 Dashboard/业务服务，邮件与地址均为 `.invalid` 合成数据，AIProvider 使用 fake，IMAP/外部通知禁用。浏览器手动创建 2 位联系人，登记 3 个邮箱地址（Anna 两个、Morgan 一个），另有含 2 位成员的公司和同公司的 2 个项目；9 封逻辑邮件由 fixture 预置导入，分类为归入德国/美国项目 6 封（4/2）、1 封非项目、1 封新机会、1 封待确认。摘要完成并覆盖 4/4 封项目邮件。日期范围显示 09-01 至 09-30；公司与编辑按钮可操作；From/To/CC/BCC 参与人、引用片段及来源按钮可读；空 CC/BCC 显示 `—`。移除下方回复的历史引用后，RFC 同线程导航为 3/3，上一封切到 2/3 且正文更新。
- 另一次合成摘要 Provider 验证返回并通过 5 claims、4 sources、5 evidence。以上 browser 数据为隔离 fixture，不能代表生产数据。
- 初轮暴露的公司按钮、日期序列化、参与人、原始证据 JSON 和 fake 摘要引用问题均已修正。第二轮在人工复核动作触发原生 `confirm()`，阻塞 in-app browser；项目归属、取消分析、复核忽略现已改为页面内二次确认。Dashboard 回归为 42/42；但这些内嵌确认尚未由浏览器完成复验，当前浏览器验收因此仍未完成。

## 部署与运行时

2026-10-02 最终 backend/worker 镜像已部署；PostgreSQL 与 backend healthy、worker running，migration 26，`GET /health` 返回 200，剩余临时数据库为 0。独占队列配置为 30 秒 UTC，首个队列 job 完成；末轮只读检查时项目分析队列 5 个 job 均 completed，8 个 SyncCheckpoint 均 completed。迁移与退档前后邮件总数和原文总字节数一致（963 封/857922398 bytes）；159 个自动 provisional contact 已软退档并产生 8 条审计，旧自动联系人待复核为 0；后续同步没有新建自动联系人，联系人/公司/项目主目录仍为 0。只读快照还显示 120 个 AgentEvent completed、12 个 NotificationDelivery delivered、293 个全局 ReviewItem pending/189 个 resolved；这是既有工作进程恢复后的业务状态，不是本轮通知发送测试，也未清理待复核。UI fixture 以 SIGTERM 退出码 0，fixture DB 删除成功，剩余临时数据库为 0。

备份：一次 `backup.mjs` 流式尝试被取消并以 exit 1（`pipeclosed`）结束；终止后发现 526638814-byte partial，另有空目标文件。Windows/Docker Desktop 根因未确认，运行中大小观察不可靠。partial、空目标和容器临时文件现已删除。替代完整备份由容器内 `pg_dump` 写 `/tmp/aimail-pre-crm-20261002-2239.dump`，再复制到 `backups/ai-mail-pre-crm-2026-10-02.dump`；文件 829044321 bytes，容器源/本地 SHA-256 均为 `887cf391a5629e1424c0917628de7bade2eef460491d85ed2cb396068acb54fd`，`pg_restore --list` 可读 319 行。新备份未执行恢复演练；2026-10-01 旧备份恢复结果不能替代。

OpenClaw MCP 容器挂载并成功加载共享契约模块，报告 20 个工具契约；stdio `tools/list` 返回 45 项，真实 `list_contacts` API 调用成功并返回空列表。16 个新增工具仍未加入 allowlist。`configure-mcp.mjs` 配置请求被自动审批拒绝，用户批准仍待处理，因此不能声称本轮工具已完整接入。Agent 事件、项目通知 hook 与真实新项目通知尚未做端到端验收。Dashboard 页面内确认通过 42 项行为回归，但最新内联确认仍待浏览器复验。Overview 截图 [manual-crm-fixture-2026-10-02.png](assets/manual-crm-fixture-2026-10-02.png) 仅记录概览页面，不是内联确认流程的证据。

fixture SIGTERM 退出码 0、fixture 数据库清理成功，剩余临时数据库为 0。备份哈希检查、镜像构建、接口状态、契约模块加载、工作树回归各自只证明对应步骤；不代表新备份恢复、Gateway allowlist、完整浏览器流程或通知端到端已通过。

不得将 UI fixture 账户、合成邮件或隔离 PostgreSQL 状态视作生产数据。当前状态和剩余工作见 [README](../README.md) 与 [Problem](../Problem.md)。

## 投递失败报告页独立扩展验收

本节是 2026-10-02 后续的独立投递报告扩展记录，不回写或替代上面的 CRM/项目验收快照。

**代码与隔离验证：**最终 `pnpm build` 通过；Dashboard 49/49、CLI/MCP 共享契约 77 个 fake API 请求通过。系统发件地址隔离 PostgreSQL 验证通过 8 组业务用例（含国际化域名），临时库自动删除。项目分析隔离回归为 28 个 job、113 次 fake Provider 调用（归类 61、摘要 39、reducer 13）；此前 CRM backend 53/53、sync-recovery 18、triage 9、AI validator/project-evidence 回归通过。没有在真实业务地址上新增或删除配置。

**部署与真实 API：**2026-10-02 backend/worker 已部署 migration 27；backend/PostgreSQL healthy、worker running，`GET /health` 返回 200。未经 Bearer Token 的投递报告请求返回 401。三个默认精确地址正确存在。邮件数据升级前后均为 963 封、原文 857891622 bytes，严格相同；本快照与上一个部署时的 963 封/857922398 bytes 是不同时间点的独立快照，不可比较成邮件丢失。验收写操作未修改真实系统地址；三条默认配置由 migration 27 初始化。2026-09-28 的 API 快照有 49 个物理邮件副本、RFC 去重后 47 份报告：失败 46、不同失败地址 46、未知对象 0、延迟 0、其他系统通知 1；分页为 20 条，响应不含 subject/body/raw。默认查询日 2026-10-02 为 0 份报告。新备份 `backups/ai-mail-pre-delivery-reports-2026-10-02.dump` 为 829246101 bytes，SHA-256 `0995590c46db1870f646608883ad28303ef3a2cf8bf931e88d76cfad37893c21`，`pg_restore --list` 可读 345 行；未做恢复演练。

**真实 Dashboard 与合成 fixture：**重新加载后的生产 Dashboard 显示默认今天 0 份报告及完整的三个地址管理入口，未改生产地址配置。隔离 fixture 验证当天 4 份逻辑报告（失败 2、不同失败地址 2、未知对象 1、延迟 1、系统通知 1）；2026-03-29 Europe/Rome 日界限只含 2 份，22:01Z 邮件落入次日。新增 `RETURNS@extra-fixture.invalid` 后归一为小写；移除合成来源后聚合为 0，再加回恢复为 4。桌面最终截图为 [投递报告 fixture](assets/delivery-reports-fixture-2026-10-02.png)，宽 1844 px；最终页面的标签单行显示，未知目标只显示一次“未识别”。375px viewport DOM 测得页面及 scrollWidth 均为 375px，表格容器 305px；移动端完整截图/视觉验收未完成，不据此宣称全移动端通过。

fixture 以 SIGTERM 退出码 0 结束，随机数据库已删除，临时测试库为 0。OpenClaw 未增加 allowlist 权限；新四个投递报告工具只完成共享契约定义，尚未在 OpenClaw 授权。项目通知 E2E 与旧项目复核内联确认浏览器验收仍待完成。Dashboard 投递报告页可独立使用，不依赖该 Agent 接入。

## 项目详情布局独立调整

2026-10-02 按用户窗口拥挤反馈，项目详情扩大至最多 1180px，并分为“概览 / 邮件往来 / 分析记录”三个 ARIA 分区。概览采用主内容与公司、联系人侧栏；邮件归类依据及最近动态默认折叠。邮件筛选、分页和任务完成刷新保留当前分区；项目专用宽度在关闭、跳转邮件/公司、打开普通表单时清除。本次只改 Dashboard 及对应行为回归，没有业务接口或 Schema 变化。

**验证：**`node --check apps/dashboard/app.js`、Dashboard 51/51 通过；Impeccable layout 检测返回空结果。真实项目浏览器最终确认覆盖 1280×720 桌面与 390×844 手机：三分区、方向键切换、依据独立展开、来源邮件跳转、邮件第二页 21–29/29、收件筛选 1–12/12、已有分析任务下的分析入口、普通分析/公司窗口 760px、Escape 关闭。桌面弹窗 clientWidth/scrollWidth 均为 1165px；手机均为 341px，页面宽/scrollWidth 均为 390px，邮件横向滚动限制在表格容器。没有提交分析、重试摘要、编辑资料或其他业务写操作；已有 AI_TIMEOUT 摘要失败不属于本次布局验收。

**部署：**backend 镜像构建成功并已重建运行容器；backend/PostgreSQL healthy、原 worker 保持 running，`GET /health` 为 200。容器内 app.js/styles.css 的 SHA-256 与已验收本地源码分别相同。临时验收标签已关闭，手机视口覆盖已恢复。最终截图：[桌面概览](assets/project-detail-layout-2026-10-02.png)、[手机概览](assets/project-detail-layout-mobile-2026-10-02.png)。本节不替代前述 Agent 接入或通知 E2E 的待验收项。
