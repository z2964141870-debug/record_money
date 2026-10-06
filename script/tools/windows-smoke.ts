import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { saveConfigFields, saveSetupConfig } from '../src/config-files.js';

if (process.platform !== 'win32') throw new Error('此验收须在Windows运行');
const root = resolve(import.meta.dirname, '../..'), version = JSON.parse(readFileSync(join(root, 'script/package.json'), 'utf8')).version;
const temp = mkdtempSync(join(tmpdir(), 'record-money-windows-qa-'));
const home = join(temp, '安装目录 with spaces'), storage = join(temp, '账本目录 with spaces');
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
let launcher = '';
let currentPort = 0;
try {
  const archive = join(root, 'data/releases', `record-money-v${version}-windows-x64.zip`);
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:RM_ARCHIVE, $env:RM_EXTRACT)'],
    { env: { ...process.env, RM_ARCHIVE: archive, RM_EXTRACT: join(temp, 'extracted') } });
  const bundle = join(temp, 'extracted', `record-money-v${version}-windows-x64`);
  console.log('Extracted Windows package');
  launcher = join(bundle, 'RecordMoney.exe');
  const run = (args: string[]) => execFileSync(launcher, args, { timeout: 90000, encoding: 'utf8' });
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  currentPort = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  run(['--install-only', '--destination', home]);
  console.log('Installed into an isolated Unicode path');
  assert.ok(existsSync(join(home, 'desktop', version, 'bin/node.exe')));
  for (const doc of ['FEISHU.md', 'DINGTALK.md']) assert.ok(existsSync(join(bundle, 'reports', doc)));
  run(['--headless', '--destination', home, '--port', String(currentPort)]);
  const url = `http://127.0.0.1:${currentPort}`;
  let bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  assert.equal(bootstrap.setupRequired, true); assert.equal(bootstrap.version, version);
  console.log('Started bundled service');
  run(['--stop', '--destination', home]);

  saveSetupConfig(home, storage, { appId: 'cli_windowsqa', appSecret: 'fixture-secret', aiBaseUrl: 'https://fixture.invalid/v1', aiKey: 'fixture-key', model: 'fixture-vision', port: currentPort });
  saveConfigFields(join(storage, 'data'), { FEISHU_ENABLED: 'false' });
  run(['--headless', '--destination', home]);
  bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  assert.equal(bootstrap.setupRequired, false);
  const setup = await (await fetch(url + '/api/setup')).json();
  assert.equal(setup.storage, storage); assert.equal(setup.canChooseFolder, true);
  console.log('Reopened with separate ledger storage');
  const post = async (path: string, body: unknown) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ledger-Token': bootstrap.csrf }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  await post('/api/entries', { kind: 'expense', amount: 1234, date: '2026-10-06', category: '餐饮', merchant: 'Windows验收' });
  for (const kind of ['bill', 'pie', 'funds']) {
    const chart = await post('/api/charts', { kind, start: '2026-10-01', end: '2026-10-31' });
    const response = await fetch(url + chart.url); assert.equal(response.status, 200);
    const png = Buffer.from(await response.arrayBuffer()); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(png.length > 1000);
  }
  console.log('Generated three PNG charts');
  const db = new Database(join(storage, 'data/ledger.sqlite'));
  db.prepare("INSERT INTO messages(id,user_id,text,received_at,status) VALUES(?,?,?,?,?)").run('windows:qa', 'fixture-owner', '记忆验收', new Date().toISOString(), 'done');
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run('windows_fixture', 'preserved');
  const before = db.prepare('SELECT * FROM entries ORDER BY id').all() as Record<string, unknown>[]; db.close();
  run(['--stop', '--destination', home]); run(['--headless', '--destination', home]);
  assert.deepEqual(await (await fetch(url + '/api/entries')).json(), before.map(row => ({ ...row, account_name: null, to_account_name: null, refunded_amount: 0 })));
  const status = JSON.parse(run(['--status', '--destination', home]).trim());
  execFileSync('taskkill.exe', ['/PID', String(status.pid), '/F']);
  for (let i = 0; i < 40; i++) {
    try { await fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(500) }); }
    catch { break; }
    await new Promise(done => setTimeout(done, 100));
  }
  await assert.rejects(fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(1000) }));
  run(['--headless', '--destination', home]);
  console.log('Restart and crash cleanup passed');

  // Simulate a later package to exercise the real launcher backup and upgrade path.
  const next = '99.0.0', upgrade = join(temp, 'upgrade'); cpSync(bundle, upgrade, { recursive: true });
  const manifest = join(upgrade, 'payload/script/package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')); pkg.version = next; writeFileSync(manifest, JSON.stringify(pkg));
  const entrypoint = join(upgrade, 'payload/script/build/server.js');
  writeFileSync(entrypoint, readFileSync(entrypoint, 'utf8').replace(`version: '${version}'`, `version: '${next}'`));
  launcher = join(upgrade, 'RecordMoney.exe');
  run(['--headless', '--destination', home]);
  const upgraded = await (await fetch(url + '/api/bootstrap')).json(); assert.equal(upgraded.version, next);
  const check = new Database(join(storage, 'data/ledger.sqlite'), { readonly: true });
  assert.deepEqual(check.prepare('SELECT * FROM entries ORDER BY id').all(), before);
  assert.equal((check.prepare("SELECT text FROM messages WHERE id='windows:qa'").get() as { text: string }).text, '记忆验收');
  assert.equal((check.prepare("SELECT value FROM settings WHERE key='windows_fixture'").get() as { value: string }).value, 'preserved');
  check.close();
  assert.ok(existsSync(join(storage, 'data/backups')));
  assert.equal(readFileSync(join(home, 'data/runtime-location.txt'), 'utf8').trim(), storage);
  console.log('Windows smoke passed: extracted package, Unicode paths, native dependencies, startup, three PNG charts, restart, supervisor crash cleanup, backup, upgrade and preserved ledger/history.');
} catch (error) {
  const logs = join(storage, 'logs', 'stderr.log');
  if (existsSync(logs)) console.error(readFileSync(logs, 'utf8').slice(-4000));
  throw error;
} finally {
  if (launcher) { try { execFileSync(launcher, ['--stop', '--destination', home], { timeout: 20000 }); } catch {} }
  rmSync(temp, { recursive: true, force: true });
}
