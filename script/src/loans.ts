import { z } from 'zod';
import type { DB } from './db.js';
import { getAccount, listAccounts, saveAccount } from './accounts.js';
import { createEntry, dateSchema, money, today } from './ledger.js';
export const loanInput = z.object({
  name: z.string().trim().min(1).max(100), balance: z.number().int().nonnegative().max(100_000_000_000).nullable(),
  category: z.enum(['student','monthly','personal','other']).default('other'), creditor: z.string().trim().max(100).default(''),
  repayment_start: dateSchema.nullable().default(null), monthly_payment: z.number().int().positive().max(100_000_000_000).nullable().default(null),
  due_day: z.number().int().min(1).max(31).nullable().default(null), maturity_date: dateSchema.nullable().default(null),
  annual_rate: z.string().regex(/^\d+(\.\d{1,6})?$/).refine(v=>Number(v)<=100).nullable().default(null),
  subsidy_until: dateSchema.nullable().default(null), note: z.string().trim().max(1000).default(''),
});
export type LoanProfile = Omit<z.infer<typeof loanInput>, 'name'|'balance'> & { account_id: number; updated_at: string };
const defaults = { category:'other' as const, creditor:'', repayment_start:null, monthly_payment:null, due_day:null, maturity_date:null, annual_rate:null, subsidy_until:null, note:'' };
export function getLoan(db: DB, id: number) {
  const a = getAccount(db,id); if (a.kind !== 'liability') throw new Error('贷款须关联负债账户');
  const profile = db.prepare('SELECT * FROM loans WHERE account_id=?').get(id) as LoanProfile | undefined;
  return { ...defaults,category:/月付|花呗|白条/.test(a.name)?'monthly' as const:'other' as const,...profile, account_id:id, name:a.name, balance:a.balance, platform:a.platform, note:profile?.note || a.note };
}
export function saveLoan(db: DB, raw: unknown, id?: number) {
  return db.transaction(() => {
    const value = loanInput.parse(raw), before = id ? getLoan(db,id) : null;
    if (value.maturity_date && value.repayment_start && value.maturity_date < value.repayment_start) throw new Error('到期日不能早于开始还款日');
    const a = id ? getAccount(db,id) : null;
    const account = saveAccount(db,{ name:value.name,kind:'liability',balance:value.balance,platform:a?.platform || value.creditor,note:a?.note || '' },id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO loans(account_id,category,creditor,repayment_start,monthly_payment,due_day,maturity_date,annual_rate,subsidy_until,note,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET category=excluded.category,creditor=excluded.creditor,repayment_start=excluded.repayment_start,
      monthly_payment=excluded.monthly_payment,due_day=excluded.due_day,maturity_date=excluded.maturity_date,annual_rate=excluded.annual_rate,subsidy_until=excluded.subsidy_until,note=excluded.note,updated_at=excluded.updated_at`).run(account.id,value.category,value.creditor,value.repayment_start,value.monthly_payment,value.due_day,value.maturity_date,value.annual_rate,value.subsidy_until,value.note,now);
    const after=getLoan(db,account.id);
    db.prepare('INSERT INTO inventory_audit(entity,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run('loan',account.id,before ? JSON.stringify(before):null,JSON.stringify(after),now);
    return after;
  })();
}
export const installmentInput=z.object({due_date:dateSchema,principal:z.number().int().nonnegative().max(100_000_000_000),interest:z.number().int().nonnegative().max(100_000_000_000).default(0),note:z.string().max(1000).default('')}).refine(v=>v.principal+v.interest>0,'分期金额需大于零');
export function installments(db:DB,id:number) {
  return db.prepare(`SELECT i.*,COALESCE(SUM(CASE WHEN p.cancelled_at IS NULL AND p.kind='transfer' AND p.to_account_id=i.account_id THEN p.amount ELSE 0 END),0) AS paid_principal,
    COALESCE(SUM(CASE WHEN t.cancelled_at IS NULL AND t.kind='expense' THEN t.amount ELSE 0 END),0) AS paid_interest
    FROM loan_installments i LEFT JOIN loan_events e ON e.installment_id=i.id AND e.kind='repayment'
    LEFT JOIN entries p ON p.id=e.entry_id LEFT JOIN entries t ON t.id=e.interest_entry_id WHERE i.account_id=? GROUP BY i.id ORDER BY i.due_date`).all(id) as {id:number;account_id:number;due_date:string;principal:number;interest:number;paid_principal:number;paid_interest:number;note:string}[];
}
export function saveInstallment(db:DB,id:number,raw:unknown,installmentId?:number) {
  return db.transaction(()=>{
  getLoan(db,id); const v=installmentInput.parse(raw),before=installmentId?installments(db,id).find(i=>i.id===installmentId):null;
  if(installmentId) {
    const existing=installments(db,id).find(i=>i.id===installmentId);if(!existing)throw new Error('分期不存在');
    if(existing.paid_principal>v.principal||existing.paid_interest>v.interest)throw new Error('分期金额不能低于已还金额');
    db.prepare('UPDATE loan_installments SET due_date=?,principal=?,interest=?,note=? WHERE id=?').run(v.due_date,v.principal,v.interest,v.note,installmentId);
  } else installmentId=Number(db.prepare('INSERT INTO loan_installments(account_id,due_date,principal,interest,note) VALUES(?,?,?,?,?)').run(id,v.due_date,v.principal,v.interest,v.note).lastInsertRowid);
  const after=installments(db,id).find(i=>i.id===installmentId)!;
  db.prepare('INSERT INTO inventory_audit(entity,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run('installment',installmentId,before?JSON.stringify(before):null,JSON.stringify(after),new Date().toISOString());
  return after;
  })();
}
export function projectedMonths(loan:ReturnType<typeof getLoan>,date=today()) {
  if(!loan.repayment_start||!loan.monthly_payment||!loan.due_day||loan.balance===0)return [];
  let month=loan.repayment_start.slice(0,7); if(month<date.slice(0,7))month=date.slice(0,7);
  const rows: {due_date:string;amount:number;estimated:true}[]=[];
  for(let i=0;i<6;i++) {
    const [y,m]=month.split('-').map(Number), day=Math.min(loan.due_day,new Date(Date.UTC(y,m,0)).getUTCDate());
    const due=month+'-'+String(day).padStart(2,'0');
    if(due>=date&&due>=loan.repayment_start&&(!loan.maturity_date||due<=loan.maturity_date))rows.push({due_date:due,amount:loan.monthly_payment,estimated:true});
    month=new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);
  }
  return rows;
}
export function loanOverview(db:DB,date=today()) {
  const loans=listAccounts(db).filter(a=>a.kind==='liability').map(a=>{
    const loan=getLoan(db,a.id), schedule=installments(db,a.id);
    const due=schedule.filter(i=>i.principal+i.interest>i.paid_principal+i.paid_interest);
    const events=db.prepare(`SELECT e.*,CASE WHEN e.entry_id IS NOT NULL AND p.cancelled_at IS NOT NULL THEN 1 ELSE 0 END AS principal_cancelled,
      CASE WHEN e.interest_entry_id IS NOT NULL AND t.cancelled_at IS NOT NULL THEN 1 ELSE 0 END AS interest_cancelled
      FROM loan_events e LEFT JOIN entries p ON p.id=e.entry_id LEFT JOIN entries t ON t.id=e.interest_entry_id WHERE e.account_id=? ORDER BY e.id DESC LIMIT 100`).all(a.id);
    return {...loan,installments:schedule,events,projected:projectedMonths(loan,date),overdue:due.filter(i=>i.due_date<date).reduce((n,i)=>n+Math.max(0,i.principal+i.interest-i.paid_principal-i.paid_interest),0)};
  });
  return {loans,total:loans.reduce((n,l)=>n+(l.balance??0),0),unknown:loans.filter(l=>l.balance===null).length,
    this_month:loans.reduce((n,l)=>n+l.installments.filter(i=>i.due_date.startsWith(date.slice(0,7))).reduce((s,i)=>s+Math.max(0,i.principal+i.interest-i.paid_principal-i.paid_interest),0),0),
    overdue:loans.reduce((n,l)=>n+l.overdue,0)};
}
export const paymentInput=z.object({amount:z.number().int().nonnegative().max(100_000_000_000),interest:z.number().int().nonnegative().max(100_000_000_000).default(0),date:dateSchema,cash_account_id:z.number().int().positive(),installment_id:z.number().int().positive().optional(),note:z.string().max(1000).default('')});
export function repayLoan(db:DB,id:number,raw:unknown,messageId?:string) {
  return db.transaction(()=>{
    const v=paymentInput.parse(raw),loan=getLoan(db,id),cash=getAccount(db,v.cash_account_id);
    if(v.amount+v.interest===0)throw new Error('还款金额需大于零');
    if(v.date>today())throw new Error('未来还款请录入分期计划');
    if(cash.kind!=='cash')throw new Error('还款来源须为现金账户');
    if(loan.balance===null)throw new Error('请先补全尚欠本金');
    if(v.amount>loan.balance)throw new Error('还款本金不能超过尚欠本金');
    if(v.installment_id) {
      const i=installments(db,id).find(i=>i.id===v.installment_id);if(!i)throw new Error('分期不属于该贷款');
      if(v.amount>i.principal-i.paid_principal||v.interest>i.interest-i.paid_interest)throw new Error('还款不能超过该分期的未还金额');
    }
    const principal=v.amount?createEntry(db,{kind:'transfer',amount:v.amount,date:v.date,category:'还款',note:v.note||loan.name+'本金还款',account_id:cash.id,to_account_id:id},'loan',messageId):null;
    const interest=v.interest ? createEntry(db,{kind:'expense',amount:v.interest,date:v.date,category:'利息',note:loan.name+'利息',account_id:cash.id},'loan',messageId):null;
    db.prepare('INSERT INTO loan_events(account_id,kind,amount,interest,date,note,installment_id,entry_id,interest_entry_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'repayment',v.amount,v.interest,v.date,v.note,v.installment_id??null,principal?.id??null,interest?.id??null,new Date().toISOString());
    return {loan:getLoan(db,id),principal,interest};
  })();
}
export function drawLoan(db:DB,id:number,raw:unknown,messageId?:string) {
  return db.transaction(()=>{
    const v=paymentInput.omit({interest:true,installment_id:true}).extend({cash_account_id:z.number().int().positive().optional()}).parse(raw),loan=getLoan(db,id);
    if(v.amount===0||v.date>today())throw new Error('新增借款需为已发生的正数本金');
    if(loan.balance===null)throw new Error('请先补全已有贷款本金，避免重复累计');
    let entryId:number|null=null;
    if(v.cash_account_id) {
      const cash=getAccount(db,v.cash_account_id);if(cash.kind!=='cash')throw new Error('到账账户须为现金账户');
      entryId=createEntry(db,{kind:'transfer',amount:v.amount,date:v.date,category:'借款',account_id:id,to_account_id:cash.id,note:v.note},'loan',messageId).id;
    } else {
      const a=getAccount(db,id);saveAccount(db,{...a,balance:loan.balance+v.amount},id);
    }
    db.prepare('INSERT INTO loan_events(account_id,kind,amount,date,note,entry_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id,'draw',v.amount,v.date,v.note,entryId,new Date().toISOString());
    return getLoan(db,id);
  })();
}
export function loanText(db:DB) {
  const s=loanOverview(db);
  return `已知尚欠金额合计 ${money(s.total)}元 · ${s.unknown}笔金额待补全\n本月合同分期待还 ${money(s.this_month)}元 · 逾期计划未还 ${money(s.overdue)}元\n长期贷款按本金，月付按已录入未还余额，未知利息不自动估算。\n\n`+s.loans.map(l=>`${l.name}：${l.balance===null?'待补全':money(l.balance)+'元'}\n开始还款 ${l.repayment_start||'待补全'} · 月还 ${l.monthly_payment===null?'待补全':money(l.monthly_payment)+'元'}${l.note?'\n'+l.note:''}`).join('\n\n');
}
