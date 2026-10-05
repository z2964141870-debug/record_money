import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../src/db.js';
import { createEntry, updateEntry, cancelEntry, refunded, cents, summary, csv, listEntries, today } from '../src/ledger.js';
import { applyActions, receiveMessage, resolveConfirmation } from '../src/assistant.js';
import { runSchedule } from '../src/reports.js';
const input = (amount: number, more = {}) => ({ kind: 'expense', amount, date: '2026-10-05', category: '餐饮', subcategory: '饮料', merchant: 'CoCo', note: '奶茶', parent_id: null, ...more });
test('decimal amounts and valid calendar dates', () => {
  assert.equal(cents('12.8'), 1280); assert.equal(cents('0.29'), 29); assert.equal(cents('1.01'), 101);
  for (const v of ['-2', '1.001', 'NaN', '0', '1e3']) assert.throws(() => cents(v));
  const db = openDb(':memory:'); assert.throws(() => createEntry(db, input(200, { date: '2026-02-30' }))); db.close();
  assert.equal(today(new Date('2026-10-04T16:00:00Z')), '2026-10-05');
});
test('refunds preserve originals, reject over-refund and invalid edits', () => {
  const db = openDb(':memory:'); const expense = createEntry(db, input(1280));
  const refund = createEntry(db, input(500, { kind: 'refund', parent_id: expense.id }));
  assert.equal(refunded(db, expense.id), 500); assert.throws(() => createEntry(db, input(800, { kind: 'refund', parent_id: expense.id })));
  assert.throws(() => updateEntry(db, expense.id, input(499))); assert.throws(() => cancelEntry(db, expense.id));
  assert.throws(() => createEntry(db, input(100, { kind: 'refund', parent_id: expense.id, date: '2026-10-04' })));
  createEntry(db, input(780, { kind: 'refund', parent_id: expense.id }));
  const s = summary(db, '2026-10-01', '2026-10-31'); assert.equal(s.netExpense, 0); assert.equal(s.income, 0); assert.equal(listEntries(db).length, 3);
  updateEntry(db, expense.id, input(1280, { category: '购物' })); assert.equal(listEntries(db).find(e => e.id === refund.id)?.category, '购物'); db.close();
});
test('cross-month refund cash flow and transfer exclusion', () => {
  const db = openDb(':memory:'); const e = createEntry(db, input(1280, { date: '2026-09-30' }));
  createEntry(db, input(1280, { kind: 'refund', parent_id: e.id })); createEntry(db, input(10000, { kind: 'transfer' }));
  assert.equal(summary(db, '2026-09-01', '2026-09-30').netExpense, 1280); assert.equal(summary(db, '2026-10-01', '2026-10-31').netExpense, -1280); assert.equal(summary(db, '2026-10-01', '2026-10-31').income, 0); db.close();
});
test('message deduplication and atomic multi-entry rollback', () => {
  const db = openDb(':memory:'); assert.equal(receiveMessage(db, 'm1', 'owner', '奶茶20'), true); assert.equal(receiveMessage(db, 'm1', 'owner', '奶茶20'), false);
  const actions = [{ type: 'add' as const, kind: 'expense' as const, amount: '20', category: '餐饮' }];
  applyActions(db, 'm1', actions); applyActions(db, 'm1', actions); assert.equal(listEntries(db).length, 1);
  receiveMessage(db, 'm2', 'owner', '多笔'); assert.throws(() => applyActions(db, 'm2', [...actions, { type: 'add', kind: 'expense', amount: '0' }])); assert.equal(listEntries(db).length, 1); db.close();
});
test('ambiguous refunds require selection; selection only runs once', () => {
  const db = openDb(':memory:'); const e = createEntry(db, input(1280, { note: '券' })); createEntry(db, input(1280, { note: '券' }));
  receiveMessage(db, 'm1', 'owner', '券退了12.8'); const reply = applyActions(db, 'm1', [{ type: 'refund', amount: '12.8', match: '券', date: '2026-10-05' }]);
  assert.match(reply, /请确认/); assert.equal(refunded(db, e.id), 0);
  assert.throws(() => resolveConfirmation(db, 1, e.id, 'stranger'));
  resolveConfirmation(db, 1, e.id, 'owner'); assert.equal(refunded(db, e.id), 1280); assert.throws(() => resolveConfirmation(db, 1, e.id, 'owner')); db.close();
});
test('scheduled reports are persistent, deduplicated and catch up after restart', () => {
  const db = openDb(':memory:'); setSetting(db, 'owner', 'owner'); setSetting(db, 'schedule_start', '2026-09-30');
  runSchedule(db, new Date('2026-10-01T01:00:00Z')); const count = (db.prepare('SELECT count(*) AS n FROM reports').get() as { n: number }).n;
  assert.equal(count, 2); runSchedule(db, new Date('2026-10-01T01:00:00Z')); assert.equal((db.prepare('SELECT count(*) AS n FROM reports').get() as { n: number }).n, count);
  runSchedule(db, new Date('2026-10-02T00:00:00Z')); assert.equal((db.prepare('SELECT count(*) AS n FROM reports').get() as { n: number }).n, 3); db.close();
});
test('one message can require multiple independent refund confirmations', () => {
  const db = openDb(':memory:');
  const first = createEntry(db, input(1280, { note: '券' }));
  const second = createEntry(db, input(1280, { note: '券' }));
  receiveMessage(db, 'two-refunds', 'owner', '两张券分别退5元和6元');
  const result = applyActions(db, 'two-refunds', [
    { type: 'refund', amount: '5', match: '券' },
    { type: 'refund', amount: '6', match: '券' },
  ]);
  assert.match(result, /C1/); assert.match(result, /C2/);
  resolveConfirmation(db, 1, first.id, 'owner');
  resolveConfirmation(db, 2, second.id, 'owner');
  assert.equal(refunded(db, first.id), 500); assert.equal(refunded(db, second.id), 600);
  assert.equal(listEntries(db).length, 4); db.close();
});
test('CSV escapes spreadsheet formulas and quotes', () => {
  const db = openDb(':memory:'); createEntry(db, input(100, { note: '=HYPERLINK("bad")' })); const result = csv(listEntries(db)); assert.match(result, /'=HYPERLINK/); assert.match(result, /""bad""/); db.close();
});
