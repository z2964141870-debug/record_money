import { z } from 'zod';
import { type DB, setting, setSetting } from './db.js';
import { createEntry, dateSchema, money, today } from './ledger.js';
import { getAccount, saveAccount } from './accounts.js';
import { fundCode, benchmarkCode, fetchNav, fetchReference, freshReference, type ReferenceQuote } from './fund-market.js';
import { fundTrades, latestNav, replayFund, roundedRatio, scaled, shareValue, type FundPosition, type FundTrade } from './fund-math.js';
const amount = z.number().int().min(0).max(100_000_000_000);
const nonFuture = dateSchema.refine(d => d <= today(), '不能记录未来的已确认持仓或交易');
const input = z.object({ code: fundCode, name: z.string().trim().min(1).max(100), platform: z.string().trim().max(60).default(''),
  shares: z.string(), cost: amount, date: nonFuture, account_id: z.number().int().positive().optional(),
  benchmark: z.union([benchmarkCode, z.literal('')]).default(''), note: z.string().trim().max(1000).default('') });
const tradeInput = z.object({ kind: z.enum(['buy', 'sell', 'dividend']), shares: z.string().default('0'), amount: amount.refine(n => n > 0, '金额必须大于0'),
  fee: amount.default(0), date: nonFuture, cash_account_id: z.number().int().positive().nullable().default(null), note: z.string().trim().max(1000).default('') });
