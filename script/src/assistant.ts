import type { DB } from './db.js';
import { type Action, type LedgerAction, parseOperations, parseText } from './ai.js';
import { ledgerRevision, pendingDialogue } from './conversation.js';
import { setSetting } from './db.js';
import { cancelEntry, cents, createEntry, getEntry, listEntries, money, refunded, summary, today, updateEntry, type Entry } from './ledger.js';
import { accountOverview, findAccount, saveAccount } from './accounts.js';
import { domainSchema, applyDomain, type DomainAction } from './domain-actions.js';
import { findPossession } from './possessions.js';
import { analyzeLedgerImage } from './images.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createImageDraft, latestImageDraft, reviewImageDraft, renderImageDraft, imageAlreadyImported } from './image-ledger.js';
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
  if (action.type === 'image_review') {
    const draft = latestImageDraft(db, message.user_id, message.id);
    if (!draft) return '没有可核对的图片清单，请先发送图片。';
    const reviewed = reviewImageDraft(db, draft, action);
    if (action.request !== 'text') db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE user_id=? AND source_image_id=? AND resolved_at IS NULL').run(new Date().toISOString(), message.user_id, draft.message_id);
    return reviewed.proposal ? applyAction(db, reviewed.proposal, message) : reviewed.text;
  }
  const domain = domainSchema.safeParse(action);
  if (domain.success) return applyDomain(db,domain.data,message);
  return applyLedgerAction(db,action as Exclude<Action,DomainAction|{type:'reply';text:string}|{type:'image_review'}>,message,permitId);
}
function applyLedgerAction(db: DB, action: Exclude<Action,DomainAction|{type:'reply';text:string}|{type:'image_review'}>, message: { id: string; user_id: string; reply_to?: string | null; received_at?: string }, permitId?: number): string {
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
      if (item.type === 'possession_update') {
        findPossession(db,item.name);
      }
      if (['loan_update','loan_draw','loan_repay','loan_installment'].includes(item.type) && 'name' in item && item.name) findAccount(db,item.name);
    }
    const now = new Date();
    db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE user_id=? AND resolved_at IS NULL').run(now.toISOString(), message.user_id);
    db.prepare('INSERT INTO dialogue_pending(user_id,message_id,question,actions_json,revision,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(message.user_id, message.id, action.question, JSON.stringify(action.actions), ledgerRevision(db), now.toISOString(), new Date(now.getTime() + 86400000).toISOString());
    if(action.sourceImageId)db.prepare('UPDATE dialogue_pending SET source_image_id=? WHERE id=last_insert_rowid()').run(action.sourceImageId);
    return action.question + (action.sourceImageId ? '\n回复“确认入账”确认，或回复“取消这个方案”。' : '\n回复“可以，就这样”确认，或回复“取消这个方案”。');
  }
  if (action.type === 'confirm_pending' || action.type === 'dismiss_pending') {
    const pending = pendingDialogue(db, message.user_id);
    if (!pending) return '当前没有有效的待确认方案，请说明要处理的内容。';
    if (action.type === 'dismiss_pending') {
      db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE id=?').run(new Date().toISOString(), pending.id);
      if(pending.source_image_id)db.prepare("UPDATE image_drafts SET status='cancelled',updated_at=? WHERE message_id=?").run(new Date().toISOString(),pending.source_image_id);
      return '已取消这个方案，账目和账户未修改。';
    }
    if (pending.revision !== ledgerRevision(db)) {
      db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE id=?').run(new Date().toISOString(), pending.id);
      return '方案提出后账本已有变化，请重新说明或核对操作，避免覆盖新记录。';
    }
    if (pending.source_image_id) {
      if (imageAlreadyImported(db,pending.source_image_id)) return '这张图片已有确认入账记录，请核对原记录，不再次入账。';
      if (!db.prepare('SELECT 1 FROM image_drafts WHERE message_id=?').get(pending.source_image_id)) return '这张图片是旧版文字清单，请重新发送原图进行结构化核对，尚未入账。';
      const current = db.prepare('SELECT text FROM messages WHERE id=?').get(message.id) as { text: string };
      if (!/^(确认(?:入账|执行)?|可以(?:的)?(?:就这样)?|好的?(?:就这样)?|就这样|同意)$/.test(current.text.trim().replace(/[，。！？!?,.\s]/g,''))) return '图片方案仍待确认，请核对后明确回复“确认入账”。';
    }
    const operations = parseOperations(JSON.parse(pending.actions_json));
    const result = operations.map(a => applyAction(db, a, message)).join('\n\n');
    db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE id=?').run(new Date().toISOString(), pending.id);
    if(pending.source_image_id)db.prepare('INSERT INTO image_imports(message_id,imported_at) VALUES(?,?)').run(pending.source_image_id,new Date().toISOString());
    if(pending.source_image_id)db.prepare("UPDATE image_drafts SET status='imported',updated_at=? WHERE message_id=?").run(new Date().toISOString(),pending.source_image_id);
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
  const source = message.user_id === 'local' ? 'web-chat' : message.user_id.startsWith('dingtalk:') ? 'dingtalk' : 'feishu';
  if (action.type === 'add') {
    if (!action.kind || !action.amount) throw new Error('请补充金额和收支方向');
    const account = action.account ? findAccount(db, action.account) : null;
    const target = action.to_account ? findAccount(db, action.to_account) : null;
    if (action.kind === 'transfer' && (!account || !target)) throw new Error('转账或还款请提供转出和转入账户');
    const e = createEntry(db, { kind: action.kind, amount: cents(action.amount), date, category: action.category || '待分类', subcategory: action.subcategory || '', merchant: action.merchant || '', note: action.note || '', parent_id: null, account_id: account?.id ?? null, to_account_id: target?.id ?? null }, source, message.id);
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
    const e = createEntry(db, { kind: 'refund', amount: cents(action.amount || '0'), date, category: entry.category, subcategory: entry.subcategory, merchant: entry.merchant, note: action.note || '退款到账', parent_id: entry.id, account_id: action.account ? findAccount(db, action.account).id : entry.account_id }, source, message.id);
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
  const image = db.prepare('SELECT path,extracted_text,content_hash FROM message_images WHERE message_id=?').get(id) as { path: string | null; extracted_text: string | null; content_hash:string|null } | undefined;
  if(image) {
    if(!image.path)throw new Error('图片尚未下载，请核对飞书图片资源权限');
    if (!image.content_hash) db.prepare('UPDATE message_images SET content_hash=? WHERE message_id=?').run(createHash('sha256').update(readFileSync(image.path)).digest('hex'),id);
    if (imageAlreadyImported(db,id)) return applyActions(db,id,[{type:'reply',text:'这张图片已有确认入账记录，不再次导入。'}]);
    let saved = db.prepare('SELECT analysis_json,review_json,status FROM image_drafts WHERE message_id=?').get(id) as {analysis_json:string;review_json:string;status:string}|undefined;
    if (!saved) {
      const analysis = await analyzeLedgerImage(db,image.path);
      db.transaction(()=>{
        db.prepare('UPDATE message_images SET extracted_text=? WHERE message_id=?').run(analysis.text,id);
        createImageDraft(db,id,analysis);
        db.prepare('UPDATE dialogue_pending SET resolved_at=? WHERE user_id=? AND resolved_at IS NULL').run(new Date().toISOString(),message.user_id);
      })();
      saved = db.prepare('SELECT analysis_json,review_json,status FROM image_drafts WHERE message_id=?').get(id) as typeof saved;
    }
    const draft = {message_id:id,analysis:JSON.parse(saved!.analysis_json),rows:JSON.parse(saved!.review_json),status:saved!.status};
    const reviewed = reviewImageDraft(db,draft,{type:'image_review',request:'preview'});
    return applyActions(db,id,[reviewed.proposal||{type:'reply',text:reviewed.text}]);
  }
  const normalized = message.text.trim().replace(/[，。！？!?,.\s]/g, '');
  if (['今天没有收支', '今天无收支', '今天不用提醒'].includes(normalized)) return applyActions(db, id, [{ type: 'no_activity' }]);
  if (pendingDialogue(db, message.user_id)) {
    if (/^(可以(的)?(就这样)?|好的?(就这样)?|就这样|确认|确认入账|确认执行|同意)$/.test(normalized)) return applyActions(db, id, [{ type: 'confirm_pending' }]);
    if (/^(取消(这个方案)?|不用了|不同意|先不执行)$/.test(normalized)) return applyActions(db, id, [{ type: 'dismiss_pending' }]);
  } else if (/^(可以(的)?(就这样)?|好的?(就这样)?|就这样|确认|确认执行|同意)$/.test(normalized)) {
    const latest = db.prepare("SELECT id FROM messages WHERE user_id=? AND status='done' AND rowid<(SELECT rowid FROM messages WHERE id=?) ORDER BY rowid DESC LIMIT 1").get(message.user_id, id) as { id: string } | undefined;
    if (latest && db.prepare('SELECT id FROM dialogue_pending WHERE message_id=? AND user_id=?').get(latest.id, message.user_id)) return applyActions(db, id, [{ type: 'confirm_pending' }]);
  }
  const draft = latestImageDraft(db,message.user_id,id);
  if(draft&&/^(确认|确认入账|确认执行|记进去|把这张图片记到账本|入账)$/.test(normalized))return applyActions(db,id,[{type:'image_review',request:'preview'}]);
  if(draft&&/^(显示图片清单|图片清单|核对图片)$/.test(normalized))return applyActions(db,id,[{type:'image_review',request:'preview'}]);
  if(draft&&/^(只看图片文字|只提取文字|提取文字)$/.test(normalized))return applyActions(db,id,[{type:'image_review',request:'text'}]);
  if(draft&&/^(取消这个方案|取消图片|取消入账)$/.test(normalized))return applyActions(db,id,[{type:'image_review',request:'cancel'}]);
  const choice = message.text.match(/^\s*选择\s*C(\d+)\s*#(\d+)\s*$/i);
  if (choice) return db.transaction(() => {
    const result = resolveConfirmation(db, Number(choice[1]), Number(choice[2]), message.user_id);
    db.prepare("UPDATE messages SET status='done',result=? WHERE id=?").run(result, id);
    if (message.user_id !== 'local') queueReply(db, message.user_id, result, 'message:' + id);
    return result;
  })();
  const actions = await parseText(db, message.text, today(new Date(message.received_at)), { user: message.user_id, messageId: id });
  return applyActions(db, id, protectImageActions(db,id,message.user_id,message.text,actions));
}
export function protectImageActions(db:DB,id:string,user:string,text:string,actions:Action[]):Action[] {
  if (actions.some(a=>a.type==='image_review')) {
    if(actions.length!==1)return [{type:'reply',text:'图片核对和其他操作请分别发送，尚未修改账本。'}];
    return actions;
  }
  const activeDraft=latestImageDraft(db,user,id);
  if(activeDraft&&activeDraft.rows.some(r=>r.decision!=='skip')&&['reviewing','proposed'].includes(activeDraft.status)&&actions.some(a=>['add','refund'].includes(a.type)||(a.type==='propose'&&a.actions.some(p=>['add','refund'].includes(p.type))))) {
    return [{type:'reply',text:renderImageDraft(db,activeDraft)+'\n当前有图片清单待核对，请先补充或取消图片方案；本次未新增账目。'}];
  }
  if(!/图片|截图|这张|上图|图里|图中|^(?:帮我|请)?(?:记一下|记进去|记下来|入账|保存到账本)/.test(text))return actions;
  const source=db.prepare(`SELECT i.message_id FROM message_images i JOIN messages m ON m.id=i.message_id
    WHERE m.user_id=? AND m.rowid<(SELECT rowid FROM messages WHERE id=?) ORDER BY m.rowid DESC LIMIT 1`).get(user,id) as {message_id:string}|undefined;
  if(!source)return actions;
  const mutations=new Set(['add','refund','update','cancel','account_create','account_update','possession_create','possession_update','loan_create','loan_update','loan_draw','loan_repay','loan_installment']);
  const writes=actions.some(a=>mutations.has(a.type)||(a.type==='propose'&&a.actions.some(p=>mutations.has(p.type))));
  if(!writes)return actions;
  const draft=latestImageDraft(db,user,id);
  if(draft&&(draft.status==='imported'||imageAlreadyImported(db,draft.message_id)))return [{type:'reply',text:'这张图片已有确认入账记录，不再次入账；可查询或修改原记录。'}];
  if(draft?.status==='cancelled')return [{type:'reply',text:'这张图片的清单已取消，请重新发送原图以重新核对。'}];
  if(draft)return [{type:'reply',text:renderImageDraft(db,draft)+'\n请补充或修正清单信息，再核对最终方案；不会直接执行模型生成的图片财务操作。'}];
  return [{type:'reply',text:'这张图片只有旧版文字提取结果，请重新发送原图，生成结构化交易清单后再核对入账。'}];
}
