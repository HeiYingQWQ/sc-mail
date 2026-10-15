#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { enableScopedDeliveryToolsFile } from './enable-crm-tools.mjs';

// Explicit operator action: enable only report queries and system sender management.
// This never starts/restarts the Gateway, calls APIs, or sends notifications.
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  await enableScopedDeliveryToolsFile(process.env.OPENCLAW_CONFIG_PATH || '/home/node/.openclaw/openclaw.json', {
    log: record => process.stdout.write(`${JSON.stringify(record)}\n`),
  });
}
