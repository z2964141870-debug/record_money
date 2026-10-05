import { z } from 'zod';
import { setting, setSetting, type DB } from './db.js';
import { today } from './ledger.js';
export const reminderSchema = z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式为HH:MM') });
export function reminderSettings(db: DB) {
  return { enabled: setting(db, 'reminder_enabled', 'true') === 'true', time: setting(db, 'reminder_time', '20:00') };
}
export function saveReminderSettings(db: DB, raw: unknown) {
  const value = reminderSchema.parse(raw);
  db.transaction(() => { setSetting(db, 'reminder_enabled', String(value.enabled)); setSetting(db, 'reminder_time', value.time); })();
  return value;
}
function hasActivity(db: DB, date: string) {
  return !!db.prepare("SELECT 1 FROM entries WHERE date=? AND kind IN ('expense','income','refund') AND cancelled_at IS NULL LIMIT 1").get(date);
}
function minuteOfDay(time: string) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
function withinWindow(db: DB, now: Date) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const minute = minuteOfDay(time), scheduled = minuteOfDay(reminderSettings(db).time);
  return minute >= scheduled && minute < Math.min(1440, scheduled + 60);
}
export function cancelObsoleteReminders(db: DB, now = new Date()) {
  const date = today(now), settings = reminderSettings(db);
  const rows = db.prepare("SELECT id,dedup FROM outbox WHERE status='pending' AND dedup LIKE 'reminder:%'").all() as { id: number; dedup: string }[];
  for (const row of rows) {
    if (!settings.enabled || row.dedup !== 'reminder:' + date || !withinWindow(db, now) || hasActivity(db, date) || setting(db, 'no_activity_date') === date) db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(row.id);
  }
}
export function runReminder(db: DB, now = new Date()) {
  cancelObsoleteReminders(db, now);
  const date = today(now), owner = setting(db, 'owner');
  if (!owner || !reminderSettings(db).enabled || !withinWindow(db, now) || hasActivity(db, date) || setting(db, 'no_activity_date') === date) return;
  // Let an incoming message finish before deciding whether its transaction is missing.
  if (db.prepare("SELECT 1 FROM messages WHERE status='pending' LIMIT 1").get()) return;
  const failed = !!db.prepare("SELECT 1 FROM messages WHERE status='needs_attention' LIMIT 1").get();
  const text = `${date} 记账提醒\n今天的账本还没有收支记录，今天有消费或收入吗？发给我就能记下来；没有的话可以回复“今天没有收支”。${failed ? '\n另外有消息尚未处理成功，请在网页运行状态中核对。' : ''}`;
  db.prepare('INSERT OR IGNORE INTO outbox(user_id,text,dedup,created_at) VALUES(?,?,?,?)').run(owner, text, 'reminder:' + date, now.toISOString());
}
