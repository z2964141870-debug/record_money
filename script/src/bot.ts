import * as lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';
import { setting, setSetting, type DB } from './db.js';
import { processMessage, queueReply, receiveMessage } from './assistant.js';
import { cancelObsoleteReminders } from './reminders.js';
import { createReadStream,existsSync,writeFileSync,mkdirSync } from 'node:fs';
import {dirname} from 'node:path';
import { saveImage } from './images.js';
import { downloadFeishuImage, FeishuImageError } from './feishu-images.js';
import { renderChart } from './charts.js';
import { createDingTalkTransport, DingTalkImageError, type DingMessage } from './dingtalk.js';
import { ModelFailure, modelCapabilities, modelRuntime } from './model-api.js';
import { acceptFeishuMessage, decodeFeishuHistory, recoverFeishuHistory, HistoryFailure, type HistoryAPI } from './feishu-history.js';
import { watchSystemWake } from './wake-monitor.js';
import { cancelObsoleteFundReminders } from './funds.js';
export type BotStatus = { state: string; lastReceived: string | null; lastSent: string | null; lastError: string | null;
  lastWake: string | null; recovery: { state: string; lastSynced: string | null; recovered: number; error: string | null } };
export function acceptDingMessage(db: DB, message: DingMessage) {
  const owner = setting(db, 'owner');
  if (!owner) { setSetting(db, 'pending_user', message.user); return false; }
  if (owner !== message.user) return false;
  return db.transaction(() => {
    const saved = receiveMessage(db, message.id, message.user, message.text, undefined, message.time);
    if (saved && message.imageKey) db.prepare('INSERT INTO message_images(message_id,image_key) VALUES(?,?)').run(message.id, message.imageKey);
    return saved;
  })();
}
export function createBot(db: DB, options: {
  socketFactory?: (params: ConstructorParameters<typeof lark.WSClient>[0]) => lark.WSClient;
  now?: () => number;
  historyAPI?: HistoryAPI;
  watchWake?: typeof watchSystemWake;
  feishuClient?: lark.Client;
} = {}) {
  const status: BotStatus = { state: 'disabled', lastReceived: null, lastSent: null, lastError: null, lastWake: null,
    recovery: { state: 'idle', lastSynced: null, recovered: 0, error: null } };
  const quietLogger = { debug: (..._args: unknown[]) => {}, info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {}, trace: (..._args: unknown[]) => {} };
  const client = config.channel === 'feishu' && config.appId && config.appSecret ? options.feishuClient || new lark.Client({ appId: config.appId, appSecret: config.appSecret, disableTokenCache: false, logger: quietLogger }) : undefined;
  const ding = config.channel === 'dingtalk' && config.appId && config.appSecret ? createDingTalkTransport(config) : undefined;
  let ws: lark.WSClient | undefined, busy = false, stopped = false;
  const now = options.now || Date.now;
  let lastTick = now(), lastReconnect = 0, restoring = false, wakePending = false, fastRecoveryUntil = 0;
  let syncRequested = false, nextSync = 0, syncAttempts = 0;
  async function historyCall<T extends { code?: number }>(request: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([request, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new HistoryFailure('飞书离线补收暂未连通，联网后自动重试')), 10000); })]);
      if (result.code === 99991672) throw new HistoryFailure('飞书离线补收需要 im:message:readonly 或 im:message.history:readonly 权限，开通后需发布应用', false);
      if (result.code !== 0) throw new HistoryFailure('飞书离线补收失败，稍后自动重试');
      return result;
    } catch (error) {
      if (error instanceof HistoryFailure) throw error;
      const response = (error as { response?: { status?: number; data?: { code?: number } } })?.response;
      if (response?.status === 403 || response?.data?.code === 99991672) throw new HistoryFailure('飞书离线补收需要消息读取权限，开通后需发布应用', false);
      throw new HistoryFailure('飞书离线补收暂未连通，联网后自动重试');
    } finally { if (timeout) clearTimeout(timeout); }
  }
  const historyAPI = options.historyAPI || (client ? {
    chatForMessage: async (id: string) => (await historyCall(client.im.message.get({ path: { message_id: id } }))).data?.items?.[0]?.chat_id,
    page: async (input: { chat: string; start: string; end: string; token?: string }) => {
      const response = await historyCall(client.im.message.list({ params: { container_id_type: 'chat', container_id: input.chat, start_time: input.start,
        end_time: input.end, sort_type: 'ByCreateTimeAsc', page_size: 50, page_token: input.token } }));
      if (!response.data || !Array.isArray(response.data.items)) throw new HistoryFailure('飞书历史消息响应不完整，稍后自动重试');
      return { items: response.data?.items || [], hasMore: response.data?.has_more || false, token: response.data?.page_token };
    },
  } : undefined);
  function requestWake() {
    if (stopped) return;
    status.lastWake = new Date(now()).toISOString();
    wakePending = true; fastRecoveryUntil = now() + 90000; syncRequested = true; nextSync = 0;
    void tick().catch(() => { status.lastError = '唤醒恢复失败，将自动重试'; });
  }
  const logger = {
    debug: (..._args: unknown[]) => {}, trace: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => { status.state = 'error'; status.lastError = '飞书连接失败，请核对凭证、应用发布与事件订阅'; },
  };
  async function tick() {
    if (stopped) return;
    const time = now(), resumed = time - lastTick > 10000;
    lastTick = time;
    if (resumed) { wakePending = true; fastRecoveryUntil = time + 90000; syncRequested = true; nextSync = 0; status.lastWake = new Date(time).toISOString(); }
    if (ws && !restoring) {
      const connection = ws.getConnectionStatus();
      status.state = connection.state === 'failed' ? 'error' : connection.state === 'idle' ? 'reconnecting' : connection.state;
      const slowRetry = ['connecting', 'reconnecting'].includes(connection.state) && (connection.nextConnectTime || 0) > time + 5000;
      if (wakePending || connection.state === 'idle' && time - lastReconnect >= 5000 || time < fastRecoveryUntil && slowRetry && time - lastReconnect >= 5000) {
        restoring = true; lastReconnect = time;
        wakePending = false; syncRequested = true; nextSync = 0;
        status.state = 'reconnecting';
        // A socket can still report OPEN after the Mac wakes with a dead connection.
        ws.close({ force: true }); ws = undefined;
        try { await start(); } finally { restoring = false; }
      }
    }
    if (busy || stopped) return; busy = true;
    try {
      if (ding && config.feishuEnabled) status.state = ding.state();
      if (historyAPI && config.feishuEnabled && !restoring && (syncRequested || time >= nextSync)) {
        if (time >= nextSync) {
          syncRequested = false; status.recovery.state = 'syncing';
          try {
            const result = await recoverFeishuHistory(db, historyAPI, config.appId, now(), () => stopped);
            if (stopped) return;
            status.recovery.state = 'idle'; status.recovery.error = null; status.recovery.recovered += result.recovered;
            status.recovery.lastSynced = new Date(now()).toISOString(); syncAttempts = 0; nextSync = syncRequested ? 0 : now() + 60000;
            if (result.recovered) status.lastReceived = new Date(now()).toISOString();
            if (ws && (ws.getConnectionStatus().nextConnectTime || 0) > now()) wakePending = true;
          } catch (error) {
            if (stopped) return;
            const retryable = !(error instanceof HistoryFailure) || error.retryable;
            status.recovery.state = retryable ? 'retrying' : 'blocked';
            status.recovery.error = error instanceof HistoryFailure ? error.message : '离线消息补收失败，将自动重试';
            syncRequested = true; syncAttempts++;
            nextSync = now() + (retryable ? Math.min(30000, 2000 * 2 ** Math.min(syncAttempts - 1, 4)) : 60000);
          }
        }
      }
      if (stopped) return;
      const canProcess = !restoring && (!historyAPI || !syncRequested || status.recovery.state === 'blocked');
      const message = canProcess ? db.prepare("SELECT id,next_attempt FROM messages WHERE status='pending' AND user_id!='local' ORDER BY received_at,rowid LIMIT 1").get() as { id: string; next_attempt: number } | undefined : undefined;
      if (message && message.next_attempt <= Date.now()) {
        try {
          const image=db.prepare('SELECT image_key,path FROM message_images WHERE message_id=?').get(message.id) as {image_key:string;path:string|null}|undefined;
          if(image && config.aiMode==='fixed')throw new ModelFailure('service','未启用AI图片识别，请发文字；账单图表仍可使用');
          if(image && modelCapabilities(db,modelRuntime(db)).vision==='unsupported')throw new ModelFailure('unsupported','当前模型不支持读图，请发文字或更换模型');
          if(image&&(!image.path||!existsSync(image.path))) {
            if(!client && !ding)throw new Error('图片下载服务尚未配置');
            const bytes=ding ? await ding.download(image.image_key) : await downloadFeishuImage(()=>client!.im.messageResource.get({path:{message_id:message.id,file_key:image.image_key},params:{type:'image'}}));
            const path=await saveImage(bytes);db.prepare('UPDATE message_images SET path=? WHERE message_id=?').run(path,message.id);
          }
          await processMessage(db, message.id);
        }
        catch (error) {
          const msg = db.prepare('SELECT user_id,attempts FROM messages WHERE id=?').get(message.id) as { user_id: string; attempts: number };
          const attempts = msg.attempts + 1;
          if(error instanceof ModelFailure) {
            const retryable=['network'].includes(error.reason)||error.reason==='service'&&/HTTP (429|5\d\d)/.test(error.message);
            db.prepare('UPDATE messages SET attempts=?,next_attempt=?,status=?,error=? WHERE id=?').run(attempts,Date.now()+Math.min(300000,15000*2**attempts),retryable&&attempts<3?'pending':'needs_attention',error.message,message.id);
            queueReply(db,msg.user_id,error.message+'；尚未入账，可在网页重试。','failure:'+message.id);return;
          }
          if (error instanceof FeishuImageError || error instanceof DingTalkImageError) {
            db.prepare('UPDATE messages SET attempts=?,next_attempt=?,status=?,error=? WHERE id=?').run(attempts, Date.now() + Math.min(300000, 15000 * 2 ** attempts), error.retryable && attempts < 3 ? 'pending' : 'needs_attention', error.message, message.id);
            queueReply(db, msg.user_id, error.message, 'image-failure:' + message.id);
            return;
          }
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
      if (!config.feishuEnabled || (!client && !ding)) return;
      cancelObsoleteReminders(db);
      cancelObsoleteFundReminders(db);
      const next = db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now()) as { id: number; user_id: string; text: string; attempts: number; image_path:string|null;image_key:string|null } | undefined;
      if (next && next.user_id === setting(db, 'owner')) {
        try {
          let imageKey=next.image_key;
          if(next.image_path&&!imageKey) {
            if(!existsSync(next.image_path)) {
              const snapshot=db.prepare('SELECT snapshot_json FROM chart_files WHERE path=?').get(next.image_path) as {snapshot_json:string}|undefined;
              if(!snapshot)throw new Error('chart-not-found');
              mkdirSync(dirname(next.image_path),{recursive:true,mode:0o700});writeFileSync(next.image_path,renderChart(JSON.parse(snapshot.snapshot_json)),{mode:0o600});
            }
            imageKey=ding ? await ding.upload(next.image_path) : (await client!.im.image.create({data:{image_type:'message',image:createReadStream(next.image_path)}}))?.image_key||null;
            if(!imageKey)throw new Error('image-upload-failed');
            db.prepare('UPDATE outbox SET image_key=? WHERE id=?').run(imageKey,next.id);
          }
          if (ding) await ding.send(next.user_id, next.text, imageKey);
          else { const response = await client!.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: next.user_id, msg_type: imageKey?'image':'text', content: JSON.stringify(imageKey?{image_key:imageKey}:{text:next.text}), uuid: `ledger-outbox-${next.id}` } });
            if (response.code !== 0) throw new Error('send-failed'); }
          db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(next.id); status.lastSent = new Date().toISOString(); status.lastError = null;
        } catch {
          db.prepare('UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?').run(Date.now() + Math.min(600000, 10000 * 2 ** Math.min(next.attempts, 6)), next.id);
          status.lastError = '消息发送失败，已排队重试；检查机器人发送权限及可用范围';
        }
      }
    } finally { busy = false; }
  }
  async function start() {
    if (stopped || !config.feishuEnabled || !config.appId || !config.appSecret) return;
    status.state = 'connecting';
    if (ding) {
      try { await ding.start(message => {
        if (acceptDingMessage(db, message)) { status.lastReceived = new Date().toISOString(); status.lastError = null; }
      }); status.state = ding.state(); if (status.state !== 'connected') status.lastError = '钉钉尚未连接，请检查应用凭证、机器人Stream模式与发布状态'; }
      catch { status.state = 'error'; status.lastError = '钉钉Stream连接失败，请检查应用凭证、机器人Stream模式与发布状态'; }
      return;
    }
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event) => {
        if (event.sender?.sender_type !== 'user' || event.message?.chat_type !== 'p2p' || !['text','image'].includes(event.message.message_type)) return;
        if (stopped) return;
        const message = decodeFeishuHistory({ message_id: event.message.message_id, chat_id: event.message.chat_id,
          msg_type: event.message.message_type, create_time: event.message.create_time, body: { content: event.message.content },
          sender: { sender_type: event.sender.sender_type, id: event.sender.sender_id?.open_id, id_type: 'open_id' }, parent_id: event.message.parent_id });
        if (!message || !acceptFeishuMessage(db, message, config.appId)) return;
        status.state = 'connected'; status.lastReceived = new Date().toISOString();
      },
    });
    const params: ConstructorParameters<typeof lark.WSClient>[0] = { appId: config.appId, appSecret: config.appSecret, logger, autoReconnect: true, handshakeTimeoutMs: 15000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => { if (!stopped) { status.state = 'connected'; status.lastError = null; syncRequested = true; nextSync = 0; } },
      onReconnecting: () => { status.state = 'reconnecting'; },
      onReconnected: () => { if (!stopped) { status.state = 'connected'; status.lastError = null; syncRequested = true; nextSync = 0; } },
      onError: () => { status.state = 'error'; status.lastError = '飞书长连接失败，请核对应用配置'; },
    };
    ws = options.socketFactory ? options.socketFactory(params) : new lark.WSClient(params);
    try { await ws.start({ eventDispatcher: dispatcher }); }
    catch { status.state = 'error'; status.lastError = '无法建立长连接，请核对飞书设置'; }
  }
  const timer = setInterval(() => { void tick().catch(() => { status.lastError = '后台任务失败，请查看运行状态'; }); }, 2000);
  timer.unref();
  const stopWake = client && config.feishuEnabled ? (options.watchWake || watchSystemWake)(requestWake) : () => {};
  return { status, start, stop: () => { stopped = true; clearInterval(timer); stopWake(); ws?.close(); ding?.stop(); }, tick };
}
