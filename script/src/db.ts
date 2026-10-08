import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
export function openDb(path = join(dataDir, 'ledger.sqlite')) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('expense','income','refund','transfer')),
      amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL, category TEXT NOT NULL,
      subcategory TEXT NOT NULL DEFAULT '', merchant TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES entries(id), source TEXT NOT NULL DEFAULT 'web', message_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
    CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent_id);
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, platform TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('cash','investment','locked','liability')),
      opening_balance INTEGER, available_date TEXT, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_audit (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL,
      before_json TEXT, after_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, entry_id INTEGER, action TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT,
      received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS confirmations (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, action_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE IF NOT EXISTS dialogue_pending (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, message_id TEXT NOT NULL,
      question TEXT NOT NULL, actions_json TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, dedup TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, period TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, cutoff TEXT NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(period,start,end));
    CREATE TABLE IF NOT EXISTS possessions (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, category TEXT NOT NULL DEFAULT '其他',
      price INTEGER, purchased_on TEXT, retired_on TEXT, note TEXT NOT NULL DEFAULT '', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loans (account_id INTEGER PRIMARY KEY REFERENCES accounts(id), category TEXT NOT NULL DEFAULT 'other',
      creditor TEXT NOT NULL DEFAULT '', repayment_start TEXT, monthly_payment INTEGER, due_day INTEGER, maturity_date TEXT,
      annual_rate TEXT, subsidy_until TEXT, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS loan_installments (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
      due_date TEXT NOT NULL, principal INTEGER NOT NULL, interest INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', UNIQUE(account_id,due_date));
    CREATE TABLE IF NOT EXISTS loan_events (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
      kind TEXT NOT NULL, amount INTEGER NOT NULL, interest INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      installment_id INTEGER REFERENCES loan_installments(id), entry_id INTEGER REFERENCES entries(id), interest_entry_id INTEGER REFERENCES entries(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_audit (id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL,
      before_json TEXT, after_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS message_images (message_id TEXT PRIMARY KEY REFERENCES messages(id), image_key TEXT, path TEXT, extracted_text TEXT);
    CREATE TABLE IF NOT EXISTS image_imports (message_id TEXT PRIMARY KEY REFERENCES message_images(message_id), imported_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_drafts (message_id TEXT PRIMARY KEY REFERENCES message_images(message_id), analysis_json TEXT NOT NULL,
      review_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chart_files (id TEXT PRIMARY KEY, message_id TEXT, kind TEXT NOT NULL, path TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fund_positions (id INTEGER PRIMARY KEY, account_id INTEGER UNIQUE NOT NULL REFERENCES accounts(id),
      code TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', opening_shares INTEGER NOT NULL,
      opening_cost INTEGER NOT NULL, opening_date TEXT NOT NULL, benchmark TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(code,platform));
    CREATE TABLE IF NOT EXISTS fund_trades (id INTEGER PRIMARY KEY, position_id INTEGER NOT NULL REFERENCES fund_positions(id),
      kind TEXT NOT NULL CHECK(kind IN ('buy','sell','dividend')), shares INTEGER NOT NULL, amount INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL, cash_account_id INTEGER REFERENCES accounts(id), entry_id INTEGER REFERENCES entries(id),
      message_id TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, cancelled_at TEXT);
    CREATE TABLE IF NOT EXISTS fund_quotes (code TEXT NOT NULL, date TEXT NOT NULL, nav INTEGER NOT NULL, source TEXT NOT NULL,
      fetched_at TEXT NOT NULL, PRIMARY KEY(code,date));
    CREATE TABLE IF NOT EXISTS fund_references (symbol TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
      previous_close INTEGER NOT NULL, quoted_at TEXT NOT NULL, fetched_at TEXT NOT NULL, source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fund_audit (id INTEGER PRIMARY KEY, position_id INTEGER NOT NULL,
      action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const entryColumns = new Set((db.pragma('table_info(entries)') as { name: string }[]).map(c => c.name));
  for (const column of ['account_id', 'to_account_id']) {
    if (!entryColumns.has(column)) db.exec(`ALTER TABLE entries ADD COLUMN ${column} INTEGER REFERENCES accounts(id)`);
  }
  const outboxColumns = new Set((db.pragma('table_info(outbox)') as { name: string }[]).map(c => c.name));
  for (const column of ['image_path', 'image_key']) if (!outboxColumns.has(column)) db.exec(`ALTER TABLE outbox ADD COLUMN ${column} TEXT`);
  if(!(db.pragma('table_info(dialogue_pending)') as {name:string}[]).some(c=>c.name==='source_image_id'))db.exec('ALTER TABLE dialogue_pending ADD COLUMN source_image_id TEXT');
  if(!(db.pragma('table_info(message_images)') as {name:string}[]).some(c=>c.name==='content_hash'))db.exec('ALTER TABLE message_images ADD COLUMN content_hash TEXT');
  const confirmationSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='confirmations'").get() as { sql: string };
  if (confirmationSchema.sql.includes('message_id TEXT UNIQUE')) {
    db.transaction(() => db.exec(`
      ALTER TABLE confirmations RENAME TO confirmations_legacy;
      CREATE TABLE confirmations (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, action_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      INSERT INTO confirmations SELECT * FROM confirmations_legacy;
      DROP TABLE confirmations_legacy;
    `))();
  }
  if (path !== ':memory:') chmodSync(path, 0o600);
  return db;
}
export type DB = ReturnType<typeof openDb>;
export function setting(db: DB, key: string, fallback = ''): string {
  return (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? fallback;
}
export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
