import { z } from 'zod';
import { setting, setSetting, type DB } from './db.js';
import { receiveMessage, queueReply } from './assistant.js';

const messageSchema = z.object({
  message_id: z.string().min(1).max(200), chat_id: z.string().min(1).max(200),
  msg_type: z.enum(['text', 'image']), create_time: z.string().regex(/^\d+$/),
  sender: z.object({ id: z.string(), sender_type: z.literal('user'), id_type: z.string().optional() }),
  body: z.object({ content: z.string() }), deleted: z.boolean().optional(), parent_id: z.string().optional(),
});
export type FeishuIncoming = { id: string; user: string; chat: string; time: string; text: string; imageKey?: string; replyTo?: string };
export function decodeFeishuHistory(raw: unknown): FeishuIncoming | undefined {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success || parsed.data.deleted) return;
  const m = parsed.data, time = Number(m.create_time);
  if (!Number.isFinite(time) || time < 0 || time > 8640000000000000 || m.sender.id_type && m.sender.id_type !== 'open_id') return;
  try {
    const body = JSON.parse(m.body.content);
    const text = m.msg_type === 'image' ? '[用户发送图片，请提取文字]' : body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return;
    if (m.msg_type === 'image' && (typeof body.image_key !== 'string' || !body.image_key || body.image_key.length > 200)) return;
    return { id: m.message_id, user: m.sender.id, chat: m.chat_id, time: new Date(time).toISOString(), text,
      imageKey: m.msg_type === 'image' ? body.image_key : undefined, replyTo: m.parent_id };
  } catch { return; }
}
export function acceptFeishuMessage(db: DB, message: FeishuIncoming, appId: string) {
  const owner = setting(db, 'owner');
  if (owner && owner !== message.user) return false;
  setSetting(db, 'feishu_chat', JSON.stringify({ appId, owner: message.user, chat: message.chat }));
  if (!owner) { setSetting(db, 'pending_user', message.user); return false; }
  return db.transaction(() => {
    const saved = receiveMessage(db, message.id, message.user, message.text, message.replyTo, message.time);
    if (saved && message.imageKey) db.prepare('INSERT INTO message_images(message_id,image_key) VALUES(?,?)').run(message.id, message.imageKey);
    return saved;
  })();
}
export type HistoryAPI = {
  chatForMessage: (id: string) => Promise<string | undefined>;
  page: (input: { chat: string; start: string; end: string; token?: string }) => Promise<{ items: unknown[]; hasMore: boolean; token?: string }>;
};
export class HistoryFailure extends Error {
  constructor(message: string, public retryable = true) { super(message); }
}
function stored(db: DB, key: string, appId: string, owner: string) {
  try { const value = JSON.parse(setting(db, key)); return value.appId === appId && value.owner === owner ? value : undefined; }
  catch { return; }
}
export async function recoverFeishuHistory(db: DB, api: HistoryAPI, appId: string, until: number, stopped = () => false) {
  const owner = setting(db, 'owner');
  if (!owner) return { recovered: 0, review: 0 };
  const cursor = stored(db, 'feishu_history', appId, owner);
  const latest = db.prepare("SELECT id,received_at FROM messages WHERE user_id=? AND id LIKE 'om_%' ORDER BY received_at DESC,id DESC LIMIT 1").get(owner) as { id: string; received_at: string } | undefined;
  let chat = stored(db, 'feishu_chat', appId, owner)?.chat;
  if (!chat && latest) chat = await api.chatForMessage(latest.id);
  if (stopped()) return { recovered: 0, review: 0 };
  if (!chat) return { recovered: 0, review: 0 };
  const end = Math.floor(until / 1000) * 1000;
  const previous = typeof cursor?.until === 'number' && Number.isFinite(cursor.until) ? cursor.until : latest ? Date.parse(latest.received_at) : end;
  const start = Math.max(0, Math.floor(Math.min(previous, end) / 1000) - 2);
  const messages: FeishuIncoming[] = [], tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 100) throw new HistoryFailure('离线消息过多，补收尚未完成，请在运行状态核对', false);
    const result = await api.page({ chat, start: String(start), end: String(end / 1000), token });
    if (stopped()) return { recovered: 0, review: 0 };
    for (const raw of result.items) {
      const message = decodeFeishuHistory(raw);
      if (message && message.user === owner && message.chat === chat && Date.parse(message.time) < end && Date.parse(message.time) >= start * 1000) messages.push(message);
    }
    if (!result.hasMore) break;
    if (!result.token || tokens.has(result.token)) throw new HistoryFailure('飞书历史消息分页异常，稍后重试');
    tokens.add(result.token); token = result.token;
  }
  messages.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return db.transaction(() => {
    let recovered = 0, review = 0;
    for (const m of messages) {
      if (db.prepare('SELECT 1 FROM messages WHERE id=?').get(m.id)) continue;
      const duplicate = !m.imageKey && db.prepare('SELECT 1 FROM messages WHERE user_id=? AND text=? AND ABS(julianday(received_at)-julianday(?))<=? LIMIT 1').get(owner, m.text, m.time, 10 / (24 * 60));
      const laterDone = db.prepare("SELECT 1 FROM messages WHERE user_id=? AND status='done' AND received_at>? LIMIT 1").get(owner, m.time);
      if (!acceptFeishuMessage(db, m, appId)) continue;
      recovered++;
      if (duplicate || laterDone) {
        const error = duplicate ? '离线补收：与附近消息内容相同，疑似重复，核对后可重试或忽略；尚未执行' : '离线补收：后续消息已处理，需核对是否仍要执行；尚未执行';
        db.prepare("UPDATE messages SET status='needs_attention',error=? WHERE id=?").run(error, m.id);
        queueReply(db, owner, error + '\n' + (m.imageKey ? '[图片]' : m.text), 'history-review:' + m.id); review++;
      }
    }
    setSetting(db, 'feishu_chat', JSON.stringify({ appId, owner, chat }));
    setSetting(db, 'feishu_history', JSON.stringify({ appId, owner, until: end }));
    return { recovered, review };
  })();
}
