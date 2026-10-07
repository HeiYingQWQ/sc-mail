---
name: sc-mail-openclaw-deploy
description: Deploy and verify the SC Mail to OpenClaw 2026.9.6 bridge, including MCP, event webhook, and optional WhatsApp notification relay.
---

# SC-Mail OpenClaw deployment

Use this Skill only when the user asks you to connect an already deployed SC Mail service to OpenClaw. Install this folder in a separate operator Agent's workspace `skills/sc-mail-openclaw-deploy`, then invoke it for the server setup. The runtime [SC-Mail Skill](../sc-mail/SKILL.md) teaches mailbox tool use; it does not install MCP or configure hooks. The operator Agent needs a host or SSH shell with Docker and file access to the repository and its ignored `.env` files. Do not mount the host Docker socket into the target OpenClaw Gateway. The target `ai-mail` is a general personal assistant with workspace files, local memory, web/reminder tools and SC Mail MCP tools, but no deployment shell; it cannot execute these deployment steps. A Skill cannot grant shell or file permissions. If you have only those MCP tools, state that you need an operator session with those capabilities; do not pretend the configuration is done.

These commands target the repository's **dedicated** OpenClaw `2026.9.6` Compose setup. `configure-mcp.mjs` sets a global tool allowlist in that dedicated instance. If the user's existing OpenClaw Gateway also hosts unrelated agents, do not run this script against it; use a separate dedicated stack or inspect its version and configure only the intended Agent. Preserve existing channels, model settings, automations, and WhatsApp pairing. Never print `.env` contents or secrets, paste credentials into chat, write literal tokens to `openclaw.json`, run `docker compose down -v`, or send a test WhatsApp message without the user's request.

## Information to establish

1. Locate the SC Mail repository on the server. Confirm `docker-compose.yml`, `docker-compose.server.yml`, `openclaw-stack/compose.yml`, `openclaw-stack/compose.server.yml`, and both setup scripts are present. Work from the repository root. If only this Skill file was supplied, request the repository path or checkout; the Skill is not an MCP executable.
   Require Node.js 22.12+ and Docker Compose v2 before running the helper scripts.
2. Confirm SC Mail backend and worker are running and the root `.env` has a nonempty `IMAP_API_TOKEN`. Do not display its value. Confirm whether OpenClaw already has its own `.env`, `openclaw.json`, model, and paired WhatsApp channel. Preserve existing state.
3. Ask for the exact E.164 WhatsApp number if proactive notification is desired and it is not already authorized in `NOTIFICATION_ALLOWED_RECIPIENTS`. The bundled `enable-events.mjs` requires exactly one allowlisted recipient and `whatsapp` in `NOTIFICATION_ALLOWED_CHANNELS`. Do not infer a recipient from contact or mailbox data.
4. Determine the network topology. The commands below assume both Compose stacks run on one Linux Docker host. For different hosts, provide an HTTPS URL reachable from each side, validate the OpenClaw version/config schema, and adapt the URLs. Do not copy `host.docker.internal` from the Docker Desktop example into a Linux server deployment.

## Same-host Docker network

Create one private shared network, and attach SC Mail backend/worker and the OpenClaw Gateway with the supplied overlay files. Keep the original Compose files and their data volumes. This gives OpenClaw the SC Mail API address `http://sc-mail-api:3000/api/v1` and gives the worker the Gateway address `http://sc-mail-openclaw:18789` without exposing the hook port publicly.

```sh
docker network inspect sc-mail-link >/dev/null 2>&1 || docker network create sc-mail-link
docker compose -f docker-compose.yml -f docker-compose.server.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build backend worker
```

Set up `openclaw-stack/.env` once. `setup.mjs` reads the existing root `.env` and refuses to overwrite an OpenClaw `.env`. For a new installation, run it with the server addresses; for an existing installation, carefully set or verify the two URL keys in the existing ignored file. Keep the generated Gateway and hook tokens. If `openclaw.json` does not exist, follow section 2 of `docs/AGENT_INTEGRATION.md` for onboarding (use the Linux overlay and server URLs below) before running `configure-mcp.mjs`.

```sh
AI_MAIL_API_URL=http://sc-mail-api:3000/api/v1 \
OPENCLAW_INTERNAL_URL=http://sc-mail-openclaw:18789 \
node openclaw-stack/setup.mjs
```

The resulting OpenClaw `.env` must contain `AI_MAIL_API_URL=http://sc-mail-api:3000/api/v1`, `OPENCLAW_INTERNAL_URL=http://sc-mail-openclaw:18789`, `AI_MAIL_API_TOKEN`, and `OPENCLAW_HOOK_TOKEN`. Do not run `setup.mjs` over an existing file. Use the existing secret value if the user already configured one; do not rotate it casually.

For proactive WhatsApp notices, ensure the root `.env` contains `whatsapp` in `NOTIFICATION_ALLOWED_CHANNELS` and exactly the user-authorized E.164 number in `NOTIFICATION_ALLOWED_RECIPIENTS`. Do not silently replace other channel or recipient policy. If that policy cannot be met, configure read-only MCP first and leave events/notification disabled until the user supplies a supported policy.

