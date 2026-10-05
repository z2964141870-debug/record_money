import * as lark from '@larksuiteoapi/node-sdk';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseText } from '../src/ai.js';
import { initializeAccounts } from '../src/accounts.js';
import { applyActions, receiveMessage, processMessage } from '../src/assistant.js';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { findAccount } from '../src/accounts.js';
const db = openDb(':memory:');
initializeAccounts(db);
const quiet = { debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {}, trace: (..._args: unknown[]) => {} };
const client = new lark.Client({ appId: config.appId, appSecret: config.appSecret, logger: quiet });
try {
  const result = await client.auth.tenantAccessToken.internal({ data: { app_id: config.appId, app_secret: config.appSecret } });
  console.log('飞书凭证：' + (result.code === 0 ? '有效' : '验证失败，错误码 ' + result.code));
} catch { console.log('飞书凭证：网络请求失败'); }
const examples = process.argv.includes('--conversation') ? [
  '京东金融里面有灵活2.85元、稳健2235.58元、进阶3852.22元，累计收益-930.58元，三个金额都是当前市值',
  '累计收益作为京东金融的备注吧',
  '把灵活、稳健、进阶归到京东金融平台，先提出具体方案让我确认，不要马上改',
  '可以的，就这样',
  '现在京东金融这三个账户合计多少，有没有重复扣亏损？',
] : process.argv.includes('--query') ? ['我的净资产和锁定资金有多少'] : process.argv.includes('--accounts') ? [
  '微信零钱现在有1000元，支付宝余额有2000元，美团月付还欠300元',
  '从支付宝余额还美团月付100元',
  '新建支付宝7天理财第二批，今天从支付宝余额投进去500元，锁定7天',
  'LGB基金现在市值880元',
  '我的净资产和锁定资金有多少',
] : ['CoCo奶茶20', '收入，妈妈红包30', '早上买了张券12.8'];
let failures = 0;
for (const [i, text] of examples.entries()) {
  try {
    receiveMessage(db, 'doctor:' + i, 'local', text, undefined, '2026-10-05T10:00:00Z');
    if (process.argv.includes('--conversation')) {
      const result = await processMessage(db, 'doctor:' + i);
      console.log('连续对话联调：' + JSON.stringify({ input: text, result }));
    } else {
      const actions = await parseText(db, text, '2026-10-05');
      const result = applyActions(db, 'doctor:' + i, actions);
      console.log('模型联调：' + JSON.stringify({ input: text, actions, result }));
    }
  }
  catch (error) { failures++; console.log('模型联调失败：' + (error instanceof z.ZodError ? JSON.stringify(error.issues) : error instanceof Error && 'status' in error ? 'HTTP ' + String(error.status) : error instanceof Error ? error.name : 'unknown')); }
}
if (process.argv.includes('--conversation')) {
  assert.equal(failures, 0, '每一轮连续对话均须成功');
  const accounts = ['灵活', '稳健', '进阶'].map(name => findAccount(db, name));
  assert.equal(accounts.reduce((sum, a) => sum + (a.balance || 0), 0), 609065);
  assert.ok(accounts.every(a => a.platform === '京东金融' && a.note.includes('-930.58')));
  console.log('连续对话核验：三账户总额6090.65元，收益备注保留，无重复扣减。');
}
db.close();
if (failures) process.exitCode = 1;
