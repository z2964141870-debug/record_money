import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { needsSetup, persistInitialSetup } from '../src/onboarding.js';
import { storagePaths } from '../src/config-files.js';
const input = { appId: 'cli_test123', appSecret: 'test-app-secret', aiBaseUrl: 'https://model.example/v1', aiKey: 'test-model-key', model: 'cheap-vision', reasoning: 'none' };
const empty = { ...config, appId: '', appSecret: '', aiBaseUrl: '', aiKey: '', model: '' };
test('first-run setup checks connections once, hides secrets, saves isolated storage and schedules restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-onboard-')), db = openDb(':memory:'); let restarted = 0, checked = 0;
  const { app } = await buildServer(db, { runtimeConfig: { ...empty }, configDir: join(dir, 'old/data'), setupRoot: join(dir, 'code'), fixedStorage: false,
    restart: () => { restarted++; }, modelCheck: async () => { checked++; return ['feishu', 'text', 'vision'].map(service => ({ service: service as 'text', ok: true, detail: '通过' })); } });
  try {
    const headers = { host: '127.0.0.1:' + config.port }, b = (await app.inject({ url: '/api/bootstrap', headers })).json();
    assert.equal(b.setupRequired, true); const auth = { ...headers, 'x-ledger-token': b.csrf };
    assert.equal((await app.inject({ method: 'POST', url: '/api/setup', headers, payload: input })).statusCode, 403);
    const raw = { ...input, storage: join(dir, 'new') };
    const saved = await app.inject({ method: 'POST', url: '/api/setup', headers: auth, payload: raw });
    assert.equal(saved.statusCode, 200); assert.equal(checked, 1); assert.ok(!saved.body.includes(input.aiKey));
    assert.equal((await app.inject({ method: 'POST', url: '/api/setup', headers: auth, payload: raw })).statusCode, 409);
    await new Promise(r => setTimeout(r, 550)); assert.equal(restarted, 1);
    assert.equal(dotenv.parse(readFileSync(join(dir, 'new/data/config.env'))).AI_API_KEY, input.aiKey);
    assert.equal(storagePaths(join(dir, 'code'), {}).data, join(dir, 'new/data'));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as { n: number }).n, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('failed connection checks do not save config or restart and setup is locked after configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-onboard-failure-')); let restarted = false;
  for (const runtime of [{ ...empty }, { ...config, ...{ appId: input.appId, appSecret: input.appSecret, aiBaseUrl: input.aiBaseUrl, aiKey: input.aiKey, model: input.model } }]) {
    const { app } = await buildServer(openDb(':memory:'), { runtimeConfig: runtime, configDir: join(dir, 'data'), fixedStorage: true, restart: () => { restarted = true; }, modelCheck: async () => [{ service: 'text', ok: false, detail: '测试失败' }] });
    try {
      const headers = { host: '127.0.0.1:' + config.port }; const csrf = (await app.inject({ url: '/api/bootstrap', headers })).json().csrf;
      const r = await app.inject({ method: 'POST', url: '/api/setup', headers: { ...headers, 'x-ledger-token': csrf }, payload: input });
      assert.equal(r.statusCode, needsSetup(runtime) ? 400 : 409); assert.ok(!r.body.includes(input.aiKey));
      assert.ok(!existsSync(join(dir, 'data/config.env'))); assert.equal(restarted, false);
    } finally { await app.close(); }
  }
  rmSync(dir, { recursive: true, force: true });
});
test('initialization cannot switch fixed storage, overwrite another ledger or abandon existing records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-onboard-storage-')), db = openDb(':memory:');
  try {
    const data = join(dir, 'current/data'), other = join(dir, 'other');
    assert.throws(() => persistInitialSetup(db, empty, dir, data, true, { ...input, storage: other }), /部署配置/);
    mkdirSync(join(other, 'data'), { recursive: true }); writeFileSync(join(other, 'data/ledger.sqlite'), 'private-ledger');
    assert.throws(() => persistInitialSetup(db, empty, dir, data, false, { ...input, storage: other }), /已有账本/);
    assert.equal(readFileSync(join(other, 'data/ledger.sqlite'), 'utf8'), 'private-ledger');
    db.prepare("INSERT INTO messages(id,user_id,text,received_at) VALUES('existing','local','private message','2026-10-06')").run();
    assert.throws(() => persistInitialSetup(db, empty, dir, data, false, { ...input, storage: join(dir, 'fresh') }), /先备份/);
    assert.equal(storagePaths(join(dir, 'versioned-code'), { LEDGER_POINTER_ROOT: join(dir, 'runtime') }).data, join(dir, 'runtime/data'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
