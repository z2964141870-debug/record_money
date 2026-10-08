import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type DB } from './db.js';
import { dateSchema, money, today } from './ledger.js';
import { fundCode } from './fund-market.js';
import { saveFund, getFund, fundOverview, fundText } from './funds.js';
const cents = z.number().int().min(0).max(100_000_000_000);
const units = z.number().int().min(0).max(1_000_000_000_000);
export const snapshotDetails = z.object({ confirmed_value: cents.nullable().default(null), shares: units.nullable().default(null),
  available_shares: units.nullable().default(null), unit_cost: units.nullable().default(null), nav: units.refine(n => n > 0).nullable().default(null),
  nav_date: dateSchema.refine(d => d <= today(), '净值日期不能是未来').nullable().default(null),
  receivable_amount: cents.nullable().default(null), pending_included: z.boolean().nullable().default(null) });
const input = z.object({ name: z.string().trim().min(1).max(100), platform: z.string().trim().min(1).max(60),
  code: z.union([fundCode, z.literal('')]).default(''), value: cents, holding_profit: z.number().int().min(-100_000_000_000).max(100_000_000_000),
  pending_amount: cents.default(0), as_of: dateSchema.refine(d => d <= today(), '截图日期不能是未来').nullable().default(null),
  source: z.string().trim().min(1).max(200).default('手动持仓快照'), note: z.string().trim().max(1000).default(''), details: snapshotDetails.optional() });
export type FundSnapshot = Omit<z.infer<typeof input>, 'details'> & { details: z.infer<typeof snapshotDetails>; id: number; position_id: number | null; created_at: string; updated_at: string };
export function fundSnapshots(db: DB): FundSnapshot[] {
  return (db.prepare('SELECT * FROM fund_snapshots ORDER BY id').all() as (Omit<FundSnapshot, 'details'> & {details_json:string})[]).map(({details_json,...s}) => ({...s,details:snapshotDetails.parse(JSON.parse(details_json))}));
}
export function confirmedSnapshotValue(s: FundSnapshot) {
  return s.details.confirmed_value ?? (s.details.pending_included === true ? s.value - s.pending_amount : s.value);
}
export function snapshotOverview(db: DB) {
  const snapshots = fundSnapshots(db), active = snapshots.filter(s => !s.position_id);
  return { snapshots, value: active.reduce((n, s) => n + s.value, 0), profit: active.reduce((n, s) => n + s.holding_profit, 0),
    pending: active.reduce((n, s) => n + s.pending_amount, 0), confirmed_value: active.reduce((n,s) => n + confirmedSnapshotValue(s), 0),
    known_shares: active.filter(s => s.details.shares !== null).length };
}
export function saveSnapshot(db: DB, raw: unknown, id?: number) {
  return db.transaction(() => {
    const v = input.parse(raw), before = id ? fundSnapshots(db).find(s => s.id === id) : undefined;
    if (id && !before) throw new Error('持仓快照不存在');
    if (before?.position_id) throw new Error('已补全为基金持仓，请编辑正式持仓');
    const details = v.details ?? before?.details ?? snapshotDetails.parse({});
    if (details.available_shares !== null && details.shares !== null && details.available_shares > details.shares) throw new Error('可用份额不能超过持有份额');
    if (details.pending_included === true && v.pending_amount > v.value) throw new Error('待确认金额不能超过截图总金额');
    if (details.confirmed_value !== null && details.confirmed_value > v.value) throw new Error('持有金额不能超过截图总金额');
    if (details.confirmed_value !== null && details.pending_included !== null && details.confirmed_value + (details.pending_included ? v.pending_amount : 0) !== v.value) throw new Error('持有金额、待确认金额与截图总金额不一致');
    if (details.nav_date && (!v.as_of || details.nav_date > v.as_of)) throw new Error('净值日期不能晚于截图日期');
    if (v.value - v.holding_profit < 0) throw new Error('金额与持有收益不一致，请核对截图');
    if (!id && fundSnapshots(db).length >= 100) throw new Error('最多支持100条持仓快照');
    const now = new Date().toISOString();
    const {details: _details, ...fields} = v, params = {...fields,details_json:JSON.stringify(details),now};
    if (id) db.prepare('UPDATE fund_snapshots SET name=@name,platform=@platform,code=@code,value=@value,holding_profit=@holding_profit,pending_amount=@pending_amount,as_of=@as_of,source=@source,note=@note,details_json=@details_json,updated_at=@now WHERE id=@id').run({ ...params, id });
    else id = Number(db.prepare('INSERT INTO fund_snapshots(name,platform,code,value,holding_profit,pending_amount,as_of,source,note,details_json,created_at,updated_at) VALUES(@name,@platform,@code,@value,@holding_profit,@pending_amount,@as_of,@source,@note,@details_json,@now,@now)').run(params).lastInsertRowid);
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
  return `截图持仓总金额 ${money(pool.value)}元 · 持有收益 ${money(pool.profit)}元\n` + rows.map(s =>
    `${s.name}${s.code ? ' ' + s.code : ''} · ${s.platform}\n截图总金额 ${money(s.value)}元 · 持有收益 ${money(s.holding_profit)}元 · ${s.as_of || '截图日期待确认'}${s.details.confirmed_value === null ? '' : '\n持有金额 ' + money(s.details.confirmed_value) + '元'}${snapshotDetailText(s)}${s.pending_amount ? '\n申购中 ' + money(s.pending_amount) + '元（' + (s.details.pending_included === true ? '已含在截图总金额中' : s.details.pending_included === false ? '未含在截图总金额中' : '是否计入总金额待确认') + '）' : ''}`).join('\n\n') + '\n截图金额保留原值，未重复计入资金账户。';
}
export function snapshotDetailText(s: FundSnapshot) {
  const d=s.details;
  return `\n持有份额 ${d.shares === null ? '待补全' : (d.shares / 10000).toFixed(4)} · 可用份额 ${d.available_shares === null ? '待补全' : (d.available_shares / 10000).toFixed(4)}` +
    (d.unit_cost === null ? '' : '\n平台单位成本 ' + (d.unit_cost / 1e6).toFixed(4) + '（显示值，非精确总成本）') +
    (d.nav === null ? '' : '\n截图净值 ' + (d.nav / 1e6).toFixed(4) + ' · ' + (d.nav_date || '日期待补全')) +
    (d.receivable_amount === null ? '' : '\n待到账金额 ' + money(d.receivable_amount) + '元');
}
export function holdingText(db: DB, code?: string, platform?: string) {
  const confirmed = fundOverview(db).funds.some(p => (!code || p.code === code) && (platform === undefined || p.platform === platform));
  return [confirmed ? fundText(db, code, undefined, platform) : '', snapshotText(db, code, platform)].filter(Boolean).join('\n\n') || '没有匹配的持仓，请在基金页面登记。';
}
