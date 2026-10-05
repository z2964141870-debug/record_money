import { z } from 'zod';
import type { DB } from './db.js';
import { cents, dateSchema, money, today } from './ledger.js';
import { findAccount } from './accounts.js';
import { findPossession, savePossession, possessionText } from './possessions.js';
import { getLoan, saveLoan, drawLoan, repayLoan, loanText, saveInstallment } from './loans.js';
import { createChart } from './charts.js';
const amount=z.string().regex(/^\d+(\.\d{1,2})?$/);
const name=z.string().min(1).max(100);
export const domainSchema=z.union([
  z.object({type:z.enum(['possession_create','possession_update']),name,category:z.string().max(30).optional(),price:amount.nullable().optional(),purchased_on:dateSchema.nullable().optional(),retired_on:dateSchema.nullable().optional(),note:z.string().max(1000).optional()}),
  z.object({type:z.literal('possessions_query'),name:name.optional()}),
  z.object({type:z.enum(['loan_create','loan_update']),name,balance:amount.nullable().optional(),category:z.enum(['student','monthly','personal','other']).optional(),creditor:name.optional(),repayment_start:dateSchema.nullable().optional(),monthly_payment:amount.nullable().optional(),due_day:z.number().int().min(1).max(31).nullable().optional(),maturity_date:dateSchema.nullable().optional(),annual_rate:z.string().nullable().optional(),subsidy_until:dateSchema.nullable().optional(),note:z.string().max(1000).optional()}),
  z.object({type:z.literal('loans_query')}),
  z.object({type:z.enum(['loan_draw','loan_repay']),name,amount,date:dateSchema,cash_account:name.optional(),interest:amount.optional(),installment_id:z.number().int().positive().optional(),note:z.string().max(1000).optional()}),
  z.object({type:z.literal('loan_installment'),name,due_date:dateSchema,principal:amount,interest:amount.optional(),note:z.string().max(1000).optional()}),
  z.object({type:z.literal('chart'),kind:z.enum(['bill','pie','funds']),start:dateSchema.optional(),end:dateSchema.optional()}),
]);
export type DomainAction=z.infer<typeof domainSchema>;
export function decimalCents(value:string) { return /^0(?:\.0{1,2})?$/.test(value) ? 0 : cents(value); }
export function applyDomain(db:DB,action:DomainAction,message:{id:string;user_id:string}) {
  switch(action.type) {
    case 'possession_create':case 'possession_update': {
      const before=action.type==='possession_update'?findPossession(db,action.name):null;
      savePossession(db,{...before,...action,price:action.price===undefined?before?.price??null:action.price===null?null:decimalCents(action.price),purchased_on:action.purchased_on===undefined?before?.purchased_on??null:action.purchased_on},before?.id);
      return '物品清单已保存，未重复新增购买支出。\n'+possessionText(db,action.name);
    }
    case 'possessions_query':return possessionText(db,action.name);
    case 'loan_create':case 'loan_update': {
      const before=action.type==='loan_update'?getLoan(db,findAccount(db,action.name).id):null;
      const loan=saveLoan(db,{...before,...action,balance:action.balance===undefined?before?.balance??null:action.balance===null?null:decimalCents(action.balance),monthly_payment:action.monthly_payment===undefined?before?.monthly_payment??null:action.monthly_payment===null?null:decimalCents(action.monthly_payment)},before?.account_id);
      return `已保存贷款 ${loan.name} · 尚欠本金 ${loan.balance===null?'待补全':money(loan.balance)+'元'}\n开始还款 ${loan.repayment_start||'待补全'} · 已合并到负债统计，不重复计入收入或支出。`;
    }
    case 'loans_query':return loanText(db);
    case 'loan_draw':case 'loan_repay': {
      const id=findAccount(db,action.name).id,cash=action.cash_account?findAccount(db,action.cash_account).id:undefined;
      if(action.type==='loan_repay') {
        if(!cash)throw new Error('请说明从哪个现金账户还款');
        const r=repayLoan(db,id,{amount:decimalCents(action.amount),interest:decimalCents(action.interest||'0'),date:action.date,cash_account_id:cash,installment_id:action.installment_id,note:action.note||''},message.id);
        return `已还 ${r.loan.name} 本金 ${action.amount}元 · 利息 ${action.interest||'0'}元\n尚欠本金 ${money(r.loan.balance!)}元 · 本金不计入支出。`;
      }
      const l=drawLoan(db,id,{amount:cents(action.amount),date:action.date,cash_account_id:cash,note:action.note||''},message.id);
      return `已累计 ${l.name} 新借本金 ${action.amount}元 · 尚欠本金 ${money(l.balance!)}元${cash?'，到账账户已同步':'；未指定到账账户，仅增加贷款本金'}。`;
    }
    case 'loan_installment': {
      const row=saveInstallment(db,findAccount(db,action.name).id,{due_date:action.due_date,principal:decimalCents(action.principal),interest:decimalCents(action.interest||'0'),note:action.note||''});
      return `已保存 ${action.name} ${row.due_date} 分期计划 · 本金 ${money(row.principal)}元 · 利息 ${money(row.interest)}元，尚未执行还款。`;
    }
    case 'chart': {
      const date=today(),chart=createChart(db,{kind:action.kind,start:action.start||date.slice(0,7)+'-01',end:action.end||date},message.id);
      if(message.user_id!=='local')db.prepare('INSERT INTO outbox(user_id,text,dedup,image_path,created_at) VALUES(?,?,?,?,?)').run(message.user_id,'',`chart:${message.id}:${chart.id}`,chart.path,new Date().toISOString());
      return `已根据真实账本绘制${({bill:'账单',pie:'支出饼图',funds:'资金分布图'})[action.kind]}，金额未经模型改写。`;
    }
  }
}
