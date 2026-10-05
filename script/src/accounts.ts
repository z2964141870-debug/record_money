import { z } from 'zod';
import { type DB, setting, setSetting } from './db.js';
import { dateSchema } from './ledger.js';
export const accountKind = z.enum(['cash', 'investment', 'locked', 'liability']);
const accountInput = z.object({
  name: z.string().trim().min(1).max(100), platform: z.string().trim().max(60).default(''),
  kind: accountKind, balance: z.number().int().min(-100_000_000_000).max(100_000_000_000).nullable(),
  available_date: dateSchema.nullable().default(null), note: z.string().trim().max(1000).default(''),
});
export type Account = { id: number; name: string; platform: string; kind: z.infer<typeof accountKind>; opening_balance: number | null; balance: number | null; available_date: string | null; note: string; created_at: string; updated_at: string };
export function getAccount(db: DB, id: number): Account {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Account | undefined;
  if (!account) throw new Error('资金账户不存在');
  const change = (db.prepare(`SELECT COALESCE(SUM(CASE
    WHEN account_id=? THEN CASE WHEN kind IN ('expense','transfer') THEN -amount ELSE amount END
    WHEN to_account_id=? AND kind='transfer' THEN amount ELSE 0 END),0) AS n
    FROM entries WHERE cancelled_at IS NULL AND (account_id=? OR to_account_id=?)`).get(id, id, id, id) as { n: number }).n;
  return { ...account, balance: account.opening_balance === null ? null : account.opening_balance + (account.kind === 'liability' ? -change : change) };
}
export function listAccounts(db: DB) {
  return (db.prepare('SELECT id FROM accounts ORDER BY kind,name').all() as { id: number }[]).map(a => getAccount(db, a.id));
}
export function saveAccount(db: DB, raw: unknown, id?: number) {
  return db.transaction(() => {
    const value = accountInput.parse(raw), before = id ? getAccount(db, id) : null;
    if (before && before.kind !== value.kind) {
      const used = db.prepare('SELECT 1 FROM entries WHERE account_id=? OR to_account_id=? LIMIT 1').get(id, id);
      if (used) throw new Error('已有交易的账户不能更改类型，请新建账户');
    }
    if (value.kind !== 'locked' && value.available_date) throw new Error('只有锁定资金需要解锁日期');
    const delta = before && before.balance !== null && before.opening_balance !== null ? before.balance - before.opening_balance : 0;
    let opening = value.balance === null ? null : value.balance - delta;
    if (before && before.opening_balance === null && value.balance !== null) {
      db.prepare('UPDATE accounts SET opening_balance=0 WHERE id=?').run(id);
      opening = value.balance - getAccount(db, id!).balance!;
    }
    const now = new Date().toISOString();
    try {
      if (id) db.prepare('UPDATE accounts SET name=?,platform=?,kind=?,opening_balance=?,available_date=?,note=?,updated_at=? WHERE id=?').run(value.name, value.platform, value.kind, opening, value.available_date, value.note, now, id);
      else id = Number(db.prepare('INSERT INTO accounts(name,platform,kind,opening_balance,available_date,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(value.name, value.platform, value.kind, opening, value.available_date, value.note, now, now).lastInsertRowid);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new Error('账户名称已存在，请使用不同名称');
      throw error;
    }
    const after = getAccount(db, id!);
    db.prepare('INSERT INTO account_audit(account_id,before_json,after_json,created_at) VALUES(?,?,?,?)').run(id, before ? JSON.stringify(before) : null, JSON.stringify(after), now);
    return after;
  })();
}
export function accountOverview(db: DB, platform?: string) {
  const accounts = listAccounts(db).filter(a => !platform || a.platform === platform);
  const sum = (kinds: string[]) => accounts.filter(a => kinds.includes(a.kind)).reduce((n, a) => n + (a.balance ?? 0), 0);
  const assets = sum(['cash', 'investment', 'locked']), debt = sum(['liability']);
  return { accounts, assets, debt, net: assets - debt, cash: sum(['cash']), investment: sum(['investment']), locked: sum(['locked']), unknown: accounts.filter(a => a.balance === null).length };
}
export function findAccount(db: DB, name: string) {
  const accounts = listAccounts(db), exact = accounts.filter(a => a.name === name);
  const matches = exact.length ? exact : accounts.filter(a => a.name.includes(name));
  if (matches.length !== 1) throw new Error(matches.length ? `“${name}”对应多个账户，请使用完整账户名称` : `未找到“${name}”账户，请先创建`);
  return matches[0];
}
export function initializeAccounts(db: DB) {
  if(!setting(db,'accounts_v02_initialized'))db.transaction(()=>{
    if(!db.prepare('SELECT id FROM accounts WHERE name=?').get('花呗'))saveAccount(db,{name:'花呗',platform:'支付宝',kind:'liability',balance:null});
    setSetting(db,'accounts_v02_initialized','true');
  })();
  if (setting(db, 'accounts_initialized')) return;
  db.transaction(() => {
    for (const [name, platform, kind] of [
      ['微信零钱', '微信', 'cash'], ['支付宝余额', '支付宝', 'cash'],
      ['抖音月付', '抖音', 'liability'], ['美团月付', '美团', 'liability'],
      ['京东小金库', '京东金融', 'investment'], ['LGB基金', '京东金融', 'investment'],
      ['7天锁定理财', '待确认', 'locked'], ['1个月锁定理财', '待确认', 'locked'],
    ]) {
      if (!db.prepare('SELECT id FROM accounts WHERE name=?').get(name)) saveAccount(db, { name, platform, kind, balance: null });
    }
    setSetting(db, 'accounts_initialized', 'true');
  })();
}
