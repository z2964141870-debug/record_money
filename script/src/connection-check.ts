import OpenAI from 'openai';
import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { setupSchema } from './config-files.js';

export type CheckResult = { service: 'feishu' | 'text' | 'vision'; ok: boolean; detail: string };
type Options = { fetch?: typeof fetch; vision?: boolean; feishu?: boolean };
const payment = z.object({ amount: z.literal('20.00'), kind: z.literal('expense') });
export async function checkConnections(raw: unknown, options: Options = {}): Promise<CheckResult[]> {
  const c = setupSchema.omit({ appId: true, appSecret: true }).parse(raw), request = options.fetch || fetch;
  const results: CheckResult[] = [];
  if (options.feishu !== false) try {
    const credentials = setupSchema.parse(raw);
    const response = await request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }), signal: AbortSignal.timeout(15000),
    });
    const value = await response.json() as { code?: number; tenant_access_token?: string };
    const ok = response.ok && value.code === 0 && !!value.tenant_access_token;
    results.push({ service: 'feishu', ok, detail: ok ? '凭证有效；仍需启用机器人、配置事件权限并发布' : `凭证验证失败（HTTP ${response.status}），请核对App ID与App Secret` });
  } catch { results.push({ service: 'feishu', ok: false, detail: '无法验证飞书凭证，请检查网络与配置' }); }
  const client = new OpenAI({ apiKey: c.aiKey, baseURL: c.aiBaseUrl, timeout: 45000, maxRetries: 0, fetch: request });
  for (const service of options.vision === false ? ['text'] as const : ['text', 'vision'] as const) {
    try {
      const content: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: service === 'text'
        ? '测试：奶茶支出20元。仅输出JSON对象，amount为元单位两位小数字符串，kind为expense或income。'
        : '读取图片的实付金额和收支方向，仅输出JSON对象，amount为元单位两位小数字符串，kind为expense或income。' }];
      if (service === 'vision') {
        const canvas = createCanvas(520, 200), ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 520, 200); ctx.fillStyle = '#111111'; ctx.font = '32px sans-serif';
        ctx.fillText('RECEIPT - MILK TEA', 24, 60); ctx.fillText('PAID CNY 20.00', 24, 125);
        content.push({ type: 'input_image', image_url: canvas.toDataURL('image/png'), detail: 'high' });
      }
      const response = await client.responses.create({ model: c.model,
        ...(c.reasoning !== 'none' ? { reasoning: { effort: c.reasoning } } : {}),
        text: { format: { type: 'json_object' } }, input: [{ role: 'user', content }], max_output_tokens: 1000 });
      payment.parse(JSON.parse(response.output_text.trim()));
      results.push({ service, ok: true, detail: service === 'text' ? 'Responses、JSON金额与方向测试通过，未入账' : '图片输入与实付金额测试通过，未入账；复杂账单仍需核对' });
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      results.push({ service, ok: false, detail: `测试失败${status ? `（HTTP ${status}）` : ''}，请检查模型、Responses/JSON/图片支持及推理设置` });
    }
  }
  return results;
}
