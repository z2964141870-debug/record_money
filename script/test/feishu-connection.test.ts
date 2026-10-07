import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WSClient, Client } from '@larksuiteoapi/node-sdk';
import { createBot } from '../src/bot.js';
import { config } from '../src/config.js';
import { openDb, setSetting } from '../src/db.js';

test('Feishu reconnects a stale OPEN socket after sleep and receives the next message once', async () => {
  const original = { ...config }, db = openDb(':memory:');
  Object.assign(config, { channel: 'feishu', appId: 'test-app', appSecret: 'test-secret', feishuEnabled: true });
  setSetting(db, 'owner', 'test-owner');
  let clock = 100000, starts = 0, closes = 0, state = 'connected';
  let dispatcher: { invoke: (event: unknown, options: unknown) => Promise<unknown> };
  const bot = createBot(db, { now: () => clock, historyAPI: { chatForMessage: async () => undefined, page: async () => ({ items: [], hasMore: false }) }, watchWake: () => () => {}, socketFactory: params => ({
    async start(options: { eventDispatcher: typeof dispatcher }) { starts++; dispatcher = options.eventDispatcher; params.onReady?.(); },
    close(options?: { force?: boolean }) { if (options) assert.equal(options.force, true); closes++; },
    getConnectionStatus() { return { state }; },
  } as unknown as WSClient) });
  try {
    await bot.start();
    clock += 2000; await bot.tick(); assert.equal(starts, 1);
    clock += 120000; await bot.tick();
    assert.equal(starts, 2); assert.equal(closes, 1); assert.equal(bot.status.state, 'connected');
    const event = { schema: '2.0', header: { event_id: 'event1', event_type: 'im.message.receive_v1' }, event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'test-owner' } },
      message: { chat_type: 'p2p', chat_id: 'private-chat', message_type: 'text', message_id: 'after-wake', content: JSON.stringify({ text: '奶茶20' }), create_time: String(clock) },
    } };
    await dispatcher!.invoke(event, { needCheck: false });
    await dispatcher!.invoke(event, { needCheck: false });
    assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n, 1);
    assert.ok(bot.status.lastReceived);
    db.prepare("UPDATE messages SET status='done'").run();
    state = 'reconnecting'; clock += 2000; await bot.tick();
    assert.equal(bot.status.state, 'reconnecting'); assert.equal(starts, 2);
    state = 'idle'; clock += 30000; await bot.tick(); assert.equal(starts, 3);
    clock += 2000; await bot.tick(); assert.equal(starts, 3);
  } finally { bot.stop(); Object.assign(config, original); db.close(); }
});

test('native wake immediately reconnects, fills the earlier gap and executes queued work in original order', async () => {
  const original = { ...config }, db = openDb(':memory:'), base = Date.parse('2026-10-07T04:00:00Z');
  Object.assign(config, { channel: 'feishu', appId: 'test-app', appSecret: 'fixture', feishuEnabled: true, aiMode: 'fixed' });
  setSetting(db, 'owner', 'test-owner');
  setSetting(db, 'feishu_chat', JSON.stringify({ appId: 'test-app', owner: 'test-owner', chat: 'private' }));
  setSetting(db, 'feishu_history', JSON.stringify({ appId: 'test-app', owner: 'test-owner', until: base }));
  let clock = base + 10000, starts = 0, stoppedWatcher = false, sent = 0, offline = false;
  let wake: () => void, dispatcher: { invoke: (event: unknown, options: unknown) => Promise<unknown> };
  let history: unknown[] = [];
  const raw = (id: string, text: string, time: number) => ({ message_id: id, chat_id: 'private', msg_type: 'text', create_time: String(time),
    sender: { id: 'test-owner', sender_type: 'user' }, body: { content: JSON.stringify({ text }) } });
  const bot = createBot(db, {
    now: () => clock,
    watchWake: callback => { wake = callback; return () => { stoppedWatcher = true; }; },
    feishuClient: { im: { message: { create: async () => { sent++; return { code: 0 }; } } } } as unknown as Client,
    historyAPI: { chatForMessage: async () => undefined, page: async () => { if (offline) throw new Error('network offline'); return { items: history, hasMore: false }; } },
    socketFactory: params => ({
      async start(options: { eventDispatcher: typeof dispatcher }) { starts++; dispatcher = options.eventDispatcher; params.onReady?.(); },
      close() {}, getConnectionStatus() { return { state: 'connected' }; },
    } as unknown as WSClient),
  });
  try {
    await bot.start(); await bot.tick(); assert.equal(starts, 1);
    clock += 3000;
    history = [raw('om_purchase', '支出 20 餐饮 奶茶', clock - 2000)];
    await dispatcher!.invoke({ schema: '2.0', header: { event_id: 'later', event_type: 'im.message.receive_v1' }, event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'test-owner' } }, message: { chat_type: 'p2p', chat_id: 'private', message_type: 'text',
        message_id: 'om_change', create_time: String(clock - 1000), content: JSON.stringify({ text: '修改 #1 金额 18' }) },
    } }, { needCheck: false });
    offline = true; wake!(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 2); assert.equal(bot.status.recovery.state, 'retrying');
    assert.equal(db.prepare('SELECT 1 FROM entries').get(), undefined);
    offline = false; clock += 2000; await bot.tick(); await bot.tick();
    assert.equal((db.prepare('SELECT amount FROM entries').get() as { amount: number }).amount, 1800);
    assert.equal(bot.status.recovery.recovered, 1); assert.equal(sent, 2);
    wake!(); await new Promise(resolve => setImmediate(resolve)); await bot.tick();
    assert.equal((db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n, 1);
    assert.equal(sent, 2);
  } finally { bot.stop(); assert.ok(stoppedWatcher); Object.assign(config, original); db.close(); }
});
