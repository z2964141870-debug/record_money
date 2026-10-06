import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync,openSync,closeSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { once } from 'node:events';
import { saveSetupConfig,saveConfigFields } from '../src/config-files.js';

const args=process.argv.slice(2);
function argument(key:string){const i=args.indexOf(key);return i<0?undefined:args[i+1];}
const home=resolve(argument('--home')||'../data/qa/runtime-smoke');
const external=argument('--url'),serverFile=resolve(argument('--server')||'build/start.js'),node=argument('--node')||process.execPath;
let child:ReturnType<typeof spawn>|undefined,stream:number|undefined;
let url=external||'';
async function start() {
  const portServer=createServer();await new Promise<void>(done=>portServer.listen(0,'127.0.0.1',done));const port=(portServer.address() as {port:number}).port;await new Promise<void>(done=>portServer.close(()=>done()));
  saveSetupConfig(home,home,{aiMode:'fixed',appId:'cli_fixture',appSecret:'fixture',port});saveConfigFields(join(home,'data'),{FEISHU_ENABLED:'false'});
  mkdirSync(join(home,'logs'),{recursive:true});stream=openSync(join(home,'logs/smoke.log'),'a',0o600);
  child=spawn(node,[serverFile],{stdio:['ignore',stream,stream],env:{...process.env,LEDGER_DATA_DIR:join(home,'data'),LEDGER_LOGS_DIR:join(home,'logs'),FEISHU_ENABLED:'false',PORT:String(port),LEDGER_WEB_PORT:String(port),AI_MODE:'fixed',AI_API_KEY:'',AI_BASE_URL:'',AI_MODEL:''}});
  url='http://127.0.0.1:'+port;
}
async function stop(){if(child){const exit=once(child,'exit');child.kill('SIGTERM');await exit;child=undefined;}if(stream!==undefined){closeSync(stream);stream=undefined;}}
async function bootstrap(){
  for(let i=0;i<100;i++){try{const r=await fetch(url+'/api/bootstrap');if(r.ok)return await r.json();}catch{}await new Promise(done=>setTimeout(done,100));}
  throw new Error('服务未启动：'+url);
}
try {
  if(!external)await start();
  let boot=await bootstrap();assert.equal(boot.setupRequired,false);
  const call=async(path:string,body?:unknown)=>{const r=await fetch(url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Ledger-Token':boot.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
  assert.equal((await call('/status')).aiMode,'fixed');
  const receipt=await call('/chat',{text:'支出 20 餐饮 固定格式验收'});assert.match(receipt.result,/20.00/);
  const id=(await call('/entries')).find((e:{message_id:string})=>e.message_id)?.id;assert.ok(id);
  await call('/chat',{text:'修改 #'+id+' 金额 18'});await call('/chat',{text:'退款 #'+id+' 5'});
  assert.match((await call('/chat',{text:'今日账单'})).result,/净支出 13.00/);
  for(const text of ['本月账单图','本月饼图','资金分布图']){
    const chart=await call('/chat',{text});assert.equal(chart.images.length,1);
    const image=Buffer.from(await (await fetch(url+chart.images[0])).arrayBuffer());assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(image.length>1000);
  }
  await call('/possessions',{name:'验收手机',price:300000,purchased_on:'2021-09-30'});
  await call('/loans',{name:'验收贷款',balance:2400000,category:'student'});
  await call('/accounts',{name:'验收现金',kind:'cash',balance:12345});
  assert.equal((await call('/accounts')).accounts.some((a:{name:string;balance:number})=>a.name==='验收现金'&&a.balance===12345),true);
  const csv=await fetch(url+'/api/export');assert.equal(csv.status,200);assert.match(await csv.text(),/固定格式验收/);
  await call('/backup',{});
  const before=await call('/entries');
  if(!external){await stop();await start();boot=await bootstrap();assert.deepEqual(await call('/entries'),before);assert.equal((await call('/possessions')).length,1);assert.equal((await call('/loans')).loans.some((l:{name:string})=>l.name==='验收贷款'),true);assert.equal((await call('/accounts')).accounts.some((a:{name:string;balance:number})=>a.name==='验收现金'&&a.balance===12345),true);}
  console.log(JSON.stringify({passed:true,url,mode:'fixed',modelConfigured:false,charts:3,entries:before.length,restarted:!external}));
}finally{await stop();}