For MCP-only setup, skip `enable-whatsapp-notifications.mjs` and `enable-events.mjs`. Run `configure-mcp.mjs`, recreate the Gateway, and verify MCP and `sc-mail` visibility as below. The hook mapping may exist in OpenClaw, but SC Mail's worker will not send events while `AGENT_EVENT_WEBHOOK_URL` is unset. Report this as MCP-only; do not claim proactive notification is enabled.

## Register MCP and webhook

Use the existing OpenClaw Compose project name if one already exists; `ai-mail-openclaw` below is the bundled example. The CLI service shares the Gateway's state volume. Run the two helpers only after the URL and allowlist checks. They write matching hook token references and SC Mail worker callback URLs without printing secret values. `configure-mcp.mjs` registers MCP server `ai-mail`, routes WhatsApp to Agent `ai-mail`, creates the minimal `ai-mail-notify` relay, and maps `/hooks/ai-mail-event` to the event Agent. It keeps the SC-Mail runtime Skill separate from this deployment Skill.

```sh
docker compose --env-file openclaw-stack/.env --project-name ai-mail-openclaw \
  -f openclaw-stack/compose.yml -f openclaw-stack/compose.server.yml \
  config --quiet
docker compose --env-file openclaw-stack/.env --project-name ai-mail-openclaw \
  -f openclaw-stack/compose.yml -f openclaw-stack/compose.server.yml \
  up -d openclaw-gateway
node openclaw-stack/enable-whatsapp-notifications.mjs
node openclaw-stack/enable-events.mjs
docker compose --env-file openclaw-stack/.env --project-name ai-mail-openclaw \
  -f openclaw-stack/compose.yml -f openclaw-stack/compose.server.yml \
  run --rm --entrypoint node openclaw-cli /opt/configure-mcp.mjs
docker compose --env-file openclaw-stack/.env --project-name ai-mail-openclaw \
  -f openclaw-stack/compose.yml -f openclaw-stack/compose.server.yml \
  up -d --force-recreate openclaw-gateway
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --no-deps --force-recreate backend
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --no-deps --force-recreate worker
```

The helpers refuse to replace conflicting active webhook URLs or hook tokens. Investigate a conflict and preserve the current integration; do not bypass the check. The expected root `.env` values are `AGENT_EVENT_WEBHOOK_URL=http://sc-mail-openclaw:18789/hooks/ai-mail-event`, `OPENCLAW_WHATSAPP_NOTIFY_URL=http://sc-mail-openclaw:18789/hooks/agent`, `AGENT_WEBHOOK_TOKEN` matching the OpenClaw hook token, and `AI_MAIL_PUBLIC_API_URL=http://sc-mail-api:3000/api/v1`. The backend accepts this exact private Docker hostname for HTTP webhooks. For a different topology, use HTTPS callback URLs.

## Verify without sending mail or a WhatsApp message

1. Check `docker compose ... ps` for healthy backend/Gateway and running worker. From inside the Gateway, request `http://sc-mail-api:3000/health`; from inside the worker, confirm a TCP/HTTP response from `http://sc-mail-openclaw:18789/`. Authentication failures still prove reachability; connection or DNS failures do not.
2. Run `docker compose ... run --rm openclaw-cli mcp doctor ai-mail --probe` and require `ai-mail: ok`. Run `docker compose ... run --rm openclaw-cli skills info sc-mail --agent ai-mail --json` and require `eligible=true` and `modelVisible=true`. The deployment Skill itself does not need to be mounted in the runtime Gateway.
   If the user requests the bundled assistant templates, use the tracked `openclaw-stack/agent-templates/install.mjs` workflow in [the bridge README](../../openclaw-stack/README.md#通用助手模板与轻量记忆). Check `openclaw agents list --json` for the effective workspace first. The installer only creates missing files, including MEMORY.md and memory seeds; it never overwrites or reads existing memory or ignored private agent-files. Each seed has a 5,000 UTF-8 byte guidance limit, not a runtime quota. configure-mcp.mjs enables local keyword memory search and workspace/reminder tools while disabling automatic transcript-to-memory hooks, flush and dreaming diaries; search/calendar setup remains separate. Do not install templates into ai-mail-notify.
3. Check the SC Mail Dashboard system status or authenticated `GET /api/v1/mail/integrations/status`. Confirm event callback and WhatsApp sender are configured. Do not claim delivery from an HTTP health check: an event must be claimed and completed, then the notification queue must report delivery.
4. Report the configured nonsecret URLs, checks actually run, whether WhatsApp pairing is complete, and any remaining live end-to-end test. Do not invent a successful customer message or webhook event.

For a pre-existing OpenClaw installation outside this dedicated Compose bundle, inspect its version and config schema first. Use `openclaw-stack/configure-mcp.mjs` as a reference for the MCP environment reference, hook mapping, Agent IDs, and minimal relay, but do not copy its global tool allowlist or roster ownership into a shared Gateway without checking their effect on other agents. Do not assume this project's paths or overwrite its config. If you cannot safely configure and restart that installation with available tools, provide the exact remaining steps and state the access limitation.
