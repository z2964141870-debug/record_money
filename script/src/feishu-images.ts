import type { Readable } from 'node:stream';
import { maxImageBytes } from './images.js';

export class FeishuImageError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export async function downloadFeishuImage(getResource: () => Promise<{ getReadableStream(): Readable }>) {
  try {
    const resource = await getResource(), stream = resource.getReadableStream();
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxImageBytes) { stream.destroy(); throw new FeishuImageError('图片超过8MB，请压缩后重发', false); }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof FeishuImageError) throw error;
    const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
    let body = response?.data;
    // Feishu returns permission errors as JSON in a download response stream.
    if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of body as Readable) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 16_384) { (body as Readable).destroy(); break; }
          chunks.push(bytes);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { body = undefined; }
    }
    const code = (body as { code?: number } | null)?.code;
    if (code === 99991672) throw new FeishuImageError('飞书图片下载权限不足：请开通应用身份权限 im:message:readonly（获取单聊、群组消息），再在网页重试；消息已保存，尚未入账', false);
    const status = response?.status;
    const retryable = !status || status === 408 || status === 429 || status >= 500;
    throw new FeishuImageError(retryable
      ? '飞书图片下载暂时失败，已保存并排队重试，尚未入账'
      : '飞书图片下载失败，请核对消息资源、读取权限及应用发布状态，再在网页重试；尚未入账', retryable);
  }
}
