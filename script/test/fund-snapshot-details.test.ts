import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setSetting, setting } from '../src/db.js';
import { importSnapshots, saveSnapshot, snapshotOverview, completeSnapshot, snapshotText } from '../src/fund-snapshots.js';
import { investmentBudget, saveReviewSettings, buildReviewEvidence } from '../src/investment-review.js';
import { saveManualNav } from '../src/funds.js';

const row = { name: '测试基金C', platform: '测试平台', code: '000001', value: 10000, holding_profit: -1000, pending_amount: 2000, as_of: '2026-10-08',
  details: { confirmed_value: 8000, shares: 1000000, available_shares: 900000, unit_cost: 900000, nav: 800000, nav_date: '2026-09-30', receivable_amount: 0, pending_included: true } };

test('old database gains nullable detail fields without changing existing records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-details-')), path = join(dir, 'ledger.sqlite');
  try {
    let db = openDb(path);
    const { details: _, ...legacy } = row;
    saveSnapshot(db, legacy); setSetting(db, 'fixture', 'keep');
    const original = db.prepare('SELECT id,name,value,as_of FROM fund_snapshots').all();
    db.exec('ALTER TABLE fund_snapshots DROP COLUMN details_json'); db.close();
    db = openDb(path);
    assert.deepEqual(db.prepare('SELECT id,name,value,as_of FROM fund_snapshots').all(), original);
    assert.equal(snapshotOverview(db).snapshots[0].details.shares, null);
    assert.equal(setting(db, 'fixture'), 'keep'); db.close();
    db = openDb(path); assert.equal(snapshotOverview(db).snapshots.length, 1); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detail import is atomic and replay safe, preserves old-client edits and never creates trades', () => {
  const db = openDb(':memory:');
  try {
    importSnapshots(db, [row]); importSnapshots(db, [row]);
    const snapshot = snapshotOverview(db).snapshots[0];
    assert.deepEqual(snapshot.details, row.details);
    const { details: _, ...legacy } = row;
    saveSnapshot(db, { ...legacy, note: '改备注' }, snapshot.id);
    assert.deepEqual(snapshotOverview(db).snapshots[0].details, row.details);
    assert.throws(() => importSnapshots(db, [ { ...row, name: '另一只' }, { ...row, details: { ...row.details, available_shares: 1000001 } } ]), /可用份额/);
    assert.equal(snapshotOverview(db).snapshots.length, 1);
    for (const table of ['entries', 'accounts', 'fund_positions', 'fund_trades', 'fund_quotes']) assert.equal((db.prepare('SELECT count(*) n FROM ' + table).get() as {n:number}).n, 0);
    assert.match(snapshotText(db), /100.0000.*90.0000/);
    assert.match(snapshotText(db), /2026-09-30/);
    assert.match(snapshotText(db), /非精确总成本/);
    assert.throws(() => completeSnapshot(db, snapshot.id, { code: row.code, shares: '100', date: row.as_of }), /cost/);
  } finally { db.close(); }
});

test('snapshot values, share bounds and NAV dates must agree while missing and zero values remain distinct', () => {
  const db = openDb(':memory:');
  try {
    for (const details of [ { ...row.details, confirmed_value: 8001 }, { ...row.details, confirmed_value: 10001 },
      { ...row.details, nav_date: '2026-10-09' }, { ...row.details, nav: 0 }, { ...row.details, shares: 0, available_shares: 1 } ]) assert.throws(() => saveSnapshot(db, { ...row, details }));
    assert.throws(() => saveSnapshot(db, { ...row, as_of: null }), /净值日期/);
    const s = saveSnapshot(db, { ...row, pending_amount: 0, details: { confirmed_value: 10000, shares: 0, available_shares: 0, receivable_amount: 0, pending_included: false } });
    assert.equal(s.details.shares, 0); assert.equal(s.details.unit_cost, null); assert.equal(s.details.receivable_amount, 0);
  } finally { db.close(); }
});

test('budget reserves included pending purchases once and keeps uncertain inclusion conservative', () => {
  const db = openDb(':memory:');
  try {
    saveReviewSettings(db, { enabled: true, push: true, goal: 'swing', budget: 450000 });
    const total = { ...row, value: 387714, pending_amount: 6000, details: { ...row.details, confirmed_value: 381714 } };
    const s = saveSnapshot(db, total);
    assert.equal(investmentBudget(db).remaining, 62286);
    assert.equal(snapshotOverview(db).known_shares, 1);
    assert.equal(snapshotOverview(db).confirmed_value, 381714);
    const evidence = buildReviewEvidence(db, new Date('2026-10-08T14:30:00+08:00'));
    assert.match(evidence.facts.find(f => f.id === 'snapshot:' + s.id)!.text, /已含在截图总金额/);
    assert.equal(evidence.restricted, true);
    saveSnapshot(db, { ...total, details: {} }, s.id);
    assert.equal(investmentBudget(db).remaining, 56286);
    saveSnapshot(db, { ...total, value: 381714, details: { ...total.details, pending_included: false } }, s.id);
    assert.equal(investmentBudget(db).remaining, 62286);
    completeSnapshot(db, s.id, { code: row.code, shares: '100', cost: 400000, date: row.as_of });
    saveManualNav(db, row.code, { date: '2026-10-08', nav: '38.1714' });
    assert.equal(investmentBudget(db).remaining, 62286);
    assert.equal(investmentBudget(db).pending, 6000);
  } finally { db.close(); }
});
