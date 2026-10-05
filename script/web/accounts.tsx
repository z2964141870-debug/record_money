import { useState } from 'react';
import { Plus, Pencil, X, Check, Wallet, LockKeyhole, ChartNoAxesCombined, CreditCard, CircleAlert } from 'lucide-react';
import './accounts.css';
export type Account = { id: number; name: string; platform: string; kind: string; balance: number | null; available_date: string | null; note: string };
export type Funds = { accounts: Account[]; assets: number; debt: number; net: number; cash: number; investment: number; locked: number; unknown: number };
const labels: Record<string, string> = { cash: '现金余额', investment: '投资理财', locked: '锁定资金', liability: '月付 / 欠款' };
const icons = { cash: Wallet, investment: ChartNoAxesCombined, locked: LockKeyhole, liability: CreditCard };
const yuan = (n: number) => (n / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
type Request = (path: string, body?: unknown, method?: string) => Promise<unknown>;
export function AccountsView({ funds, today, request, saved }: { funds: Funds; today: string; request: Request; saved: () => void }) {
  const [filter, setFilter] = useState(''), [edit, setEdit] = useState<Account | 'new' | null>(null);
  return <div className="accounts-view">
    <div className="metrics"><div><span>已知资产 <Wallet size={16}/></span><strong>¥{yuan(funds.assets)}</strong><small>现金 ¥{yuan(funds.cash)} · 投资 ¥{yuan(funds.investment)} · 锁定 ¥{yuan(funds.locked)}</small></div><div><span>欠款 <CreditCard size={16}/></span><strong className="debt">¥{yuan(funds.debt)}</strong><small>月付及其他负债</small></div><div><span>净资产 <ChartNoAxesCombined size={16}/></span><strong className="green">¥{yuan(funds.net)}</strong><small>已知资产 − 已知欠款</small></div></div>
    {funds.unknown > 0 && <p className="funds-notice"><CircleAlert size={16}/>{funds.unknown} 个账户金额待填写 · 汇总仅含已知金额</p>}
    <div className="account-toolbar"><div className="account-tabs" role="tablist" aria-label="账户类型">{[['', '全部'], ...Object.entries(labels)].map(([kind, name]) => <button key={kind} role="tab" aria-selected={filter === kind} className={filter === kind ? 'selected' : ''} onClick={() => setFilter(kind)}>{name}</button>)}</div><button className="button primary" onClick={() => setEdit('new')}><Plus size={16}/>新增账户</button></div>
    <div className="account-list">{funds.accounts.filter(a => !filter || a.kind === filter).map(a => { const Icon = icons[a.kind as keyof typeof icons] || Wallet; return <div className={'account-row ' + a.kind} key={a.id}><span className="account-icon"><Icon size={22}/></span><div className="account-detail"><strong>{a.name}</strong><small>{a.platform || '未指定平台'} · {labels[a.kind]}</small>{a.kind === 'locked' && <span className="maturity">{a.available_date ? a.available_date <= today ? `已到期 · ${a.available_date} · 待赎回` : `解锁日期 ${a.available_date}` : '解锁日期待补全'}</span>}{a.note && <p>{a.note}</p>}</div><div className="account-value"><strong className={a.balance === null ? 'unknown' : ''}>{a.balance === null ? '待填写' : '¥' + yuan(a.balance)}</strong><small>{a.kind === 'liability' ? '尚欠金额' : a.kind === 'cash' ? '当前余额' : '当前估值'}</small></div><button className="icon-button" title={`编辑 ${a.name}`} aria-label={`编辑 ${a.name}`} onClick={() => setEdit(a)}><Pencil size={16}/></button></div>; })}{!funds.accounts.some(a => !filter || a.kind === filter) && <p className="quiet-empty">暂无账户</p>}</div>
    {edit && <AccountForm account={edit === 'new' ? undefined : edit} request={request} close={() => setEdit(null)} saved={saved}/>}
  </div>;
}
function AccountForm({ account, request, close, saved }: { account?: Account; request: Request; close: () => void; saved: () => void }) {
  const [form, setForm] = useState({ name: account?.name || '', platform: account?.platform || '', kind: account?.kind || 'cash', balance: account?.balance == null ? '' : (account.balance / 100).toFixed(2), available_date: account?.available_date || '', note: account?.note || '' });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (form.balance && !/^-?\d+(\.\d{1,2})?$/.test(form.balance)) throw new Error('金额最多两位小数');
      const sign = form.balance.startsWith('-') ? -1 : 1, [whole, part = ''] = form.balance.replace(/^-/, '').split('.');
      const balance = form.balance ? sign * (Number(whole) * 100 + Number(part.padEnd(2, '0'))) : null;
      await request(account ? '/accounts/' + account.id : '/accounts', { ...form, balance, available_date: form.kind === 'locked' && form.available_date ? form.available_date : null }, account ? 'PUT' : 'POST'); saved(); close();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={account ? '编辑账户' : '新增账户'}>
    <header><h2>{account ? '编辑账户' : '新增账户'}</h2><button className="icon-button" title="关闭" aria-label="关闭" onClick={close}><X size={19}/></button></header>
    <form onSubmit={submit}><div className="form-grid">
      <label>账户名称<input value={form.name} onChange={e => set('name', e.target.value)} required maxLength={100}/></label>
      <label>平台<input value={form.platform} onChange={e => set('platform', e.target.value)} maxLength={60}/></label>
      <label>账户类型<select value={form.kind} onChange={e => set('kind', e.target.value)}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>{form.kind === 'liability' ? '尚欠金额' : form.kind === 'cash' ? '当前余额' : '当前估值'}<input inputMode="decimal" placeholder="待填写" value={form.balance} onChange={e => set('balance', e.target.value)}/></label>
      {form.kind === 'locked' && <label>解锁日期<input type="date" value={form.available_date} onInput={e => set('available_date', e.currentTarget.value)}/></label>}
    </div><label>备注<textarea value={form.note} onChange={e => set('note', e.target.value)} maxLength={1000}/></label>{error && <p className="error">{error}</p>}
    <footer><button className="button" type="button" onClick={close}>取消</button><button className="button primary" disabled={busy}><Check size={16}/>保存账户</button></footer></form>
  </section></div>;
}
