import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { accountOverview, getAccount, saveAccount } from '../src/accounts.js';
import { createEntry, cancelEntry, summary } from '../src/ledger.js';
import { applyActions, receiveMessage } from '../src/assistant.js';
import { parseActions } from '../src/ai.js';
const entry = (amount: number, extra = {}) => ({ kind: 'expense', amount, date: '2026-10-05', category: '餐饮', ...extra });
test('asset queries ignore irrelevant ledger filters returned by the model', () => {
  assert.deepEqual(parseActions({ actions: [{ type: 'accounts_query', query_kind: 'assets' }] }), [{ type: 'accounts_query' }]);
  assert.throws(() => parseActions({ actions: [{ type: 'add', kind: 'credit', amount: '20' }] }));
});
test('cash and liability spending, repayments and reversals keep net worth consistent', () => {
  const db = openDb(':memory:');
  const cash = saveAccount(db, { name: '支付宝余额', kind: 'cash', balance: 100000 });
  const debt = saveAccount(db, { name: '美团月付', kind: 'liability', balance: 20000 });
  const spend = createEntry(db, entry(5000, { account_id: debt.id }));
  assert.equal(getAccount(db, debt.id).balance, 25000);
  const repay = createEntry(db, entry(10000, { kind: 'transfer', account_id: cash.id, to_account_id: debt.id }));
  assert.equal(getAccount(db, cash.id).balance, 90000); assert.equal(getAccount(db, debt.id).balance, 15000);
  assert.equal(accountOverview(db).net, 75000); assert.equal(summary(db, '2026-10-01', '2026-10-31').netExpense, 5000);
  cancelEntry(db, repay.id); assert.equal(getAccount(db, cash.id).balance, 100000); assert.equal(getAccount(db, debt.id).balance, 25000);
  createEntry(db, entry(5000, { kind: 'refund', parent_id: spend.id }));
  assert.equal(getAccount(db, debt.id).balance, 20000); assert.equal(accountOverview(db).net, 80000); db.close();
});
test('unknown balances, calibration, locked investments and transfers do not invent income', () => {
  const db = openDb(':memory:');
  const cash = saveAccount(db, { name: '微信', kind: 'cash', balance: null });
  createEntry(db, entry(2000, { account_id: cash.id })); assert.equal(getAccount(db, cash.id).balance, null);
  saveAccount(db, { name: '微信', kind: 'cash', balance: 100000 }, cash.id);
  assert.equal(getAccount(db, cash.id).balance, 100000);
  const fund = saveAccount(db, { name: '支付宝锁定7天', kind: 'locked', balance: 0, available_date: '2026-10-12' });
  createEntry(db, entry(30000, { kind: 'transfer', account_id: cash.id, to_account_id: fund.id }));
  assert.equal(getAccount(db, cash.id).balance, 70000); assert.equal(getAccount(db, fund.id).balance, 30000);
  saveAccount(db, { ...fund, balance: 30100 }, fund.id);
  assert.equal(getAccount(db, fund.id).balance, 30100); assert.equal(accountOverview(db).net, 100100);
  assert.equal(summary(db, '2026-10-01', '2026-10-31').income, 0);
  assert.throws(() => createEntry(db, entry(200, { kind: 'transfer', account_id: cash.id, to_account_id: cash.id })));
  assert.throws(() => saveAccount(db, { ...fund, kind: 'liability', balance: 30100, available_date: null }, fund.id)); db.close();
});
test('agent account operations and linked transfer execute atomically', () => {
  const db = openDb(':memory:'); receiveMessage(db, 'funds', 'local', '账户初始化');
  applyActions(db, 'funds', [
    { type: 'account_create', account: '支付宝余额', account_kind: 'cash', balance: '1000' },
    { type: 'account_create', account: '我的基金', account_kind: 'investment', balance: '0' },
    { type: 'add', kind: 'transfer', amount: '200', account: '支付宝余额', to_account: '我的基金' },
  ]);
  assert.equal(accountOverview(db).assets, 100000); assert.equal(accountOverview(db).investment, 20000);
  receiveMessage(db, 'bad', 'local', '错误多操作');
  assert.throws(() => applyActions(db, 'bad', [
    { type: 'account_update', account: '支付宝余额', balance: '9999' },
    { type: 'add', kind: 'transfer', amount: '20', account: '支付宝余额', to_account: '不存在' },
  ]));
  assert.equal(accountOverview(db).cash, 80000); db.close();
});
