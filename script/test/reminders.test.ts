import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, setSetting } from '../src/db.js';
import { runReminder, cancelObsoleteReminders, saveReminderSettings } from '../src/reminders.js';
import { createEntry } from '../src/ledger.js';
import { processMessage, receiveMessage } from '../src/assistant.js';
import { exportOperationRecord } from '../src/operation-records.js';
const date = '2026-10-06';
const now = (time: string) => new Date(`${date}T${time}:00+08:00`);
const count = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='pending' AND dedup LIKE 'reminder:%'").get() as { n: number }).n;
test('20:00 reminder is daily, persistent, configurable and never catches up outside its hour', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-reminder-')); let db = openDb(join(dir, 'ledger.sqlite'));
  try {
    setSetting(db, 'owner', 'owner'); runReminder(db, now('19:59')); assert.equal(count(db), 0);
    runReminder(db, now('20:00')); assert.equal(count(db), 1); runReminder(db, now('20:10')); assert.equal(count(db), 1);
    db.close(); db = openDb(join(dir, 'ledger.sqlite')); runReminder(db, now('20:15')); assert.equal(count(db), 1);
    cancelObsoleteReminders(db, now('21:00')); assert.equal(count(db), 0);
    runReminder(db, new Date('2026-10-07T00:10:00+08:00')); assert.equal(count(db), 0);
    saveReminderSettings(db, { enabled: false, time: '20:00' }); runReminder(db, new Date('2026-10-07T20:00:00+08:00')); assert.equal(count(db), 0);
    saveReminderSettings(db, { enabled: true, time: '21:15' }); runReminder(db, new Date('2026-10-07T21:15:00+08:00')); assert.equal(count(db), 1);
    assert.throws(() => saveReminderSettings(db, { enabled: true, time: '25:00' }));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('transfers do not count as daily spending; queued reminders are cancelled after bookkeeping', () => {
  const db = openDb(':memory:'); setSetting(db, 'owner', 'owner');
  createEntry(db, { kind: 'transfer', amount: 100, category: '转账', date });
  runReminder(db, now('20:00')); assert.equal(count(db), 1);
  createEntry(db, { kind: 'expense', amount: 2000, category: '餐饮', date });
  cancelObsoleteReminders(db, now('20:01')); assert.equal(count(db), 0);
  runReminder(db, now('20:02')); assert.equal(count(db), 0); db.close();
});
test('unprocessed messages defer reminder; no-activity reply exempts only that date', async () => {
  const db = openDb(':memory:'); setSetting(db, 'owner', 'owner');
  receiveMessage(db, 'm', 'owner', '今天没有收支', undefined, `${date}T19:30:00+08:00`);
  runReminder(db, now('20:00')); assert.equal(count(db), 0);
  assert.match(await processMessage(db, 'm'), /明天仍按设置/);
  runReminder(db, now('20:10')); assert.equal(count(db), 0);
  runReminder(db, new Date('2026-10-07T20:00:00+08:00')); assert.equal(count(db), 1); db.close();
});
test('daily operation README is private, reproducible and records audit operations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-records-')), db = openDb(':memory:');
  try {
    createEntry(db, { kind: 'expense', amount: 1280, category: '<餐饮>', date });
    db.prepare('UPDATE audit SET created_at=?').run(`${date}T12:00:00.000Z`);
    const path = exportOperationRecord(db, date, dir); const contents = readFileSync(path, 'utf8');
    assert.match(contents, /12.80 元/); assert.match(contents, /&lt;餐饮&gt;/);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = statSync(path).mtimeMs; exportOperationRecord(db, date, dir); assert.equal(statSync(path).mtimeMs, before);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
