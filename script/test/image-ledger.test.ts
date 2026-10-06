import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type DB } from '../src/db.js';
import { saveAccount } from '../src/accounts.js';
import { applyActions, processMessage, protectImageActions, receiveMessage } from '../src/assistant.js';
import { createImageDraft, latestImageDraft, renderImageDraft, reviewImageDraft, imageAlreadyImported, type ImageAnalysis } from '../src/image-ledger.js';
import { pendingDialogue } from '../src/conversation.js';
import { createEntry, summary, today } from '../src/ledger.js';
import { parseActions } from '../src/ai.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const row = (patch: Partial<ImageAnalysis['transactions'][number]> = {}): ImageAnalysis['transactions'][number] => ({
  merchant:'烤肉',amount:'58.99',kind:'expense',date:null,month_day:'10-03',time:'14:32',category:'餐饮',subcategory:'正餐',account:null,to_account:null,currency:'CNY',external_id:null,uncertainties:[],...patch,
});
const analysis = (transactions = [row(),row(),row({merchant:'公交',amount:'0.70',time:'13:12',category:'交通'}),row({merchant:'收益',amount:'0.03',kind:'income',time:'03:22',category:'收入'}),row({merchant:'零食',amount:'6.50',month_day:'10-02',time:'21:48'}),row({merchant:'收益',amount:'0.03',kind:'income',month_day:'10-02',time:'02:12',category:'收入'})]):ImageAnalysis => ({
  text:'账单测试',transactions,summaries:[{label:'月支出',amount:'128.68'},{label:'月收入',amount:'2400.00'}],excluded:['顶部只剩上一条记录时间，商户金额被裁切'],duplicate_groups:[],uncertain:false,
});
function seed(db:DB,id='image',user='local',a=analysis(),hash='same-image') {
  receiveMessage(db,id,user,'[图片]');db.prepare('INSERT INTO message_images(message_id,path,content_hash) VALUES(?,?,?)').run(id,'fixture-cached',hash);
  return createImageDraft(db,id,a);
}
test('structured rows retain dates, compute cents and exclude monthly summaries without guessing year or account',async()=>{
  const db=openDb(':memory:');const draft=seed(db);const text=await processMessage(db,'image');
  assert.match(text,/支出125.18元/);assert.match(text,/收入0.06元/);assert.match(text,/结余-125.12元/);
  assert.match(text,/不作为交易/);assert.match(text,/年份待补全/);assert.match(text,/账户待补全/);assert.match(text,/疑似重复/);
  assert.equal(draft.rows[0].time,'14:32');assert.equal(draft.rows[3].time,'03:22');assert.equal(draft.rows[5].time,'02:12');
  assert.equal(summary(db,today(),today()).count,0);assert.equal(pendingDialogue(db,'local'),undefined);db.close();
});
test('year/account alone cannot confirm duplicates; final confirmation imports an immutable persisted selection once',async()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'支付宝余额',kind:'cash',balance:100000});seed(db);await processMessage(db,'image');
  receiveMessage(db,'fill','local','2025年，支付宝余额');const result=applyActions(db,'fill',[{type:'image_review',request:'preview',year:2025,account:'支付宝余额'}]);
  assert.match(result,/疑似重复/);assert.equal(pendingDialogue(db,'local'),undefined);
  receiveMessage(db,'keep','local','两笔烤肉都保留');applyActions(db,'keep',[{type:'image_review',request:'preview',rows:[{row:1,decision:'keep'},{row:2,decision:'keep'}]}]);
  assert.ok(pendingDialogue(db,'local'));assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);
  receiveMessage(db,'confirm','local','可以，就这样');await processMessage(db,'confirm');
  const s=summary(db,'2025-10-01','2025-10-31');assert.equal(s.count,6);assert.equal(s.expense,12518);assert.equal(s.income,6);
  assert.equal(imageAlreadyImported(db,'image'),true);await processMessage(db,'confirm');assert.equal(summary(db,'2025-10-01','2025-10-31').count,6);
  seed(db,'resend','local',analysis());assert.match(await processMessage(db,'resend'),/不再次导入/);assert.equal(summary(db,'2025-10-01','2025-10-31').count,6);db.close();
});
test('skips change deterministic totals and supersede prior proposals; image edits never auto-confirm',async()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});seed(db);await processMessage(db,'image');
  receiveMessage(db,'fill','local','R1保留，R2跳过，2025年余额');applyActions(db,'fill',[{type:'image_review',request:'preview',year:2025,account:'余额',rows:[{row:1,decision:'keep'},{row:2,decision:'skip'}]}]);
  const first=pendingDialogue(db,'local')!;assert.equal(JSON.parse(first.actions_json).length,5);assert.match(first.question,/支出66.19元/);
  receiveMessage(db,'edit','local','年份改为2024，R3改0.80');applyActions(db,'edit',[{type:'image_review',request:'preview',year:2024,rows:[{row:3,amount:'0.80'}]}]);
  const second=pendingDialogue(db,'local')!;assert.notEqual(first.id,second.id);assert.match(second.question,/支出66.29元/);
  assert.ok(JSON.parse(second.actions_json).every((a:{date:string})=>a.date.startsWith('2024-')));
  receiveMessage(db,'not-confirm','local','年份已经补好了');assert.match(applyActions(db,'not-confirm',[{type:'confirm_pending'}]),/仍待确认/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);db.close();
});
test('missing amount, unknown direction, currency, blur and unknown account block proposals',()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});const draft=seed(db,'image','local',analysis([row({amount:null,kind:'unknown',currency:'other',uncertainties:['金额模糊']})]));
  const result=reviewImageDraft(db,draft,{type:'image_review',year:2025,account:'余额'});assert.equal(result.proposal,undefined);assert.match(result.text,/金额待补全/);assert.match(result.text,/收支方向/);assert.match(result.text,/仅支持人民币/);
  assert.throws(()=>reviewImageDraft(db,draft,{type:'image_review',account:'不存在'}),/账户/);db.close();
});
test('refunds require original entry and transfers require two real accounts',()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});saveAccount(db,{name:'微信',kind:'cash',balance:0});
  const expense=createEntry(db,{kind:'expense',amount:1000,date:'2025-10-01',category:'餐饮'});
  const draft=seed(db,'image','local',analysis([row({kind:'refund',amount:'10.00',merchant:'退款'}),row({kind:'transfer',amount:'20.00',merchant:'转账'})]));
  assert.equal(reviewImageDraft(db,draft,{type:'image_review',year:2025,account:'余额'}).proposal,undefined);
  const ready=reviewImageDraft(db,draft,{type:'image_review',rows:[{row:1,parent_id:expense.id},{row:2,to_account:'微信'}]});assert.ok(ready.proposal);
  assert.equal(ready.proposal!.actions[0].type,'refund');db.close();
});
test('overlapping ledger rows require explicit keep and arbitrary model mutations cannot bypass review',async()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});createEntry(db,{kind:'expense',amount:5899,date:'2025-10-03',category:'餐饮',merchant:'烤肉'});
  seed(db,'image','local',analysis([row()]));await processMessage(db,'image');receiveMessage(db,'review','local','记进去');
  const draft=latestImageDraft(db,'local','review')!;assert.match(reviewImageDraft(db,draft,{type:'image_review',year:2025,account:'余额'}).text,/与已有记录/);
  const blocked=protectImageActions(db,'review','local','把图片入账',[{type:'add',kind:'expense',amount:'58.99',date:'2025-10-03',category:'餐饮'}]);assert.equal(blocked[0].type,'reply');
  assert.ok(reviewImageDraft(db,draft,{type:'image_review',rows:[{row:1,decision:'keep'}]}).proposal);db.close();
});
test('image cancellation, user isolation and changed ledger protect confirmation',async()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});seed(db,'image','local',analysis([row()]));await processMessage(db,'image');
  receiveMessage(db,'other','stranger','核对图片');assert.equal(latestImageDraft(db,'stranger','other'),undefined);
  receiveMessage(db,'fill','local','2025年余额');applyActions(db,'fill',[{type:'image_review',request:'preview',year:2025,account:'余额'}]);
  createEntry(db,{kind:'income',amount:100,date:today(),category:'其他'});
  receiveMessage(db,'stale','local','确认入账');assert.match(await processMessage(db,'stale'),/账本已有变化/);assert.equal(imageAlreadyImported(db,'image'),false);
  receiveMessage(db,'cancel','local','取消图片');await processMessage(db,'cancel');receiveMessage(db,'revive','local','确认入账');assert.match(await processMessage(db,'revive'),/清单已取消/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,1);db.close();
});
test('a corrected draft preserves original analysis and a zero amount is blocked without crashing',()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});const draft=seed(db,'image','local',analysis([row({amount:'0.00'})]));
  assert.match(renderImageDraft(db,draft),/金额待补全/);const ready=reviewImageDraft(db,draft,{type:'image_review',year:2025,account:'余额',rows:[{row:1,amount:'1.25',date:'2025-10-02',time:'09:30'}]});
  assert.ok(ready.proposal);assert.equal(draft.analysis.transactions[0].amount,'0.00');assert.match(ready.text,/09:30/);db.close();
});
test('display-only summaries accept source currency formatting and never affect transaction sums',()=>{
  const db=openDb(':memory:');const a=analysis([row({amount:'1.25'})]);a.summaries=[{label:'收入',amount:'¥2,400.00'},{label:'支出',amount:'¥128.68'}];
  const draft=seed(db,'image','local',a);const text=renderImageDraft(db,draft);assert.match(text,/支出1.25元/);assert.match(text,/¥2,400.00/);assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);db.close();
});
test('model row identifiers normalize R labels while rejecting invalid or nonexistent references',()=>{
  const parsed=parseActions({actions:[{type:'image_review',rows:[{row:'R1',decision:'keep'},{row:'2',decision:'skip'}]}]})[0];
  assert.equal(parsed.type,'image_review');if(parsed.type==='image_review')assert.deepEqual(parsed.rows?.map(r=>r.row),[1,2]);
  assert.throws(()=>parseActions({actions:[{type:'image_review',rows:[{row:'R999'}]}]}));
});
test('multiple refunds in an image validate their combined amount against the original expense',()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});const original=createEntry(db,{kind:'expense',amount:1000,date:'2025-10-01',category:'餐饮'});
  const draft=seed(db,'image','local',analysis([row({merchant:'退款一',kind:'refund',amount:'6.00'}),row({merchant:'退款二',kind:'refund',amount:'6.00'})]));
  const checked=reviewImageDraft(db,draft,{type:'image_review',year:2025,account:'余额',rows:[{row:1,parent_id:original.id},{row:2,parent_id:original.id}]});
  assert.equal(checked.proposal,undefined);assert.match(checked.text,/累计金额不匹配/);db.close();
});
test('image review and final pending selection survive database reopening',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ledger-image-review-')),path=join(dir,'ledger.sqlite');let db=openDb(path);
  try {
    saveAccount(db,{name:'余额',kind:'cash',balance:100000});seed(db,'image','local',analysis([row()]));await processMessage(db,'image');db.close();db=openDb(path);
    receiveMessage(db,'fill','local','2025年余额');applyActions(db,'fill',[{type:'image_review',request:'preview',year:2025,account:'余额'}]);db.close();db=openDb(path);
    assert.equal(pendingDialogue(db,'local')!.source_image_id,'image');receiveMessage(db,'confirm','local','确认入账');await processMessage(db,'confirm');
    assert.equal(summary(db,'2025-10-01','2025-10-31').expense,5899);assert.equal(imageAlreadyImported(db,'image'),true);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
test('a failed image batch rolls back entries and leaves the import marker unset',async()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});const second=saveAccount(db,{name:'第二账户',kind:'cash',balance:0});
  seed(db,'image','local',analysis([row(),row({merchant:'公交',amount:'0.70'})]));await processMessage(db,'image');receiveMessage(db,'fill','local','2025年两个账户');
  applyActions(db,'fill',[{type:'image_review',request:'preview',year:2025,account:'余额',rows:[{row:2,account:'第二账户'}]}]);
  db.prepare('DELETE FROM accounts WHERE id=?').run(second.id);receiveMessage(db,'confirm','local','确认入账');await assert.rejects(processMessage(db,'confirm'),/账户/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);assert.equal(imageAlreadyImported(db,'image'),false);assert.ok(pendingDialogue(db,'local'));db.close();
});
test('a confirmed fifty-row image batch is not limited by the normal message action count',async()=>{
  const db=openDb(':memory:');saveAccount(db,{name:'余额',kind:'cash',balance:100000});
  seed(db,'image','local',analysis(Array.from({length:50},(_,i)=>row({merchant:'商户'+(i+1),amount:'1.00',date:'2025-01-01',month_day:'01-01',time:null,account:'余额'}))));
  await processMessage(db,'image');assert.equal(JSON.parse(pendingDialogue(db,'local')!.actions_json).length,50);
  receiveMessage(db,'confirm','local','确认入账');await processMessage(db,'confirm');assert.equal(summary(db,'2025-01-01','2025-01-01').expense,5000);assert.equal(summary(db,'2025-01-01','2025-01-01').count,50);db.close();
});
