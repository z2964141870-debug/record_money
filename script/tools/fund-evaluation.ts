import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { config, root } from '../src/config.js';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/accounts.js';
import { saveFund, saveManualNav, fundOverview } from '../src/funds.js';
import { parseText } from '../src/ai.js';
import { receiveMessage, applyActions } from '../src/assistant.js';
const index = process.argv.indexOf('--config');
if (index < 0) throw new Error('需要 --config 指定模型配置；仅使用虚构内存账本');
const saved = dotenv.parse(readFileSync(resolve(process.argv[index + 1])));
Object.assign(config, { aiKey: saved.AI_API_KEY, aiBaseUrl: saved.AI_BASE_URL, model: saved.AI_MODEL, reasoning: saved.AI_REASONING || 'none', apiType: saved.AI_API_TYPE || 'responses', aiMode: 'ai' });
const samples = [
  { name: '金额不能推份额', text: '今天买了有色金属基金20元，现在收益是多少？', expected: 'clarify' },
  { name: '收益由程序算', text: '查一下支付宝的基金000001持有收益和累计收益', expected: 'funds_query' },
  { name: '确认份额申购', text: '今天基金000001在支付宝确认申购16份，总扣款20元含手续费0.03元，从支付宝余额扣的，净值归属日2026-10-08', expected: 'fund_trade' },
  { name: '未确认交易', text: '我刚申请买入基金000001，扣了20元，但还没有确认份额，帮我记一下', expected: 'clarify' },
];
const results = [];
for (const sample of samples) {
  const db = openDb(':memory:');
  try {
    saveAccount(db, { name: '支付宝余额', platform: '支付宝', kind: 'cash', balance: 500000 });
    saveFund(db, { code: '000001', name: '验收基金', platform: '支付宝', shares: '100', cost: 10000, date: '2026-09-01' });
    saveManualNav(db, '000001', { date: '2026-09-30', nav: '1.2' });
    receiveMessage(db, 'eval', 'local', sample.text, undefined, '2026-10-08T04:00:00Z');
    const started = Date.now(), actions = await parseText(db, sample.text, '2026-10-08', { user: 'local', messageId: 'eval' });
    assert.equal(actions.length, 1); assert.equal(actions[0].type, sample.expected);
    const reply = applyActions(db, 'eval', actions);
    if (sample.expected === 'funds_query') assert.match(reply, /20.00元/);
    if (sample.expected === 'fund_trade') { assert.equal(fundOverview(db).funds[0].shares, 1160000); assert.equal(fundOverview(db).funds[0].cost, 12000); }
    else assert.equal(fundOverview(db).funds[0].shares, 1000000);
    results.push({ name: sample.name, passed: true, ms: Date.now() - started, actions, reply });
    console.log(JSON.stringify({ name: sample.name, passed: true, ms: results.at(-1)!.ms }));
  } finally { db.close(); }
}
const directory = join(root, 'data/qa/funds-v070'); mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(join(directory, 'model-evaluation.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
