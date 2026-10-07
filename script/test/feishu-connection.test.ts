import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WSClient } from '@larksuiteoapi/node-sdk';
import { createBot } from '../src/bot.js';
import { config } from '../src/config.js';
import { openDb, setSetting } from '../src/db.js';

test('Feishu reconnects a stale OPEN socket after sleep and receives the next message once', async () => {
  const original = { ...config }, db = openDb(':memory:');
  Object.assign(config, { channel: 'feishu', appId: 'test-app', appSecret: 'test-secret', feishuEnabled: true });
  setSetting(db, 'owner', 'test-owner');
  let clock = 100000, starts = 0, closes = 0, state = 'connected';
  let dispatcher: { invoke: (event: unknown, options: unknown) => Promise<unknown> };
  const bot = createBot(db, { now: () => clock, socketFactory: params => ({
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
      message: { chat_type: 'p2p', message_type: 'text', message_id: 'after-wake', content: JSON.stringify({ text: '奶茶20' }), create_time: String(clock) },
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
