import { z } from 'zod';
import type { DB } from './db.js';
import { dateSchema, today, money } from './ledger.js';
export const possessionInput = z.object({
  name: z.string().trim().min(1).max(100), category: z.string().trim().min(1).max(30).default('其他'),
  price: z.number().int().nonnegative().max(100_000_000_000).nullable(), purchased_on: dateSchema.nullable(),
  retired_on: dateSchema.nullable().default(null), note: z.string().trim().max(1000).default(''),
});
export type Possession = z.infer<typeof possessionInput> & { id: number; archived_at: string | null; created_at: string; updated_at: string };
export function possession(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM possessions WHERE id=?').get(id) as Possession | undefined;
  if (!row) throw new Error('物品不存在'); return row;
}
export function findPossession(db: DB, name: string) {
  const rows = db.prepare('SELECT * FROM possessions WHERE name=? AND archived_at IS NULL').all(name) as Possession[];
  if (rows.length !== 1) throw new Error('请使用清单中的完整物品名称'); return rows[0];
}
export function usage(item: Pick<Possession, 'price' | 'purchased_on' | 'retired_on'>, date = today()) {
  const end = item.retired_on && item.retired_on < date ? item.retired_on : date;
  const days = item.purchased_on ? Math.floor((Date.parse(end + 'T00:00:00Z') - Date.parse(item.purchased_on + 'T00:00:00Z')) / 86400000) : null;
  return { usage_days: days, daily_cost: item.price === null || days === null || days < 0 ? null : item.price / Math.max(1, days) };
}
export function listPossessions(db: DB, date = today(), archived = false) {
  return (db.prepare(`SELECT * FROM possessions ${archived ? '' : 'WHERE archived_at IS NULL'} ORDER BY purchased_on DESC,id DESC`).all() as Possession[]).map(p => ({ ...p, ...usage(p, date) }));
}
export function savePossession(db: DB, raw: unknown, id?: number) {
  return db.transaction(() => {
    const value = possessionInput.parse(raw), before = id ? possession(db, id) : null;
    if (value.purchased_on && value.purchased_on > today()) throw new Error('购买日期不能晚于今天');
    if (value.retired_on && (!value.purchased_on || value.retired_on < value.purchased_on || value.retired_on > today())) throw new Error('停用日期需在购买日期与今天之间');
    const now = new Date().toISOString();
    try {
      if (id) db.prepare('UPDATE possessions SET name=?,category=?,price=?,purchased_on=?,retired_on=?,note=?,updated_at=? WHERE id=?').run(value.name,value.category,value.price,value.purchased_on,value.retired_on,value.note,now,id);
      else id = Number(db.prepare('INSERT INTO possessions(name,category,price,purchased_on,retired_on,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(value.name,value.category,value.price,value.purchased_on,value.retired_on,value.note,now,now).lastInsertRowid);
    } catch (e) { if (e instanceof Error && e.message.includes('UNIQUE')) throw new Error('物品名称已存在，请编辑原物品或使用不同名称'); throw e; }
    const after = possession(db, id!);
    db.prepare('INSERT INTO inventory_audit(entity,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run('possession',id,before ? JSON.stringify(before) : null,JSON.stringify(after),now);
    return { ...after, ...usage(after) };
  })();
}
export function archivePossession(db: DB, id: number, archived: boolean) {
  const before = possession(db,id), now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE possessions SET archived_at=?,updated_at=? WHERE id=?').run(archived ? now : null,now,id);
    db.prepare('INSERT INTO inventory_audit(entity,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run('possession',id,JSON.stringify(before),JSON.stringify(possession(db,id)),now);
  })();
}
export function possessionText(db: DB, name?: string) {
  const rows = name ? [findPossession(db,name)].map(p => ({ ...p,...usage(p) })) : listPossessions(db);
  return rows.map(p => `${p.name} · ${p.category}\n购入价 ${p.price === null ? '待补全' : money(p.price) + '元'} · 购买日 ${p.purchased_on || '待补全'}\n已用 ${p.usage_days === null ? '待补全' : p.usage_days + '天'} · 平均每天 ${p.daily_cost === null ? '待补全' : (p.daily_cost/100).toFixed(2) + '元'}${p.retired_on ? '\n停用日 ' + p.retired_on : ''}`).join('\n\n') || '物品清单暂无记录。';
}
