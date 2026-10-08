import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type DB } from './db.js';
import { dateSchema, money, today } from './ledger.js';
import { fundCode } from './fund-market.js';
import { saveFund, getFund, fundOverview, fundText } from './funds.js';
const cents = z.number().int().min(0).max(100_000_000_000);
const input = z.object({ name: z.string().trim().min(1).max(100), platform: z.string().trim().min(1).max(60),
  code: z.union([fundCode, z.literal('')]).default(''), value: cents, holding_profit: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  pending_amount: cents.default(0), as_of: dateSchema.refine(d => d <= today(), '截图日期不能是未来').nullable().default(null),
  source: z.string().trim().min(1).max(200).default('手动持仓快照'), note: z.string().trim().max(1000).default('') });
export type FundSnapshot = z.infer<typeof input> & { id: number; position_id: number | null; created_at: string; updated_at: string };
export function fundSnapshots(db: DB) { return db.prepare('SELECT * FROM fund_snapshots ORDER BY id').all() as FundSnapshot[]; }
export function snapshotOverview(db: DB) {
  const snapshots = fundSnapshots(db), active = snapshots.filter(s => !s.position_id);
  return { snapshots, value: active.reduce((n, s) => n + s.value, 0), profit: active.reduce((n, s) => n + s.holding_profit, 0),
    pending: active.reduce((n, s) => n + s.pending_amount, 0) };
}
export function saveSnapshot(db: DB, raw: unknown, id?: number) {
  return db.transaction(() => {
    const v = input.parse(raw), before = id ? fundSnapshots(db).find(s => s.id === id) : undefined;
    if (id && !before) throw new Error('持仓快照不存在');
    if (before?.position_id) throw new Error('已补全为基金持仓，请编辑正式持仓');
    if (v.value - v.holding_profit < 0) throw new Error('金额与持有收益不一致，请核对截图');
    if (!id && fundSnapshots(db).length >= 100) throw new Error('最多支持100条持仓快照');
    const now = new Date().toISOString();
    if (id) db.prepare('UPDATE fund_snapshots SET name=@name,platform=@platform,code=@code,value=@value,holding_profit=@holding_profit,pending_amount=@pending_amount,as_of=@as_of,source=@source,note=@note,updated_at=@now WHERE id=@id').run({ ...v, now, id });
    else id = Number(db.prepare('INSERT INTO fund_snapshots(name,platform,code,value,holding_profit,pending_amount,as_of,source,note,created_at,updated_at) VALUES(@name,@platform,@code,@value,@holding_profit,@pending_amount,@as_of,@source,@note,@now,@now)').run({ ...v, now }).lastInsertRowid);
    const after = fundSnapshots(db).find(s => s.id === id)!;
    db.prepare('INSERT INTO inventory_audit(entity,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run('fund_snapshot', id, before ? JSON.stringify(before) : null, JSON.stringify(after), now);
    return after;
  })();
}
export function importSnapshots(db: DB, raw: unknown) {
  const rows = z.array(input).min(1).max(100).parse(raw), digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM fund_snapshot_batches WHERE digest=?').get(digest)) return snapshotOverview(db);
    for (const row of rows) {
      const existing = fundSnapshots(db).find(s => s.name === row.name && s.platform === row.platform);
      saveSnapshot(db, row, existing?.id);
    }
    db.prepare('INSERT INTO fund_snapshot_batches VALUES(?,?)').run(digest, new Date().toISOString());
    return snapshotOverview(db);
  })();
}
export function completeSnapshot(db: DB, id: number, raw: unknown) {
  return db.transaction(() => {
    const snapshot = fundSnapshots(db).find(s => s.id === id);
    if (!snapshot) throw new Error('持仓快照不存在');
    if (snapshot.position_id) return getFund(db, snapshot.position_id);
    const v = z.object({ code: fundCode, shares: z.string(), cost: cents, date: dateSchema,
      account_id: z.number().int().positive().optional(), benchmark: z.string().optional() }).parse(raw);
    const p = saveFund(db, { ...v, name: snapshot.name, platform: snapshot.platform,
      note: snapshot.note + '\n由截图快照补全；成本和份额由用户确认。' });
    db.prepare('UPDATE fund_snapshots SET position_id=?,updated_at=? WHERE id=?').run(p.id, new Date().toISOString(), id);
    return p;
  })();
}
export function snapshotText(db: DB, code?: string, platform?: string) {
  const rows = fundSnapshots(db).filter(s => !s.position_id && (!code || s.code === code) && (platform === undefined || s.platform === platform));
  const pool = { value: rows.reduce((n,s) => n+s.value,0), profit: rows.reduce((n,s) => n+s.holding_profit,0) };
  if (!rows.length) return '';
  return `截图持仓（未确认份额）合计 ${money(pool.value)}元 · 持有收益 ${money(pool.profit)}元\n` + rows.map(s =>
    `${s.name}${s.code ? ' ' + s.code : ''} · ${s.platform}\n截图金额 ${money(s.value)}元 · 持有收益 ${money(s.holding_profit)}元 · ${s.as_of || '截图日期待确认'}${s.pending_amount ? '\n申购中 ' + money(s.pending_amount) + '元（单列，未加进持仓）' : ''}`).join('\n\n') + '\n截图金额不会随行情自动变化，也未重复计入资金账户。';
}
export function holdingText(db: DB, code?: string, platform?: string) {
  const confirmed = fundOverview(db).funds.some(p => (!code || p.code === code) && (platform === undefined || p.platform === platform));
  return [confirmed ? fundText(db, code, undefined, platform) : '', snapshotText(db, code, platform)].filter(Boolean).join('\n\n') || '没有匹配的持仓，请在基金页面登记。';
}
