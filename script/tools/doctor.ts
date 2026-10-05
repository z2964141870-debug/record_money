import * as lark from '@larksuiteoapi/node-sdk';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseText } from '../src/ai.js';
import { initializeAccounts } from '../src/accounts.js';
import { applyActions, receiveMessage } from '../src/assistant.js';
import { z } from 'zod';
const db = openDb(':memory:');
initializeAccounts(db);
const quiet = { debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {}, trace: (..._args: unknown[]) => {} };
const client = new lark.Client({ appId: config.appId, appSecret: config.appSecret, logger: quiet });
try {
  const result = await client.auth.tenantAccessToken.internal({ data: { app_id: config.appId, app_secret: config.appSecret } });
  console.log('飞书凭证：' + (result.code === 0 ? '有效' : '验证失败，错误码 ' + result.code));
} catch { console.log('飞书凭证：网络请求失败'); }
const examples = process.argv.includes('--query') ? ['我的净资产和锁定资金有多少'] : process.argv.includes('--accounts') ? [
  '微信零钱现在有1000元，支付宝余额有2000元，美团月付还欠300元',
  '从支付宝余额还美团月付100元',
  '新建支付宝7天理财第二批，今天从支付宝余额投进去500元，锁定7天',
  'LGB基金现在市值880元',
  '我的净资产和锁定资金有多少',
] : ['CoCo奶茶20', '收入，妈妈红包30', '早上买了张券12.8'];
for (const [i, text] of examples.entries()) {
  try {
    const actions = await parseText(db, text, '2026-10-05');
    receiveMessage(db, 'doctor:' + i, 'local', text, undefined, '2026-10-05T10:00:00Z');
    const result = applyActions(db, 'doctor:' + i, actions);
    console.log('模型联调：' + JSON.stringify({ input: text, actions, result }));
  }
  catch (error) { console.log('模型联调失败：' + (error instanceof z.ZodError ? JSON.stringify(error.issues) : error instanceof Error && 'status' in error ? 'HTTP ' + String(error.status) : error instanceof Error ? error.name : 'unknown')); }
}
db.close();
