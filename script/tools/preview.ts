import { openDb, setSetting, setting } from '../src/db.js';
import { createEntry, today } from '../src/ledger.js';
import { config, root, dataDir } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { initializeAccounts, listAccounts, saveAccount } from '../src/accounts.js';
import { resolve, join } from 'node:path';
if (config.feishuEnabled || resolve(dataDir) !== resolve(join(root, 'data', 'qa'))) throw new Error('验收预览必须禁用飞书并使用项目 data/qa 隔离目录');
const db = openDb();
initializeAccounts(db);
if (!setting(db, 'preview_accounts')) {
  const amounts: Record<string, number> = { '微信零钱': 328050, '支付宝余额': 562070, '抖音月付': 65000, '美团月付': 23000, '京东小金库': 1080000, 'LGB基金': 250000, '7天锁定理财': 500000, '1个月锁定理财': 800000 };
  for (const a of listAccounts(db)) saveAccount(db, { ...a, balance: amounts[a.name] ?? null, ...(a.kind === 'locked' ? { platform: '支付宝', available_date: a.name.startsWith('7') ? '2026-10-12' : '2026-11-05' } : {}) }, a.id);
  setSetting(db, 'preview_accounts', 'true');
}
if ((db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n === 0) {
  const date = today();
  const sample = [
    ['expense', 2000, '餐饮', '饮料', 'CoCo', '奶茶'], ['income', 3000, '红包', '家人红包', '妈妈', '妈妈红包'],
    ['expense', 1280, '待分类', '', '', '早餐券'], ['expense', 4500, '餐饮', '正餐', '午餐', ''],
    ['expense', 1600, '交通', '地铁', '地铁', ''], ['expense', 7900, '购物', '日用品', '超市', '生活用品'],
  ];
  const entries = sample.map(([kind, amount, category, subcategory, merchant, note]) => createEntry(db, { kind, amount, date, category, subcategory, merchant, note, parent_id: null }, 'demo'));
  createEntry(db, { kind: 'refund', amount: 1280, date, category: '待分类', parent_id: entries[2].id, note: '券退款' }, 'demo');
}
const { app } = await buildServer(db);
await app.listen({ host: '127.0.0.1', port: config.port });
process.on('SIGINT', async () => { await app.close(); process.exit(0); });
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
