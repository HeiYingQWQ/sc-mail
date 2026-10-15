const assert = require('node:assert/strict');
const { AgentIntegrationService } = require('../dist/modules/mail/agent-integration.service.js');
const { AgentEventsService } = require('../dist/modules/mail/agent-events.service.js');
const savedFetch = global.fetch;
let calls = 0, outcome, passed = 0;
const recipient = '+15555550123';
const settings = { OPENCLAW_WHATSAPP_NOTIFY_URL: 'https://relay.test.invalid/notify', AGENT_WEBHOOK_TOKEN: 'synthetic-token', NOTIFICATION_ALLOWED_CHANNELS: 'whatsapp', NOTIFICATION_ALLOWED_RECIPIENTS: recipient };
const config = { get: (key, fallback) => settings[key] ?? fallback };
function fixture(overrides = {}) {
  const item = { id: 'delivery', leaseToken: 'lease', attempts: 1, createdAt: new Date(), recipientRef: recipient, content: 'Synthetic', channel: 'whatsapp', eventId: null, ...overrides };
  const updates = [];
  const tx = { $queryRaw: async () => [{ id: item.id }], notificationDelivery: { update: async ({ data }) => { item.leaseToken = data.leaseToken; return item; }, updateMany: async value => { updates.push(value); return { count: 1 }; } } };
  const db = { ...tx, $transaction: async fn => fn(tx) };
  return { item, service: new AgentIntegrationService(db, config, {}, { warn() {} }, {}), updates };
}
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
(async () => {
  global.fetch = async (url, options) => { calls++; assert.equal(url, settings.OPENCLAW_WHATSAPP_NOTIFY_URL); assert.equal(JSON.parse(options.body).channel, 'whatsapp'); return outcome(); };
  await test('unsupported channel rejected before database writes even with legacy allowlist', async () => {
    settings.NOTIFICATION_ALLOWED_CHANNELS = 'telegram,whatsapp';
    const events = new AgentEventsService({}, config);
    await assert.rejects(events.complete('event', { agentId: 'agent', leaseToken: 'lease', result: {}, notifications: [{ requestKey: 'key', channel: 'telegram', recipientRef: recipient, content: 'Synthetic' }] }), e => e.getResponse().code === 'NOTIFICATION_CHANNEL_UNSUPPORTED');
    const { service, updates } = fixture(); const before = calls;
    await service.deliverNotificationForChannel('telegram'); assert.equal(calls, before); assert.equal(updates.length, 0);
    settings.NOTIFICATION_ALLOWED_CHANNELS = 'whatsapp';
  });
  for (const [name, response, expected] of [
    ['confirmed relay delivery', () => Response.json({ runId: 'fixture', completion: { status: 'ok', delivered: true } }), 'delivered'],
    ['unconfirmed relay outcome', () => Response.json({ runId: 'fixture' }), 'unknown'],
    ['lost network response', () => { throw new Error('synthetic network loss'); }, 'unknown'],
    ['temporary 503', () => new Response('{}', { status: 503 }), 'pending'],
    ['rejected 401', () => new Response('{}', { status: 401 }), 'failed'],
  ]) await test(name, async () => {
    outcome = response; const { service, updates, item } = fixture(); await service.deliverNotificationForChannel('whatsapp');
    assert.equal(updates.at(-1).data.status, expected); assert.equal(updates.at(-1).where.leaseToken, item.leaseToken);
    assert.equal(updates[0].data.status, 'unknown', 'expired sending lease cannot auto-resend');
  });
  await test('removed recipient fails without transport', async () => {
    const { service, updates } = fixture({ recipientRef: '+15555550999' }); const before = calls;
    await service.deliverNotificationForChannel('whatsapp'); assert.equal(calls, before); assert.equal(updates.at(-1).data.lastError, 'NOTIFICATION_TARGET_NOT_ALLOWED');
  });
  await test('disabled sender never consumes queue', async () => {
    settings.NOTIFICATION_ALLOWED_CHANNELS = ''; const { service, updates } = fixture(); const before = calls;
    await service.deliverNotificationForChannel('whatsapp'); assert.equal(calls, before); assert.equal(updates.length, 0);
  });
  console.log(`WhatsApp isolation: ${passed} passed; real network calls: 0`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = savedFetch; });
