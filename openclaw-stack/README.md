# OpenClaw 桥接目录

独立 Compose 项目，镜像固定 2026.9.6，Gateway 端口只绑定回环地址，保留独立状态卷。不要挂载宿主 Docker socket；停止保留状态，不用 down -v。SC Mail 的 API/CLI/MCP/Agent 标识 ai-mail 为兼容名称。

`openclaw_state` 挂载 `/home/node/.openclaw`，保存配置、workspace、会话和凭据。原 `openclaw_auth` 仅挂载旧配置目录 `/home/node/.config/openclaw`，本机核实为空且没有其他依赖后已从 Compose 移除。已有安装只在确认旧卷为空、没有其他容器使用时才可删除；不要按名称批量删除卷。

## 接入入口

- 新安装、onboarding、MCP/Skill、配对、事件和 WhatsApp sender：统一按 [Docker Desktop 教程](../docs/OPENCLAW_INTEGRATION_GUIDE.md#2-从零接通本机-docker-desktop)。
- 同一 Linux Docker 主机：按 [部署 Skill](../skills/sc-mail-openclaw-deploy/SKILL.md)，使用私网 overlay；服务器端到端部署未验证。
- API/Token、业务规则与正文范围：[Agent 契约](../docs/M13_AGENT_INTEGRATION.md) 与 [运行 Skill](../skills/sc-mail/SKILL.md)。
- 回调/通知状态、备份/删除：[运维](../docs/M14_OPERATIONS.md)。当前部署状态只见 [根 README](../README.md)。

| 文件 | 职责 |
| --- | --- |
| compose.yml、compose.server.yml | 独立本机栈和 Linux 私网覆盖 |
| setup.mjs | 仅首次生成本地 .env，已有文件不覆盖 |
| configure-mcp.mjs | 注册 MCP、专用 hook、主助手与受限 relay 的工具范围 |
| enable-events.mjs | 显式启用事件地址及匹配 hook token；要求单一允许 WhatsApp 收件人 |
| enable-whatsapp-notifications.mjs | 同步 sender URL/token，不改变收件 allowlist、不发测试消息 |
| agent-templates | 通用助手模板与非覆盖式安装器；用户私有 agent-files 不进入仓库 |

configure-mcp 针对专用 Gateway 修改全局工具配置，不应直接用于承载其他 Agent 的共享实例。MCP 子进程配置保留 AI_MAIL_API_TOKEN 环境引用，不能写秘密字面值。脚本对定制模型设置 reasoning=true；须先确认实际端点支持 Responses、工具调用和该推理选项，不能由此宣称任意模型兼容。

主助手可用 workspace 文件/本地记忆、web/reminder 与 SC Mail 工具，不具备部署 shell；工具存在不证明搜索提供方/日历已经连接。ai-mail-notify 只有 session_status，是通知 relay，不能查询邮件或业务事实。

## 通用助手模板与轻量记忆

仓库发布的 [agent-templates](agent-templates/) 只含通用边界、表达和空白记忆模板，不含本机用户偏好或客户资料。`install.mjs` 只补目标 workspace 中不存在的文件；已有文件（包括 `MEMORY.md`、`memory/` 下记录）会保留，不覆盖、不备份或读取内容。被 `.gitignore` 排除的本机 `agent-files/` 是私有数据目录，安装器不会访问它。模板不是架构依据，也不代表 Agent 已启动。

安装前使用 `agents list --json` 核对 `ai-mail` 的实际 workspace 路径。默认目标为 Compose 环境中的 `OPENCLAW_WORKSPACE_DIR`；如 Agent 使用其子目录，设置 `SC_MAIL_AGENT_WORKSPACE` 为该容器内路径。目标目录必须已存在且位于 OpenClaw workspace 下。PowerShell 从仓库根目录运行：

```powershell
$dc = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'
$oc = @('compose', '--env-file', 'openclaw-stack/.env', '--project-name', 'ai-mail-openclaw', '--file', 'openclaw-stack/compose.yml')
$agentTemplates = (Resolve-Path 'openclaw-stack/agent-templates').Path
& $dc @oc run --rm --volume "${agentTemplates}:/opt/sc-mail-agent-templates:ro" --entrypoint node openclaw-cli /opt/sc-mail-agent-templates/install.mjs
```

若目标不是默认 workspace，在 `run` 命令中加入 `--env SC_MAIL_AGENT_WORKSPACE=/home/node/.openclaw/workspace/<已核实的目录>`。安装器会逐个报告新增与保留的文件名，不打印文件内容或完整本机路径；不要把个人偏好复制到通用模板。

轻量记忆为普通 Markdown，每文件 5,000 UTF-8 字节指导上限，按主题去重更新；installer 校验种子，不是运行时写拦截器。配置启用本地关键词搜索，不需 embedding API，关闭自动 transcript-to-memory hook、flush 和 dreaming 日记；会话记录与 curated memory 分开。不要因文档清理删除用户偏好、有效承诺或运行记忆。

宿主调度与 SC Mail 日报分开维护，所有者/实际任务先查 Control UI，说明见 [调度归属](../docs/OPENCLAW_INTEGRATION_GUIDE.md#4-调度归属)。
