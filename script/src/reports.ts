import type { DB } from './db.js';
import { setting } from './db.js';
import { queueReply } from './assistant.js';
import { dateSchema, money, summary, today } from './ledger.js';
import { accountOverview } from './accounts.js';
export function shiftDate(date: string, days: number) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function reportText(db: DB, period: string, start: string, end: string, cutoff: string) {
  const s = summary(db, start, end);
  const funds = accountOverview(db);
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status!='done' AND user_id!='local'").get() as { n: number }).n;
  return `${period === 'daily' ? '日' : period === 'weekly' ? '周' : '月'}账单 · ${start} 至 ${end}\n统计截止：${cutoff}（北京时间）\n\n收入 ${money(s.income)} 元\n支出 ${money(s.expense)} 元\n退款 ${money(s.refunds)} 元\n净支出 ${money(s.netExpense)} 元\n结余 ${money(s.balance)} 元\n\n${s.categories.map(c => `${c.name} ${money(c.amount)} 元`).join('\n') || '暂无交易'}\n\n共 ${s.count} 笔 · 待分类 ${s.unclassified} 笔 · 消息待处理 ${pending} 条\n\n生成时资金概况：\n已知资产 ${money(funds.assets)} 元 · 欠款 ${money(funds.debt)} 元\n净资产 ${money(funds.net)} 元 · 锁定资金 ${money(funds.locked)} 元\n${funds.unknown} 个账户金额待填写\n退款按到账日期统计；跨期退款可能使本期分类净支出为负。`;
}
export function runSchedule(db: DB, now = new Date()) {
  const owner = setting(db, 'owner'); if (!owner) return;
  const date = today(now), time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const start = setting(db, 'schedule_start', date);
  const schedules: { period: string; start: string; end: string; cutoff: string }[] = [];
  // Replay missed periods from the binding date, capped to prevent a flood after long outages.
  const first = start < shiftDate(date, -31) ? shiftDate(date, -31) : start;
  for (let d = first; d <= date; d = shiftDate(d, 1)) {
    const completed = d < date || time >= '21:30';
    if (completed) schedules.push({ period: 'daily', start: d, end: d, cutoff: d === date ? d + ' ' + time : d + ' 23:59（恢复后补发）' });
    if (new Date(d + 'T00:00:00Z').getUTCDay() === 0 && completed) schedules.push({ period: 'weekly', start: shiftDate(d, -6), end: d, cutoff: d === date ? d + ' ' + time : d + ' 23:59（恢复后补发）' });
    if (d.endsWith('-01') && (d < date || time >= '09:00')) {
      const end = shiftDate(d, -1); schedules.push({ period: 'monthly', start: end.slice(0, 7) + '-01', end, cutoff: end + ' 23:59' });
    }
  }
  db.transaction(() => {
    for (const report of schedules) {
      const exists = db.prepare('SELECT id FROM reports WHERE period=? AND start=? AND end=?').get(report.period, report.start, report.end); if (exists) continue;
      const text = reportText(db, report.period, report.start, report.end, report.cutoff);
      db.prepare('INSERT INTO reports(period,start,end,cutoff,text,created_at) VALUES(?,?,?,?,?,?)').run(report.period, report.start, report.end, report.cutoff, text, now.toISOString());
      queueReply(db, owner, text, `report:${report.period}:${report.start}:${report.end}`);
    }
  })();
}
