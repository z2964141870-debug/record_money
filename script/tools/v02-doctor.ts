import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
import {openDb} from '../src/db.js';
import {initializeAccounts,findAccount} from '../src/accounts.js';
import {receiveMessage,processMessage} from '../src/assistant.js';
import {saveImage,extractImageText} from '../src/images.js';
import {findPossession} from '../src/possessions.js';
import {getLoan} from '../src/loans.js';
import {pendingDialogue} from '../src/conversation.js';
import {chartFont} from '../src/chart-font.js';
const db=openDb(':memory:');initializeAccounts(db);
try {
  const canvas=createCanvas(800,360),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,800,360);ctx.fillStyle='black';ctx.font='38px '+chartFont;
  ctx.fillText('测试收据 / RECEIPT',40,70);ctx.fillText('CoCo 奶茶 20.00 元',40,145);ctx.fillText('已支付 2026-10-06',40,220);
  const path=await saveImage(canvas.toBuffer('image/png')),ocr=await extractImageText(db,path);
  assert.match(ocr.text,/20[.．]00/);assert.match(ocr.text,/CoCo/i);assert.match(ocr.text,/奶茶/);assert.match(ocr.text,/已支付/);console.log('真实模型读图：中文文字、商家及20.00金额识别成功。');
  const examples=[
    '我的验收手机是iPhone验收机，2021年9月30日买的，当时3000元，保存到物品清单，不要记支出。',
    '我有一笔验收助学贷款，现在尚欠本金24000元，大四，之后还要读研三年，银行开始还款日期暂时不知道，只保存贷款信息。',
    '今年新增加这笔验收助学贷款12000元，今天已发生，只累计本金，不知道到账账户。',
    'iPhone验收机已经用多久，平均每天多少钱？',
    '给我发一张本月支出饼图',
  ];
  for(const [i,text] of examples.entries()){receiveMessage(db,'v02:'+i,'local',text);console.log('v0.2联调：'+await processMessage(db,'v02:'+i));}
  const item=findPossession(db,'iPhone验收机');assert.equal(item.price,300000);assert.equal(item.purchased_on,'2021-09-30');
  const loan=getLoan(db,findAccount(db,'验收助学贷款').id);assert.equal(loan.balance,3600000);assert.equal(loan.repayment_start,null);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM chart_files').get() as {n:number}).n,1);
  receiveMessage(db,'v02:image','local','[用户上传图片]');db.prepare('INSERT INTO message_images(message_id,path,extracted_text) VALUES(?,?,?)').run('v02:image',path,ocr.text);
  await processMessage(db,'v02:image');receiveMessage(db,'v02:image-book','local','把这张图片记到账本');console.log('图片入账方案：'+await processMessage(db,'v02:image-book'));
  assert.ok(pendingDialogue(db,'local'),'图片入账需先确认');assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);
  receiveMessage(db,'v02:image-confirm','local','确认');await processMessage(db,'v02:image-confirm');assert.equal((db.prepare('SELECT SUM(amount) n FROM entries').get() as {n:number}).n,2000);
  console.log('v0.2核验通过：物品未重复记支出，助学贷款累计36000元，起始日未知保留，图表来自数据库。');
}finally{db.close();}
