import { chmodSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { dataDir } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backup } from '../src/backup.js';
if (process.argv[2] === 'restore') {
  const input = process.argv[3]; if (!input) throw new Error('请指定备份文件：npm run restore -- /完整路径/备份.sqlite');
  try { const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 4317) + '/api/bootstrap'); if (r.ok) throw new Error('请先停止后台服务再恢复'); } catch(e) { if ((e as Error).message === '请先停止后台服务再恢复') throw e; }
  const path = resolve(input); if (!existsSync(path)) throw new Error('备份文件不存在');
  const check = new Database(path, { readonly: true, fileMustExist: true }); const integrity = check.pragma('integrity_check', { simple: true }); check.close();
  if (integrity !== 'ok') throw new Error('备份文件完整性检查失败');
  const target = join(dataDir, 'ledger.sqlite');
  if (existsSync(target)) { const db = openDb(); await backup(db, true); db.close(); }
  copyFileSync(path, target); chmodSync(target, 0o600);
  for (const suffix of ['-wal', '-shm']) if (existsSync(target + suffix)) unlinkSync(target + suffix);
  console.log('账本已恢复，恢复前账本已备份。');
} else { const db = openDb(); const path = await backup(db, true); db.close(); console.log('备份完成：' + path); }
