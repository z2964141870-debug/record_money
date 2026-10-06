import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { openDb, setting, setSetting } from '../src/db.js';
import { config } from '../src/config.js';
import { saveModelService } from '../src/model-service.js';
import { buildServer } from '../src/server.js';
import { receiveMessage, applyActions } from '../src/assistant.js';
import { parseText } from '../src/ai.js';
import { checkConnections } from '../src/connection-check.js';

const original = { aiBaseUrl: 'https://old.example/v1', aiKey: 'old-test-key', model: 'old-model', reasoning: 'none', port: 4317 };
test('model service persists replacements, keeps blank key and preserves unrelated configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-model-')), db = openDb(':memory:'), runtime = { ...original };
  try {
    writeFileSync(join(dir, 'config.env'), "FEISHU_APP_SECRET='private-feishu'\nPORT='4317'\nCHART_FONT_PATH='/font/test.ttf'\n");
    saveModelService(db, runtime, dir, { baseUrl: 'https://new.example/v1/', apiKey: 'new#test$secret', model: 'cheap-vision', reasoning: 'none' });
    assert.equal(runtime.aiBaseUrl, 'https://new.example/v1'); assert.equal(runtime.aiKey, 'new#test$secret');
    assert.equal(setting(db, 'model'), 'cheap-vision');
    const parsed = dotenv.parse(readFileSync(join(dir, 'config.env'))); assert.equal(parsed.AI_API_KEY, runtime.aiKey);
    assert.equal(parsed.FEISHU_APP_SECRET, 'private-feishu'); assert.equal(parsed.CHART_FONT_PATH, '/font/test.ttf');
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'config.env')).mode & 0o777, 0o600);
    saveModelService(db, runtime, dir, { baseUrl: runtime.aiBaseUrl, apiKey: '  ', model: 'another-model', reasoning: 'low' });
    assert.equal(runtime.aiKey, 'new#test$secret'); assert.equal(dotenv.parse(readFileSync(join(dir, 'config.env'))).AI_MODEL, 'another-model');
    saveModelService(db, runtime, dir, { model: 'legacy-model', reasoning: 'none' }); assert.equal(runtime.model, 'legacy-model');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('invalid input and failed config writes leave runtime and stored model unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-model-failure-')), db = openDb(':memory:'), runtime = { ...original };
  try {
    setSetting(db, 'model', original.model); setSetting(db, 'reasoning', original.reasoning);
    for (const patch of [{ baseUrl: 'https://user:secret@example.com/v1' }, { apiKey: 'secret\nPORT=80' }, { baseUrl: 'file:///tmp/model' }, { baseUrl: 'https://other.example/v1', apiKey: '' }]) {
      assert.throws(() => saveModelService(db, runtime, dir, { model: 'new-model', reasoning: 'none', ...patch }));
    }
    const blocked = join(dir, 'blocked'); writeFileSync(blocked, 'file');
    assert.throws(() => saveModelService(db, runtime, blocked, { model: 'new-model', reasoning: 'high' }), /保存失败/);
    assert.equal(setting(db, 'model'), original.model); assert.equal(setting(db, 'reasoning'), original.reasoning); assert.deepEqual(runtime, original);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('switching a service changes the next API request without losing both sides of conversation or ledger data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-model-context-')), db = openDb(':memory:'), oldConfig = { ...config }, oldFetch = globalThis.fetch;
  try {
    Object.assign(config, original);
    receiveMessage(db, 'earlier', 'local', '奶茶20'); applyActions(db, 'earlier', [{ type: 'reply', text: '图片账户尚待核对' }]);
    const before = JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY rowid').all());
    saveModelService(db, config, dir, { baseUrl: 'https://new.example/v1', apiKey: 'new-test-secret', model: 'new-vision', reasoning: 'none' });
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY rowid').all()), before);
    receiveMessage(db, 'next', 'local', '继续核对');
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), body = await request.json() as { model: string; input: { role: string; content: string }[] };
      assert.equal(request.url, 'https://new.example/v1/responses'); assert.equal(request.headers.get('authorization'), 'Bearer new-test-secret');
      assert.equal(body.model, 'new-vision'); assert.ok(body.input.some(v => v.role === 'user' && v.content === '奶茶20'));
      assert.ok(body.input.some(v => v.role === 'assistant' && v.content === '图片账户尚待核对'));
      return new Response(JSON.stringify({ id: 'test', object: 'response', status: 'completed', output: [{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"actions":[{"type":"reply","text":"收到"}]}', annotations: [] }] }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    assert.equal((await parseText(db, '继续核对', undefined, { user: 'local', messageId: 'next' }))[0].type, 'reply');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as { n: number }).n, 0);
  } finally { globalThis.fetch = oldFetch; Object.assign(config, oldConfig); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('web settings require CSRF, never return key and test unsaved credentials without storing them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-model-api-')), db = openDb(':memory:'), runtime = { ...config, ...original };
  let checked: unknown, complete!: () => void;
  const gate = new Promise<void>(r => { complete = r; });
  const { app } = await buildServer(db, { configDir: dir, runtimeConfig: runtime, modelCheck: async (raw, options) => {
    checked = raw; assert.equal(options?.feishu, false); await gate;
    return [{ service: 'text', ok: true, detail: '通过' }, { service: 'vision', ok: true, detail: '通过' }];
  } });
  try {
    const headers = { host: '127.0.0.1:' + config.port }, boot = await app.inject({ url: '/api/bootstrap', headers });
    const auth = { ...headers, 'x-ledger-token': boot.json().csrf }, payload = { baseUrl: 'https://new.example/v1', apiKey: 'private-new-key', model: 'cheap-vision', reasoning: 'none' };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/check', headers, payload })).statusCode, 403);
    const pending = app.inject({ method: 'POST', url: '/api/settings/check', headers: auth, payload });
    await new Promise<void>(r => setImmediate(r));
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/check', headers: auth, payload })).statusCode, 409);
    complete(); const tested = await pending; assert.equal(tested.statusCode, 200); assert.ok(!tested.body.includes(payload.apiKey));
    assert.equal((checked as { aiKey: string }).aiKey, payload.apiKey); assert.equal(runtime.aiKey, original.aiKey); assert.equal(setting(db, 'model'), '');
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload }); assert.equal(saved.statusCode, 200); assert.ok(!saved.body.includes(payload.apiKey));
    const status = await app.inject({ url: '/api/status', headers }); assert.equal(status.json().baseUrl, payload.baseUrl); assert.ok(!status.body.includes(payload.apiKey));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as { n: number }).n, 0);
  } finally { complete(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('model-only connection check needs no Feishu credentials and sends no Feishu request', async () => {
  const requested: string[] = [];
  const results = await checkConnections(original, { feishu: false, fetch: async input => {
    requested.push(String(input)); return new Response(JSON.stringify({ error: { message: 'private-provider-body' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(results.length, 3); assert.ok(results.every(r => !r.ok)); assert.ok(requested.every(u => u.startsWith(original.aiBaseUrl)));
  assert.ok(!JSON.stringify(results).includes('private-provider-body'));
});
