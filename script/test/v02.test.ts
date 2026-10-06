import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,copyFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCanvas} from '@napi-rs/canvas';
import sharp from 'sharp';
import {openDb} from '../src/db.js';
import {savePossession,usage,listPossessions,archivePossession} from '../src/possessions.js';
import {saveLoan,drawLoan,repayLoan,loanOverview,saveInstallment,installments,projectedMonths,getLoan} from '../src/loans.js';
import {saveAccount,getAccount,accountOverview} from '../src/accounts.js';
import {cancelEntry,createEntry,summary,today,updateEntry} from '../src/ledger.js';
import {applyActions,receiveMessage,processMessage,protectImageActions} from '../src/assistant.js';
import {parseActions} from '../src/ai.js';
import {chartSnapshot,renderChart,createChart} from '../src/charts.js';
import {normalizeImage,decodeImageDataUrl} from '../src/images.js';
import {backupAssets,restoreAssets} from '../src/backup-assets.js';
import {Readable} from 'node:stream';
import {downloadFeishuImage,FeishuImageError} from '../src/feishu-images.js';
test('Feishu image downloads report permission errors separately and retry transient failures',async()=>{
  const permission={response:{status:400,data:Readable.from([JSON.stringify({code:99991672,msg:'Access denied'})])}};
  await assert.rejects(downloadFeishuImage(async()=>{throw permission;}),error=>error instanceof FeishuImageError&&!error.retryable&&error.message.includes('im:message:readonly')&&!error.message.includes('模型'));
  await assert.rejects(downloadFeishuImage(async()=>{throw {response:{status:503,data:{}}};}),error=>error instanceof FeishuImageError&&error.retryable);
  await assert.rejects(downloadFeishuImage(async()=>{throw {response:{status:404,data:{}}};}),error=>error instanceof FeishuImageError&&!error.retryable);
  const bytes=Buffer.from('image bytes');assert.deepEqual(await downloadFeishuImage(async()=>({getReadableStream:()=>Readable.from([bytes])})),bytes);
  await assert.rejects(downloadFeishuImage(async()=>({getReadableStream:()=>Readable.from([Buffer.alloc(8*1024*1024+1)])})),error=>error instanceof FeishuImageError&&!error.retryable&&error.message.includes('8MB'));
});
test('possessions calculate exact calendar days, preserve unknowns and never duplicate expense or assets',()=>{
  const db=openDb(':memory:');const p=savePossession(db,{name:'手机',price:300000,purchased_on:'2021-09-30'});
  assert.equal(usage(p,'2026-10-06').usage_days,1832);assert.equal(usage({...p,purchased_on:'2024-02-28'},'2024-03-01').usage_days,2);
  assert.equal(usage({...p,purchased_on:'2026-10-06'},'2026-10-06').daily_cost,300000);
  assert.equal(usage({...p,price:null}).daily_cost,null);assert.equal(usage({...p,retired_on:'2021-10-10'},'2026-10-06').usage_days,10);
  assert.throws(()=>savePossession(db,{name:'未来',price:1,purchased_on:'2099-01-01'}));
  receiveMessage(db,'p','local','手机备注常用');applyActions(db,'p',parseActions({actions:[{type:'possession_update',name:'手机',note:'常用'}]}));
  assert.equal(listPossessions(db)[0].price,300000);assert.equal(listPossessions(db)[0].purchased_on,'2021-09-30');
  archivePossession(db,p.id,true);assert.equal(listPossessions(db).length,0);archivePossession(db,p.id,false);assert.equal(listPossessions(db).length,1);
  assert.equal(summary(db,'2021-01-01',today()).expense,0);assert.equal(accountOverview(db).assets,0);db.close();
});
test('loan balances share liability accounts; draws and repayments separate principal from interest and reverse correctly',()=>{
  const db=openDb(':memory:'),cash=saveAccount(db,{name:'余额',kind:'cash',balance:100000});
  const loan=saveLoan(db,{name:'助学贷款',balance:2000000,category:'student',note:'大四后读研三年，合同待补全'});
  assert.equal(loan.repayment_start,null);assert.equal(accountOverview(db).debt,loanOverview(db).total);
  drawLoan(db,loan.account_id,{amount:1200000,date:today()});assert.equal(getLoan(db,loan.account_id).balance,3200000);assert.equal(getAccount(db,cash.id).balance,100000);
  drawLoan(db,loan.account_id,{amount:50000,date:today(),cash_account_id:cash.id});assert.equal(getAccount(db,cash.id).balance,150000);
  const i=saveInstallment(db,loan.account_id,{due_date:today(),principal:10000,interest:500});
  const r=repayLoan(db,loan.account_id,{amount:10000,interest:500,date:today(),cash_account_id:cash.id,installment_id:i.id});
  assert.equal(getAccount(db,cash.id).balance,139500);assert.equal(getLoan(db,loan.account_id).balance,3240000);assert.equal(summary(db,today(),today()).expense,500);
  assert.equal(installments(db,loan.account_id)[0].paid_principal,10000);assert.equal(loanOverview(db).this_month,0);
  assert.throws(()=>updateEntry(db,r.principal!.id,{...r.principal!,amount:12000}),/请先撤销/);
  assert.throws(()=>repayLoan(db,loan.account_id,{amount:1,date:today(),cash_account_id:cash.id,installment_id:i.id}));
  cancelEntry(db,r.principal!.id);assert.equal(installments(db,loan.account_id)[0].paid_principal,0);assert.equal(getLoan(db,loan.account_id).balance,3250000);
  assert.throws(()=>repayLoan(db,loan.account_id,{amount:999999999,date:today(),cash_account_id:cash.id}));
  const balance=getAccount(db,cash.id).balance;assert.throws(()=>repayLoan(db,loan.account_id,{amount:1,interest:10,date:'2099-01-01',cash_account_id:cash.id}));assert.equal(getAccount(db,cash.id).balance,balance);
  repayLoan(db,loan.account_id,{amount:0,interest:100,date:today(),cash_account_id:cash.id});assert.equal(getLoan(db,loan.account_id).balance,3250000);db.close();
});
test('monthly previews clamp due dates and preserve contractual unknowns; plans do not execute payments',()=>{
  const db=openDb(':memory:');const l=saveLoan(db,{name:'分期',balance:100000,category:'monthly',repayment_start:'2028-01-31',monthly_payment:10000,due_day:31});
  const schedule=projectedMonths(l,'2028-01-01');assert.equal(schedule[1].due_date,'2028-02-29');assert.equal(schedule[3].due_date,'2028-04-30');
  assert.deepEqual(projectedMonths({...l,monthly_payment:null}),[]);
  saveInstallment(db,l.account_id,{due_date:'2028-01-31',principal:9000,interest:1000});assert.equal(getLoan(db,l.account_id).balance,100000);assert.equal(summary(db,today(),today()).count,0);db.close();
});
test('bill, pie and funds PNGs use integer-cent snapshots, negative refunds and unknown balances without fabricated amounts',async()=>{
  const db=openDb(':memory:');const e=createEntry(db,{kind:'expense',amount:1280,date:'2026-09-30',category:'餐饮'});
  createEntry(db,{kind:'refund',amount:1280,date:'2026-10-01',category:'餐饮',parent_id:e.id});createEntry(db,{kind:'expense',amount:2000,date:'2026-10-01',category:'购物'});
  saveAccount(db,{name:'微信',kind:'cash',balance:10001});saveAccount(db,{name:'美团月付',kind:'liability',balance:15000});saveAccount(db,{name:'未知',kind:'investment',balance:null});
  for(const kind of ['bill','pie','funds']) {
    const s=chartSnapshot(db,{kind,start:'2026-10-01',end:'2026-10-31'});assert.equal(s.stats.netExpense,720);assert.equal(s.funds.assets,10001);assert.equal(s.funds.debt,15000);assert.equal(s.stats.categories.find(c=>c.name==='餐饮')!.amount,-1280);
    const image=renderChart(s),m=await sharp(image).metadata();assert.equal(m.format,'png');assert.equal(m.width,1100);
    const {data}=await sharp(image).removeAlpha().raw().toBuffer({resolveWithObject:true});assert.ok(data.some(v=>v<100),'chart contains visible content');
  }
  const dir=mkdtempSync(join(tmpdir(),'ledger-chart-'));try{const c=createChart(db,{kind:'funds',start:today(),end:today()},'test',dir);assert.equal(statSync(c.path).mode&0o777,0o600);}finally{rmSync(dir,{recursive:true,force:true});db.close();}
});
test('image validation and cached OCR expose text without writing financial records',async()=>{
  const bytes=createCanvas(200,100).toBuffer('image/png');assert.equal((await sharp(await normalizeImage(bytes)).metadata()).format,'png');
  assert.deepEqual(decodeImageDataUrl('data:image/png;base64,'+bytes.toString('base64')),bytes);assert.throws(()=>decodeImageDataUrl('https://example.com/a.png'));await assert.rejects(normalizeImage(Buffer.from('not an image')));
  const db=openDb(':memory:');receiveMessage(db,'image','local','[用户上传图片]');db.prepare('INSERT INTO message_images(message_id,path,extracted_text) VALUES(?,?,?)').run('image','cached-only','奶茶 实付20.00');
  assert.match(await processMessage(db,'image'),/尚未修改账本/);assert.equal(summary(db,today(),today()).count,0);assert.equal(await processMessage(db,'image'),(db.prepare('SELECT result FROM messages WHERE id=?').get('image') as {result:string}).result);db.close();
});
test('image-derived writes are forced into confirmation and the same image cannot import twice',async()=>{
  const db=openDb(':memory:');receiveMessage(db,'source','local','[图片]');db.prepare('INSERT INTO message_images(message_id,path,extracted_text) VALUES(?,?,?)').run('source','cached','CoCo奶茶20');await processMessage(db,'source');
  receiveMessage(db,'book','local','记进去');const actions=protectImageActions(db,'book','local','记进去',parseActions({actions:[{type:'add',kind:'expense',amount:'20',date:today(),category:'餐饮'}]}));
  assert.equal(actions[0].type,'propose');applyActions(db,'book',actions);assert.equal(summary(db,today(),today()).expense,0);
  receiveMessage(db,'yes','local','确认');await processMessage(db,'yes');assert.equal(summary(db,today(),today()).expense,2000);
  receiveMessage(db,'again','local','把图片再次入账');const blocked=protectImageActions(db,'again','local','把图片再次入账',parseActions({actions:[{type:'add',kind:'expense',amount:'20',date:today(),category:'餐饮'}]}));
  assert.equal(blocked[0].type,'reply');applyActions(db,'again',blocked);assert.equal(summary(db,today(),today()).expense,2000);db.close();
});
test('chart and image attachment backups restore portable local paths and pending chart delivery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ledger-files-')),path=join(dir,'source.sqlite'),snapshot=join(dir,'backup.sqlite'),restored=join(dir,'restore.sqlite');
  const db=openDb(path);try{
    const chart=createChart(db,{kind:'funds',start:today(),end:today()},'chart',join(dir,'charts'));
    receiveMessage(db,'image','local','图片');db.prepare('INSERT INTO message_images(message_id,path,extracted_text) VALUES(?,?,?)').run('image',chart.path,'测试文字');
    db.prepare('INSERT INTO outbox(user_id,text,dedup,image_path,created_at) VALUES(?,?,?,?,?)').run('owner','','chart-test',chart.path,new Date().toISOString());
    await db.backup(snapshot);backupAssets(snapshot);assert.ok(existsSync(join(snapshot+'.files','images',chart.id+'.png')));assert.ok(existsSync(join(snapshot+'.files','charts',chart.id+'.png')));
    copyFileSync(snapshot,restored);const target=join(dir,'portable');restoreAssets(snapshot,restored,target);const check=openDb(restored);
    try{assert.equal((check.prepare('SELECT path FROM message_images').get() as {path:string}).path,join(target,'images',chart.id+'.png'));assert.equal((check.prepare('SELECT image_path FROM outbox').get() as {image_path:string}).image_path,join(target,'charts',chart.id+'.png'));assert.ok(existsSync(join(target,'charts',chart.id+'.png')));}finally{check.close();}
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
