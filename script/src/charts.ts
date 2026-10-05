import { createCanvas } from '@napi-rs/canvas';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DB } from './db.js';
import { dataDir } from './config.js';
import { summary, money, today, dateSchema } from './ledger.js';
import { accountOverview } from './accounts.js';
import { chartFont } from './chart-font.js';
export const chartRequest=z.object({kind:z.enum(['bill','pie','funds']),start:dateSchema,end:dateSchema}).refine(v=>v.start<=v.end,'开始日不能晚于结束日');
const palette=['#237d6b','#da8d36','#408bb4','#c55e78','#8673ad','#648d45','#bc7151','#718899'];
export function chartSnapshot(db:DB,raw:unknown) {
  const request=chartRequest.parse(raw),stats=summary(db,request.start,request.end),funds=accountOverview(db);
  return { ...request,stats,funds,as_of:today(),generated_at:new Date().toISOString() };
}
export function renderChart(snapshot:ReturnType<typeof chartSnapshot>) {
  const {kind,stats,funds,start,end}=snapshot;
  const rows=kind==='funds'?funds.accounts.map(a=>({name:a.name,amount:a.balance,kind:a.kind})) : stats.categories.map(c=>({...c,kind:'category'}));
  const height=Math.max(760,420+rows.length*52),canvas=createCanvas(1100,height),ctx=canvas.getContext('2d');
  ctx.fillStyle='#f7faf9';ctx.fillRect(0,0,1100,height);
  const text=(s:string,x:number,y:number,size=24,color='#213b35',maxWidth=1000)=>{ctx.fillStyle=color;ctx.font=`${size}px ${chartFont}`;ctx.fillText(s,x,y,maxWidth);};
  text('私人账本',56,60,20,'#618078');
  text(({bill:'收支账单',pie:'支出分类饼图',funds:'资金分布图'})[kind],56,115,40);
  text(kind==='funds'?`资金快照 · ${snapshot.as_of} · 人民币`:`${start} 至 ${end} · 人民币`,56,158,22,'#618078');
  if(kind==='funds') {
    text(`已知资产 ¥${money(funds.assets)}    欠款 ¥${money(funds.debt)}    净资产 ¥${money(funds.net)}`,56,219,26);
    text(`金额待填写 ${funds.unknown} 个账户 · 资产和负债分开显示`,56,260,20,'#618078');
  } else {
    text(`收入 ¥${money(stats.income)}    支出 ¥${money(stats.expense)}    退款 ¥${money(stats.refunds)}`,56,219,25);
    text(`净支出 ¥${money(stats.netExpense)}    结余 ¥${money(stats.balance)}    ${stats.count} 笔记录`,56,264,27);
  }
  const positive=rows.filter(r=>r.amount!==null&&r.amount>0&&(kind!=='funds'||r.kind!=='liability'));
  const total=positive.reduce((n,r)=>n+(r.amount||0),0);
  if(kind==='pie'||kind==='funds') {
    const cx=245,cy=478,radius=148;let angle=-Math.PI/2;
    if(total)positive.forEach((r,i)=>{const next=angle+(r.amount!/total)*Math.PI*2;ctx.fillStyle=palette[i%palette.length];ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,radius,angle,next);ctx.closePath();ctx.fill();angle=next;});
    else {ctx.fillStyle='#e3ece8';ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle='#f7faf9';ctx.beginPath();ctx.arc(cx,cy,85,0,Math.PI*2);ctx.fill();
    text(total?'正值合计':'暂无正值',cx-70,cy-6,20,'#618078',150);text('¥'+money(total),cx-77,cy+27,22,'#213b35',160);
    rows.forEach((row,i)=>{
      const y=338+i*52,pi=positive.indexOf(row);ctx.fillStyle=pi<0?'#becbc6':palette[pi%palette.length];ctx.fillRect(465,y-19,13,13);
      text(row.name+(row.kind==='liability'?'（欠款）':''),490,y,22,'#213b35',365);
      text(row.amount===null?'待填写':'¥'+money(row.amount),860,y,22,row.kind==='liability'?'#bd5a65':'#213b35',185);
    });
    text(kind==='pie'?'按退款到账日期统计。负值分类仅列明细，不放入饼图。':'饼图仅包含正值资产；负债及负值账户列明细，未知金额不计入汇总。',56,height-74,19,'#618078');
  } else {
    text('分类净支出',56,332,24);
    const max=Math.max(1,...rows.map(r=>Math.abs(r.amount||0)));
    rows.forEach((r,i)=>{const y=388+i*52;text(r.name,56,y,23,'#213b35',235);ctx.fillStyle=palette[i%palette.length];ctx.fillRect(325,y-21,Math.abs(r.amount||0)/max*470,23);text('¥'+money(r.amount||0),842,y,23,'#213b35',200);});
    if(!rows.length)text('本期暂无收支记录',56,416,24,'#618078');
    text('退款按到账日期抵减。转账与本金还款不计入收支。',56,height-74,20,'#618078');
  }
  text('由本地数据库绘制 · 金额以分计算 · '+snapshot.generated_at.replace('T',' ').slice(0,19)+' UTC',56,height-32,16,'#7b9088');
  return canvas.toBuffer('image/png');
}
export function createChart(db:DB,raw:unknown,messageId?:string,directory=join(dataDir,'charts')) {
  const snapshot=chartSnapshot(db,raw),id=randomUUID(),path=join(directory,id+'.png');
  mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(path,renderChart(snapshot),{mode:0o600});
  db.prepare('INSERT INTO chart_files(id,message_id,kind,path,snapshot_json,created_at) VALUES(?,?,?,?,?,?)').run(id,messageId??null,snapshot.kind,path,JSON.stringify(snapshot),snapshot.generated_at);
  return {id,path,url:'/api/charts/file/'+id,snapshot};
}
