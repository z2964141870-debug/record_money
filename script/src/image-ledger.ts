import { z } from 'zod';
import type { DB } from './db.js';
import type { Action } from './ai.js';
import { cents, dateSchema, getEntry, money, refunded, today } from './ledger.js';
import { findAccount } from './accounts.js';

const amount = z.string().regex(/^\d+(?:\.\d{1,2})?$/).refine(v => Number(v) <= 1_000_000_000);
const rowIndex = z.preprocess(v => typeof v==='string'&&/^R?[1-9]\d?$/i.test(v) ? Number(v.replace(/^R/i,'')) : v,z.number().int().min(1).max(50));
export const imageAnalysisSchema = z.object({
  text: z.string().max(16000),
  transactions: z.array(z.object({
    merchant: z.string().max(100), amount: amount.nullable(),
    kind: z.enum(['expense', 'income', 'refund', 'transfer', 'unknown']),
    date: dateSchema.nullable(), month_day: z.string().regex(/^\d{2}-\d{2}$/).nullable(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
    category: z.string().max(30), subcategory: z.string().max(30),
    account: z.string().max(100).nullable(), to_account: z.string().max(100).nullable(),
    currency: z.enum(['CNY', 'other', 'unknown']), external_id: z.string().max(100).nullable(),
    uncertainties: z.array(z.string().max(200)).max(10),
  })).max(50),
  summaries: z.array(z.object({ label: z.string().max(100), amount: z.string().max(100).nullable() })).max(20),
  excluded: z.array(z.string().max(300)).max(30),
  duplicate_groups: z.array(z.array(rowIndex).min(2).max(50)).max(30),
  uncertain: z.boolean(),
});
export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;
export const imageReviewSchema = z.object({
  type: z.literal('image_review'), request: z.enum(['preview', 'cancel', 'text']).default('preview'),
  year: z.number().int().min(1900).max(2100).optional(), account: z.string().min(1).max(100).optional(),
  rows: z.array(z.object({
    row: rowIndex, decision: z.enum(['keep', 'skip']).optional(),
    date: dateSchema.optional(), amount: amount.optional(), kind: z.enum(['expense', 'income', 'refund', 'transfer']).optional(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
    merchant: z.string().max(100).optional(), category: z.string().min(1).max(30).optional(), subcategory: z.string().max(30).optional(),
    account: z.string().min(1).max(100).optional(), to_account: z.string().min(1).max(100).optional(),
    parent_id: z.number().int().positive().optional(), acknowledge: z.boolean().optional(),
  })).max(50).optional(),
});
export type ImageReviewAction = z.infer<typeof imageReviewSchema>;
type Row = ImageAnalysis['transactions'][number] & { row: number; decision: 'keep' | 'skip' | null; acknowledged: boolean; parent_id?: number };
export type ImageDraft = { message_id: string; analysis: ImageAnalysis; rows: Row[]; status: string };

export function imageAlreadyImported(db: DB, id: string) {
  return !!db.prepare(`SELECT 1 FROM image_imports p JOIN message_images old ON old.message_id=p.message_id
    JOIN message_images current ON current.message_id=?
    WHERE p.message_id=? OR (current.content_hash IS NOT NULL AND old.content_hash=current.content_hash) LIMIT 1`).get(id, id);
}
export function latestImageDraft(db: DB, user: string, beforeId: string) {
  const message = db.prepare('SELECT reply_to FROM messages WHERE id=?').get(beforeId) as { reply_to: string | null } | undefined;
  const read = (id?: string | null) => db.prepare(`SELECT d.* FROM image_drafts d JOIN messages m ON m.id=d.message_id
    JOIN messages current ON current.id=? WHERE m.user_id=? AND
    (m.received_at<current.received_at OR (m.received_at=current.received_at AND m.rowid<current.rowid)) ${id ? 'AND d.message_id=?' : ''}
    ORDER BY m.received_at DESC,m.rowid DESC LIMIT 1`).get(...(id ? [beforeId, user, id] : [beforeId, user])) as { message_id: string; analysis_json: string; review_json: string; status: string } | undefined;
  const record = (message?.reply_to && read(message.reply_to)) || read();
  return record ? { message_id: record.message_id, analysis: imageAnalysisSchema.parse(JSON.parse(record.analysis_json)), rows: JSON.parse(record.review_json) as Row[], status: record.status } : undefined;
}
export function createImageDraft(db: DB, id: string, raw: unknown): ImageDraft {
  const analysis = imageAnalysisSchema.parse(raw), duplicate = new Set(analysis.duplicate_groups.flat());
  const groups = new Map<string, number[]>();
  analysis.transactions.forEach((row, index) => {
    const key = JSON.stringify([row.merchant, row.amount, row.kind, row.date || row.month_day, row.time]);
    groups.set(key, [...(groups.get(key) || []), index + 1]);
  });
  for (const group of groups.values()) if (group.length > 1) group.forEach(row => duplicate.add(row));
  const rows: Row[] = analysis.transactions.map((row, index) => ({ ...row, row: index + 1, decision: duplicate.has(index + 1) ? null : 'keep', acknowledged: false }));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO image_drafts(message_id,analysis_json,review_json,status,updated_at) VALUES(?,?,?,?,?)').run(id, JSON.stringify(analysis), JSON.stringify(rows), 'reviewing', now);
  return { message_id: id, analysis, rows, status: 'reviewing' };
}
function issues(db: DB, draft: ImageDraft) {
  const result: { row: number; text: string }[] = [];
  const refundTotals = new Map<number, number>();
  for (const row of draft.rows.filter(r => r.decision !== 'skip')) {
    const warn = (text:string) => result.push({row:row.row,text});
    if (!row.decision) warn('疑似重复，请明确保留或跳过');
    if (!row.amount || Number(row.amount) <= 0) warn('金额待补全');
    if (row.kind === 'unknown') warn('收支方向待确认');
    if (row.currency !== 'CNY') warn('仅支持人民币，请核对币种后单独记录或跳过');
    if (!row.date) warn(row.month_day ? '年份待补全' : '交易日期待补全');
    else if (row.date > today()) warn('日期在未来，请核对');
    if (!row.account) warn('付款或收款账户待补全');
    else { try { findAccount(db, row.account); } catch { warn(`账户“${row.account}”不存在，请先创建或选择已有账户`); } }
    if (row.uncertainties.length && !row.acknowledged) warn(row.uncertainties.join('；') + '，请核对后明确保留或修正');
    if (row.kind === 'transfer') {
      if (!row.to_account) warn('转入账户待补全');
      else { try { findAccount(db, row.to_account); } catch { warn('转入账户不存在'); } }
      if (row.account && row.account === row.to_account) warn('转出和转入账户不能相同');
    }
    if (row.kind === 'refund') {
      if (!row.parent_id) warn('退款需明确关联原支出编号');
      else { try {
        const parent = getEntry(db, row.parent_id);
        const total = (refundTotals.get(parent.id) || 0) + (row.amount && Number(row.amount)>0 ? cents(row.amount) : 0);
        refundTotals.set(parent.id,total);
        if (parent.kind !== 'expense' || (row.date && row.date < parent.date) || refunded(db, parent.id) + total > parent.amount) warn('原支出与退款日期或累计金额不匹配');
      } catch { warn('关联原支出不存在或已撤销'); } }
    }
    if (row.date && row.amount && Number(row.amount)>0 && !row.acknowledged) {
      const existing = db.prepare('SELECT id FROM entries WHERE cancelled_at IS NULL AND kind=? AND merchant=? AND amount=? AND date=? LIMIT 1').get(row.kind, row.merchant, cents(row.amount), row.date) as { id: number } | undefined;
      if (existing) warn(`与已有记录#${existing.id}相似，请明确保留或跳过`);
    }
  }
  return result;
}
const labels = { expense: '支出', income: '收入', refund: '退款', transfer: '转账', unknown: '方向待核对' };
export function renderImageDraft(db: DB, draft: ImageDraft) {
  if (!draft.rows.length) return `图片识别文字：\n${draft.analysis.text || '没有可读文字'}\n\n未识别到完整交易，尚未修改账本。`;
  const totals = { expense: 0, income: 0, refund: 0, transfer: 0 }, missing = issues(db, draft);
  const grouped = new Map<string,number[]>();
  for(const issue of missing) grouped.set(issue.text,[...(grouped.get(issue.text)||[]),issue.row]);
  for (const row of draft.rows.filter(r => r.decision !== 'skip')) {
    if (row.amount && Number(row.amount) > 0 && row.kind !== 'unknown' && row.currency === 'CNY') totals[row.kind] += cents(row.amount);
  }
  return `图片交易清单（待核对）：\n${draft.rows.map(row =>
    `R${row.row}${row.decision === 'skip' ? ' [跳过]' : ''} ${row.date || (row.month_day ? row.month_day + '（年份待补）' : '日期待补')}${row.time ? ' ' + row.time : ''} · ${row.merchant || '商户待核对'} · ${labels[row.kind]} ${row.amount || '金额待补'}元 · ${row.category || '待分类'}${row.account ? ' · ' + row.account : ''}`
  ).join('\n')}\n\n本图未跳过明细：支出${money(totals.expense)}元 · 收入${money(totals.income)}元 · 退款${money(totals.refund)}元 · 净支出${money(totals.expense - totals.refund)}元 · 结余${money(totals.income - totals.expense + totals.refund)}元${totals.transfer ? ' · 转账' + money(totals.transfer) + '元' : ''}（仅汇总已明确的人民币金额）。\n` +
    (draft.analysis.summaries.length ? `图中汇总（不作为交易）：${draft.analysis.summaries.map(s => `${s.label} ${s.amount ?? '未知'}${s.amount&&/^\d+(?:\.\d{1,2})?$/.test(s.amount)?'元':''}`).join('；')}。截图可能只显示部分明细，不要求两者相等。\n` : '') +
    (draft.analysis.excluded.length ? '已排除：' + draft.analysis.excluded.join('；') + '\n' : '') +
    (missing.length ? '\n待补充或核对：\n' + [...grouped].map(([text,rows])=>rows.map(r=>'R'+r).join('、')+'：'+text).join('\n') : '') + '\n\n尚未修改账本。';
}
export function reviewImageDraft(db: DB, draft: ImageDraft, raw: unknown): { text: string; proposal?: Extract<Action, { type: 'propose' }> } {
  const action = imageReviewSchema.parse(raw);
  if (action.request === 'text') return { text: '图片识别文字：\n' + draft.analysis.text + '\n\n本次未修改账本。' };
  if (draft.status === 'imported' || imageAlreadyImported(db, draft.message_id)) return { text: '这张图片已有确认入账记录，不再次入账；可查询或修改原记录。' };
  if (action.request === 'cancel') {
    db.prepare("UPDATE image_drafts SET status='cancelled',updated_at=? WHERE message_id=?").run(new Date().toISOString(), draft.message_id);
    return { text: '已取消这张图片的入账清单，账目未修改。' };
  }
  if (draft.status === 'cancelled') return { text: '这张图片的清单已取消，请重新发送图片以重新核对。' };
  if (action.account) findAccount(db, action.account);
  for (const patch of action.rows || []) if (!draft.rows.some(row => row.row === patch.row)) throw new Error(`图片中没有R${patch.row}`);
  for (const row of draft.rows) {
    const monthDay = row.date ? row.date.slice(5) : row.month_day;
    if (action.year && monthDay) row.date = dateSchema.parse(`${action.year}-${monthDay}`);
    if (action.account) row.account = action.account;
    const patch = action.rows?.find(p => p.row === row.row);
    if (patch) {
      const { row: _index, acknowledge, ...fields } = patch; Object.assign(row, fields);
      if (acknowledge || patch.decision === 'keep') row.acknowledged = true;
      if (patch.account) findAccount(db, patch.account);
      if (patch.to_account) findAccount(db, patch.to_account);
    }
  }
  const missing = issues(db, draft), selected = draft.rows.filter(r => r.decision !== 'skip');
  draft.status = !missing.length && selected.length ? 'proposed' : 'reviewing';
  db.prepare('UPDATE image_drafts SET review_json=?,status=?,updated_at=? WHERE message_id=?').run(JSON.stringify(draft.rows), draft.status, new Date().toISOString(), draft.message_id);
  const text = renderImageDraft(db, draft);
  if (missing.length || !selected.length) return { text: text + (!selected.length ? '\n所有明细均已跳过。' : '\n请补充年份、已有账户名称，并用R编号说明需保留、跳过或修正的记录。') };
  const actions: Extract<Action, {type:'propose'}>['actions'] = selected.map(row => ({
    type: row.kind === 'refund' ? 'refund' : 'add', kind: row.kind === 'refund' ? undefined : row.kind as 'expense' | 'income' | 'transfer',
    amount: row.amount!, date: row.date!, category: row.category || '待分类', subcategory: row.subcategory,
    merchant: row.merchant, account: row.account!, ...(row.kind === 'transfer' ? { to_account: row.to_account! } : {}),
    ...(row.kind === 'refund' ? { id: row.parent_id! } : {}),
    note: `图片明细R${row.row}${row.time ? ' · 时间' + row.time : ''}${row.external_id ? ' · 交易编号' + row.external_id : ''}`,
  }));
  return { text, proposal: { type: 'propose', question: text + '\n以上为待入账方案。', actions, sourceImageId: draft.message_id } };
}
