import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, setSetting, setting } from '../src/db.js';
import { acceptFeishuMessage, decodeFeishuHistory, recoverFeishuHistory, type HistoryAPI } from '../src/feishu-history.js';
import { processMessage, receiveMessage, applyActions } from '../src/assistant.js';
import { config } from '../src/config.js';
import { conversationInput } from '../src/conversation.js';
import { createImageDraft, latestImageDraft } from '../src/image-ledger.js';

const base = Date.parse('2026-10-07T04:00:00Z');
function message(id: string, text: string, offset: number, extra = {}) {
  return { message_id: id, chat_id: 'private', create_time: String(base + offset), msg_type: 'text',
    sender: { id: 'owner', sender_type: 'user', id_type: 'open_id' }, body: { content: JSON.stringify({ text }) }, ...extra };
}
function seed(db: ReturnType<typeof openDb>) {
  setSetting(db, 'owner', 'owner');
  setSetting(db, 'feishu_chat', JSON.stringify({ appId: 'app', owner: 'owner', chat: 'private' }));
  setSetting(db, 'feishu_history', JSON.stringify({ appId: 'app', owner: 'owner', until: base }));
}
test('offline pages preserve timestamps, pictures and reply links; live overlap and rescans never book twice', async () => {
  const db = openDb(':memory:'), old = { ...config };
  Object.assign(config, { aiMode: 'fixed', aiKey: '', aiBaseUrl: '' }); seed(db);
  const live = message('om_live', '收入 30 红包 家人', 5000);
  acceptFeishuMessage(db, decodeFeishuHistory(live)!, 'app');
  const picture = message('om_image', '', 3000, { msg_type: 'image', parent_id: 'om_purchase', body: { content: JSON.stringify({ image_key: 'image-test' }) } });
  const requests: string[] = [];
  const api: HistoryAPI = { chatForMessage: async () => { throw new Error('cached chat should be used'); }, page: async input => {
    requests.push(input.token || 'first');
    return input.token ? { items: [picture, live], hasMore: false } : { items: [message('om_purchase', '支出 20 餐饮 奶茶', 1000)], hasMore: true, token: 'page2' };
  } };
  try {
    assert.deepEqual(await recoverFeishuHistory(db, api, 'app', base + 10000), { recovered: 2, review: 0 });
    assert.deepEqual(requests, ['first', 'page2']);
    assert.equal((db.prepare('SELECT received_at FROM messages WHERE id=?').get('om_purchase') as { received_at: string }).received_at, new Date(base + 1000).toISOString());
    assert.equal((db.prepare('SELECT reply_to FROM messages WHERE id=?').get('om_image') as { reply_to: string }).reply_to, 'om_purchase');
    assert.equal((db.prepare('SELECT image_key FROM message_images').get() as { image_key: string }).image_key, 'image-test');
    await processMessage(db, 'om_purchase'); await processMessage(db, 'om_live');
    assert.deepEqual(await recoverFeishuHistory(db, api, 'app', base + 11000), { recovered: 0, review: 0 });
    assert.equal((db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n, 2);
    const rows = db.prepare('SELECT kind,amount,date,source FROM entries ORDER BY id').all();
    assert.deepEqual(rows, [{ kind: 'expense', amount: 2000, date: '2026-10-07', source: 'feishu' }, { kind: 'income', amount: 3000, date: '2026-10-07', source: 'feishu' }]);
  } finally { Object.assign(config, old); db.close(); }
});
test('failed later page does not advance cursor or insert partial history; retry and restart catch up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-history-')), path = join(dir, 'ledger.sqlite');
  let db = openDb(path); seed(db);
  const before = setting(db, 'feishu_history'); let fail = true;
  const api: HistoryAPI = { chatForMessage: async () => undefined, page: async input => {
    if (input.token && fail) throw new Error('offline');
    return { items: input.token ? [message('om_second', '修改 #1 金额 18', 5000)] : [message('om_first', '支出 20 餐饮 奶茶', 1000)], hasMore: !input.token, token: input.token ? undefined : 'next' };
  } };
  try {
    await assert.rejects(recoverFeishuHistory(db, api, 'app', base + 10000), /offline/);
    assert.equal(setting(db, 'feishu_history'), before); assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n, 0);
    db.close(); db = openDb(path); fail = false;
    assert.deepEqual(await recoverFeishuHistory(db, api, 'app', base + 10000), { recovered: 2, review: 0 });
    const old = { ...config }; Object.assign(config, { aiMode: 'fixed', aiKey: '', aiBaseUrl: '' });
    try { await processMessage(db, 'om_first'); await processMessage(db, 'om_second'); }
    finally { Object.assign(config, old); }
    assert.equal((db.prepare('SELECT amount FROM entries').get() as { amount: number }).amount, 1800);
    assert.equal(JSON.parse(setting(db, 'feishu_history')).until, base + 10000);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('similar new IDs and history preceding completed work require review; private sender and payload filters hold', async () => {
  const db = openDb(':memory:'); seed(db);
  receiveMessage(db, 'om_done', 'owner', '支出 20 餐饮 奶茶', undefined, new Date(base + 5000).toISOString());
  applyActions(db, 'om_done', [{ type: 'reply', text: '已处理' }]);
  const api: HistoryAPI = { chatForMessage: async () => undefined, page: async () => ({ hasMore: false, items: [
    message('om_repeat', '支出 20 餐饮 奶茶', 6000), message('om_old', '修改 #1 金额 18', 1000),
    message('om_other', '支出 20 餐饮 奶茶', 2000, { sender: { id: 'stranger', sender_type: 'user' } }),
    message('om_group', '支出 20 餐饮 奶茶', 2000, { chat_id: 'other-chat' }),
    message('om_bot', '支出 20 餐饮 奶茶', 2000, { sender: { id: 'owner', sender_type: 'app' } }),
    message('om_deleted', '支出 20 餐饮 奶茶', 2000, { deleted: true }),
    message('om_future', '支出 20 餐饮 奶茶', 20000), message('om_invalid', '', 2000, { body: { content: '{' } }),
  ] }) };
  try {
    assert.deepEqual(await recoverFeishuHistory(db, api, 'app', base + 10000), { recovered: 2, review: 2 });
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages WHERE status='needs_attention'").get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number }).n, 3);
    await recoverFeishuHistory(db, api, 'app', base + 11000);
    assert.equal((db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number }).n, 3);
  } finally { db.close(); }
});
test('history pagination and shutdown failures retain the checkpoint; conversation follows original time', async () => {
  const db = openDb(':memory:'); seed(db); const checkpoint = setting(db, 'feishu_history');
  try {
    const loop: HistoryAPI = { chatForMessage: async () => undefined, page: async () => ({ items: [], hasMore: true, token: 'loop' }) };
    await assert.rejects(recoverFeishuHistory(db, loop, 'app', base + 10000), /分页/); assert.equal(setting(db, 'feishu_history'), checkpoint);
    let stopped = false;
    await recoverFeishuHistory(db, { ...loop, page: async () => { stopped = true; return { items: [message('om_skip', '奶茶20', 1000)], hasMore: false }; } }, 'app', base + 10000, () => stopped);
    assert.equal(setting(db, 'feishu_history'), checkpoint); assert.equal(db.prepare('SELECT 1 FROM messages').get(), undefined);
    receiveMessage(db, 'current', 'owner', '改成18', undefined, new Date(base + 5000).toISOString());
    receiveMessage(db, 'older', 'owner', '奶茶20', undefined, new Date(base + 1000).toISOString());
    applyActions(db, 'older', [{ type: 'reply', text: '已记20' }]);
    receiveMessage(db, 'later', 'owner', '未来消息', undefined, new Date(base + 8000).toISOString());
    applyActions(db, 'later', [{ type: 'reply', text: '未来回执' }]);
    assert.deepEqual(conversationInput(db, '改成18', { user: 'owner', messageId: 'current' }).map(x => x.content), ['奶茶20', '已记20', '改成18']);
    receiveMessage(db, 'image', 'owner', '[图片]', undefined, new Date(base + 2000).toISOString());
    db.prepare('INSERT INTO message_images(message_id,image_key) VALUES(?,?)').run('image', 'fixture');
    createImageDraft(db, 'image', { text: '图片文字', transactions: [], summaries: [], excluded: [], duplicate_groups: [], uncertain: false });
    assert.equal(latestImageDraft(db, 'owner', 'current')?.message_id, 'image');
    assert.equal(latestImageDraft(db, 'owner', 'older'), undefined);
  } finally { db.close(); }
});
