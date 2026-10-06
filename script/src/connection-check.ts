import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { setupSchema, validateModelConfig } from './config-files.js';
import { modelRequest, modelFailure, type Capability } from './model-api.js';

export type CheckResult = { service: 'feishu' | 'dingtalk' | 'text' | 'structured' | 'vision'; ok: boolean; detail: string; state?:Capability; reason?:string };
type Options = { fetch?: typeof fetch; vision?: boolean; feishu?: boolean };
const payment = z.object({ amount: z.literal('20.00'), kind: z.literal('expense') });
export async function checkConnections(raw: unknown, options: Options = {}): Promise<CheckResult[]> {
  const c = setupSchema.omit({ appId: true, appSecret: true }).parse(raw), request = options.fetch || fetch;
  validateModelConfig(c);
  const results: CheckResult[] = [];
  if (options.feishu !== false) try {
    const credentials = setupSchema.parse(raw);
    const response = await request(c.channel === 'dingtalk' ? 'https://api.dingtalk.com/v1.0/oauth2/accessToken' : 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c.channel === 'dingtalk' ? { appKey: credentials.appId, appSecret: credentials.appSecret } : { app_id: credentials.appId, app_secret: credentials.appSecret }), signal: AbortSignal.timeout(15000),
    });
    const value = await response.json() as { code?: number; tenant_access_token?: string; accessToken?: string };
    const ok = response.ok && (c.channel === 'dingtalk' ? !!value.accessToken : value.code === 0 && !!value.tenant_access_token);
    results.push({ service: c.channel, ok, detail: ok ? '凭证有效；仍需启用机器人、配置消息权限并发布' : `凭证验证失败（HTTP ${response.status}），请核对应用ID与Secret` });
  } catch { results.push({ service: c.channel, ok: false, detail: '无法验证应用凭证，请检查网络与配置' }); }
  if(c.aiMode==='fixed')return results;
  for(const service of options.vision===false?['text'] as const:['text','vision'] as const) {
    try {
      let image:string|undefined;
      if(service==='vision') {
        const canvas=createCanvas(520,200),ctx=canvas.getContext('2d');
        ctx.fillStyle='#ffffff';ctx.fillRect(0,0,520,200);ctx.fillStyle='#111111';ctx.font='32px sans-serif';
        ctx.fillText('RECEIPT - MILK TEA',24,60);ctx.fillText('PAID CNY 20.00',24,125);image=canvas.toDataURL('image/png');
      }
      const response=await modelRequest(c,{input:[{role:'user',content:service==='text'
        ?'虚构测试：奶茶支出20元。仅输出JSON对象，amount为两位小数字符串，kind为expense或income。'
        :'读取虚构收据图片的实付金额和方向，仅输出JSON对象，amount为两位小数字符串，kind为expense或income。'}],image,maxTokens:1000},{fetch:request});
      let parsed:unknown;
      try {parsed=JSON.parse(response.output_text.trim());}catch{throw new Error('JSON格式无效');}
      const structured=z.object({amount:z.string(),kind:z.enum(['expense','income'])}).safeParse(parsed);
      if(service==='text')results.push({service:'structured',ok:structured.success,state:structured.success?'verified':'unverified',detail:structured.success?'JSON字段测试通过':'JSON字段未通过，请更换模型或接口'});
      const correct=payment.safeParse(parsed).success;
      results.push({service,ok:correct,state:correct?'verified':'unverified',detail:correct?'虚构金额与方向测试通过，未入账':'金额或方向不正确，能力尚未验证'});
    }catch(error) {
      const failure=error instanceof SyntaxError || (error instanceof Error && error.message==='JSON格式无效')
        ?{reason:'format',message:'JSON格式无效，能力尚未验证'}:modelFailure(error,service==='vision'?'vision':'structured');
      const state:Capability=failure.reason==='unsupported'?'unsupported':'unverified';
      if(service==='text')results.push({service:'structured',ok:false,state,reason:failure.reason,detail:failure.message});
      results.push({service,ok:false,state:service==='text'?'unverified':state,reason:failure.reason,detail:failure.message});
    }
  }
  return results;
}
