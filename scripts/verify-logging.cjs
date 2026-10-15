/* Real Nest/Express HTTP fixture; no database, mailbox, provider or notification. */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { Controller, Get, Post, Req, Module, RequestMethod } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { LoggerModule } = require('nestjs-pino');
const { createLoggingOptions } = require('../dist/logging.config.js');

const records = [], startup = [];
const output = new Writable({ write(chunk, _encoding, done) {
  for (const line of chunk.toString().trim().split('\n')) if (line) records.push(JSON.parse(line));
  done();
} });
class FixtureController {
  probe(request) {
    request.res.setHeader('set-cookie', 'synthetic-response-secret');
    request.log.info({ fixtureProbe: true, payload: { password: 'synthetic-password', token: 'synthetic-token' } }, 'Synthetic logging probe');
    return { ok: true };
  }
}
Controller()(FixtureController);
Get(['', 'health', 'probe', 'nested/probe'])(FixtureController.prototype, 'probe', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'probe'));
Req()(FixtureController.prototype, 'probe', 0);
// Separate method metadata for POST.
FixtureController.prototype.writeProbe = function(request) { return this.probe(request); };
Post('probe')(FixtureController.prototype, 'writeProbe', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'writeProbe'));
Req()(FixtureController.prototype, 'writeProbe', 0);
const options = createLoggingOptions({ get: (_key, fallback) => fallback });
options.pinoHttp = [options.pinoHttp, output];
class FixtureModule {}
Module({ imports: [LoggerModule.forRoot(options)], controllers: [FixtureController] })(FixtureModule);
const capture = Object.fromEntries(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'].map(level => [level, (...args) => startup.push(args.join(' '))]));

(async () => {
  const app = await NestFactory.create(FixtureModule, { logger: capture, abortOnError: false });
  try {
    app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const paths = ['/health', '/api/v1', '/api/v1/', '/api/v1/probe', '/api/v1/nested/probe', '/api/v1/not-found'];
    for (const path of paths) {
      const response = await fetch(base + path, { headers: { authorization: 'Bearer synthetic-auth-secret', cookie: 'synthetic-cookie-secret' } });
      assert.equal(response.status, path.endsWith('not-found') ? 404 : 200, path);
      await response.text();
    }
    const response = await fetch(base + '/api/v1/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"synthetic-body-secret"}' });
    assert.equal(response.status, 201); await response.text();
    assert.ok(!startup.some(message => /unsupported route path|legacyrouteconverter/i.test(message)), 'No legacy wildcard conversion warning');
    const completed = records.filter(record => record.res);
    for (const path of paths) assert.equal(completed.filter(record => record.req.url === path && record.req.method === 'GET').length, 1, `one request log for ${path}`);
    assert.equal(completed.filter(record => record.req.method === 'POST').length, 1);
    assert.equal(records.filter(record => record.fixtureProbe).length, 6, 'Request logger remains available to handlers');
    const text = JSON.stringify(records);
    for (const secret of ['synthetic-auth-secret', 'synthetic-cookie-secret', 'synthetic-response-secret', 'synthetic-password', 'synthetic-token', 'synthetic-body-secret']) assert.ok(!text.includes(secret), 'Synthetic secret redacted');
    assert.ok(text.includes('[REDACTED]'));
    console.log('PASS NestJS 11 request logging: prefix root, health exclusion, nested GET/POST and 404; no legacy wildcard warning; secret redaction preserved (7 loopback requests).');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
