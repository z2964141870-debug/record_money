import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { config, dataDir } from '../src/config.js';
import { checkConnections } from '../src/connection-check.js';
try {
  const effective = { ...config }, path = join(dataDir, 'ledger.sqlite');
  if (existsSync(path)) {
    const db = new Database(path, { readonly: true });
    try {
      for (const key of ['model', 'reasoning'] as const) {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
        if (row) effective[key] = row.value;
      }
    } finally { db.close(); }
  }
  const results = await checkConnections(effective);
  for (const result of results) console.log(`${result.ok ? '通过' : '失败'} · ${result.service}：${result.detail}`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
} catch { console.error('配置不完整或格式无效，请先运行npm run setup。'); process.exitCode = 1; }
