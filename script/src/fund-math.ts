import type { DB } from './db.js';

export type FundPosition = { id: number; account_id: number; code: string; name: string; platform: string; opening_shares: number; opening_cost: number; opening_date: string; benchmark: string; note: string };
export type FundTrade = { id: number; position_id: number; kind: 'buy' | 'sell' | 'dividend'; shares: number; amount: number; fee: number; date: string; entry_id: number | null; cash_account_id: number | null; note: string; cancelled_at: string | null };
export type FundQuote = { code: string; date: string; nav: number; source: string; fetched_at: string };
export function scaled(value: string, digits: number, allowZero = false) {
  if (!new RegExp('^\\d+(?:\\.\\d{1,' + digits + '})?$').test(value)) throw new Error(`数字最多${digits}位小数`);
  const [whole, part = ''] = value.split('.');
  const result = Number(whole) * 10 ** digits + Number(part.padEnd(digits, '0'));
  if (!Number.isSafeInteger(result) || result > 1_000_000_000_000 || result < (allowZero ? 0 : 1)) throw new Error('数字超出范围');
  return result;
}
export function roundedRatio(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error('除数必须大于零');
  const sign = numerator < 0n ? -1 : 1, absolute = numerator < 0n ? -numerator : numerator;
  const result = Number((absolute + denominator / 2n) / denominator) * sign;
  if (!Number.isSafeInteger(result) || Math.abs(result) > 100_000_000_000) throw new Error('计算结果超出范围');
  return result;
}
// Shares use 1/10000 units, NAV uses 1/1000000 yuan, money uses cents.
export function shareValue(shares: number, nav: number) { return roundedRatio(BigInt(shares) * BigInt(nav), 100_000_000n); }
export function fundTrades(db: DB, id: number) {
  return db.prepare('SELECT * FROM fund_trades WHERE position_id=? ORDER BY date,id').all(id) as FundTrade[];
}
export function replayFund(position: FundPosition, trades: FundTrade[], through = '9999-12-31') {
  let shares = position.opening_shares, cost = position.opening_cost, realized = 0, invested = cost, dividends = 0;
  for (const trade of trades.filter(t => !t.cancelled_at && t.date <= through)) {
    if (trade.date < position.opening_date) throw new Error('交易早于期初持仓日期');
    if (trade.kind === 'buy') { shares += trade.shares; cost += trade.amount; invested += trade.amount; }
    if (trade.kind === 'sell') {
      if (trade.shares > shares || !shares) throw new Error('赎回份额超过持仓');
      const removed = trade.shares === shares ? cost : roundedRatio(BigInt(cost) * BigInt(trade.shares), BigInt(shares));
      realized += trade.amount - removed; cost -= removed; shares -= trade.shares;
    }
    if (trade.kind === 'dividend') dividends += trade.amount;
    if (!Number.isSafeInteger(shares) || shares > 1_000_000_000_000 || Math.max(cost, invested) > 100_000_000_000) throw new Error('持仓超出范围');
  }
  return { shares, cost, realized, invested, dividends };
}
export function latestNav(db: DB, code: string) {
  return db.prepare('SELECT * FROM fund_quotes WHERE code=? ORDER BY date DESC LIMIT 1').get(code) as FundQuote | undefined;
}
export function fundAccountValue(db: DB, account: number): { managed: boolean; balance: number | null } {
  const p = db.prepare('SELECT * FROM fund_positions WHERE account_id=?').get(account) as FundPosition | undefined;
  if (!p) return { managed: false, balance: null };
  const state = replayFund(p, fundTrades(db, p.id)), quote = latestNav(db, p.code);
  return { managed: true, balance: state.shares === 0 ? 0 : quote ? shareValue(state.shares, quote.nav) : null };
}
