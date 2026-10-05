import * as lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';
import { setting, setSetting, type DB } from './db.js';
import { processMessage, queueReply, receiveMessage } from './assistant.js';
import { cancelObsoleteReminders } from './reminders.js';
export type BotStatus = { state: string; lastReceived: string | null; lastSent: string | null; lastError: string | null };
export function createBot(db: DB) {
  const status: BotStatus = { state: 'disabled', lastReceived: null, lastSent: null, lastError: null };
  const quietLogger = { debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {}, trace: (..._args: unknown[]) => {} };
  const client = config.appId && config.appSecret ? new lark.Client({ appId: config.appId, appSecret: config.appSecret, disableTokenCache: false, logger: quietLogger }) : undefined;
  let ws: lark.WSClient | undefined, busy = false, stopped = false;
  const logger = {
    debug: (..._args: unknown[]) => {}, trace: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => { status.state = 'error'; status.lastError = '飞书连接失败，请核对凭证、应用发布与事件订阅'; },
  };
  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      const message = db.prepare("SELECT id,next_attempt FROM messages WHERE status='pending' AND user_id!='local' ORDER BY received_at,id LIMIT 1").get() as { id: string; next_attempt: number } | undefined;
      if (message && message.next_attempt <= Date.now()) {
        try { await processMessage(db, message.id); }
        catch (error) {
          const msg = db.prepare('SELECT user_id,attempts FROM messages WHERE id=?').get(message.id) as { user_id: string; attempts: number };
          const attempts = msg.attempts + 1;
          const transient = error instanceof Error && (/timeout|fetch|connect|ECONN|rate|429|5\d\d|JSON|Unexpected|模型/i.test(error.message) || 'status' in error);
          if (!transient) {
            const text = '未完成记账：' + (error instanceof Error ? error.message : '请检查输入');
            db.prepare("UPDATE messages SET status='done',result=?,error=NULL WHERE id=?").run(text.slice(0, 300), message.id);
            queueReply(db, msg.user_id, text.slice(0, 300), 'message:' + message.id);
          } else {
            db.prepare('UPDATE messages SET attempts=?,next_attempt=?,status=?,error=? WHERE id=?').run(attempts, Date.now() + Math.min(300000, 15000 * 2 ** attempts), attempts >= 3 ? 'needs_attention' : 'pending', '模型调用失败，请检查服务状态或在网页重试', message.id);
            queueReply(db, msg.user_id, '消息已保存，模型暂时不可用，尚未入账。可在本机网页查看和重试。', 'failure:' + message.id);
          }
        }
      }
      if (!config.feishuEnabled || !client) return;
      cancelObsoleteReminders(db);
      const next = db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now()) as { id: number; user_id: string; text: string; attempts: number } | undefined;
      if (next && next.user_id === setting(db, 'owner')) {
        try {
          const response = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: next.user_id, msg_type: 'text', content: JSON.stringify({ text: next.text }), uuid: `ledger-outbox-${next.id}` } });
          if (response.code !== 0) throw new Error('send-failed');
          db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(next.id); status.lastSent = new Date().toISOString();
        } catch {
          db.prepare('UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?').run(Date.now() + Math.min(600000, 10000 * 2 ** Math.min(next.attempts, 6)), next.id);
          status.lastError = '消息发送失败，已排队重试；检查机器人发送权限及可用范围';
        }
      }
    } finally { busy = false; }
  }
  async function start() {
    if (!config.feishuEnabled || !config.appId || !config.appSecret) return;
    status.state = 'connecting';
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event) => {
        if (event.sender?.sender_type !== 'user' || event.message?.chat_type !== 'p2p' || event.message.message_type !== 'text') return;
        const user = event.sender.sender_id?.open_id; if (!user) return;
        const owner = setting(db, 'owner');
        if (!owner) { setSetting(db, 'pending_user', user); return; }
        if (owner !== user) return;
        let text: string; try { text = JSON.parse(event.message.content).text; } catch { return; }
        if (typeof text !== 'string' || text.length > 4000) return;
        const timestamp = Number(event.message.create_time);
        status.state = 'connected'; status.lastReceived = new Date().toISOString();
        receiveMessage(db, event.message.message_id, user, text, event.message.parent_id, Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined);
      },
    });
    ws = new lark.WSClient({ appId: config.appId, appSecret: config.appSecret, logger, autoReconnect: true, handshakeTimeoutMs: 15000,
      onReady: () => { status.state = 'connected'; status.lastError = null; },
      onReconnecting: () => { status.state = 'reconnecting'; },
      onReconnected: () => { status.state = 'connected'; status.lastError = null; },
      onError: () => { status.state = 'error'; status.lastError = '飞书长连接失败，请核对应用配置'; },
    });
    try { await ws.start({ eventDispatcher: dispatcher }); }
    catch { status.state = 'error'; status.lastError = '无法建立长连接，请核对飞书设置'; }
  }
  const timer = setInterval(() => { void tick().catch(() => { status.lastError = '后台任务失败，请查看运行状态'; }); }, 2000);
  timer.unref();
  return { status, start, stop: () => { stopped = true; clearInterval(timer); ws?.close(); }, tick };
}
