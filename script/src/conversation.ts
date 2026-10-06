import type { DB } from './db.js';
export type PendingDialogue = { id: number; question: string; actions_json: string; revision: string; expires_at: string; source_image_id:string|null };
export function pendingDialogue(db: DB, user: string, now = new Date()) {
  return db.prepare('SELECT * FROM dialogue_pending WHERE user_id=? AND resolved_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1').get(user, now.toISOString()) as PendingDialogue | undefined;
}
export function ledgerRevision(db: DB) {
  return JSON.stringify(db.prepare(`SELECT (SELECT COALESCE(MAX(id),0) FROM audit) AS ledger,
    (SELECT COALESCE(MAX(id),0) FROM account_audit) AS accounts,
    (SELECT COALESCE(MAX(id),0) FROM inventory_audit) AS inventory,
    (SELECT COALESCE(MAX(id),0) FROM loan_events) AS loans`).get());
}
export function conversationInput(db: DB, text: string, context?: { user: string; messageId: string }) {
  const input: { role: 'user' | 'assistant'; content: string }[] = [];
  if (context) {
    const rows = db.prepare(`SELECT text,result,received_at FROM messages WHERE user_id=? AND status='done' AND result IS NOT NULL
      AND rowid < (SELECT rowid FROM messages WHERE id=?) ORDER BY rowid DESC LIMIT 8`).all(context.user, context.messageId) as { text: string; result: string; received_at: string }[];
    for (const row of rows.reverse()) {
      input.push({ role: 'user', content: row.text });
      if (row.result.length <= 6000) input.push({ role: 'assistant', content: row.result });
      else input.push({ role:'assistant',content:'较长回执未附带；图片与待确认详情见系统中的结构化清单。' });
    }
    const current = db.prepare('SELECT received_at FROM messages WHERE id=?').get(context.messageId) as { received_at: string };
    const proactive = db.prepare(`SELECT text FROM outbox WHERE user_id=? AND status='sent' AND created_at>? AND created_at<=?
      AND (dedup LIKE 'reminder:%' OR dedup LIKE 'report:%') ORDER BY created_at DESC LIMIT 3`).all(context.user, rows.at(-1)?.received_at || '1970-01-01', current.received_at) as { text: string }[];
    for (const message of proactive.reverse()) if(message.text.length<=6000)input.push({ role: 'assistant', content: message.text });
  }
  input.push({ role: 'user', content: text });
  return input;
}
