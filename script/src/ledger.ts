import { z } from 'zod';
import type { DB } from './db.js';
export const kindSchema = z.enum(['expense', 'income', 'refund', 'transfer']);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, '日期无效');
export const inputSchema = z.object({
  kind: kindSchema, amount: z.number().int().positive().max(100_000_000_000), date: dateSchema,
  category: z.string().trim().min(1).max(30), subcategory: z.string().trim().max(30).default(''),
  merchant: z.string().trim().max(100).default(''), note: z.string().trim().max(1000).default(''),
  parent_id: z.number().int().positive().nullable().default(null),
  account_id: z.number().int().positive().nullable().default(null),
  to_account_id: z.number().int().positive().nullable().default(null),
});
export type EntryInput = z.infer<typeof inputSchema>;
export type Entry = EntryInput & { id: number; source: string; message_id: string | null; created_at: string; updated_at: string; cancelled_at: string | null; account_name?: string | null; to_account_name?: string | null };
export function today(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
export function money(cents: number) { return (cents / 100).toFixed(2); }
export function cents(value: string | number) {
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('金额需为正数，最多两位小数');
  const [whole, part = ''] = s.split('.');
  const n = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100_000_000_000) throw new Error('金额超出范围');
  return n;
}
export function getEntry(db: DB, id: number) {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id) as Entry | undefined;
  if (!e || e.cancelled_at) throw new Error('记录不存在或已撤销');
  return e;
}
export function refunded(db: DB, id: number, excluding?: number) {
  return (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM entries WHERE parent_id=? AND kind='refund' AND cancelled_at IS NULL AND id != ?").get(id, excluding || 0) as { n: number }).n;
}
function validate(db: DB, value: EntryInput, id?: number) {
  for (const account of [value.account_id, value.to_account_id]) {
    if (account && !db.prepare('SELECT id FROM accounts WHERE id=?').get(account)) throw new Error('资金账户不存在');
  }
  if (value.to_account_id && value.kind !== 'transfer') throw new Error('只有转账需要目标账户');
  if (value.kind === 'transfer' && (value.account_id || value.to_account_id)) {
    if (!value.account_id || !value.to_account_id || value.account_id === value.to_account_id) throw new Error('转账必须选择两个不同账户');
  }
  if (value.kind === 'refund') {
    if (!value.parent_id) throw new Error('退款必须关联原支出');
    const parent = getEntry(db, value.parent_id);
    value.account_id ||= parent.account_id;
    if (parent.kind !== 'expense') throw new Error('只能关联支出记录');
    if (value.date < parent.date) throw new Error('退款日期不能早于原支出');
    if (refunded(db, parent.id, id) + value.amount > parent.amount) throw new Error('累计退款超过原支出');
    value.category = parent.category; value.subcategory = parent.subcategory; value.merchant ||= parent.merchant;
  } else {
    if (value.parent_id !== null) throw new Error('只有退款可以关联原记录');
    if (id && refunded(db, id) > 0) {
      if (value.kind !== 'expense' || value.amount < refunded(db, id)) throw new Error('原支出不能少于已退款金额');
      const earlier = db.prepare('SELECT MIN(date) AS date FROM entries WHERE parent_id=? AND cancelled_at IS NULL').get(id) as { date: string };
      if (value.date > earlier.date) throw new Error('支出日期不能晚于关联退款');
    }
  }
}
function audit(db: DB, id: number, action: string, before: unknown, after: unknown) {
  db.prepare('INSERT INTO audit(entry_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, new Date().toISOString());
}
export function createEntry(db: DB, raw: unknown, source = 'web', messageId: string | null = null): Entry {
  return db.transaction(() => {
    const value = inputSchema.parse(raw); validate(db, value);
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO entries(kind,amount,date,category,subcategory,merchant,note,parent_id,account_id,to_account_id,source,message_id,created_at,updated_at) VALUES(@kind,@amount,@date,@category,@subcategory,@merchant,@note,@parent_id,@account_id,@to_account_id,@source,@message_id,@created_at,@updated_at)`).run({ ...value, source, message_id: messageId, created_at: now, updated_at: now });
    const e = getEntry(db, Number(result.lastInsertRowid)); audit(db, e.id, 'create', null, e); return e;
  })();
}
export function updateEntry(db: DB, id: number, raw: unknown) {
  return db.transaction(() => {
    const before = getEntry(db, id), value = inputSchema.parse(raw); validate(db, value, id);
    db.prepare('UPDATE entries SET kind=@kind,amount=@amount,date=@date,category=@category,subcategory=@subcategory,merchant=@merchant,note=@note,parent_id=@parent_id,account_id=@account_id,to_account_id=@to_account_id,updated_at=@updated_at WHERE id=@id').run({ ...value, id, updated_at: new Date().toISOString() });
    const after = getEntry(db, id); audit(db, id, 'update', before, after); return after;
  })();
}
export function cancelEntry(db: DB, id: number) {
  return db.transaction(() => {
    const before = getEntry(db, id);
    if (refunded(db, id) > 0) throw new Error('请先撤销关联退款，再撤销原支出');
    db.prepare('UPDATE entries SET cancelled_at=?,updated_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), id);
    audit(db, id, 'cancel', before, null);
  })();
}
export function listEntries(db: DB, filters: { start?: string; end?: string; kind?: string; category?: string; q?: string; includeCancelled?: boolean } = {}) {
  const where = filters.includeCancelled ? ['1=1'] : ['e.cancelled_at IS NULL']; const params: unknown[] = [];
  if (filters.start) { where.push('e.date>=?'); params.push(dateSchema.parse(filters.start)); }
  if (filters.end) { where.push('e.date<=?'); params.push(dateSchema.parse(filters.end)); }
  if (filters.kind) { where.push('e.kind=?'); params.push(kindSchema.parse(filters.kind)); }
  if (filters.category) { where.push("COALESCE(p.category,e.category)=?"); params.push(filters.category); }
  if (filters.q) { where.push("(e.note LIKE ? OR e.merchant LIKE ? OR CAST(e.id AS TEXT)=?)"); params.push('%' + filters.q + '%', '%' + filters.q + '%', filters.q); }
  return db.prepare(`SELECT e.*, a.name AS account_name, t.name AS to_account_name, COALESCE(p.category,e.category) AS category, COALESCE(p.subcategory,e.subcategory) AS subcategory,
    (SELECT COALESCE(SUM(r.amount),0) FROM entries r WHERE r.parent_id=e.id AND r.cancelled_at IS NULL) AS refunded_amount
    FROM entries e LEFT JOIN entries p ON e.parent_id=p.id LEFT JOIN accounts a ON e.account_id=a.id LEFT JOIN accounts t ON e.to_account_id=t.id WHERE ${where.join(' AND ')} ORDER BY e.date DESC,e.id DESC`).all(...params) as (Entry & { refunded_amount: number })[];
}
export function summary(db: DB, start: string, end: string) {
  const entries = listEntries(db, { start, end });
  let income = 0, expense = 0, refunds = 0; const categories: Record<string, number> = {}, days: Record<string, { income: number; expense: number }> = {};
  for (const e of entries) {
    days[e.date] ||= { income: 0, expense: 0 };
    if (e.kind === 'income') { income += e.amount; days[e.date].income += e.amount; }
    if (e.kind === 'expense' || e.kind === 'refund') {
      const sign = e.kind === 'refund' ? -1 : 1;
      if (e.kind === 'refund') refunds += e.amount; else expense += e.amount;
      categories[e.category] = (categories[e.category] || 0) + sign * e.amount; days[e.date].expense += sign * e.amount;
    }
  }
  return { income, expense, refunds, netExpense: expense - refunds, balance: income - expense + refunds, count: entries.length,
    unclassified: entries.filter(e => e.category === '待分类').length,
    categories: Object.entries(categories).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    days: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values })) };
}
export function csv(entries: Entry[]) {
  const cell = (x: unknown) => { let s = String(x ?? ''); if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  const labels = { expense: '支出', income: '收入', refund: '退款', transfer: '转账' };
  return '\uFEFF' + [['编号', '日期', '类型', '金额', '分类', '子分类', '商家', '备注', '关联编号', '资金账户', '转入账户', '状态'], ...entries.map(e => [e.id, e.date, labels[e.kind], money(e.amount), e.category, e.subcategory, e.merchant, e.note, e.parent_id || '', e.account_name || '', e.to_account_name || '', e.cancelled_at ? '已撤销' : '已入账'])].map(row => row.map(cell).join(',')).join('\r\n');
}
