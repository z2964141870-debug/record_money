import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import { config } from '../src/config.js';
import { openDb,setSetting,setting } from '../src/db.js';
import { receiveMessage,processMessage,applyActions } from '../src/assistant.js';
import { fixedCommands } from '../src/fixed-commands.js';
import { listEntries } from '../src/ledger.js';
import { saveAccount } from '../src/accounts.js';
import { checkConnections } from '../src/connection-check.js';
import { modelCapabilities,saveCapabilities,modelRequest,ModelFailure } from '../src/model-api.js';
import { saveModelService } from '../src/model-service.js';
import { needsSetup,persistInitialSetup } from '../src/onboarding.js';
import { runReminder } from '../src/reminders.js';
import { runSchedule } from '../src/reports.js';
import { buildServer } from '../src/server.js';
import { createImageDraft } from '../src/image-ledger.js';
import { validateReferences } from '../src/ai.js';

const runtime={...config,appId:'cli_fixture',appSecret:'fixture',aiBaseUrl:'https://fixture.invalid/v1',aiKey:'fixture',model:'fixture',reasoning:'none'};
function response(text:string){return new Response(JSON.stringify({id:'fixture',object:'response',status:'completed',output:[{id:'fixture-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}]}),{headers:{'Content-Type':'application/json'}});}
test('fixed setup needs no model and still schedules reminders and reports',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'money-fixed-')),db=openDb(':memory:');
  try {
    const empty={...config,appId:'',appSecret:'',aiBaseUrl:'',aiKey:'',model:''},raw={appId:'cli_fixture',appSecret:'fixture',aiMode:'fixed'};
    const results=await checkConnections(raw,{fetch:async input=>{assert.match(String(input),/feishu/);return new Response(JSON.stringify({code:0,tenant_access_token:'fixture'}));}});
    assert.deepEqual(results.map(r=>r.service),['feishu']);
    persistInitialSetup(db,empty,dir,join(dir,'data'),false,raw);
    const stored=dotenv.parse(readFileSync(join(dir,'data/config.env')));assert.equal(stored.AI_MODE,'fixed');assert.equal(stored.AI_API_KEY,'');
    assert.equal(needsSetup({...empty,appId:raw.appId,appSecret:raw.appSecret,aiMode:'fixed'}),false);
    setSetting(db,'owner','fixture');setSetting(db,'schedule_start','2026-10-05');
    runReminder(db,new Date('2026-10-06T12:00:00Z'));runSchedule(db,new Date('2026-10-06T13:30:00Z'));
    assert.ok(db.prepare("SELECT 1 FROM outbox WHERE dedup LIKE 'reminder:%'").get());assert.ok(db.prepare('SELECT 1 FROM reports').get());
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('fixed commands use cents, preserve source, references, audit and dedup with zero model calls',async()=>{
  const db=openDb(':memory:'),old={...config},previous=globalThis.fetch;let calls=0;
  try {
    Object.assign(config,{aiMode:'fixed',aiBaseUrl:'',aiKey:'',model:''});globalThis.fetch=async()=>{calls++;throw new Error('must not call model');};
    const account=saveAccount(db,{name:'支付宝 余额',kind:'cash',balance:10000});
    const send=async(id:string,text:string,user='dingtalk:fixture')=>{receiveMessage(db,id,user,text,undefined,'2026-10-06T04:00:00Z');return processMessage(db,id);};
    assert.match(await send('a','支出 20 餐饮 奶茶 账户="支付宝 余额"'),/20.00/);
    assert.equal(await send('a','支出 20 餐饮 奶茶'),await processMessage(db,'a'));
    await send('b','修改 #1 金额 18');await send('c','退款 #1 12.8');
    await send('d','收入 30 红包 妈妈红包','fixture-feishu');
    let entries=listEntries(db);assert.equal(entries.length,3);assert.equal(entries.find(e=>e.id===1)?.amount,1800);
    assert.equal(entries.find(e=>e.id===2)?.parent_id,1);assert.equal(entries.find(e=>e.id===2)?.amount,1280);
    assert.equal(entries.find(e=>e.id===1)?.account_id,account.id);assert.equal(entries.find(e=>e.id===3)?.account_id,null);
    assert.equal(entries.find(e=>e.id===1)?.source,'dingtalk');assert.equal(entries.find(e=>e.id===3)?.source,'feishu');
    assert.match(await send('excess','退款 #1 6'),/累计退款超过/);assert.equal(listEntries(db).length,3);
    assert.match(await send('bad','支出 0.001 餐饮 奶茶'),/最多两位/);
    assert.match(await send('date','支出 2 餐饮 饭 日期=2026-02-30'),/日期无效/);
    assert.match(await send('id','撤销 #999'),/不存在/);
    assert.match(await send('account','支出 2 餐饮 饭 账户=不存在'),/账户/);
    assert.match(await send('free','CoCo奶茶20'),/支出 20 餐饮 奶茶/);
    assert.match(await send('query','今日账单'),/净支出 5.20/);
    await send('cancel-refund','撤销 #2');await send('cancel-expense','撤销 #1');
    entries=listEntries(db,{includeCancelled:true});assert.ok(entries.find(e=>e.id===1)?.cancelled_at);
    assert.ok((db.prepare('SELECT COUNT(*) n FROM audit').get() as {n:number}).n>=6);assert.equal(calls,0);
  }finally{globalThis.fetch=previous;Object.assign(config,old);db.close();}
});
test('explicit malformed commands never fall through to AI; natural language uses the selected endpoint once',async()=>{
  const db=openDb(':memory:'),old={...config},previous=globalThis.fetch;let calls=0;
  try {
    Object.assign(config,runtime,{aiMode:'ai',apiType:'chat_completions'});
    globalThis.fetch=async(input,init)=>{calls++;const request=new Request(input,init),body=await request.json();assert.match(request.url,/chat\/completions$/);assert.equal(body.reasoning_effort,'none');assert.equal(body.tools,undefined);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"actions":[{"type":"clarify","question":"请说明退款对应哪笔消费"}]}'}}]}),{headers:{'Content-Type':'application/json'}});};
    receiveMessage(db,'bad','local','退款 #1 0.001');assert.match(await processMessage(db,'bad'),/未执行/);assert.equal(calls,0);
    receiveMessage(db,'natural','local','刚才的钱退了');assert.match(await processMessage(db,'natural'),/哪笔/);assert.equal(calls,1);
    for(const text of ['支出','撤销#1','收入 -3 红包 测试','支出 1 餐饮 奶茶 账户="未闭合','本月账单 额外'])assert.throws(()=>fixedCommands(text,'2026-10-06'));
  }finally{globalThis.fetch=previous;Object.assign(config,old);db.close();}
});
test('failed batch rolls back ledger, balances, audit and message completion',()=>{
  const db=openDb(':memory:');try {
    receiveMessage(db,'batch','local','fixture');
    assert.throws(()=>applyActions(db,'batch',[{type:'add',kind:'expense',amount:'20',category:'餐饮'},{type:'refund',id:1,amount:'30'}]),/累计退款超过/);
    assert.equal(listEntries(db).length,0);assert.equal((db.prepare('SELECT COUNT(*) n FROM audit').get() as {n:number}).n,0);
    assert.equal((db.prepare("SELECT status FROM messages WHERE id='batch'").get() as {status:string}).status,'pending');
  }finally{db.close();}
});
test('fixed command storage failures remain retryable and do not become completed validation replies',async()=>{
  const db=openDb(':memory:'),old={...config};
  try {
    config.aiMode='fixed';
    db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
    receiveMessage(db,'storage','local','支出 20 餐饮 奶茶');
    await assert.rejects(processMessage(db,'storage'),/fixture storage failure/);
    assert.equal((db.prepare("SELECT status FROM messages WHERE id='storage'").get() as {status:string}).status,'pending');
    assert.equal(listEntries(db).length,0);
  }finally{Object.assign(config,old);db.close();}
});
test('model cannot invent an original ID or choose the latest expense for an ambiguous refund',()=>{
  assert.equal(validateReferences('早上奶茶退了5元',[{type:'refund',id:1,amount:'5'}])[0].type,'clarify');
  assert.equal(validateReferences('早上奶茶退了5元',[{type:'refund',match:'上一笔',amount:'5'}])[0].type,'clarify');
  assert.equal(validateReferences('给 #1 记退款5元',[{type:'refund',id:1,amount:'5'}])[0].type,'refund');
  assert.deepEqual(validateReferences('刚才那杯改18',[{type:'update',id:1,amount:'18'}]),[{type:'update',amount:'18',match:'上一笔'}]);
});
test('text-only services pass text and structured checks; vision unsupported differs from auth and network',async()=>{
  for(const failure of ['unsupported','auth','network','wrong']){
    const result=await checkConnections(runtime,{feishu:false,fetch:async(input,init)=>{
      const body=await new Request(input,init).json(),image=JSON.stringify(body.input).includes('input_image');
      if(!image)return response('{"amount":"20.00","kind":"expense"}');
      if(failure==='network')throw new TypeError('fixture-secret');
      if(failure==='wrong')return response('{"amount":"30.00","kind":"expense"}');
      return new Response(JSON.stringify({error:{message:failure==='unsupported'?'This model does not support image inputs':'fixture-secret'}}),{status:failure==='unsupported'?400:401,headers:{'Content-Type':'application/json'}});
    }});
    assert.equal(result.find(r=>r.service==='text')?.state,'verified');assert.equal(result.find(r=>r.service==='structured')?.state,'verified');
    assert.equal(result.find(r=>r.service==='vision')?.state,failure==='unsupported'?'unsupported':'unverified');assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  }
});
test('capabilities are tied to service; switching modes keeps conversations, ledger, image drafts and proposals',()=>{
  const dir=mkdtempSync(join(tmpdir(),'money-switch-')),db=openDb(':memory:'),current={...runtime};
  try {
    receiveMessage(db,'seed','local','fixture');applyActions(db,'seed',[{type:'add',kind:'expense',amount:'20',category:'餐饮'},{type:'propose',question:'改18元？',actions:[{type:'update',id:1,amount:'18'}]}]);
    receiveMessage(db,'img','local','fixture-image');db.prepare('INSERT INTO message_images(message_id,path) VALUES(?,?)').run('img','fixture.png');createImageDraft(db,'img',{text:'fixture',transactions:[],summaries:[],excluded:[],duplicate_groups:[],uncertain:false});
    const snapshot=()=>JSON.stringify(['entries','messages','dialogue_pending','image_drafts'].map(t=>db.prepare('SELECT * FROM '+t).all()));const before=snapshot();
    saveCapabilities(db,current,{text:'verified',structured:'verified',vision:'unsupported'});
    saveCapabilities(db,{...current,model:'unsaved-fixture'},{text:'verified',structured:'verified',vision:'unverified'});
    assert.equal(modelCapabilities(db,current).vision,'unsupported');
    saveModelService(db,current,dir,{aiMode:'fixed'});assert.equal(snapshot(),before);assert.equal(modelCapabilities(db,current).vision,'unsupported');
    assert.equal(current.model,runtime.model);assert.equal(current.reasoning,runtime.reasoning);
    saveModelService(db,current,dir,{model:'text-fixture',reasoning:'none',aiMode:'ai',apiType:'chat_completions'});assert.equal(snapshot(),before);assert.equal(modelCapabilities(db,current).vision,'unverified');
    const stored=dotenv.parse(readFileSync(join(dir,'config.env')));assert.equal(stored.AI_API_TYPE,'chat_completions');assert.equal(stored.AI_API_KEY,'fixture');
    assert.equal(setting(db,'model'),'text-fixture');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('fixed and unsupported images retain messages for later retries without any model call',async()=>{
  const db=openDb(':memory:'),old={...config};try {
    Object.assign(config,runtime,{aiMode:'fixed'});receiveMessage(db,'img','local','fixture image');db.prepare('INSERT INTO message_images(message_id,path) VALUES(?,?)').run('img','fixture-missing.png');
    await assert.rejects(processMessage(db,'img'),/未启用AI/);
    Object.assign(config,{aiMode:'ai'});saveCapabilities(db,config,{text:'verified',structured:'verified',vision:'unsupported'});
    await assert.rejects(processMessage(db,'img'),/不支持读图/);assert.ok(db.prepare("SELECT 1 FROM message_images WHERE message_id='img'").get());assert.equal(listEntries(db).length,0);
  }finally{Object.assign(config,old);db.close();}
});
test('model transport respects persisted thinking parameter and rejects incomplete output',async()=>{
  const db=openDb(':memory:');try {
    let calls=0;
    await modelRequest({...runtime,apiType:'chat_completions',chatThinking:'enable_thinking'},{input:[{role:'user',content:'JSON fixture'}],maxTokens:10},{fetch:async(input,init)=>{calls++;const body=await new Request(input,init).json();assert.equal(body.enable_thinking,false);assert.equal(body.reasoning_effort,undefined);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]}),{headers:{'Content-Type':'application/json'}});}});
    await assert.rejects(modelRequest(runtime,{input:[{role:'user',content:'JSON fixture'}],maxTokens:10},{fetch:async()=>new Response(JSON.stringify({status:'incomplete',output:[]}),{headers:{'Content-Type':'application/json'}})}),error=>error instanceof ModelFailure&&error.reason==='format');assert.equal(calls,1);
  }finally{db.close();}
});
test('web setup accepts a text model when vision fails and saves capability status',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'money-text-setup-')),db=openDb(':memory:');
  const {app}=await buildServer(db,{configDir:join(dir,'data'),setupRoot:dir,runtimeConfig:{...config,appId:'',appSecret:'',aiKey:'',aiBaseUrl:'',model:''},restart:()=>{},modelCheck:async()=>[
    {service:'feishu',ok:true,detail:'fixture'},{service:'text',ok:true,state:'verified',detail:'fixture'},{service:'structured',ok:true,state:'verified',detail:'fixture'},{service:'vision',ok:false,state:'unsupported',detail:'fixture'}]});
  try {
    const headers={host:'127.0.0.1:'+config.port},boot=(await app.inject({url:'/api/bootstrap',headers})).json();
    const saved=await app.inject({method:'POST',url:'/api/setup',headers:{...headers,'x-ledger-token':boot.csrf},payload:runtime});assert.equal(saved.statusCode,200,saved.body);assert.equal(modelCapabilities(db,runtime).vision,'unsupported');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
