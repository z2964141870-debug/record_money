import { z } from 'zod';
import { type DB, setting, setSetting } from './db.js';
import { today, money } from './ledger.js';
import { fundOverview, refreshFunds } from './funds.js';
import { snapshotOverview } from './fund-snapshots.js';
import { accountOverview } from './accounts.js';
import { fetchReference, freshReference, type ReferenceQuote } from './fund-market.js';
import { modelRequest, modelRuntime } from './model-api.js';
import { investmentMethod } from './investment-method.js';
const clock = (now: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
const time = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const text = z.string().trim().min(1).max(220).refine(s => !/[0-9¥￥%]/.test(s), '分析文字不能自造数值');
const refs = z.array(z.string().max(30)).min(1).max(6);
export const reviewSchema = z.object({ summary: text, observations: z.array(z.object({ text, evidence: refs })).max(3),
  suggestions: z.array(z.object({ target: z.string().max(30), action: z.enum(['observe', 'review', 'pause_plan', 'consider_reduce', 'consider_rebalance']),
    condition: text, reason: text, checks: z.array(text).min(1).max(3), evidence: refs })).min(1).max(3) });
type Analysis = z.infer<typeof reviewSchema>;
type Fact = { id: string; text: string };
type Evidence = { capturedAt: string; goal: string; market: 'open' | 'unavailable'; facts: Fact[]; targets: string[]; targetLabels: Record<string,string>; restricted: boolean; revision: string };
export type InvestmentReview = { id: number; day: string; status: string; text: string; model: string; error: string; created_at: string; updated_at: string };
const select = 'SELECT id,day,status,text,model,error,created_at,updated_at FROM investment_reviews';
export function reviewSettings(db: DB) { return { enabled: setting(db, 'investment_review_enabled', 'false') === 'true', time: '14:30',
  goal: setting(db, 'investment_review_goal', 'risk_control'), push: setting(db, 'investment_review_push', 'true') === 'true' }; }
export function investmentReviews(db: DB) { return { settings: reviewSettings(db), reports: (db.prepare('SELECT * FROM investment_reviews ORDER BY day DESC LIMIT 30').all() as (InvestmentReview & { analysis_json: string | null; evidence_json: string })[]).map(({ analysis_json, evidence_json, ...r }) => ({ ...r, analysis: analysis_json ? JSON.parse(analysis_json) : null, evidence: JSON.parse(evidence_json) })),
  methodology: '目标、现金与负债、集中度、费用、条件与备选方案', source: 'https://github.com/anthropics/financial-services/tree/main/plugins/agent-plugins/meeting-prep-agent/skills/investment-proposal' }; }
function revision(db: DB) { return JSON.stringify(db.prepare(`SELECT (SELECT MAX(id) FROM audit) ledger,
  (SELECT MAX(id) FROM inventory_audit) inventory,(SELECT MAX(id) FROM account_audit) accounts,
  (SELECT MAX(id) FROM fund_audit) funds,(SELECT MAX(id) FROM loan_events) loans`).get()); }
export function saveReviewSettings(db: DB, raw: unknown) {
  const v = z.object({ enabled: z.boolean(), goal: z.enum(['risk_control', 'long_term', 'swing']), push: z.boolean() }).parse(raw);
  db.transaction(() => { setSetting(db, 'investment_review_enabled', String(v.enabled)); setSetting(db, 'investment_review_goal', v.goal); setSetting(db, 'investment_review_push', String(v.push)); })();
  cancelReviewPushes(db); return reviewSettings(db);
}
const labels: Record<string, string> = { risk_control: '控制风险', long_term: '长期定投', swing: '短期波段' };
export function buildReviewEvidence(db: DB, now: Date, market?: ReferenceQuote): Evidence {
  const funds = fundOverview(db, now), pool = snapshotOverview(db), accounts = accountOverview(db), settings = reviewSettings(db);
  const hour = clock(now), weekday = new Date(today(now) + 'T00:00:00Z').getUTCDay();
  const open = !!market && freshReference(market, now) && weekday !== 0 && weekday !== 6 && ((hour >= '09:30' && hour <= '11:30') || (hour >= '13:00' && hour < '15:00'));
  const facts: Fact[] = [{ id: 'accounts', text: `账本已记录现金 ${money(accounts.cash)}元 · 负债 ${money(accounts.debt)}元 · ${accounts.unknown}个账户余额未知（非完整资产清单；贷款不代表今天到期）` },
    { id: 'constraints', text: '未设置应急资金、风险承受能力、计划持有期及逐只申赎费；不能据此直接给下单金额或目标仓位。' },
    { id: 'market', text: market ? `上证指数 ${((market.price - market.previous_close) / market.previous_close * 100).toFixed(2)}% · ${time(market.quoted_at)} · 腾讯行情${open ? '' : ' · 非当前交易行情'}` : '当前交易行情不可用，不做盘中交易判断。' }];
  for (const symbol of ['sh510300', 'sh512400', 'sh518880']) {
    const q = db.prepare('SELECT * FROM fund_references WHERE symbol=?').get(symbol) as ReferenceQuote | undefined;
    facts.push({ id: 'market:' + symbol, text: q ? `${q.name} ETF参考 ${((q.price - q.previous_close) / q.previous_close * 100).toFixed(2)}% · ${time(q.quoted_at)} · 腾讯行情${freshReference(q, now) ? '' : ' · 已过期'}（市场背景，非任一持仓的实际估值）` : `${symbol} ETF市场背景不可用` });
  }
  const targets = ['portfolio'], targetLabels: Record<string,string> = {portfolio:'整体组合'}, rows: { id: string; value: number }[] = []; let missing = false;
  for (const p of funds.funds) {
    const id = 'fund:' + p.id; targets.push(id); targetLabels[id] = p.name; if (p.value !== null) rows.push({ id, value: p.value }); else missing = true;
    facts.push({ id, text: `${p.name} ${p.code} · ${p.platform} · 市值 ${p.value === null ? '未知' : money(p.value) + '元'} · 持有收益 ${p.profit === null ? '未知' : money(p.profit) + '元'} · 净值日期 ${p.quote?.date || '未知'}${/QDII/i.test(p.name) ? ' · QDII净值有延迟' : ''}` });
    if (p.reference) facts.push({ id: 'etf:' + p.id, text: `${p.reference.name}参考涨跌 ${p.referenceChange!.toFixed(2)}% · ${time(p.reference.quoted_at)}${p.referenceFresh ? '' : ' · 已过期'} · 不是该基金估值` });
  }
  for (const s of pool.snapshots.filter(s => !s.position_id)) {
    const id = 'snapshot:' + s.id; targets.push(id); targetLabels[id] = s.name; rows.push({ id, value: s.value }); missing = true;
    facts.push({ id, text: `${s.name}${s.code ? ' ' + s.code : ''} · ${s.platform} · 截图金额 ${money(s.value)}元 · 截图持有收益 ${money(s.holding_profit)}元 · 截图日期 ${s.as_of || '待确认'} · 份额未知${s.pending_amount ? ' · 申购中 ' + money(s.pending_amount) + '元（是否已含在截图金额中待确认）' : ''}` });
    if (s.code) {
      const quotes = db.prepare('SELECT date,nav,source FROM fund_quotes WHERE code=? ORDER BY date DESC LIMIT 2').all(s.code) as { date: string; nav: number; source: string }[], q = quotes[0], previous = quotes[1];
      if (q) facts.push({ id: 'nav:' + s.id, text: `${s.name} 公布净值 ${(q.nav / 1e6).toFixed(4)} · ${q.date}${previous ? ' · 较' + previous.date + '变动 ' + ((q.nav - previous.nav) / previous.nav * 100).toFixed(2) + '%' : ''} · ${q.source}（不能据此重算截图金额）` });
    }
  }
  const total = rows.reduce((n, r) => n + r.value, 0), largest = rows.toSorted((a, b) => b.value - a.value)[0];
  facts.push({ id: 'concentration', text: total && largest ? `上述已知金额合计 ${money(total)}元 · 最大单只 ${largest.id} 占 ${(largest.value / total * 100).toFixed(2)}%（混合日期快照，仅为登记金额占比；不是实时仓位或完整资产占比）` : '没有可用持仓金额。' });
  return { capturedAt: now.toISOString(), goal: labels[settings.goal], market: open ? 'open' : 'unavailable', facts, targets, targetLabels,
    restricted: !open || missing, revision: revision(db) };
}
export function validateReview(raw: unknown, evidence: Evidence) {
  const analysis = reviewSchema.parse(raw), ids = new Set(evidence.facts.map(f => f.id));
  for (const item of [...analysis.observations, ...analysis.suggestions]) if (item.evidence.some(id => !ids.has(id))) throw new Error('分析引用了不存在的数据');
  for (const item of analysis.suggestions) {
    if (!evidence.targets.includes(item.target)) throw new Error('分析引用了不存在的持仓');
    if (item.target !== 'portfolio' && !item.evidence.includes(item.target)) throw new Error('建议未引用对应持仓');
    if (evidence.restricted && !['observe', 'review', 'pause_plan'].includes(item.action)) throw new Error('资料不足或行情过期，不能给调仓建议');
  }
  return analysis;
}
function fallback(): Analysis { return { summary: '先核对持仓和交易成本，再决定是否操作。', observations: [],
  suggestions: [{ target: 'portfolio', action: 'review', condition: '补齐资料并确认当前行情后再评估', reason: '当前资料不足以给出可靠的调仓结论', checks: ['确认已持有份额、截图日期和申购状态', '核对申赎费、持有期及现金需求'], evidence: ['constraints'] }] }; }
function formatReview(evidence: Evidence, analysis: Analysis, degraded: boolean) {
  return `${today(new Date(evidence.capturedAt))} 理财分析 · ${evidence.goal}\n生成时间 ${time(evidence.capturedAt)}${degraded ? '\n模型分析不可用，以下为规则核对清单' : ''}\n\n` +
    evidence.facts.map(f => `[${f.id}] ${f.text}`).join('\n') + '\n\n' + analysis.summary + '\n' +
    analysis.observations.map(o => `${o.text}（${o.evidence.join('、')}）`).join('\n') + '\n' +
    analysis.suggestions.map(s => `${evidence.targetLabels[s.target]}：${s.condition}\n${s.reason}（${s.evidence.join('、')}）\n先核对：${s.checks.join('；')}`).join('\n\n') + '\n\n仅供决策参考，不执行买卖。ETF参考与公布净值均不等于基金实时估值。';
}
type Options = { fetcher?: typeof fetch; request?: typeof modelRequest; now?: Date; signal?: AbortSignal };
const active = new WeakMap<DB, Promise<InvestmentReview>>();
export async function generateReview(db: DB, options: Options = {}): Promise<InvestmentReview> {
  const running = active.get(db); if (running) return running;
  const task = (async () => {
    const now = options.now || new Date(), day = today(now), started = performance.now();
    const overall = AbortSignal.any([AbortSignal.timeout(120000), ...(options.signal ? [options.signal] : [])]);
    let market: ReferenceQuote | undefined;
    try { market = await fetchReference('sh000001', options.fetcher, now, overall); } catch {}
    await refreshFunds(db, { now, fetcher: options.fetcher, signal: overall });
    for (const symbol of ['sh510300', 'sh512400', 'sh518880']) {
      try { const q = await fetchReference(symbol, options.fetcher, now, overall);
        if (!overall.aborted) db.prepare('INSERT INTO fund_references(symbol,name,price,previous_close,quoted_at,fetched_at,source) VALUES(@symbol,@name,@price,@previous_close,@quoted_at,@fetched_at,@source) ON CONFLICT(symbol) DO UPDATE SET name=excluded.name,price=excluded.price,previous_close=excluded.previous_close,quoted_at=excluded.quoted_at,fetched_at=excluded.fetched_at,source=excluded.source WHERE excluded.quoted_at>=fund_references.quoted_at').run(q);
      } catch {}
    }
    if (overall.aborted) throw new Error('分析已中止');
    // Evaluate timestamps after refresh, not when the network requests began.
    const captured = new Date(now.getTime() + performance.now() - started), evidence = buildReviewEvidence(db, captured, market), runtime = modelRuntime(db);
    db.prepare(`INSERT INTO investment_reviews(day,status,evidence_json,created_at,updated_at) VALUES(?,'running',?,?,?)
      ON CONFLICT(day) DO UPDATE SET status='running',evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`).run(day, JSON.stringify(evidence), now.toISOString(), now.toISOString());
    let analysis: Analysis, error = '';
    try {
      const response = await (options.request || modelRequest)(runtime, { instructions: investmentMethod,
        input: [{ role: 'user', content: JSON.stringify(evidence) }], maxTokens: 2400 }, { fetch: (url, init) => fetch(url, { ...init,
          signal: AbortSignal.any([overall, ...(init?.signal ? [init.signal] : [])]) }) });
      analysis = validateReview(JSON.parse(response.output_text), evidence);
    } catch { error = '模型未能生成合格分析，已保留真实数据和核对清单'; analysis = fallback(); }
    if (options.signal?.aborted) throw new Error('分析已中止');
    if (revision(db) !== evidence.revision) { error = '生成期间账本发生变化，请重新生成'; analysis = fallback(); }
    const text = formatReview(evidence, analysis, !!error), updatedAt = new Date().toISOString();
    db.prepare('UPDATE investment_reviews SET status=?,analysis_json=?,text=?,model=?,error=?,updated_at=? WHERE day=?').run(error ? 'fallback' : 'done', JSON.stringify(analysis), text, runtime.model, error, updatedAt, day);
    return db.prepare(select + ' WHERE day=?').get(day) as InvestmentReview;
  })();
  active.set(db, task); try { return await task; } finally { active.delete(db); }
}
export function cancelReviewPushes(db: DB, now = new Date()) {
  const v = reviewSettings(db), rows = db.prepare("SELECT id,dedup FROM outbox WHERE status='pending' AND dedup LIKE 'investment-review:%'").all() as { id: number; dedup: string }[];
  for (const row of rows) if (!v.enabled || !v.push || row.dedup !== 'investment-review:' + today(now) || clock(now) >= '15:00') db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(row.id);
}
export async function runInvestmentReview(db: DB, now = new Date(), options: Omit<Options, 'now'> = {}) {
  cancelReviewPushes(db, now); const day = today(now), settings = reviewSettings(db);
  if (!settings.enabled || clock(now) < '14:30') return;
  if (!fundOverview(db).funds.length && !snapshotOverview(db).snapshots.length) return;
  if (setting(db, 'investment_review_scheduled_day') === day) return;
  const started = performance.now(), report = await generateReview(db, { ...options, now });
  const completed = new Date(now.getTime() + performance.now() - started);
  if (today(completed) === day) setSetting(db, 'investment_review_scheduled_day', day);
  if (settings.push && reviewSettings(db).enabled && reviewSettings(db).push && today(completed) === day && clock(completed) < '15:00' && setting(db, 'owner')) {
    const row = db.prepare('SELECT analysis_json,evidence_json FROM investment_reviews WHERE id=?').get(report.id) as { analysis_json: string; evidence_json: string };
    const a = JSON.parse(row.analysis_json) as Analysis, e = JSON.parse(row.evidence_json) as Evidence;
    const message = `${day} 14:30理财分析 · ${e.goal}\n${report.error ? report.error + '\n' : ''}${a.summary}\n` + e.facts.filter(f => ['market', 'concentration'].includes(f.id)).map(f => f.text).join('\n') + '\n\n' +
      a.suggestions.map(s => `${e.targetLabels[s.target]}：${s.condition}\n${s.reason}\n核对：${s.checks.join('；')}`).join('\n\n') + '\n\n完整数据和行情时间见网页“理财分析”。建议供你决定，不执行买卖。';
    db.prepare('INSERT OR IGNORE INTO outbox(user_id,text,dedup,created_at) VALUES(?,?,?,?)').run(setting(db, 'owner'), message, 'investment-review:' + day, completed.toISOString());
  }
}
export function startInvestmentService(db: DB) {
  const abort = new AbortController(); let pending: Promise<void> | undefined;
  function tick() { if (!pending) pending = runInvestmentReview(db, new Date(), { signal: abort.signal }).catch(() => {}).finally(() => { pending = undefined; }); }
  const timer = setInterval(tick, 60000); timer.unref(); tick();
  return async () => { abort.abort(); clearInterval(timer); await pending; };
}
