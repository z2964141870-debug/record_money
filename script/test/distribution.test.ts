import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { setupSchema, saveSetupConfig, storagePaths } from '../src/config-files.js';
import { checkConnections } from '../src/connection-check.js';
import { buildRelease, packageFiles } from '../tools/release-lib.js';
const fixture = { appId: 'cli_test123', appSecret: 'test-app-secret', aiBaseUrl: 'https://model.example/v1', aiKey: 'test-key', model: 'cheap-vision', reasoning: 'none' as const, port: 4317 };

test('setup stores private config without copying or replacing a ledger; explicit environment wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-setup-')), root = join(dir, 'code'), storage = join(dir, 'private');
  try {
    mkdirSync(join(storage, 'data'), { recursive: true }); writeFileSync(join(storage, 'data', 'ledger.sqlite'), 'existing-ledger');
    writeFileSync(join(storage, 'data', 'config.env'), "CHART_FONT_PATH='/font path/test.ttf'\n");
    const value = { ...fixture, aiKey: 'key#with$quotes"and`backticks' };
    const path = saveSetupConfig(root, storage, value);
    const parsed = dotenv.parse(readFileSync(path)); assert.equal(parsed.AI_API_KEY, value.aiKey); assert.equal(parsed.CHART_FONT_PATH, '/font path/test.ttf');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(storage, 'data', 'ledger.sqlite'), 'utf8'), 'existing-ledger');
    assert.equal(storagePaths(root, {}).data, join(storage, 'data')); assert.equal(storagePaths(root, {}).logs, join(storage, 'logs'));
    assert.deepEqual(storagePaths(root, { LEDGER_DATA_DIR: join(dir, 'other', 'data') }), { data: join(dir, 'other', 'data'), logs: join(dir, 'other', 'logs') });
    assert.equal(storagePaths(root, { LEDGER_LOGS_DIR: join(dir, 'custom-logs') }).logs, join(dir, 'custom-logs'));
    assert.throws(() => saveSetupConfig(root, storage, { ...fixture, appSecret: 'secret\nPORT=80' }));
    assert.equal(dotenv.parse(readFileSync(path)).AI_API_KEY, value.aiKey);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('container setup can save in mounted storage without writing code directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-container-'));
  try {
    saveSetupConfig(join(dir, 'absent-code'), join(dir, 'storage'), fixture, { writePointer: false });
    assert.ok(existsSync(join(dir, 'storage', 'data', 'config.env'))); assert.ok(!existsSync(join(dir, 'absent-code')));
    assert.throws(() => setupSchema.parse({ ...fixture, aiBaseUrl: 'https://example.com/v1?key=secret' }));
    assert.throws(() => setupSchema.parse({ ...fixture, port: 80 }));
    assert.throws(() => saveSetupConfig(dir,join(dir,'storage'),{...fixture,model:''}));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function modelResponse(text: string) {
  return new Response(JSON.stringify({ id: 'test', object: 'response', status: 'completed', output: [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] }), { headers: { 'Content-Type': 'application/json' } });
}
test('connection checks validate text and image JSON, disable reasoning and never expose tokens', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, body: JSON.parse(String(init?.body)) });
    return url.includes('feishu.cn') ? new Response(JSON.stringify({ code: 0, tenant_access_token: 'private-token' }), { headers: { 'Content-Type': 'application/json' } }) : modelResponse('{"amount":"20.00","kind":"expense"}');
  };
  const results = await checkConnections(fixture, { fetch: fake }); assert.equal(results.length, 4); assert.ok(results.every(r => r.ok));
  assert.ok(requests[1].url.endsWith('/v1/responses')); assert.deepEqual(requests[1].body.reasoning, {effort:'none'});
  const input = requests[2].body.input as { content: { type: string; image_url?: string }[] }[];
  assert.ok(input[0].content.find(c => c.type === 'input_image')?.image_url?.startsWith('data:image/png;base64,'));
  assert.ok(!JSON.stringify(results).includes('private-token'));
  const high = await checkConnections({ ...fixture, reasoning: 'high' }, { fetch: fake, vision: false }); assert.ok(high.every(r => r.ok));
  assert.deepEqual(requests.at(-1)?.body.reasoning, { effort: 'high' });
});
test('connection failures and wrong image amounts are reported without leaking provider body or key', async () => {
  const fake: typeof fetch = async (input) => String(input).includes('feishu.cn')
    ? new Response(JSON.stringify({ code: 1, msg: fixture.appSecret }), { status: 400 }) : modelResponse('{"amount":"200.00","kind":"expense"}');
  const results = await checkConnections(fixture, { fetch: fake }); assert.ok(results.filter(r=>r.service!=='structured').every(r => !r.ok));
  assert.equal(results.find(r=>r.service==='structured')?.state,'verified');
  assert.ok(!JSON.stringify(results).includes(fixture.appSecret)); assert.ok(!JSON.stringify(results).includes('200.00'));
  const errors = await checkConnections(fixture, { fetch: async () => { throw new Error(fixture.aiKey); } });
  assert.ok(errors.every(r => !r.ok)); assert.ok(!JSON.stringify(errors).includes(fixture.aiKey));
});
test('release ZIP excludes all runtime data and contains a verifiable manifest', { skip: process.platform === 'win32' ? 'Source ZIP is built and verified on Linux; Windows uses its native package smoke test' : false }, () => {
  const root = resolve(import.meta.dirname, '../..'), dir = mkdtempSync(join(tmpdir(), 'money-package-'));
  try {
    const code = join(dir, 'code'); for (const path of packageFiles(root)) { mkdirSync(join(code, path, '..'), { recursive: true }); cpSync(join(root, path), join(code, path)); }
    mkdirSync(join(code, 'data')); writeFileSync(join(code, 'data', 'config.env'), 'private-config'); writeFileSync(join(code, 'data', 'ledger.sqlite'), 'private-ledger');
    const result = buildRelease(code, join(dir, 'release')); const entries = execFileSync('unzip', ['-Z1', result.archive], { encoding: 'utf8' });
    assert.ok(entries.includes('FILES.sha256')); assert.ok(entries.includes('LICENSE')); assert.ok(entries.includes('reports/DISTRIBUTION.md'));
    assert.ok(!/config\.env|ledger\.sqlite|runtime-location|node_modules|VALIDATION\.md/.test(entries));
    const extracted = join(dir, 'extracted'); execFileSync('unzip', ['-q', result.archive, '-d', extracted]);
    const packageRoot = join(extracted, 'record-money-v' + result.version);
    for (const line of readFileSync(join(packageRoot, 'FILES.sha256'), 'utf8').trim().split('\n')) {
      const [digest, path] = line.split('  '); assert.equal(createHash('sha256').update(readFileSync(join(packageRoot, path))).digest('hex'), digest);
    }
    assert.throws(() => buildRelease(code, join(dir, 'release')), /已存在/);
    writeFileSync(join(code, 'script', 'src', 'private.env'), 'PRIVATE=1'); assert.throws(() => packageFiles(code), /私密/);
    rmSync(join(code, 'script', 'src', 'private.env')); symlinkSync(join(code, 'data', 'config.env'), join(code, 'script', 'src', 'leak.ts')); assert.throws(() => packageFiles(code), /符号链接/);
    rmSync(join(code, 'script', 'src', 'leak.ts')); writeFileSync(join(code, 'script', 'src', 'leak.ts'), ['sk', 'A'.repeat(32)].join('-')); assert.throws(() => packageFiles(code), /疑似密钥/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
