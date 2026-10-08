import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { setting, setSetting, type DB } from './db.js';
import { config } from './config.js';
import type { ModelRuntime } from './model-service.js';

export type Capability = 'verified'|'unsupported'|'unverified';
export type Capabilities = Record<'text'|'structured'|'vision', Capability>;
export class ModelFailure extends Error {
  constructor(public reason: 'auth'|'network'|'unsupported'|'format'|'service', message:string) { super(message); }
}
export function modelFailure(error:unknown, feature:'vision'|'structured'|'text'='text') {
  if(error instanceof ModelFailure)return error;
  if(error instanceof OpenAI.APIError) {
    if(error.status===401||error.status===403)return new ModelFailure('auth','模型密钥无效或无访问权限，请检查模型服务配置');
    const description=error.message.toLowerCase();
    const term=feature==='vision'?/image|vision|multimodal|图片|多模态/:feature==='structured'?/json|response_format|structured/:/text/;
    if([400,422].includes(error.status||0)&&term.test(description)&&/not support|unsupported|does not|不支持/.test(description))return new ModelFailure('unsupported',feature==='vision'?'当前模型不支持读图，请发文字或更换模型':'当前接口不支持所需的JSON输出格式，请更换接口或模型');
    if(error.status)return new ModelFailure('service',`模型服务返回 HTTP ${error.status}，消息已保留，可重试`);
  }
  return new ModelFailure('network','无法连接模型服务，请检查网络或服务地址，消息已保留，可重试');
}
export function modelRuntime(db:DB):ModelRuntime {return {...config,model:setting(db,'model',config.model),reasoning:setting(db,'reasoning',config.reasoning)};}
function fingerprint(runtime:ModelRuntime) {return createHash('sha256').update(JSON.stringify([runtime.aiBaseUrl,runtime.aiKey,runtime.model,runtime.reasoning,runtime.apiType||'responses',runtime.chatThinking||'reasoning_effort'])).digest('hex');}
export function modelCapabilities(db:DB,runtime:ModelRuntime):Capabilities {
  const unknown:Capabilities={text:'unverified',structured:'unverified',vision:'unverified'};
  try {
    const key=fingerprint(runtime), saved=JSON.parse(setting(db,'model_capabilities','{}'));
    const capabilities=saved.services?.[key]?.capabilities || (saved.fingerprint===key?saved.capabilities:undefined);
    return capabilities?{...unknown,...capabilities}:unknown;
  }catch{return unknown;}
}
export function saveCapabilities(db:DB,runtime:ModelRuntime,capabilities:Capabilities) {
  let services:Record<string,unknown>={};
  try {
    const saved=JSON.parse(setting(db,'model_capabilities','{}'));
    services=saved.services || (saved.fingerprint?{[saved.fingerprint]:{capabilities:saved.capabilities,checked_at:saved.checked_at}}:{});
  }catch{}
  services[fingerprint(runtime)]={capabilities,checked_at:new Date().toISOString()};
  setSetting(db,'model_capabilities',JSON.stringify({services:Object.fromEntries(Object.entries(services).slice(-20))}));
}
type Message = {role:'user'|'assistant'|'system';content:string};
type Request = {instructions?:string;input:Message[];image?:string;maxTokens:number;json?:boolean};
export async function modelRequest(runtime:ModelRuntime, request:Request, options:{fetch?:typeof fetch;timeout?:number}={}) {
  if(runtime.aiMode==='fixed')throw new ModelFailure('service','未启用AI图片识别，请发文字；账单图表仍可使用');
  if(!runtime.aiKey||!runtime.aiBaseUrl||!runtime.model)throw new ModelFailure('service','尚未配置模型服务');
  const client=new OpenAI({apiKey:runtime.aiKey,baseURL:runtime.aiBaseUrl,timeout:options.timeout||45000,maxRetries:0,fetch:options.fetch});
  try {
    if(runtime.apiType==='chat_completions') {
      const messages:OpenAI.Chat.Completions.ChatCompletionMessageParam[]=[];
      if(request.instructions)messages.push({role:'system',content:request.instructions});
      messages.push(...request.input);
      if(request.image) {
        const last=request.input.at(-1)!;
        messages[messages.length-1]={role:'user',content:[{type:'text',text:last.content},{type:'image_url',image_url:{url:request.image,detail:'high'}}]};
      }
      const response=await client.chat.completions.create({model:runtime.model,messages,
        ...(request.json!==false?{response_format:{type:'json_object' as const}}:{}),max_tokens:request.maxTokens,
        ...(runtime.chatThinking==='enable_thinking'?{enable_thinking:runtime.reasoning!=='none'}:{reasoning_effort:runtime.reasoning})} as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
      const choice=response.choices[0];
      if(choice?.finish_reason==='length')throw new ModelFailure('format','模型输出达到上限，尚未执行，请缩小输入后重试');
      return {output_text:choice?.message.content||'',usage:response.usage};
    }
    const input:OpenAI.Responses.ResponseInput=request.input.map((m,index)=>request.image&&index===request.input.length-1
      ?{role:'user',content:[{type:'input_text',text:m.content},{type:'input_image',image_url:request.image,detail:'high'}]}:m);
    // Some compatible gateways validate JSON mode against input, excluding instructions.
    if(request.json!==false&&!request.input.some(m=>/json/i.test(m.content)))input.unshift({role:'system',content:'请严格输出 JSON。'});
    const response=await client.responses.create({model:runtime.model,instructions:request.instructions,input,
      reasoning:{effort:runtime.reasoning as 'none'|'low'|'medium'|'high'},
      ...(request.json!==false?{text:{format:{type:'json_object' as const}}}:{}),max_output_tokens:request.maxTokens,store:false});
    if(response.status==='incomplete')throw new ModelFailure('format','模型输出不完整，尚未执行，请缩小输入后重试');
    return {output_text:response.output_text,usage:response.usage};
  }catch(error){throw modelFailure(error,request.image?'vision':request.json!==false?'structured':'text');}
}
