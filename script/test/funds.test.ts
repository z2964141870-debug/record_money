import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setSetting, setting } from '../src/db.js';
import { saveAccount, getAccount, accountOverview } from '../src/accounts.js';
import { createEntry, cancelEntry, updateEntry, summary } from '../src/ledger.js';
import { saveFund, recordFundTrade, cancelFundTrade, fundOverview, fundView, getFund, saveManualNav, refreshFunds, runFundReminder, saveFundReminder, cancelObsoleteFundReminders } from '../src/funds.js';
import { scaled, shareValue } from '../src/fund-math.js';
import { parseNavResponse, parseReference, parseFundMetadata, freshReference } from '../src/fund-market.js';
import { applyActions, processMessage, receiveMessage } from '../src/assistant.js';
import { parseActions } from '../src/ai.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';
const initial = { code: '000001', name: '测试基金', platform: '支付宝', shares: '100', cost: 10000, date: '2026-09-01' };
const now = new Date('2026-10-08T14:50:00+08:00');
function referenceRaw(symbol: string, stamp = '20261008145000') {
  const fields = new Array(35).fill(''); fields[1] = 'ETF'; fields[2] = symbol.slice(2); fields[3] = '1.02'; fields[4] = '1.00'; fields[30] = stamp;
  return `v_${symbol}="${fields.join('~')}";`;
}
const fakeMarket = (stale = false): typeof fetch => async url => {
  const address = String(url);
  if (address.includes('pingzhongdata')) return new Response('var ishb=false;var fS_name="Test Fund";var fS_code="000001";');
  if (address.includes('lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [{ FSRQ: '2026-09-30', DWJZ: '1.2000', NAVTYPE: '1' }, { FSRQ: '2026-09-29', DWJZ: '1.1000', NAVTYPE: '1' }] } });
  const symbol = address.split('q=')[1];
  return new Response(referenceRaw(symbol, stale ? '20260930145000' : '20261008145000'));
};
test('fund arithmetic uses fixed precision and rounds only the final cent', () => {
  assert.equal(scaled('12.3456', 4), 123456); assert.equal(scaled('1.234567', 6), 1234567);
  assert.equal(shareValue(123456, 1234567), 1524);
  assert.equal(shareValue(10000, -15000), -2);
  assert.throws(() => scaled('1.12345', 4)); assert.throws(() => scaled('Infinity', 6)); assert.throws(() => scaled('10000000000000000', 4));
});
test('fund linking replaces the account valuation once and does not write income', () => {
  const db = openDb(':memory:'), account = saveAccount(db, { name: '旧持仓', kind: 'investment', platform: '支付宝', balance: 13000 });
  const p = saveFund(db, { ...initial, account_id: account.id });
  assert.equal(p.value, null); assert.equal(accountOverview(db).unknown, 1);
  saveManualNav(db, p.code, { date: '2026-09-30', nav: '1.2' });
  assert.equal(getAccount(db, account.id).balance, 12000); assert.equal(accountOverview(db).assets, 12000);
  assert.throws(() => saveManualNav(db, p.code, { date: '2026-10-08', nav: '1000001' }), /超出/);
  assert.equal(fundView(db, getFund(db, p.id)).quote!.date, '2026-09-30');
  assert.equal(summary(db, '2026-09-01', '2026-10-08').income, 0);
  assert.throws(() => saveAccount(db, { ...account, balance: 99999 }, account.id), /基金/);
  assert.throws(() => saveFund(db, { ...initial, platform: '京东', account_id: account.id }, p.id), /平台/);
  const cash = saveAccount(db, { name: '现金', kind: 'cash', balance: 10000 });
  assert.throws(() => createEntry(db, { kind: 'transfer', amount: 20, date: initial.date, category: '投资', account_id: cash.id, to_account_id: account.id }), /基金栏目/);
  db.close();
});
test('confirmed buy, partial sale, fees and dividends reconcile cost and cash', () => {
  const db = openDb(':memory:'), p = saveFund(db, initial), cash = saveAccount(db, { name: '现金', kind: 'cash', balance: 100000 });
  saveManualNav(db, p.code, { date: '2026-09-30', nav: '1.2' });
  recordFundTrade(db, p.id, { kind: 'buy', shares: '50', amount: 6000, fee: 100, date: '2026-09-02', cash_account_id: cash.id });
  let v = recordFundTrade(db, p.id, { kind: 'sell', shares: '60', amount: 7200, fee: 100, date: '2026-09-03', cash_account_id: cash.id });
  assert.equal(v.shares, 900000); assert.equal(v.cost, 9600); assert.equal(v.realized, 800); assert.equal(v.profit, 1200); assert.equal(v.totalProfit, 2000);
  v = recordFundTrade(db, p.id, { kind: 'dividend', amount: 300, date: '2026-09-04', cash_account_id: cash.id });
  assert.equal(v.totalProfit, 2300); assert.equal(getAccount(db, cash.id).balance, 101500);
  assert.equal(accountOverview(db).assets, 112300); assert.equal(summary(db, '2026-09-01', '2026-10-08').income, 300);
  const sale = v.trades.find(t => t.kind === 'sell')!;
  assert.throws(() => updateEntry(db, sale.entry_id!, {}), /基金/); assert.throws(() => cancelEntry(db, sale.entry_id!), /基金/);
  assert.throws(() => recordFundTrade(db, p.id, { kind: 'sell', shares: '91', amount: 100, date: '2026-09-05', cash_account_id: cash.id }), /超过/);
  assert.equal(fundView(db, getFund(db, p.id)).trades.length, 3);
  cancelFundTrade(db, p.id, sale.id); assert.equal(getAccount(db, cash.id).balance, 94300); assert.equal(fundView(db, getFund(db, p.id)).shares, 1500000);
  db.close();
});
test('full redemption clears cost, and invalid cancellation rolls back cash and shares', () => {
  const db = openDb(':memory:'), p = saveFund(db, initial), cash = saveAccount(db, { name: '现金', kind: 'cash', balance: 100000 });
  recordFundTrade(db, p.id, { kind: 'buy', shares: '50', amount: 6000, date: '2026-09-02', cash_account_id: cash.id });
  const v = recordFundTrade(db, p.id, { kind: 'sell', shares: '150', amount: 18000, date: '2026-09-03', cash_account_id: cash.id });
  assert.equal(v.cost, 0); assert.equal(v.value, 0); assert.equal(v.realized, 2000); assert.equal(v.totalProfit, 2000);
  assert.throws(() => cancelFundTrade(db, p.id, v.trades[0].id), /超过/);
  assert.equal(getAccount(db, cash.id).balance, 112000); assert.equal(fundView(db, getFund(db, p.id)).shares, 0);
  cancelFundTrade(db, p.id, v.trades[1].id); cancelFundTrade(db, p.id, v.trades[0].id);
  assert.equal(getAccount(db, cash.id).balance, 100000);
  saveFund(db, { ...initial, shares: '90' }, p.id); assert.equal(fundView(db, getFund(db, p.id)).shares, 900000);
  db.close();
});
test('NAV-day earnings exclude new subscriptions and include redemption-day units', () => {
  const db = openDb(':memory:'), p = saveFund(db, initial);
  saveManualNav(db, p.code, { date: '2026-09-29', nav: '1.1' }); saveManualNav(db, p.code, { date: '2026-09-30', nav: '1.2' });
  recordFundTrade(db, p.id, { kind: 'buy', shares: '50', amount: 6000, date: '2026-09-30' });
  recordFundTrade(db, p.id, { kind: 'sell', shares: '20', amount: 2400, date: '2026-09-30' });
  assert.equal(fundView(db, getFund(db, p.id)).dailyProfit, 1000);
  const q = saveFund(db, { ...initial, platform: '京东', date: '2026-09-30' });
  assert.equal(q.dailyProfit, null);
  db.close();
});
test('market input rejects HTML, mismatched codes, unsupported currency and future data', () => {
  assert.throws(() => parseNavResponse('000001', '<html>404</html>', now));
  assert.throws(() => parseNavResponse('000001', { ErrCode: 0, Data: { LSJZList: [{ FSRQ: '2026-10-09', DWJZ: '1.2', NAVTYPE: '1' }] } }, now), /未来/);
  assert.throws(() => parseNavResponse('000001', { ErrCode: 0, Data: { LSJZList: [{ FSRQ: '2026-10-08', DWJZ: '0.5', NAVTYPE: '2' }] } }, now), /货币基金/);
  assert.throws(() => parseReference('sh512400', referenceRaw('sh518880'), now), /格式/);
  assert.throws(() => parseReference('sh512400', referenceRaw('sh512400', '20261009145000'), now), /未来/);
  assert.equal(parseFundMetadata('000001', 'var fS_name="华夏成长混合";var fS_code="000001";'), '华夏成长混合');
  assert.throws(() => parseFundMetadata('000001', 'var fS_name="某基金美元";var fS_code="000001";'), /人民币/);
  assert.throws(() => parseFundMetadata('000001', 'var fS_name="基金";var fS_code="000002";'), /不匹配/);
  assert.equal(freshReference(parseReference('sh512400', referenceRaw('sh512400'), now), now), true);
  assert.equal(freshReference(parseReference('sh512400', referenceRaw('sh512400', '20260930145000'), now), now), false);
});
test('refresh caches real-shaped quotes and never labels an ETF proxy as fund valuation', async () => {
  const db = openDb(':memory:'), p = saveFund(db, { ...initial, benchmark: 'sh512400' });
  await refreshFunds(db, { fetcher: fakeMarket(), now });
  let v = fundOverview(db, now).funds[0]; assert.equal(v.value, 12000); assert.equal(v.referenceChange!.toFixed(2), '2.00'); assert.equal(v.referenceProfit, 240);
  assert.equal(v.quote!.date, '2026-09-30'); assert.equal(v.quote!.source, '天天基金公布净值 · Test Fund');
  await refreshFunds(db, { fetcher: async () => new Response('bad', { status: 503 }), now });
  v = fundOverview(db, now).funds[0]; assert.equal(v.value, 12000); assert.ok(v.error); assert.ok(v.referenceError);
  assert.equal(fundOverview(db, new Date('2026-10-09T14:50:00+08:00')).funds[0].referenceProfit, null);
  recordFundTrade(db, p.id, { kind: 'buy', shares: '1', amount: 120, date: '2026-10-08' });
  assert.equal(fundOverview(db, now).funds[0].referenceProfit, null);
  db.close();
});
test('14:50 reminders persist deduplication and skip weekends, holidays and disabled settings', async () => {
  const db = openDb(':memory:'); saveFund(db, { ...initial, benchmark: 'sh512400' }); setSetting(db, 'owner', 'user');
  const count = () => (db.prepare('SELECT count(*) n FROM outbox').get() as { n: number }).n;
  await runFundReminder(db, now, { fetcher: fakeMarket(true) }); assert.equal(count(), 0);
  await runFundReminder(db, new Date('2026-10-08T14:49:00+08:00'), { fetcher: fakeMarket() }); assert.equal(count(), 0);
  await runFundReminder(db, now, { fetcher: fakeMarket() }); await runFundReminder(db, now, { fetcher: fakeMarket() });
  assert.equal(count(), 1);
  const msg = db.prepare('SELECT text FROM outbox').get() as { text: string }; assert.match(msg.text, /14:50基金快照/); assert.match(msg.text, /不是基金盘中估值/);
  cancelObsoleteFundReminders(db,new Date('2026-10-08T15:00:00+08:00'));
  assert.equal((db.prepare('SELECT status FROM outbox').get() as {status:string}).status,'cancelled');
  saveFundReminder(db, { enabled: false }); await runFundReminder(db, new Date('2026-10-09T14:50:00+08:00'), { fetcher: fakeMarket() });
  saveFundReminder(db, { enabled: true }); await runFundReminder(db, new Date('2026-10-10T14:50:00+08:00'), { fetcher: fakeMarket() });
  assert.equal(count(), 1); db.close();
});
test('unknown shares are rejected and explicit agent fund actions are atomic and replay-safe', async () => {
  const db = openDb(':memory:');
  receiveMessage(db, 'init', 'local', '基金');
  const actions = parseActions({ actions: [{ type: 'fund_create', code: '000001', name: '基金', shares: '100', cost: '100', date: '2026-09-01', platform: '支付宝' }] });
  applyActions(db, 'init', actions); applyActions(db, 'init', actions); assert.equal(fundOverview(db).funds.length, 1);
  receiveMessage(db, 'missing', 'local', '买基金20');
  assert.throws(() => applyActions(db, 'missing', [{ type: 'fund_trade', code: '000001', kind: 'buy', amount: '20', date: '2026-10-08' }]), /确认/);
  assert.equal(fundOverview(db).funds[0].trades.length, 0);
  receiveMessage(db, 'query', 'local', '基金收益');
  const original = globalThis.fetch; globalThis.fetch = fakeMarket();
  try { assert.match(await processMessage(db, 'query'), /份额/); } finally { globalThis.fetch = original; }
  assert.equal(summary(db, '2026-09-01', '2026-10-08').count, 0); db.close();
});
test('fund migration and restart retain existing ledgers, configuration and fund history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-money-funds-')), path = join(dir, 'ledger.sqlite');
  try {
    let db = openDb(path); createEntry(db, { kind: 'expense', amount: 2000, date: '2026-10-05', category: '餐饮' }); setSetting(db, 'owner', 'existing-user');
    const p = saveFund(db, initial); recordFundTrade(db, p.id, { kind: 'buy', shares: '1', amount: 120, date: '2026-09-20' });
    saveManualNav(db, p.code, { date: '2026-09-30', nav: '1.2' }); const before = fundOverview(db); db.close();
    db = openDb(path); assert.deepEqual(fundOverview(db), before); assert.equal(setting(db, 'owner'), 'existing-user'); assert.equal(summary(db, '2026-10-01', '2026-10-08').expense, 2000); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('fund API requires CSRF and keeps cash and holdings consistent through undo', async () => {
  const { app } = await buildServer(openDb(':memory:')); const headers = { host: '127.0.0.1:' + config.port };
  try {
    const bootstrap = (await app.inject({ url: '/api/bootstrap', headers })).json(), auth = { ...headers, 'x-ledger-token': bootstrap.csrf };
    assert.equal((await app.inject({ method: 'POST', url: '/api/funds', headers, payload: initial })).statusCode, 403);
    const add = await app.inject({ method: 'POST', url: '/api/funds', headers: auth, payload: initial }); assert.equal(add.statusCode, 200);
    const id = add.json().id;
    assert.equal((await app.inject({ method: 'POST', url: '/api/funds/000001/nav', headers: auth, payload: { date: '2026-09-30', nav: '1.2' } })).statusCode, 200);
    const trade = await app.inject({ method: 'POST', url: `/api/funds/${id}/trades`, headers: auth, payload: { kind: 'buy', shares: '1', amount: 120, date: '2026-09-20' } }); assert.equal(trade.statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/funds/${id}/trades/${trade.json().trades[0].id}/cancel`, headers: auth, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/funds', headers })).json().funds[0].shares, 1000000);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/funds/reminder', headers: auth, payload: { enabled: false } })).statusCode, 200);
  } finally { await app.close(); }
});
