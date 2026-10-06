import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { readSetupConfig, saveSetupConfig, setupSchema, storagePaths, storageRoot } from '../src/config-files.js';
import { checkConnections } from '../src/connection-check.js';

if (!process.stdin.isTTY) throw new Error('请在交互式终端运行 npm run setup，密钥输入不回显');
const root = fileURLToPath(new URL('../../', import.meta.url));
let hidden = false;
const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: true });
async function ask(label: string, fallback = '', secret = false) {
  const prompt = label + (fallback ? secret ? ' [回车保留已配置值]' : ` [${fallback}]` : '') + '：';
  if (secret) process.stdout.write(prompt);
  hidden = secret;
  try { return (await rl.question(secret ? '' : prompt)).trim() || fallback; }
  finally { hidden = false; if (secret) process.stdout.write('\n'); }
}
try {
  console.log('私人记账助手 v0.3 配置向导。现有账本不会移动；更换存储目录会打开另一套账本。');
  const fixedData = process.env.LEDGER_DATA_DIR ? resolve(process.env.LEDGER_DATA_DIR) : null;
  if (fixedData && basename(fixedData) !== 'data') throw new Error('向导要求LEDGER_DATA_DIR以/data结尾；当前目录可手动编辑config.env');
  const existingStorage = existsSync(join(root, 'data', 'runtime-location.txt')) || existsSync(join(root, 'data', 'config.env'));
  const defaultStorage = existingStorage ? dirname(storagePaths(root).data) : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'RecordMoney') : join(homedir(), '.local', 'share', 'record-money');
  const storage = fixedData ? dirname(fixedData) : storageRoot(await ask('数据与日志存放位置（绝对路径）', defaultStorage));
  if (fixedData) console.log('环境变量指定存储位置：' + storage);
  const old = readSetupConfig(storage + '/data');
  const ledgerPath = join(storage, 'data', 'ledger.sqlite');
  if (existsSync(ledgerPath)) {
    const db = new Database(ledgerPath, { readonly: true });
    try {
      for (const [key, field] of [['model', 'AI_MODEL'], ['reasoning', 'AI_REASONING']]) {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
        if (row) old[field] = row.value;
      }
    } finally { db.close(); }
  }
  const raw = {
    appId: await ask('飞书App ID', old.FEISHU_APP_ID), appSecret: await ask('飞书App Secret', old.FEISHU_APP_SECRET, true),
    aiBaseUrl: await ask('AI Base URL', old.AI_BASE_URL || 'https://api.openai.com/v1'), aiKey: await ask('AI API Key', old.AI_API_KEY, true),
    model: await ask('多模态模型名称', old.AI_MODEL), reasoning: await ask('推理强度（none/low/medium/high）', old.AI_REASONING || 'none'),
    port: Number(await ask('本机网页端口', old.PORT || '4317')),
  };
  const value = setupSchema.parse(raw);
  console.log('配置格式有效。连接测试会向飞书验证凭证，并调用模型进行一次文字和一次示例图片测试，不读取你的账本。');
  if ((await ask('现在进行连接测试？（y/n）', 'y')).toLowerCase() === 'y') {
    const results = await checkConnections(value); for (const r of results) console.log(`${r.ok ? '通过' : '失败'} · ${r.service}：${r.detail}`);
    if (results.some(r => !r.ok) && (await ask('存在测试失败，仍保存配置？（y/n）', 'n')).toLowerCase() !== 'y') throw new Error('配置未保存，请核对后重新运行');
  }
  console.log('配置已保存：' + saveSetupConfig(root, storage, value, { writePointer: !fixedData }));
  if (existsSync(ledgerPath)) {
    const db = new Database(ledgerPath);
    try { db.transaction(() => {
      const save = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      save.run('model', value.model); save.run('reasoning', value.reasoning);
    })(); } finally { db.close(); }
  }
  console.log(`下一步：npm run build && npm start。打开 http://127.0.0.1:${value.port}，按reports/FEISHU.md配置机器人并绑定用户。已有后台服务须重新安装或重启。`);
} catch (error) {
  console.error(error instanceof Error && !('issues' in error) ? error.message : '配置格式不正确，请检查ID、地址、模型、推理强度与端口');
  process.exitCode = 1;
} finally { rl.close(); }
