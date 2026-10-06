import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeDingMessage, createDingTalkTransport, DingTalkImageError } from '../src/dingtalk.js';
import { checkConnections } from '../src/connection-check.js';
import { saveSetupConfig } from '../src/config-files.js';
import dotenv from 'dotenv';
import { openDb, setting, setSetting } from '../src/db.js';
import { acceptDingMessage } from '../src/bot.js';
test('DingTalk accepts only private supported messages, preserves time and namespacing and rejects malformed fields', () => {
  const base = { conversationType: '1', senderStaffId: 'staff1', msgId: 'message1', createAt: 1791244800000, msgtype: 'text', text: { content: '奶茶20' } };
  assert.deepEqual(decodeDingMessage(base), { id: 'dingtalk:message1', user: 'dingtalk:staff1', text: '奶茶20', imageKey: undefined, time: new Date(base.createAt).toISOString() });
  assert.equal(decodeDingMessage({ ...base, conversationType: '2' }), null);
  assert.equal(decodeDingMessage({ ...base, msgtype: 'audio' }), null);
  assert.equal(decodeDingMessage({ ...base, senderStaffId: '' }), null);
  assert.equal(decodeDingMessage({ ...base, text: { content: 42 } }), null);
  assert.equal(decodeDingMessage({ ...base, text: { content: 'x'.repeat(4001) } }), null);
  assert.equal(decodeDingMessage({ ...base, msgtype: 'picture', content: { downloadCode: 'image-code' } })?.imageKey, 'image-code');
});
test('DingTalk APIs cache token, send proactive text and uploaded chart image, download images and hide provider errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-ding-')), calls: { url: string; body?: unknown; auth?: string | null }[] = [];
  const respond = (raw: unknown, status = 200) => new Response(JSON.stringify(raw), { status, headers: { 'Content-Type': 'application/json' } });
  const transport = createDingTalkTransport({ appId: 'dingtest', appSecret: 'test-secret' }, async (input, init) => {
    const url = String(input); calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, auth: new Headers(init?.headers).get('x-acs-dingtalk-access-token') });
    if (url.endsWith('accessToken')) return respond({ accessToken: 'test-access-token', expireIn: 7200 });
    if (url.includes('batchSend')) return respond({ processQueryKey: 'sent' });
    if (url.includes('media/upload')) { assert.ok(init?.body instanceof FormData); return respond({ errcode: 0, media_id: '@media' }); }
    if (url.includes('messageFiles/download')) return respond({ downloadUrl: 'https://image.dingtalk.com/test.png' });
    return new Response(Buffer.from('test-image'));
  });
  try {
    await transport.send('dingtalk:staff1', '今天还没有记账');
    const path = join(dir, 'chart.png'); writeFileSync(path, 'test-chart');
    const image = await transport.upload(path); await transport.send('dingtalk:staff1', '', image);
    assert.equal((await transport.download('code')).toString(), 'test-image');
    assert.equal(calls.filter(c => c.url.endsWith('accessToken')).length, 1);
    const sent = calls.filter(c => c.url.includes('batchSend')).map(c => c.body) as { userIds: string[]; msgKey: string; msgParam: string }[];
    assert.deepEqual(sent[0].userIds, ['staff1']); assert.equal(JSON.parse(sent[0].msgParam).content, '今天还没有记账'); assert.equal(JSON.parse(sent[1].msgParam).photoURL, '@media');
    assert.ok(calls.filter(c => new URL(c.url).hostname === 'api.dingtalk.com' && !c.url.endsWith('accessToken')).every(c => c.auth === 'test-access-token'));
    await assert.rejects(transport.send('feishu-user', 'hi'), /绑定用户/);
    const bad = createDingTalkTransport({ appId: 'dingtest', appSecret: 'test-secret' }, async () => respond({ message: 'test-secret' }, 403));
    await assert.rejects(bad.send('dingtalk:staff1', 'hi'), error => error instanceof Error && !error.message.includes('test-secret'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('DingTalk setup stores channel-specific credentials and connection check never contacts Feishu', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-ding-config-'));
  const value = { channel: 'dingtalk', appId: 'dingtest', appSecret: 'test-secret', aiBaseUrl: 'https://model.example/v1', aiKey: 'test-key', model: 'vision', reasoning: 'none' };
  try {
    saveSetupConfig(dir, join(dir, 'storage'), value);
    const env = dotenv.parse(readFileSync(join(dir, 'storage/data/config.env')));
    assert.equal(env.CHAT_CHANNEL, 'dingtalk'); assert.equal(env.DINGTALK_CLIENT_ID, value.appId); assert.equal(env.FEISHU_APP_ID, undefined);
    const results = await checkConnections(value, { fetch: async (url) => {
      assert.ok(!String(url).includes('feishu'));
      return new Response(JSON.stringify(String(url).includes('dingtalk') ? { accessToken: 'private-access-token' } : {}));
    } });
    assert.equal(results[0].service, 'dingtalk'); assert.equal(results[0].ok, true); assert.ok(!JSON.stringify(results).includes('private-access-token'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('DingTalk image permissions stop automatic retries, temporary failures retry and download hosts are restricted', async () => {
  for (const status of [403, 429, 503]) {
    const t = createDingTalkTransport({ appId: 'dingtest', appSecret: 'test-secret' }, async url => new Response(JSON.stringify(String(url).endsWith('accessToken') ? { accessToken: 'token' } : { message: 'private-provider-error' }), { status: String(url).endsWith('accessToken') ? 200 : status }));
    await assert.rejects(t.download('code'), e => e instanceof DingTalkImageError && e.retryable === (status !== 403) && !e.message.includes('private-provider-error'));
  }
  const t = createDingTalkTransport({ appId: 'dingtest', appSecret: 'test-secret' }, async url => {
    assert.ok(String(url).includes('api.dingtalk.com'));
    return new Response(JSON.stringify(String(url).endsWith('accessToken') ? { accessToken: 'token' } : { downloadUrl: 'https://private.example/data' }));
  });
  await assert.rejects(t.download('code'), e => e instanceof DingTalkImageError && !e.retryable);
});
test('DingTalk discovery never books the first message, accepts only the bound owner and deduplicates image delivery', () => {
  const db = openDb(':memory:');
  try {
    const message = { id: 'dingtalk:message', user: 'dingtalk:staff1', text: '[用户发送图片]', imageKey: 'download-code' };
    assert.equal(acceptDingMessage(db, message), false); assert.equal(setting(db, 'pending_user'), message.user);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 0);
    setSetting(db, 'owner', message.user);
    assert.equal(acceptDingMessage(db, { ...message, user: 'dingtalk:other' }), false);
    assert.ok(acceptDingMessage(db, message)); assert.ok(!acceptDingMessage(db, message));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM message_images').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