function positions(db: DB) { return db.prepare('SELECT * FROM fund_positions ORDER BY id').all() as FundPosition[]; }
export function getFund(db: DB, id: number) {
  const p = db.prepare('SELECT * FROM fund_positions WHERE id=?').get(id) as FundPosition | undefined;
  if (!p) throw new Error('基金持仓不存在'); return p;
}
export function findFund(db: DB, code: string, platform?: string) {
  const rows = positions(db).filter(p => p.code === code && (platform === undefined || p.platform === platform));
  if (rows.length !== 1) throw new Error(rows.length ? '同一基金在多个平台持有，请指定平台' : '请先在基金页面添加该基金持仓');
  return rows[0];
}
function audit(db: DB, id: number, action: string, detail: unknown) {
  db.prepare('INSERT INTO fund_audit(position_id,action,detail_json,created_at) VALUES(?,?,?,?)').run(id, action, JSON.stringify(detail), new Date().toISOString());
}
export function saveFund(db: DB, raw: unknown, id?: number) {
  return db.transaction(() => {
    const v = input.parse(raw), shares = scaled(v.shares, 4, true), old = id ? getFund(db, id) : null;
    if (!shares && v.cost) throw new Error('零份额的持仓成本应为0');
    if (id && fundTrades(db, id).some(t => !t.cancelled_at) && (old!.code !== v.code || old!.opening_shares !== shares || old!.opening_cost !== v.cost || old!.opening_date !== v.date)) throw new Error('已有交易，请撤销交易后校准期初份额、成本、代码或日期');
    if (!old && positions(db).length >= 100) throw new Error('当前版本最多支持100个基金持仓');
    if (/美元|港币|USD|HKD/i.test(v.name)) throw new Error('当前仅支持人民币净值型基金');
    if (positions(db).some(p => p.id !== id && p.code === v.code && p.platform === v.platform)) throw new Error('该平台已有这个基金，请修改原持仓');
    if (old && v.account_id && old.account_id !== v.account_id) throw new Error('已有基金不能更换关联账户');
    let account = old?.account_id || v.account_id;
    if (account) {
      const a = getAccount(db, account);
      if (a.kind !== 'investment') throw new Error('基金只能关联投资账户');
      if (!old && db.prepare('SELECT 1 FROM fund_positions WHERE account_id=?').get(account)) throw new Error('该账户已关联其他基金');
      if (a.platform !== v.platform) throw new Error('基金平台须与关联资金账户的平台一致');
    } else account = saveAccount(db, { name: `${v.name} (${v.code})${v.platform ? ' · ' + v.platform : ''}`, platform: v.platform, kind: 'investment', balance: null }).id;
    const now = new Date().toISOString();
    if (id) db.prepare('UPDATE fund_positions SET code=?,name=?,platform=?,opening_shares=?,opening_cost=?,opening_date=?,benchmark=?,note=?,updated_at=? WHERE id=?').run(v.code, v.name, v.platform, shares, v.cost, v.date, v.benchmark, v.note, now, id);
    else id = Number(db.prepare('INSERT INTO fund_positions(account_id,code,name,platform,opening_shares,opening_cost,opening_date,benchmark,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(account, v.code, v.name, v.platform, shares, v.cost, v.date, v.benchmark, v.note, now, now).lastInsertRowid);
    audit(db, id!, old ? 'update' : 'create', { before: old, after: getFund(db, id!) });
    return fundView(db, getFund(db, id!));
  })();
}
export function recordFundTrade(db: DB, id: number, raw: unknown, messageId: string | null = null) {
  return db.transaction(() => {
    const p = getFund(db, id), v = tradeInput.parse(raw), shares = scaled(v.shares, 4, v.kind === 'dividend');
    if (v.date < p.opening_date) throw new Error('交易不能早于期初持仓日期');
    if (v.kind === 'dividend' && (shares || v.fee)) throw new Error('现金分红不填份额和手续费；红利再投资请另记确认申购');
    if (v.kind === 'buy' && v.fee >= v.amount) throw new Error('申购金额含手续费，手续费应小于总扣款');
    if (v.cash_account_id && getAccount(db, v.cash_account_id).kind !== 'cash') throw new Error('扣款/到账账户必须为现金账户');
    const now = new Date().toISOString();
    const result = db.prepare('INSERT INTO fund_trades(position_id,kind,shares,amount,fee,date,cash_account_id,message_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, v.kind, shares, v.amount, v.fee, v.date, v.cash_account_id, messageId, v.note, now);
    replayFund(p, fundTrades(db, id));
    if (v.cash_account_id) {
      const e = createEntry(db, { kind: v.kind === 'dividend' ? 'income' : 'transfer', amount: v.amount, date: v.date,
        category: v.kind === 'dividend' ? '投资分红' : '投资转账', merchant: p.name, note: v.note,
        account_id: v.kind === 'buy' ? v.cash_account_id : v.kind === 'sell' ? p.account_id : v.cash_account_id,
        to_account_id: v.kind === 'buy' ? p.account_id : v.kind === 'sell' ? v.cash_account_id : null }, 'fund-trade', messageId);
      db.prepare('UPDATE fund_trades SET entry_id=? WHERE id=?').run(e.id, result.lastInsertRowid);
    }
    audit(db, id, 'trade', { id: Number(result.lastInsertRowid), ...v, shares });
    return fundView(db, p);
  })();
}
export function cancelFundTrade(db: DB, id: number, tradeId: number) {
  return db.transaction(() => {
    const p = getFund(db, id), trade = db.prepare('SELECT * FROM fund_trades WHERE id=? AND position_id=? AND cancelled_at IS NULL').get(tradeId, id) as FundTrade | undefined;
    if (!trade) throw new Error('基金交易不存在或已撤销');
    const now = new Date().toISOString();
    db.prepare('UPDATE fund_trades SET cancelled_at=? WHERE id=?').run(now, tradeId);
    replayFund(p, fundTrades(db, id));
    if (trade.entry_id) {
      const before = db.prepare('SELECT * FROM entries WHERE id=?').get(trade.entry_id);
      db.prepare('UPDATE entries SET cancelled_at=?,updated_at=? WHERE id=?').run(now, now, trade.entry_id);
      db.prepare('INSERT INTO audit(entry_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(trade.entry_id, 'cancel', JSON.stringify(before), null, now);
    }
    audit(db, id, 'cancel', { trade: tradeId }); return fundView(db, p);
  })();
}
export function fundView(db: DB, p: FundPosition, now = new Date()) {
  const trades = fundTrades(db, p.id), state = replayFund(p, trades), quote = latestNav(db, p.code);
  const previous = quote ? db.prepare('SELECT * FROM fund_quotes WHERE code=? AND date<? ORDER BY date DESC LIMIT 1').get(p.code, quote.date) as typeof quote : undefined;
  const value = state.shares === 0 ? 0 : quote ? shareValue(state.shares, quote.nav) : null;
  const profit = value === null ? null : value - state.cost;
  const reference = p.benchmark ? db.prepare('SELECT * FROM fund_references WHERE symbol=?').get(p.benchmark) as ReferenceQuote | undefined : undefined;
  // Buy-day shares do not receive that day's NAV movement. Redemption-day shares still do.
  const priorShares = quote && p.opening_date < quote.date ? replayFund(p, trades, quote.date).shares
    - trades.filter(t => !t.cancelled_at && t.date === quote.date && t.kind === 'buy').reduce((n, t) => n + t.shares, 0)
    + trades.filter(t => !t.cancelled_at && t.date === quote.date && t.kind === 'sell').reduce((n, t) => n + t.shares, 0) : null;
  const dailyProfit = quote && previous && priorShares !== null ? shareValue(priorShares, quote.nav - previous.nav)
    + trades.filter(t => !t.cancelled_at && t.date === quote.date && t.kind === 'dividend').reduce((n, t) => n + t.amount, 0) : null;
  const refFresh = reference ? freshReference(reference, now) : false;
  const referenceChange = reference ? (reference.price - reference.previous_close) / reference.previous_close * 100 : null;
  const activeReferenceShares = reference ? replayFund(p, trades, today(new Date(reference.quoted_at))).shares : null;
  const hasSameDayTrade = reference && (p.opening_date >= today(new Date(reference.quoted_at)) || trades.some(t => !t.cancelled_at && t.date === today(new Date(reference.quoted_at))));
  const referenceProfit = quote && reference && activeReferenceShares !== null && refFresh && !hasSameDayTrade && quote.date < today(new Date(reference.quoted_at))
    ? roundedRatio(BigInt(shareValue(activeReferenceShares, quote.nav)) * BigInt(reference.price - reference.previous_close), BigInt(reference.previous_close)) : null;
  return { ...p, ...state, value, profit, totalProfit: profit === null ? null : profit + state.realized + state.dividends,
    profitRate: profit === null || !state.cost ? null : profit / state.cost * 100,
    unitCost: state.shares ? roundedRatio(BigInt(state.cost) * 100_000_000n, BigInt(state.shares)) : null,
    quote: quote || null, dailyProfit, navChange: quote && previous ? (quote.nav - previous.nav) / previous.nav * 100 : null,
    reference: reference || null, referenceFresh: refFresh, referenceChange, referenceProfit,
    error: setting(db, 'fund_error:' + p.code), referenceError: p.benchmark ? setting(db, 'fund_reference_error:' + p.benchmark) : '',
    trades, history: db.prepare('SELECT date,nav FROM fund_quotes WHERE code=? ORDER BY date DESC LIMIT 60').all(p.code) as { date: string; nav: number }[] };
}
export function fundOverview(db: DB, now = new Date()) {
  const funds = positions(db).map(p => fundView(db, p, now));
  return { funds, value: funds.reduce((n, p) => n + (p.value || 0), 0), cost: funds.reduce((n, p) => n + p.cost, 0),
    profit: funds.reduce((n, p) => n + (p.profit || 0), 0), unknown: funds.filter(p => p.value === null).length,
    reminder: { enabled: setting(db, 'fund_reminder_enabled', 'true') === 'true', time: '14:50' }, lastRefresh: setting(db, 'fund_last_refresh') };
}
export function fundText(db: DB, code?: string, now = new Date(), platform?: string) {
  const funds = code ? [fundView(db, findFund(db, code, platform), now)] : fundOverview(db, now).funds;
  if (!funds.length) return '还没有基金持仓，请在网页基金栏目填写基金代码、已确认份额和剩余持仓成本。';
  return funds.map(p => `${p.name} ${p.code}${p.platform ? ' · ' + p.platform : ''}\n份额 ${(p.shares / 10000).toFixed(4)} · 剩余成本 ${money(p.cost)}元\n${p.quote ? `净值 ${(p.quote.nav / 1000000).toFixed(4)}（${p.quote.date}） · 持有收益 ${money(p.profit!)}元 · 累计收益 ${money(p.totalProfit!)}元` : '净值暂不可用，收益未知'}${p.dailyProfit === null ? '' : `\n${p.quote!.date}净值变动收益 ${money(p.dailyProfit)}元`}${p.reference ? `\nETF参考 ${p.reference.name} ${p.referenceChange!.toFixed(2)}%（${new Date(p.reference.quoted_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）${p.referenceFresh ? '' : '，非当前实时行情'}${p.referenceProfit === null ? '' : ` · 参考变动 ${money(p.referenceProfit)}元`}` : ''}${p.error ? '\n净值更新失败，保留上次数据' : ''}`).join('\n\n') + '\nETF涨跌仅作参考，不是基金盘中估值。未实现收益不记入收支。';
}
const refreshing = new WeakMap<DB, Promise<void>>();
export async function refreshFunds(db: DB, options: { fetcher?: typeof fetch; now?: Date; signal?: AbortSignal } = {}) {
  const existing = refreshing.get(db); if (existing) return existing;
  const task = (async () => {
    const list = positions(db), now = options.now || new Date();
    for (const code of new Set(list.map(p => p.code))) {
      if (options.signal?.aborted) return;
      try { const quotes = await fetchNav(code, options.fetcher, now, options.signal); if (options.signal?.aborted) return;
        db.transaction(() => { for (const q of quotes) db.prepare('INSERT INTO fund_quotes(code,date,nav,source,fetched_at) VALUES(@code,@date,@nav,@source,@fetched_at) ON CONFLICT(code,date) DO UPDATE SET nav=excluded.nav,source=excluded.source,fetched_at=excluded.fetched_at').run(q);
          for (const p of positions(db).filter(p => p.code === code)) fundView(db, p, now);
          setSetting(db, 'fund_error:' + code, ''); })();
      } catch { if (options.signal?.aborted) return; setSetting(db, 'fund_error:' + code, '净值更新失败，请稍后重试或手动录入正式净值'); }
    }
    for (const symbol of new Set(list.map(p => p.benchmark).filter(Boolean))) {
      if (options.signal?.aborted) return;
      try { const q = await fetchReference(symbol, options.fetcher, now, options.signal); if (options.signal?.aborted) return;
        db.prepare('INSERT INTO fund_references(symbol,name,price,previous_close,quoted_at,fetched_at,source) VALUES(@symbol,@name,@price,@previous_close,@quoted_at,@fetched_at,@source) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,price=excluded.price,previous_close=excluded.previous_close,quoted_at=excluded.quoted_at,fetched_at=excluded.fetched_at,source=excluded.source WHERE excluded.quoted_at>=fund_references.quoted_at').run(q);
        setSetting(db, 'fund_reference_error:' + symbol, '');
      } catch { if (options.signal?.aborted) return; setSetting(db, 'fund_reference_error:' + symbol, 'ETF参考更新失败'); }
    }
    if (list.length) setSetting(db, 'fund_last_refresh', now.toISOString());
  })();
  refreshing.set(db, task); try { await task; } finally { refreshing.delete(db); }
}
export function saveManualNav(db: DB, code: string, raw: unknown) {
  fundCode.parse(code); const v = z.object({ date: nonFuture, nav: z.string() }).parse(raw), nav = scaled(v.nav, 6);
  if (!positions(db).some(p => p.code === code)) throw new Error('请先添加基金持仓');
  db.transaction(() => {
    db.prepare('INSERT INTO fund_quotes(code,date,nav,source,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET nav=excluded.nav,source=excluded.source,fetched_at=excluded.fetched_at').run(code, v.date, nav, '手动录入净值', new Date().toISOString());
    for (const p of positions(db).filter(p => p.code === code)) { fundView(db, p); audit(db, p.id, 'nav', { ...v, nav }); }
    setSetting(db, 'fund_error:' + code, '');
  })();
}
export function saveFundReminder(db: DB, raw: unknown) {
  const v = z.object({ enabled: z.boolean() }).parse(raw); setSetting(db, 'fund_reminder_enabled', String(v.enabled)); cancelObsoleteFundReminders(db); return v;
}
export function cancelObsoleteFundReminders(db: DB, now = new Date()) {
  const day = today(now), clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const enabled = setting(db, 'fund_reminder_enabled', 'true') === 'true';
  const rows = db.prepare("SELECT id,dedup FROM outbox WHERE status='pending' AND dedup LIKE 'fund-reminder:%'").all() as { id: number; dedup: string }[];
  for (const row of rows) if (!enabled || row.dedup !== 'fund-reminder:' + day || clock < '14:50' || clock >= '15:00') db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(row.id);
}
export async function runFundReminder(db: DB, now = new Date(), options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
  const started = performance.now();
  cancelObsoleteFundReminders(db, now);
  const owner = setting(db, 'owner'), day = today(now), weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  if (!owner || setting(db, 'fund_reminder_enabled', 'true') !== 'true' || !positions(db).some(p => replayFund(p, fundTrades(db, p.id)).shares > 0) || weekday === 0 || weekday === 6 || clock < '14:50' || clock >= '15:00' || db.prepare('SELECT 1 FROM outbox WHERE dedup=?').get('fund-reminder:' + day)) return;
  // A same-day, fresh exchange quote avoids sending holiday or stale-market alerts.
  let market: ReferenceQuote;
  try { market = await fetchReference('sh000001', options.fetcher, now, options.signal); } catch { return; }
  if (options.signal?.aborted || !freshReference(market, now)) return;
  await refreshFunds(db, { ...options, now }); if (options.signal?.aborted) return;
  const completedAt = new Date(now.getTime() + performance.now() - started);
  const completed = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(completedAt);
  if (today(completedAt) !== day || completed >= '15:00') return;
  if (setting(db, 'fund_reminder_enabled', 'true') !== 'true') return;
  db.prepare('INSERT OR IGNORE INTO outbox(user_id,text,dedup,created_at) VALUES(?,?,?,?)').run(owner, `${day} 14:50基金快照\n${fundText(db, undefined, now)}`, 'fund-reminder:' + day, now.toISOString());
}
export function startFundService(db: DB) {
  const abort = new AbortController(); let active: Promise<void> | undefined, next = 0;
  function tick() {
    if (active || abort.signal.aborted) return;
    active = (async () => {
      if (Date.now() >= next) { await refreshFunds(db, { signal: abort.signal }); next = Date.now() + 5 * 60000; }
      if (!abort.signal.aborted) await runFundReminder(db, new Date(), { signal: abort.signal });
    })().catch(() => {}).finally(() => { active = undefined; });
  }
  const timer = setInterval(tick, 60000); timer.unref(); tick();
  return async () => { abort.abort(); clearInterval(timer); await active; };
}
