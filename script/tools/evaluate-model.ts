import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import dotenv from 'dotenv';
import { createCanvas } from '@napi-rs/canvas';
import { config,root } from '../src/config.js';
import { openDb } from '../src/db.js';
import { saveAccount } from '../src/accounts.js';
import { saveLoan } from '../src/loans.js';
import { parseText,type Action } from '../src/ai.js';
import { applyActions,receiveMessage } from '../src/assistant.js';
import { analyzeLedgerImage } from '../src/images.js';
import { ModelFailure } from '../src/model-api.js';

function argument(name:string) {const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];}
const path=argument('--config');
if(path) {
  const saved=dotenv.parse(readFileSync(resolve(path)));
  Object.assign(config,{aiBaseUrl:saved.AI_BASE_URL||'',aiKey:saved.AI_API_KEY||'',model:argument('--model')||saved.AI_MODEL||'',
    apiType:argument('--api-type')||saved.AI_API_TYPE||'responses',chatThinking:saved.AI_CHAT_THINKING||'reasoning_effort'});
}
config.aiMode='ai';config.reasoning=argument('--reasoning')||'none';
if(!config.aiKey||!config.aiBaseUrl||!config.model)throw new Error('请用 --config 指定已配置的 config.env，仅读取模型凭证，不读取账本');
const directory=join(root,'data/qa/model-evaluation',config.model.replace(/[^a-zA-Z0-9_.-]/g,'_')+'-'+config.reasoning);
mkdirSync(directory,{recursive:true,mode:0o700});
const actualFetch=globalThis.fetch;let usage:unknown[]=[];
globalThis.fetch=async(input,init)=>{
  const response=await actualFetch(input,init);
  try {const body=await response.clone().json() as {usage?:Record<string,unknown>};if(body.usage)usage.push({input_tokens:body.usage.input_tokens??body.usage.prompt_tokens,output_tokens:body.usage.output_tokens??body.usage.completion_tokens,total_tokens:body.usage.total_tokens});}catch{}
  return response;
};
const date='2026-10-06',received=date+'T04:00:00Z';
type Sample={name:string;text:string;seed?:'tea'|'ambiguous';check:(actions:Action[],reply:string)=>boolean};
const samples:Sample[]=[
  {name:'奶茶',text:'CoCo奶茶20',check:a=>a.length===1&&a[0].type==='add'&&a[0].kind==='expense'&&Number(a[0].amount)===20&&a[0].category==='餐饮'&&a[0].subcategory==='饮料'},
  {name:'红包',text:'妈妈红包30',check:a=>a.length===1&&a[0].type==='add'&&a[0].kind==='income'&&Number(a[0].amount)===30},
  {name:'连续修改',text:'刚才那杯其实18',seed:'tea',check:a=>a.length===1&&a[0].type==='update'&&Number(a[0].amount)===18},
  {name:'部分退款',text:'早上的奶茶实际退回5元了',seed:'tea',check:(a,reply)=>a.length===1&&a[0].type==='refund'&&Number(a[0].amount)===5&&/已记退款/.test(reply)},
  {name:'转账',text:'从支付宝余额转100元到微信零钱，已到账',check:a=>a.length===1&&a[0].type==='add'&&a[0].kind==='transfer'&&Number(a[0].amount)===100&&a[0].account==='支付宝余额'&&a[0].to_account==='微信零钱'},
  {name:'月付还款',text:'今天用支付宝余额偿还美团月付本金100元，没有利息',check:a=>a.length===1&&((a[0].type==='add'&&a[0].kind==='transfer'&&a[0].account==='支付宝余额'&&a[0].to_account==='美团月付'&&Number(a[0].amount)===100)||(a[0].type==='loan_repay'&&a[0].name==='美团月付'&&a[0].cash_account==='支付宝余额'&&Number(a[0].amount)===100&&Number(a[0].interest||'0')===0))},
  {name:'未知贷款日期',text:'我现在大四，接下来还要读研三年，助学贷款具体哪天开始还？',check:a=>a.length===1&&((a[0].type==='clarify'&&/合同|银行|还款|日期/.test(a[0].question||''))||(a[0].type==='reply'&&/合同|银行/.test(a[0].text)&&/未知|无法|不能|待/.test(a[0].text)))},
  {name:'退款对象含糊',text:'早上的奶茶退了5元',seed:'ambiguous',check:(a,reply)=>a.length===1&&(a[0].type==='clarify'||/确认要操作哪笔/.test(reply))},
];
const results:{name:string;passed:boolean;clarification:boolean;ms:number;usage:unknown[];actions?:unknown;result?:unknown;error?:string}[]=[];
try {
  for(const sample of samples){
    const db=openDb(':memory:');usage=[];const started=performance.now();
    try {
      for(const name of ['支付宝余额','微信零钱'])saveAccount(db,{name,kind:'cash',balance:500000});
      saveLoan(db,{name:'美团月付',balance:30000,category:'monthly'});saveLoan(db,{name:'助学贷款',balance:2400000,category:'student',note:'大四，计划读研三年，合同还款日未提供'});
      if(sample.seed){
        receiveMessage(db,'seed','local','CoCo奶茶20',undefined,received);applyActions(db,'seed',[{type:'add',kind:'expense',amount:'20',category:'餐饮',subcategory:'饮料',merchant:'CoCo',note:'奶茶',date}]);
        if(sample.seed==='ambiguous'){receiveMessage(db,'seed2','local','另一杯奶茶20',undefined,received);applyActions(db,'seed2',[{type:'add',kind:'expense',amount:'20',category:'餐饮',subcategory:'饮料',merchant:'CoCo',note:'奶茶',date}]);}
      }
      receiveMessage(db,'current','local',sample.text,undefined,received);
      const actions=await parseText(db,sample.text,date,{user:'local',messageId:'current'}),reply=applyActions(db,'current',actions);
      const passed=sample.check(actions,reply),clarification=actions.some(a=>a.type==='clarify')||/确认要操作哪笔/.test(reply);
      results.push({name:sample.name,passed,clarification,ms:Math.round(performance.now()-started),usage:[...usage],actions,result:reply});
      console.log(JSON.stringify({name:sample.name,passed,clarification,ms:results.at(-1)!.ms,usage}));
    }catch(error){results.push({name:sample.name,passed:false,clarification:false,ms:Math.round(performance.now()-started),usage:[...usage],error:error instanceof ModelFailure?error.message:'输出格式或业务校验失败'});console.log(JSON.stringify(results.at(-1)));}
    finally{db.close();}
  }
  const canvas=createCanvas(800,540),ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,800,540);ctx.fillStyle='#151515';ctx.font='28px sans-serif';
  const lines=['Statement (CNY)','Summary: expense 999.00 / income 888.00','Milk tea                       -20.00','10-06 09:15','Milk tea                       -20.00','10-06 09:15'];lines.forEach((line,i)=>ctx.fillText(line,30,50+i*75));
  const imagePath=join(directory,'fictional-statement.png');writeFileSync(imagePath,canvas.toBuffer('image/png'),{mode:0o600});
  const db=openDb(':memory:');usage=[];const started=performance.now();
  try {
    const result=await analyzeLedgerImage(db,imagePath),passed=result.transactions.length===2&&result.transactions.every(t=>t.amount==='20.00'&&t.kind==='expense'&&t.month_day==='10-06'&&t.time==='09:15'&&t.date===null&&t.account===null)&&result.summaries.length>=1&&result.duplicate_groups.some(g=>g.includes(1)&&g.includes(2));
    results.push({name:'图片汇总与重复行',passed,clarification:result.duplicate_groups.length>0,ms:Math.round(performance.now()-started),usage:[...usage],result});console.log(JSON.stringify({name:results.at(-1)!.name,passed,ms:results.at(-1)!.ms,usage}));
  }catch(error){results.push({name:'图片汇总与重复行',passed:false,clarification:false,ms:Math.round(performance.now()-started),usage:[...usage],error:error instanceof ModelFailure?error.message:'图片清单格式无效'});}
  finally{db.close();}
  writeFileSync(join(directory,'result.json'),JSON.stringify({model:config.model,apiType:config.apiType,reasoning:config.reasoning,checked_at:new Date().toISOString(),passed:results.filter(r=>r.passed).length,total:results.length,results},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,report:join(directory,'result.json')}));
  if(results.some(r=>!r.passed))process.exitCode=1;
}finally{globalThis.fetch=actualFetch;}
