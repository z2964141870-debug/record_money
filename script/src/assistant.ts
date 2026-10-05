import type { DB } from './db.js';
import { type Action, type LedgerAction, parseActions, parseText } from './ai.js';
import { ledgerRevision, pendingDialogue } from './conversation.js';
import { setSetting } from './db.js';
import { cancelEntry, cents, createEntry, getEntry, listEntries, money, refunded, summary, today, updateEntry, type Entry } from './ledger.js';
import { accountOverview, findAccount, saveAccount } from './accounts.js';
export function queueReply(db: DB, user: string, text: string, dedup: string) {
  db.prepare('INSERT OR IGNORE INTO outbox(user_id,text,dedup,created_at) VALUES(?,?,?,?)').run(user, text, dedup, new Date().toISOString());
}
function candidates(db: DB, action: LedgerAction, replyTo?: string | null) {
  if (action.id) return [getEntry(db, action.id)];
  if (replyTo) {
    const linked = db.prepare('SELECT id FROM entries WHERE message_id=? AND cancelled_at IS NULL ORDER BY id DESC').all(replyTo) as { id: number }[];
    if (linked.length) return linked.map(e => getEntry(db, e.id));
  }
  let rows: Entry[] = listEntries(db).slice(0, 200);
  if (action.type === 'refund') rows = rows.filter(e => e.kind === 'expense' && e.amount - refunded(db, e.id) >= cents(action.amount || '0'));
  if (action.target_date) rows = rows.filter(e => e.date === action.target_date);
  if (action.match === '上一笔') return rows.sort((a, b) => b.id - a.id).slice(0, 1);
  if (action.match) rows = rows.filter(e => (e.note + e.merchant + e.category + e.subcategory).toLowerCase().includes(action.match!.toLowerCase()));
  return rows;
}
function applyAction(db: DB, action: Action, message: { id: string; user_id: string; reply_to?: string | null; received_at?: string }, permitId?: number): string {
  if (action.type === 'reply') return action.text;
  if (action.type === 'no_activity') {
    setSetting(db, 'no_activity_date', today(message.received_at ? new Date(message.received_at) : undefined));
    return '已记下今天无需记账提醒，不新增账目；明天仍按设置检查。';
  }
  if (action.type === 'propose') {
    for (const item of action.actions) {
      if (['update', 'cancel', 'refund'].includes(item.type) && !('id' in item && item.id)) throw new Error('待确认方案需明确账目编号');
      if (item.type === 'account_update') {
        if (!item.account) throw new Error('待确认方案需明确账户名称');
        findAccount(db, item.account);
      }
    }
    const now = new Date();
    db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE user_id=? AND resolved_at IS NULL').run(now.toISOString(), message.user_id);
    db.prepare('INSERT INTO dialogue_pending(user_id,message_id,question,actions_json,revision,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(message.user_id, message.id, action.question, JSON.stringify(action.actions), ledgerRevision(db), now.toISOString(), new Date(now.getTime() + 86400000).toISOString());
    return action.question + '\n回复“可以，就这样”确认，或回复“取消这个方案”。';
  }
  if (action.type === 'confirm_pending' || action.type === 'dismiss_pending') {
    const pending = pendingDialogue(db, message.user_id);
    if (!pending) return '当前没有有效的待确认方案，请说明要处理的内容。';
    if (action.type === 'dismiss_pending') {
      db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE id=?').run(new Date().toISOString(), pending.id);
      return '已取消这个方案，账目和账户未修改。';
    }
    if (pending.revision !== ledgerRevision(db)) {
      db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE id=?').run(new Date().toISOString(), pending.id);
      return '方案提出后账本已有变化，请重新说明或核对操作，避免覆盖新记录。';
    }
    const operations = parseActions({ actions: JSON.parse(pending.actions_json) });
    const result = operations.map(a => applyAction(db, a, message)).join('\n\n');
    db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE id=?').run(new Date().toISOString(), pending.id);
    return result;
  }
  if (action.type === 'clarify') return action.question || '请补充金额和用途。';
  if (action.type === 'accounts_query') {
    const s = accountOverview(db, action.platform);
    return `${action.platform ? action.platform + '\n' : ''}已知资产 ${money(s.assets)} 元 · 欠款 ${money(s.debt)} 元 · 净资产 ${money(s.net)} 元\n现金 ${money(s.cash)} 元 · 投资 ${money(s.investment)} 元 · 锁定 ${money(s.locked)} 元\n${s.accounts.map(a => `${a.name}：${a.balance === null ? '待填写' : money(a.balance) + ' 元'}${a.available_date ? ' · 解锁 ' + a.available_date : ''}`).join('\n')}\n${s.unknown} 个账户金额待填写，汇总仅含已知金额。`;
  }
  if (action.type === 'account_create' || action.type === 'account_update') {
    if (!action.account) throw new Error('请提供完整账户名称');
    const before = action.type === 'account_update' ? findAccount(db, action.account) : null;
    if (!before && !action.account_kind) throw new Error('请说明账户是现金、投资、锁定资金还是欠款');
    let balance = before?.balance ?? null;
    if (action.balance !== undefined) {
      if (!/^-?\d+(\.\d{1,2})?$/.test(action.balance)) throw new Error('账户金额最多两位小数');
      const sign = action.balance.startsWith('-') ? -1 : 1;
      const [whole, part = ''] = action.balance.replace(/^-/, '').split('.');
      balance = sign * (Number(whole) * 100 + Number(part.padEnd(2, '0')));
    }
    const a = saveAccount(db, { name: before?.name || action.account, kind: action.account_kind || before?.kind,
      platform: action.platform ?? before?.platform ?? '', balance, available_date: action.available_date !== undefined ? action.available_date : before?.available_date ?? null, note: action.note ?? before?.note ?? '' }, before?.id);
    return `已${before ? '更新' : '创建'}账户 ${a.name} · ${a.balance === null ? '金额待填写' : money(a.balance) + ' 元'}${a.platform ? ' · ' + a.platform : ''}${a.available_date ? ' · 解锁 ' + a.available_date : ''}${a.note ? '\n备注：' + a.note : ''}`;
  }
  if (action.type === 'query') {
    const start = action.start || today().slice(0, 7) + '-01', end = action.end || today();
    let entries = listEntries(db, { start, end, kind: action.query_kind, category: action.category, q: action.match });
    if (action.subcategory) entries = entries.filter(e => e.subcategory === action.subcategory);
    const net = entries.reduce((n, e) => n + (e.kind === 'refund' ? -e.amount : e.kind === 'expense' ? e.amount : 0), 0);
    const income = entries.filter(e => e.kind === 'income').reduce((n, e) => n + e.amount, 0);
    return `${start} 至 ${end}\n收入 ${money(income)} 元 · 净支出 ${money(net)} 元\n${entries.slice(0, 12).map(e => `#${e.id} ${e.date} ${e.merchant || e.note || e.category} ${e.kind === 'income' ? '收入' : e.kind === 'refund' ? '退款' : e.kind === 'transfer' ? '转账' : '支出'} ${money(e.amount)} 元`).join('\n') || '暂无记录'}${entries.length > 12 ? `\n共 ${entries.length} 笔，完整明细可在本机网页查看。` : ''}`;
  }
  const date = action.date || today(message.received_at ? new Date(message.received_at) : undefined);
  if (action.type === 'add') {
    if (!action.kind || !action.amount) throw new Error('请补充金额和收支方向');
    const account = action.account ? findAccount(db, action.account) : null;
    const target = action.to_account ? findAccount(db, action.to_account) : null;
    if (action.kind === 'transfer' && (!account || !target)) throw new Error('转账或还款请提供转出和转入账户');
    const e = createEntry(db, { kind: action.kind, amount: cents(action.amount), date, category: action.category || '待分类', subcategory: action.subcategory || '', merchant: action.merchant || '', note: action.note || '', parent_id: null, account_id: account?.id ?? null, to_account_id: target?.id ?? null }, message.user_id === 'local' ? 'web-chat' : 'feishu', message.id);
    return `已记${e.kind === 'income' ? '收入' : e.kind === 'transfer' ? '转账' : '支出'} ${money(e.amount)} 元 · ${e.category}${e.subcategory ? ' / ' + e.subcategory : ''}${account ? ' · ' + account.name : ''}${target ? ' → ' + target.name : ''} · #${e.id}`;
  }
  const rows = permitId ? [getEntry(db, permitId)] : candidates(db, action, message.reply_to);
  if (rows.length !== 1) {
    if (!rows.length) return '没有找到对应记录，请提供记录编号或更具体的原消费信息。';
    const result = db.prepare('INSERT INTO confirmations(message_id,user_id,action_json,created_at) VALUES(?,?,?,?)').run(message.id, message.user_id, JSON.stringify({ action, candidates: rows.map(e => e.id) }), new Date().toISOString());
    return `请确认要操作哪笔记录（确认单 C${result.lastInsertRowid}）：\n${rows.slice(0, 12).map(e => `#${e.id} ${e.date} ${e.note || e.merchant || e.category} ${money(e.amount)} 元`).join('\n')}\n回复“选择 C${result.lastInsertRowid} #编号”，或到本机网页选择。`;
  }
  const entry = rows[0];
  if (action.type === 'cancel') { cancelEntry(db, entry.id); return `已撤销 #${entry.id}，历史记录已保留。`; }
  if (action.type === 'refund') {
    const e = createEntry(db, { kind: 'refund', amount: cents(action.amount || '0'), date, category: entry.category, subcategory: entry.subcategory, merchant: entry.merchant, note: action.note || '退款到账', parent_id: entry.id, account_id: action.account ? findAccount(db, action.account).id : entry.account_id }, message.user_id === 'local' ? 'web-chat' : 'feishu', message.id);
    return `已记退款 ${money(e.amount)} 元 · #${e.id} → 原支出 #${entry.id}\n原交易净支出 ${money(entry.amount - refunded(db, entry.id))} 元`;
  }
  const updated = updateEntry(db, entry.id, { ...entry, ...(action.account ? { account_id: findAccount(db, action.account).id } : {}), ...(action.to_account ? { to_account_id: findAccount(db, action.to_account).id } : {}), ...(action.amount ? { amount: cents(action.amount) } : {}), ...(action.date ? { date: action.date } : {}), ...(action.category ? { category: action.category } : {}), ...(action.subcategory !== undefined ? { subcategory: action.subcategory } : {}), ...(action.merchant !== undefined ? { merchant: action.merchant } : {}), ...(action.note !== undefined ? { note: action.note } : {}) });
  return `已修改 #${updated.id} · ${money(updated.amount)} 元 · ${updated.category}`;
}
export function resolveConfirmation(db: DB, confirmationId: number, entryId: number, user: string) {
  return db.transaction(() => {
    const record = db.prepare('SELECT * FROM confirmations WHERE id=? AND user_id=? AND resolved_at IS NULL').get(confirmationId, user) as { message_id: string; action_json: string } | undefined;
    if (!record) throw new Error('确认单不存在或已处理');
    const saved = JSON.parse(record.action_json) as { action: Action; candidates: number[] };
    if (!saved.candidates.includes(entryId)) throw new Error('请选择确认单中的候选记录');
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(record.message_id) as { id: string; user_id: string; reply_to: string; received_at: string };
    const result = applyAction(db, saved.action, msg, entryId);
    db.prepare('UPDATE confirmations SET resolved_at=? WHERE id=?').run(new Date().toISOString(), confirmationId);
    return result;
  })();
}
export function applyActions(db: DB, messageId: string, actions: Action[]) {
  return db.transaction(() => {
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as { id: string; user_id: string; reply_to: string; received_at: string; status: string; result: string };
    if (msg.status === 'done') return msg.result;
    const replies = actions.map(a => applyAction(db, a, msg));
    const result = replies.join('\n\n');
    db.prepare("UPDATE messages SET status='done',result=?,error=NULL WHERE id=?").run(result, messageId);
    if (msg.user_id !== 'local') queueReply(db, msg.user_id, result, 'message:' + messageId);
    return result;
  })();
}
export function receiveMessage(db: DB, id: string, user: string, text: string, replyTo?: string, receivedAt = new Date().toISOString()) {
  return db.prepare('INSERT OR IGNORE INTO messages(id,user_id,text,reply_to,received_at) VALUES(?,?,?,?,?)').run(id, user, text, replyTo || null, receivedAt).changes > 0;
}
const processing = new WeakMap<DB, Promise<unknown>>();
export function processMessage(db: DB, id: string): Promise<string> {
  // Serialize model parsing so references to previous entries see committed changes.
  const task = (processing.get(db) || Promise.resolve()).catch(() => {}).then(() => processNextMessage(db, id));
  processing.set(db, task);
  return task;
}
async function processNextMessage(db: DB, id: string) {
  const message = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as { user_id: string; text: string; received_at: string; status: string; result: string };
  if (message.status === 'done') return message.result;
  const normalized = message.text.trim().replace(/[，。！？!?,.\s]/g, '');
  if (['今天没有收支', '今天无收支', '今天不用提醒'].includes(normalized)) return applyActions(db, id, [{ type: 'no_activity' }]);
  if (pendingDialogue(db, message.user_id)) {
    if (/^(可以(的)?(就这样)?|好的?(就这样)?|就这样|确认|确认执行|同意)$/.test(normalized)) return applyActions(db, id, [{ type: 'confirm_pending' }]);
    if (/^(取消(这个方案)?|不用了|不同意|先不执行)$/.test(normalized)) return applyActions(db, id, [{ type: 'dismiss_pending' }]);
  } else if (/^(可以(的)?(就这样)?|好的?(就这样)?|就这样|确认|确认执行|同意)$/.test(normalized)) {
    const latest = db.prepare("SELECT id FROM messages WHERE user_id=? AND status='done' AND rowid<(SELECT rowid FROM messages WHERE id=?) ORDER BY rowid DESC LIMIT 1").get(message.user_id, id) as { id: string } | undefined;
    if (latest && db.prepare('SELECT id FROM dialogue_pending WHERE message_id=? AND user_id=?').get(latest.id, message.user_id)) return applyActions(db, id, [{ type: 'confirm_pending' }]);
  }
  const choice = message.text.match(/^\s*选择\s*C(\d+)\s*#(\d+)\s*$/i);
  if (choice) return db.transaction(() => {
    const result = resolveConfirmation(db, Number(choice[1]), Number(choice[2]), message.user_id);
    db.prepare("UPDATE messages SET status='done',result=? WHERE id=?").run(result, id);
    if (message.user_id !== 'local') queueReply(db, message.user_id, result, 'message:' + id);
    return result;
  })();
  const actions = await parseText(db, message.text, today(new Date(message.received_at)), { user: message.user_id, messageId: id });
  return applyActions(db, id, actions);
}
