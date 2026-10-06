import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { readFileSync } from 'node:fs';
export type DingMessage = { id: string; user: string; text: string; imageKey?: string; time?: string };
class DingTalkApiError extends Error { constructor(readonly status: number) { super('钉钉接口调用失败，请检查应用权限与网络'); } }
export class DingTalkImageError extends Error { constructor(message: string, readonly retryable: boolean) { super(message); } }
export function decodeDingMessage(raw: unknown): DingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.conversationType !== '1' || typeof m.senderStaffId !== 'string' || !m.senderStaffId || m.senderStaffId.length > 100 || typeof m.msgId !== 'string' || !m.msgId || m.msgId.length > 300) return null;
  let text: string, imageKey: string | undefined;
  if (m.msgtype === 'text') text = (m.text as { content?: string })?.content || '';
  else if (m.msgtype === 'picture') { imageKey = (m.content as { downloadCode?: string })?.downloadCode; text = '[用户发送图片，请提取文字]'; if (typeof imageKey !== 'string' || !imageKey || imageKey.length > 4000) return null; }
  else return null;
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return null;
  const time = typeof m.createAt === 'number' && Number.isFinite(m.createAt) && m.createAt > 0 && m.createAt < 8640000000000000 ? new Date(m.createAt).toISOString() : undefined;
  return { id: 'dingtalk:' + m.msgId, user: 'dingtalk:' + m.senderStaffId, text, imageKey, time };
}
export function createDingTalkTransport(credentials: { appId: string; appSecret: string }, request = fetch) {
  let token = '', expiry = 0, stream: DWClient | undefined, stopped = false;
  async function accessToken() {
    if (token && Date.now() < expiry) return token;
    try {
      const response = await request('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey: credentials.appId, appSecret: credentials.appSecret }), signal: AbortSignal.timeout(15000) });
      const raw = await response.json() as { accessToken?: string; expireIn?: number };
      if (!response.ok || !raw.accessToken) throw new Error('invalid-token');
      token = raw.accessToken; expiry = Date.now() + Math.max(60, (raw.expireIn || 7200) - 120) * 1000; return token;
    } catch { throw new Error('钉钉凭证验证失败，请检查Client ID与Client Secret'); }
  }
  async function api(path: string, data: unknown) {
    try {
      const response = await request('https://api.dingtalk.com/v1.0/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await accessToken() }, body: JSON.stringify(data), signal: AbortSignal.timeout(20000) });
      if (!response.ok) { if (response.status === 401) expiry = 0; throw new DingTalkApiError(response.status); }
      return await response.json() as Record<string, unknown>;
    } catch (e) { if (e instanceof DingTalkApiError) throw e; throw new Error('钉钉接口调用失败，请检查应用权限与网络'); }
  }
  return {
    async download(downloadCode: string) {
      try {
      const result = await api('robot/messageFiles/download', { robotCode: credentials.appId, downloadCode });
      if (typeof result.downloadUrl !== 'string') throw new Error('钉钉图片下载地址不可用，请检查机器人文件下载权限');
      const url = new URL(result.downloadUrl);
      // DingTalk can return an HTTP OSS URL; keep the signed path/query and use TLS.
      if (url.protocol === 'http:' && url.hostname.endsWith('.aliyuncs.com')) url.protocol = 'https:';
      if (url.protocol !== 'https:' || url.username || url.password || !['dingtalk.com', 'dingding.cn', 'aliyuncs.com', 'alicdn.com'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) throw new Error('钉钉图片下载地址不受支持');
      const r = await request(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!r.ok) throw new DingTalkApiError(r.status);
      if (!r.body) throw new Error('钉钉图片下载失败');
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = r.body.getReader();
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('图片不能超过8MB'); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
      } catch (e) {
        const retryable = e instanceof DingTalkApiError ? e.status === 408 || e.status === 429 || e.status >= 500 : e instanceof TypeError || (e instanceof Error && /timeout|network|fetch/i.test(e.message));
        throw new DingTalkImageError(retryable ? '钉钉图片下载暂时失败，已保存并排队重试，尚未入账' : '钉钉图片下载失败，请检查机器人文件下载权限、消息资源和应用发布状态；消息已保存，尚未入账', retryable);
      }
    },
    async upload(path: string) {
      const form = new FormData(); form.set('media', new Blob([readFileSync(path)], { type: 'image/png' }), 'ledger.png');
      try {
        const r = await request('https://oapi.dingtalk.com/media/upload?type=image&access_token=' + encodeURIComponent(await accessToken()), { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
        const result = await r.json() as { errcode?: number; media_id?: string };
        if (!r.ok || result.errcode !== 0 || !result.media_id) throw new Error('upload-failed'); return result.media_id;
      } catch { throw new Error('钉钉图片上传失败，请检查媒体上传权限'); }
    },
    async send(user: string, text: string, imageKey?: string | null) {
      if (!user.startsWith('dingtalk:')) throw new Error('钉钉绑定用户无效');
      const result = await api('robot/oToMessages/batchSend', { robotCode: credentials.appId, userIds: [user.slice(9)], msgKey: imageKey ? 'sampleImageMsg' : 'sampleText', msgParam: JSON.stringify(imageKey ? { photoURL: imageKey } : { content: text }) });
      if (!result.processQueryKey || (Array.isArray(result.invalidStaffIdList) && result.invalidStaffIdList.length)) throw new Error('钉钉消息发送失败，请检查机器人发送权限与可用范围');
    },
    async start(receive: (message: DingMessage) => void) {
      stopped = false;
      stream = new DWClient({ clientId: credentials.appId, clientSecret: credentials.appSecret, debug: false, keepAlive: true });
      stream.registerCallbackListener(TOPIC_ROBOT, event => {
        try { const message = decodeDingMessage(JSON.parse(event.data)); if (message && !stopped) receive(message); stream?.socketCallBackResponse(event.headers.messageId, {}); }
        catch { /* Leave failed persistence unacknowledged so DingTalk can redeliver. */ }
      });
      await stream.connect();
    },
    state() { return stopped ? 'disabled' : stream?.connected ? 'connected' : stream?.reconnecting ? 'reconnecting' : 'connecting'; },
    stop() { stopped = true; stream?.disconnect(); },
  };
}
