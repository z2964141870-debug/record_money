import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { saveAccount, getAccount } from '../src/accounts.js';
import { applyActions, processMessage, receiveMessage } from '../src/assistant.js';
import { conversationInput, pendingDialogue } from '../src/conversation.js';
import { parseActions } from '../src/ai.js';
test('conversational acknowledgement replies without modifying financial records', () => {
  const db = openDb(':memory:');
  receiveMessage(db, 'thanks', 'owner', '谢谢');
  assert.equal(applyActions(db, 'thanks', parseActions({ actions: [{ type: 'reply', text: '备注已经保存。' }] })), '备注已经保存。');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM account_audit').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT status FROM messages WHERE id=?').get('thanks') as { status: string }).status, 'done');
  db.close();
});
test('conversation history includes both sides, limits turns and excludes other users and later messages', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 23; i++) { receiveMessage(db, 'h' + i, 'owner', '消息' + i); applyActions(db, 'h' + i, [{ type: 'clarify', question: '回执' + i }]); }
  receiveMessage(db, 'stranger', 'stranger', '隔离数据'); applyActions(db, 'stranger', [{ type: 'clarify', question: '不应出现' }]);
  receiveMessage(db, 'current', 'owner', '可以，就这样');
  receiveMessage(db, 'future', 'owner', '未来消息'); applyActions(db, 'future', [{ type: 'clarify', question: '未来回执' }]);
  const input = conversationInput(db, '可以，就这样', { user: 'owner', messageId: 'current' });
  assert.equal(input.length, 41); assert.equal(input[0].content, '消息3'); assert.equal(input[1].content, '回执3');
  assert.deepEqual(input.at(-1), { role: 'user', content: '可以，就这样' }); assert.ok(!JSON.stringify(input).includes('不应出现')); assert.ok(!JSON.stringify(input).includes('未来回执')); db.close();
});
test('confirmed proposal survives database reopening and only applies once without model access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-dialogue-')), path = join(dir, 'ledger.sqlite');
  let db = openDb(path);
  try {
    const a = saveAccount(db, { name: '灵活', kind: 'investment', balance: 285 });
    receiveMessage(db, 'proposal', 'owner', '帮我整理京东金融');
    applyActions(db, 'proposal', [{ type: 'propose', question: '将灵活归入京东金融并保存总体收益备注，可以吗？', actions: [{ type: 'account_update', account: '灵活', platform: '京东金融', note: '京东金融总体累计收益 -930.58元' }] }]);
    assert.equal(getAccount(db, a.id).platform, '');
    assert.equal(pendingDialogue(db, 'stranger'), undefined);
    db.close(); db = openDb(path);
    receiveMessage(db, 'yes', 'owner', '可以的，就这样'); const result = await processMessage(db, 'yes');
    assert.match(result, /京东金融/); assert.match(result, /930.58/); assert.equal(getAccount(db, a.id).balance, 285);
    assert.equal(pendingDialogue(db, 'owner'), undefined);
    await processMessage(db, 'yes'); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM account_audit').get() as { n: number }).n, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('changed ledger invalidates pending proposal; cancelled and expired proposals cannot run', async () => {
  const db = openDb(':memory:'); const a = saveAccount(db, { name: '支付宝', kind: 'cash', balance: 10000 });
  const propose = (id: string) => { receiveMessage(db, id, 'owner', '修改金额'); applyActions(db, id, [{ type: 'propose', question: '改为200元？', actions: [{ type: 'account_update', account: '支付宝', balance: '200' }] }]); };
  propose('p1'); saveAccount(db, { name: '支付宝', kind: 'cash', balance: 30000 }, a.id);
  receiveMessage(db, 'yes', 'owner', '确认'); assert.match(await processMessage(db, 'yes'), /已有变化/); assert.equal(getAccount(db, a.id).balance, 30000);
  propose('p2'); receiveMessage(db, 'cancel', 'owner', '取消这个方案'); assert.match(await processMessage(db, 'cancel'), /已取消/);
  propose('p3'); db.prepare("UPDATE dialogue_pending SET expires_at='2000-01-01T00:00:00Z' WHERE resolved_at IS NULL").run();
  receiveMessage(db, 'expired', 'owner', '确认'); assert.match(await processMessage(db, 'expired'), /没有有效/);
  assert.equal(getAccount(db, a.id).balance, 30000); db.close();
});
test('reply to a proactive reminder includes that sent reminder as context', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO outbox(user_id,text,dedup,status,created_at) VALUES('owner','今天还没有收支记录','reminder:2026-10-06','sent','2026-10-06T12:00:00.000Z')").run();
  receiveMessage(db, 'reply', 'owner', '没有', undefined, '2026-10-06T12:01:00.000Z');
  assert.deepEqual(conversationInput(db, '没有', { user: 'owner', messageId: 'reply' }), [
    { role: 'assistant', content: '今天还没有收支记录' }, { role: 'user', content: '没有' },
  ]); db.close();
});
