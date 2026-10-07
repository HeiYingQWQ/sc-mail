# SC Mail 对接 OpenClaw：原理与本机教程

> 适用范围：本仓库的 Docker Desktop 部署，以及 `openclaw-stack/compose.yml` 固定的 OpenClaw 镜像版本 `2026.9.6`。操作针对仓库固定版本；当前部署/验收状态见 [README](../README.md)，不能从本文推断服务正在运行。产品名称是 **SC Mail**；Skill 标题为 **SC-Mail**，加载标识为 `sc-mail`；现有 `ai-mail` Agent、MCP、CLI 和 API 路径仍为兼容性标识。

服务器上的 OpenClaw 自配置步骤另见 [SC-Mail OpenClaw 部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md)。它需要独立部署 Agent 的 shell、Docker 和配置文件访问权限；`ai-mail` 运行 Agent 可使用个人助手和业务工具，但没有部署 shell，安装 Skill 不会赋予这些权限。

## 1. 接入职责与凭据

SC Mail 独立同步和保存事实，OpenClaw 承接手机对话、MCP 工具调用和事件处理；安装 Skill、MCP 接通、事件唤醒、主动投递分别配置。整体数据流见 [当前架构](../PROJECT_DEVELOPMENT.md#运行结构)，工具契约见 [Agent 接口](M13_AGENT_INTEGRATION.md)。

Dashboard 密码仅供登录；OpenClaw MCP 使用 API Token。setup.mjs 将根 .env 的 IMAP_API_TOKEN 复制为 openclaw-stack/.env 的 AI_MAIL_API_TOKEN，并生成独立 Gateway/hook 凭据。不要把密码与 Token 混用。

## 2. 从零接通：本机 Docker Desktop

以下是新安装步骤，PowerShell 命令从项目根目录执行。已有服务升级本轮修复先按 [升级顺序](REVIEW_FIXES_2026-10-01.md#迁移及升级) 停旧进程并验收/迁移。先确认 Docker Desktop 正在运行，根目录 `.env` 已配置 IMAP、`IMAP_API_TOKEN`、AI 提供方与密钥。不要将 `.env`、Gateway URL 中的令牌或终端输出的凭据贴进文档、聊天或截图。

### 第一步：启动 SC Mail

```powershell
$dc = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'
& $dc compose up --build --detach
& $dc compose ps
Invoke-RestMethod http://localhost:3000/health
```

应看到 `postgres` 和 `backend` 为 healthy，`worker` 为 running。SC Mail API 在 `http://localhost:3000/api/v1`，Dashboard 在 `http://localhost:3000/dashboard/`。数据库在 Docker 卷中；停止时不要使用 `down -v`。

### 第二步：初始化独立的 OpenClaw 配置

`setup.mjs` 从 SC Mail 的本地 `.env` 读取模型地址、模型密钥、模型 ID 和 API Token，生成 `openclaw-stack/.env`，并另外生成 Gateway 与 hook 密钥。该脚本只在文件不存在时运行，不覆盖已有凭据。

```powershell
node openclaw-stack/setup.mjs
$oc = @('compose', '--env-file', 'openclaw-stack/.env', '--project-name', 'ai-mail-openclaw', '--file', 'openclaw-stack/compose.yml')
& $dc @oc pull
& $dc @oc run --rm --entrypoint sh openclaw-cli -lc 'node dist/index.js onboard --non-interactive --accept-risk --skip-health --mode local --agent-name ai-mail --auth-choice custom-api-key --custom-base-url "$CUSTOM_BASE_URL" --custom-model-id "$CUSTOM_MODEL_ID" --custom-compatibility openai-responses --secret-input-mode ref --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --skip-channels --skip-hooks --skip-search'
```

此处 `openai-responses` 是当前接入配置所用的模型协议。所选模型端点还需要实际支持工具调用；模型能单纯回复文字，不代表 MCP 对话已经可用。若 `openclaw-stack/.env` 已存在，不重复运行 `setup.mjs`；检查并维护现有本地配置。

### 第三步：启动 Gateway，安装 MCP 与 Skill

```powershell
& $dc @oc up --detach openclaw-gateway
& $dc @oc run --rm --entrypoint node openclaw-cli /opt/configure-mcp.mjs
& $dc @oc up --detach --force-recreate openclaw-gateway
& $dc @oc run --rm openclaw-cli mcp doctor ai-mail --probe
& $dc @oc run --rm openclaw-cli skills info sc-mail --agent ai-mail --json
```

MCP 检查应返回 `ai-mail: ok`，Skill 检查应显示 `sc-mail` 的 `eligible` 和 `modelVisible` 为 `true`。Compose 将 `/opt/ai-mail-mcp.mjs`、`/opt/ai-mail.mjs`、`/opt/tool-contracts.mjs` 和受限 CRM 工具 helper 只读挂载；`configure-mcp.mjs` 是初始配置工具，不要为了更新 CRM 工具而重复运行它，因为它会调整更广的宿主设置。对已经正确注册的 Ai Mail MCP，先审查配置，再使用本教程中已初始化的 `$oc` Compose 参数运行 `& $dc @oc exec -T openclaw-gateway node /opt/enable-crm-tools.mjs`。该 helper 只追加共享 registry 中 CRM/项目/分析/邮件归属工具到现有的三处允许列表，保留模型、文件权限、cron、hook、relay 与已有 deny，并在写配置前备份；它不会注册 MCP 或授予通用 shell/exec。运行后重建 Gateway 使 MCP 过滤生效。当前是否已启用以实时 `mcp probe` 和 OpenClaw 配置为准，不从脚本存在推断接入完成。CLI 与 Gateway 共用 `openclaw_state`；Skill 由 Compose 以只读目录挂载到 OpenClaw workspace。OpenClaw 容器通过 `host.docker.internal:3000` 访问 SC Mail；宿主机的 Gateway 端口只映射到 `127.0.0.1:18789`。

可选地把通用个人助手文件补入 `ai-mail` Agent workspace。先用 `agents list --json` 确认该 Agent 的容器内 workspace 路径；模板默认来自仓库 `openclaw-stack/agent-templates`，不要从被忽略的本机私有 `agent-files/` 复制。安装器只创建缺少的文件，已有文件（尤其 `MEMORY.md` 与 `memory/` 记录）保持原样；它不改 OpenClaw 运行配置，也不启动 Agent：

```powershell
$agentTemplates = (Resolve-Path 'openclaw-stack/agent-templates').Path
& $dc @oc run --rm --volume "${agentTemplates}:/opt/sc-mail-agent-templates:ro" --entrypoint node openclaw-cli /opt/sc-mail-agent-templates/install.mjs
```

默认目标是 Compose 的 `OPENCLAW_WORKSPACE_DIR`。如果 `agents list --json` 显示 `ai-mail` 使用其下级目录，在命令中追加 `--env SC_MAIL_AGENT_WORKSPACE=/home/node/.openclaw/workspace/<已核实的目录>`。目标目录须已存在并位于 OpenClaw workspace 下。已有本机 `agent-files/` 私有目录不会被读取、覆盖或删除。

固定版本的 `mcp doctor` 可能对展开后的 `env.AI_MAIL_API_TOKEN` 提示敏感字面值；核实持久配置保存的是 `${AI_MAIL_API_TOKEN}` 环境引用，不要为消除提示把密钥复制进配置文件。

在 OpenClaw Control UI `http://127.0.0.1:18789/` 完成 WhatsApp 渠道的配对和授权。`configure-mcp.mjs` 把 WhatsApp 会话路由给 `ai-mail` Agent，但不会替你扫描二维码或完成手机端配对。获取本机带认证信息的 Dashboard URL 可运行 `& $dc @oc run --rm openclaw-cli dashboard --no-open`；该输出含访问令牌，只在本机使用。

**先验证 MCP，再验证手机对话。** 可以从 WhatsApp 向已配对的 OpenClaw 发送“今天收到多少封商务邮件？”或“有哪些待办？”，观察 Agent 是否调用 SC Mail 工具并在原会话回答。此完整手机提问到 MCP 再到手机回复的链路，在现有项目记录中仍标为待端到端验收，不能用 `mcp doctor` 成功代替。

### 第四步：按需启用事件唤醒与主动 WhatsApp 通知

只想从 WhatsApp 主动查询时，前三步即可。若还要让新邮件事件唤醒 OpenClaw，并由 SC Mail 受控发送主动通知：先在根目录 `.env` 设置 `NOTIFICATION_ALLOWED_CHANNELS=whatsapp`，以及**唯一、明确授权的** E.164 收件号码 `NOTIFICATION_ALLOWED_RECIPIENTS=+...`。`enable-events.mjs` 要求白名单恰好只有一个有效号码；不会自行选择联系人。

```powershell
node openclaw-stack/enable-whatsapp-notifications.mjs
node openclaw-stack/enable-events.mjs
& $dc @oc run --rm --entrypoint node openclaw-cli /opt/configure-mcp.mjs
& $dc @oc up --detach --force-recreate openclaw-gateway
& $dc compose up --build --detach worker
& $dc @oc run --rm openclaw-cli mcp doctor ai-mail --probe
```

两个辅助脚本分别写入通知发送 URL、事件回调 URL 和共享 hook 密钥；不会发送测试消息，也不会删除邮件数据。`configure-mcp.mjs` 注册 `/hooks/ai-mail-event`，并配置单独的 `ai-mail-notify` 转发 Agent。通知 Agent 只允许最小工具集，不持有邮件业务 MCP 工具。配置完后可在 SC Mail Dashboard“系统状态”查看事件唤醒、通知 sender 与队列状态。

## 3. 事件和投递的验收

新来信持久化、分类和异步重要性分流后，合格候选建立 AgentEvent；worker 用事件 ID 回调唤醒 OpenClaw，Agent 通过 MCP 领取/完成，通知请求写 NotificationDelivery，worker 再调用受限 relay 投递 WhatsApp。回调成功、事件完成、通知入队和渠道接受分别验证。

分类及必通知/静默规则统一见 [发件规则](M20_SENDER_RULES.md)，租约和 complete 字段见 [事件接口](AGENT_EVENTS_API.md)。后台不自行应用业务建议，不自动给客户发信。Agent 临时离线事件仍保留；unknown 投递不要绕过队列另发。

不因配置成功自动发送测试消息。实际手机问答、真实新来信通知正反例和渠道投递需要单独验收，当前缺口见 [Problem](../Problem.md)。

## 4. 调度归属

SC Mail worker 创建 DAILY_BRIEF，时间由根 .env 管理，新安装默认关闭，不在 OpenClaw 重复建日报。事件 webhook 不受宿主定时检查时刻限制。

OpenClaw 的 heartbeat、Skill Workshop 和记忆任务属于宿主。2026-09-30 本机记录曾禁用 system-owned heartbeat，并使用可编辑的固定时刻检查；这些是历史配置，不代表新安装自动建立或当前仍存在。维护前查 Control UI/cron list 的实际任务、所有者和时区，避免重复启用。宿主任务不是 SC Mail 邮件计数或投递状态的依据。

## 5. 常见故障与排查顺序

| 现象 | 核查与处理 |
| --- | --- |
| `AI_MAIL_API_TOKEN` 或 `IMAP_API_TOKEN` 缺失 | 这指 **MCP 子进程**没有 API 凭据，与 Dashboard 登录密码无关。先检查两份本地 `.env` 的变量是否存在，重新运行 `configure-mcp.mjs` 并重建 Gateway，再运行 `mcp doctor ai-mail --probe`。配置中的 MCP server 必须保留 `AI_MAIL_API_TOKEN: '${AI_MAIL_API_TOKEN}'` 环境引用；Gateway 环境变量不会自动传给该子进程。不要把 Token 明文写进 `openclaw.json`。 |
| MCP probe 失败或连接被拒 | 确认 SC Mail `backend` healthy；OpenClaw 容器中的 API 地址应是 `http://host.docker.internal:3000/api/v1`，而非容器自己的 `localhost:3000`。核对 API Token 是否与 SC Mail 的 `IMAP_API_TOKEN` 一致；若曾轮换 Token，安全更新 `openclaw-stack/.env` 后重建 Gateway。 |
| 能用 MCP 查询，但邮件到达没有唤醒 | MCP 与自动触发是两条配置。检查根目录 `.env` 的 `AGENT_EVENT_WEBHOOK_URL`、`AGENT_WEBHOOK_TOKEN`，OpenClaw hook 配置、Gateway 与 worker 是否重启，并查看“系统状态”的唤醒失败数。机器邮件、普通 low/normal 邮件本就静默。 |
| 事件完成但手机没收到消息 | 查看 `NotificationDelivery`，确认渠道为 `whatsapp`、号码在 `NOTIFICATION_ALLOWED_RECIPIENTS` 中、`OPENCLAW_WHATSAPP_NOTIFY_URL` 已设置，以及 OpenClaw WhatsApp 已配对。`pending` 或 `unknown` 不等于送达；不要直接从 OpenClaw 再发送一次绕过队列。 |
| 定时任务在 Control UI 不能修改 | 先核实所有者；system-owned 任务与用户任务维护方式不同，不假定旧固定时刻任务仍存在。日报时间在 SC Mail `.env` 的 `DAILY_BRIEF_TIME` 管理。 |

## 6. 相关文档与能力限制

实时健康用 compose ps、/health 和 integrations/status 查询。已有本机验收结果以 [README](../README.md) 及 [历史归档](archive/README.md) 为准；不把历史 healthy 或 MCP probe 代替当前服务/手机端到端验收。

通用个人助手模板与轻量记忆安装见 [桥接目录](../openclaw-stack/README.md)：默认只使用仓库内 `openclaw-stack/agent-templates`，不使用被忽略的本机私有 `agent-files/`。非覆盖式安装器只补 workspace 中缺少的模板；已有本机文件及运行中的 `MEMORY.md`、`memory/` 记录均保留。回调、备份、删除和受控恢复见 [运维](M14_OPERATIONS.md)，运行时指导见 [sc-mail Skill](../skills/sc-mail/SKILL.md)。同一 Linux Docker 主机使用 [部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md)，该路径尚未在用户服务器端到端部署。不同主机需适配可达 HTTPS URL，不直接复用 Docker Desktop 地址。
