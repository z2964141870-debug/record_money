import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../src/db.js';
import { importSnapshots, saveSnapshot, snapshotOverview, completeSnapshot, holdingText } from '../src/fund-snapshots.js';
import { saveFund, saveManualNav, saveFundReminder } from '../src/funds.js';
import { createEntry, summary } from '../src/ledger.js';
import { saveAccount, accountOverview } from '../src/accounts.js';
import { buildReviewEvidence, validateReview, generateReview, runInvestmentReview, saveReviewSettings, investmentReviews, cancelReviewPushes } from '../src/investment-review.js';
import { type modelRequest } from '../src/model-api.js';
import { modelRequest as requestModel } from '../src/model-api.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';
import { parseReference } from '../src/fund-market.js';
const now = new Date('2026-10-08T14:30:00+08:00');
const row = { name: '示例基金C', platform: '测试平台', code: '000001', value: 11000, holding_profit: -1000, pending_amount: 2000, source: '测试截图' };
function rawQuote(symbol: string, stamp = '20261008143000') {
  const fields = Array(35).fill(''); fields[1] = '市场参考'; fields[2] = symbol.slice(2); fields[3] = '1.02'; fields[4] = '1'; fields[30] = stamp;
  return `v_${symbol}="${fields.join('~')}";`;
}
const market: typeof fetch = async url => {
  const u = String(url);
  if (u.includes('pingzhongdata')) return new Response('var fS_name="示例基金C";var fS_code="000001";');
  if (u.includes('lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [{ FSRQ: '2026-09-30', DWJZ: '1.1', NAVTYPE: '1' }, { FSRQ: '2026-09-29', DWJZ: '1', NAVTYPE: '1' }] } });
  return new Response(rawQuote(u.split('q=')[1]));
};
const good = { summary: '先核对交易费用和流动性。', observations: [{ text: '当前截图还缺少份额和日期。', evidence: ['snapshot:1'] }],
  suggestions: [{ target: 'snapshot:1', action: 'review', condition: '确认资料后再决定是否调整', reason: '当前持仓仅是截图快照', checks: ['核对平台确认份额和持有时间'], evidence: ['snapshot:1'] }] };
const request: typeof modelRequest = async () => ({ output_text: JSON.stringify(good), usage: undefined });
test('snapshot import is atomic and replay safe, and never fabricates shares or duplicates assets', () => {
  const db = openDb(':memory:'); const a = saveAccount(db, { name: '原投资汇总', platform: '测试平台', kind: 'investment', balance: 11000 });
  const before = accountOverview(db); importSnapshots(db, [row]); importSnapshots(db, [row]);
  assert.equal(snapshotOverview(db).snapshots.length, 1); assert.equal(snapshotOverview(db).pending, 2000); assert.deepEqual(accountOverview(db), before);
  assert.equal(db.prepare('SELECT count(*) n FROM fund_positions').get() && (db.prepare('SELECT count(*) n FROM fund_positions').get() as { n: number }).n, 0);
  assert.equal(snapshotOverview(db).snapshots[0].as_of, null); assert.match(holdingText(db, '000001'), /份额/);
  assert.throws(() => importSnapshots(db, [{ ...row, name: '第二只' }, { ...row, value: 100, holding_profit: 200 }]), /不一致/);
  assert.equal(snapshotOverview(db).snapshots.length, 1);
  assert.throws(() => completeSnapshot(db, 1, { code: '000001', shares: '', cost: 12000, date: '2026-09-01' }));
  const p = completeSnapshot(db, 1, { code: '000001', shares: '100', cost: 12000, date: '2026-09-01', account_id: a.id });
  saveManualNav(db, '000001', { date: '2026-09-30', nav: '1.1' });
  assert.equal(snapshotOverview(db).value, 0); assert.equal(accountOverview(db).assets, 11000);
  assert.equal(completeSnapshot(db, 1, {}).id, p.id); assert.throws(() => saveSnapshot(db, row, 1), /正式持仓/);
  assert.equal(summary(db, '2026-09-01', '2026-10-08').income, 0); db.close();
});
test('analysis evidence keeps dates, missing amounts, QDII and stale references explicit', () => {
  const db = openDb(':memory:'); importSnapshots(db, [{ ...row, name: '海外测试(QDII)C' }]);
  const e = buildReviewEvidence(db, now, parseReference('sh000001', rawQuote('sh000001'), now));
  assert.equal(e.market, 'open'); assert.equal(e.restricted, true);
  assert.match(e.facts.find(f => f.id === 'snapshot:1')!.text, /截图日期 待确认/);
  assert.match(e.facts.find(f => f.id === 'concentration')!.text, /不是实时仓位/);
  assert.doesNotThrow(() => validateReview(good, e));
  assert.throws(() => validateReview({ ...good, summary: '保证盈利20%' }, e));
  assert.throws(() => validateReview({ ...good, suggestions: [{ ...good.suggestions[0], target: 'snapshot:99' }] }, e), /不存在/);
  assert.throws(() => validateReview({ ...good, suggestions: [{ ...good.suggestions[0], evidence: ['made-up'] }] }, e), /不存在/);
  assert.throws(() => validateReview({ ...good, suggestions: [{ ...good.suggestions[0], action: 'consider_reduce' }] }, e), /资料不足/);
  assert.equal(buildReviewEvidence(db, new Date('2026-10-08T15:30:00+08:00')).market, 'unavailable'); db.close();
});
test('model analysis and fallback persist locally and cannot modify financial records', async () => {
  const db = openDb(':memory:'); importSnapshots(db, [row]); createEntry(db, { kind: 'expense', amount: 20, date: '2026-10-08', category: '餐饮' });
  const before = summary(db, '2026-10-01', '2026-10-08'), accounts = accountOverview(db);
  const r = await generateReview(db, { now, fetcher: market, request }); assert.equal(r.status, 'done'); assert.match(r.text, /不是实时仓位/);
  assert.equal(investmentReviews(db).reports[0].analysis.summary, good.summary);
  const failed = await generateReview(db, { now, fetcher: market, request: async () => { throw new Error('network'); } });
  assert.equal(failed.status, 'fallback'); assert.match(failed.text, /规则核对清单/);
  assert.deepEqual(summary(db, '2026-10-01', '2026-10-08'), before); assert.deepEqual(accountOverview(db), accounts); db.close();
});
test('14:30 daily review deduplicates, works on holidays and expires late pushes', async () => {
  const db = openDb(':memory:'); importSnapshots(db, [row]); setSetting(db, 'owner', 'owner'); saveReviewSettings(db, { enabled: true, push: true, goal: 'swing' }); saveFundReminder(db, { enabled: false });
  let calls = 0; const counted: typeof modelRequest = async (...args) => { calls++; return request(...args); };
  await runInvestmentReview(db, new Date('2026-10-08T14:29:00+08:00'), { fetcher: market, request: counted }); assert.equal(calls, 0);
  await runInvestmentReview(db, now, { fetcher: market, request: counted }); await runInvestmentReview(db, now, { fetcher: market, request: counted }); assert.equal(calls, 1);
  const msg = db.prepare('SELECT * FROM outbox').get() as { text: string; status: string }; assert.match(msg.text, /14:30理财分析/); assert.match(msg.text, /短期波段/); assert.equal(msg.status, 'pending');
  cancelReviewPushes(db, new Date('2026-10-08T15:00:00+08:00')); assert.equal((db.prepare('SELECT status FROM outbox').get() as { status: string }).status, 'cancelled');
  await runInvestmentReview(db, new Date('2026-10-09T16:00:00+08:00'), { fetcher: market, request });
  assert.equal(investmentReviews(db).reports.length, 2); assert.equal((db.prepare('SELECT count(*) n FROM outbox').get() as { n: number }).n, 1);
  saveReviewSettings(db, { enabled: false, push: true, goal: 'swing' }); await runInvestmentReview(db, new Date('2026-10-10T14:30:00+08:00'), { fetcher: market, request: counted }); assert.equal(calls, 1); db.close();
});
test('a manual report before the scheduled time does not suppress the daily refresh or push', async () => {
  const db = openDb(':memory:'); importSnapshots(db, [row]); setSetting(db, 'owner', 'owner'); saveReviewSettings(db, { enabled: true, push: true, goal: 'swing' });
  let calls = 0; const counted: typeof modelRequest = async (...args) => { calls++; return request(...args); };
  await generateReview(db, { now: new Date('2026-10-08T10:00:00+08:00'), fetcher: market, request: counted });
  await runInvestmentReview(db, now, { fetcher: market, request: counted }); assert.equal(calls, 2);
  assert.equal((db.prepare('SELECT count(*) n FROM outbox').get() as { n: number }).n, 1); db.close();
});
test('concurrent generation calls one model and a mid-generation ledger change yields a review checklist', async () => {
  const db = openDb(':memory:'); importSnapshots(db, [row]); let calls = 0;
  const changing: typeof modelRequest = async () => { calls++; saveSnapshot(db, { ...row, value: 11100 }, 1); return request(config, { input: [], maxTokens: 100 }); };
  const results = await Promise.all([generateReview(db, { now, fetcher: market, request: changing }), generateReview(db, { now, fetcher: market, request: changing })]);
  assert.equal(calls, 1); assert.equal(results[0].status, 'fallback'); assert.match(results[0].error, /账本发生变化/); db.close();
});
test('snapshot and review API require CSRF and preserve the original configuration', async () => {
  const db = openDb(':memory:'), { app } = await buildServer(db), headers = { host: '127.0.0.1:' + config.port };
  try {
    const token = (await app.inject({ url: '/api/bootstrap', headers })).json().csrf, auth = { ...headers, 'x-ledger-token': token };
    assert.equal((await app.inject({ method: 'POST', url: '/api/funds/snapshots/import', headers, payload: [row] })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/funds/snapshots/import', headers: auth, payload: [row] })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/funds', headers })).json().snapshots.snapshots.length, 1);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/investment-reviews/settings', headers: auth, payload: { enabled: true, goal: 'swing', push: true } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/investment-reviews', headers })).json().settings.time, '14:30');
  } finally { await app.close(); }
});
test('Responses JSON mode includes the required marker in input and preserves the final image message', async () => {
  const fake: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.input[0].role, 'system'); assert.match(body.input[0].content, /JSON/);
    assert.equal(body.input.at(-1).content[1].type, 'input_image');
    return Response.json({ id:'r',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"ok":true}'}]}] });
  };
  const r = await requestModel({...config,aiMode:'ai',apiType:'responses',model:'fixture',aiBaseUrl:'https://fixture.invalid/v1',aiKey:'fixture'},
    {instructions:'输出JSON',input:[{role:'user',content:'识别图片'}],image:'data:image/png;base64,fixture',maxTokens:100}, {fetch:fake});
  assert.equal(r.output_text,'{"ok":true}');
});
