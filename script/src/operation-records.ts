import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { setting, setSetting, type DB } from './db.js';
import { today, money } from './ledger.js';
export function exportOperationRecord(db: DB, date: string, directory = join(dataDir, 'operations')) {
  const range = `${date}T00:00:00+08:00`, end = new Date(new Date(range).getTime() + 86400000).toISOString();
  const start = new Date(range).toISOString();
  const entries = db.prepare('SELECT * FROM audit WHERE created_at>=? AND created_at<? ORDER BY id').all(start, end) as { entry_id: number; action: string; after_json: string | null; before_json: string | null; created_at: string }[];
  const accounts = db.prepare('SELECT * FROM account_audit WHERE created_at>=? AND created_at<? ORDER BY id').all(start, end) as { after_json: string; created_at: string }[];
  const messages = db.prepare("SELECT id,status,result FROM messages WHERE received_at>=? AND received_at<? ORDER BY rowid").all(start, end) as { id: string; status: string; result: string | null }[];
  const encode = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
  const content = `# ${date} 操作记录\n\n北京时间。本文件从本地数据库自动生成；数据库及审计历史为原始记录。\n\n## 账目操作（${entries.length}）\n\n` + entries.map(a => {
    const e = JSON.parse(a.after_json || a.before_json || '{}') as { amount: number; category: string; note: string };
    return `- #${a.entry_id} ${a.action === 'create' ? '新增' : a.action === 'update' ? '修改' : '撤销'} ${money(e.amount)} 元 · ${encode(e.category)}\n`;
  }).join('') + `\n## 账户操作（${accounts.length}）\n\n` + accounts.map(a => {
    const account = JSON.parse(a.after_json) as { name: string; balance: number | null; platform: string };
    return `- ${encode(account.name)} · ${encode(account.platform)} · ${account.balance === null ? '金额待填写' : money(account.balance) + ' 元'}\n`;
  }).join('') + `\n## 对话处理（${messages.length}）\n\n` + messages.map(m => `- ${m.status === 'done' ? '已处理' : m.status === 'pending' ? '排队中' : '需要处理'}：${encode(m.result || '尚无完成回执')}\n`).join('');
  const folder = join(directory, date), path = join(folder, 'README.md');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return path;
  const temporary = path + '.tmp'; writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600);
  return path;
}
export function runOperationRecords(db: DB, now = new Date()) {
  const date = today(now), previous = setting(db, 'operation_record_date');
  if (previous && previous !== date) exportOperationRecord(db, previous);
  exportOperationRecord(db, date); setSetting(db, 'operation_record_date', date);
}
