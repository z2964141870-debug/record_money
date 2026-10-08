import { useState, type FormEvent } from 'react';
import { Plus, Pencil, Check, ListChecks } from 'lucide-react';
import { Dialog, parseMoney, yuan, type Request } from './inventory.js';
import type { Account } from './accounts.js';
type SnapshotDetails = { confirmed_value: number | null; shares: number | null; available_shares: number | null; unit_cost: number | null; nav: number | null; nav_date: string | null; receivable_amount: number | null; pending_included: boolean | null };
export type Snapshot = { id: number; name: string; code: string; platform: string; value: number; holding_profit: number; pending_amount: number; as_of: string | null; source: string; note: string; position_id: number | null; details: SnapshotDetails };
export type SnapshotPool = { snapshots: Snapshot[]; value: number; profit: number; pending: number; confirmed_value: number; known_shares: number };
const decimal = (n: number | null | undefined, scale: number, digits: number) => n == null ? '' : (n / scale).toFixed(digits);
function scaled(value: string, scale: number, digits: number) {
  if (!value.trim()) return null;
  if (!new RegExp('^\\d+(?:\\.\\d{1,' + digits + '})?$').test(value)) throw new Error('请输入非负数，最多' + digits + '位小数');
  const n = Math.round(Number(value) * scale);
  if (!Number.isSafeInteger(n)) throw new Error('数值过大');
  return n;
}
export function FundSnapshots({ pool, accounts, request, today, saved, query = '' }: { pool: SnapshotPool; accounts: Account[]; request: Request; today: string; saved: () => void; query?: string }) {
  const [edit, setEdit] = useState<Snapshot | 'new' | null>(null), [complete, setComplete] = useState<Snapshot | null>(null);
  const rows = pool.snapshots.filter(s => !s.position_id && [s.name,s.code,s.platform].some(v => v.includes(query)));
  return <section className="fund-detail snapshot-section"><div className="section-heading"><h2>截图持仓</h2><button className="button" onClick={() => setEdit('new')}><Plus size={16}/>登记快照</button></div>
    {rows.length > 0 && <><div className="snapshot-totals"><span>截图总金额 <strong>¥{yuan(pool.value)}</strong></span><span>持有金额 ¥{yuan(pool.confirmed_value)}</span><span>持有收益 <strong className={pool.profit < 0 ? 'fund-down' : 'fund-up'}>¥{yuan(pool.profit)}</strong></span><span>申购中 ¥{yuan(pool.pending)}</span></div>
      <div className="table-wrap"><table className="fund-table"><thead><tr><th>基金 / 平台</th><th>总金额 / 持有金额</th><th>持有 / 可用份额</th><th>单位成本 / 净值</th><th>持有收益</th><th>申购中</th><th>截图日期</th><th aria-label="操作"/></tr></thead><tbody>{rows.map(s => <tr key={s.id}><td><strong>{s.name}</strong><small className="type-label">{s.code || '代码待确认'} · {s.platform}</small></td><td>¥{yuan(s.value)}<small className="type-label">持有 {s.details.confirmed_value === null ? '待确认' : '¥' + yuan(s.details.confirmed_value)}</small></td><td>{decimal(s.details.shares, 10000, 4) || '待补全'}<small className="type-label">可用 {decimal(s.details.available_shares, 10000, 4) || '待补全'}</small></td><td>成本 {decimal(s.details.unit_cost, 1e6, 4) || '待补全'}<small className="type-label">净值 {decimal(s.details.nav, 1e6, 4) || '待补全'}</small><small className="type-label">{s.details.nav_date || '净值日期待补全'}</small></td><td className={s.holding_profit < 0 ? 'fund-down' : 'fund-up'}>¥{yuan(s.holding_profit)}</td><td>{s.pending_amount ? <>{'¥' + yuan(s.pending_amount)}<small className="type-label">{s.details.pending_included === true ? '已含在总金额' : s.details.pending_included === false ? '未含在总金额' : '是否包含待确认'}</small></> : '无'}</td><td>{s.as_of || '待确认'}</td><td><div className="row-actions"><button className="icon-button" title={'编辑快照 ' + s.name} aria-label={'编辑快照 ' + s.name} onClick={() => setEdit(s)}><Pencil size={15}/></button><button className="icon-button" title={'补全总成本 ' + s.name} aria-label={'补全总成本 ' + s.name} onClick={() => setComplete(s)}><ListChecks size={16}/></button></div></td></tr>)}</tbody></table></div>
      <p className="muted fund-data-note">单位成本为平台显示值。净值按标注日期保存，申购中尚无确认份额。</p></>}
    {!rows.length && <p className="quiet-empty">{query ? '未找到匹配快照' : '暂无待补全持仓'}</p>}
    {edit && <SnapshotForm snapshot={edit === 'new' ? undefined : edit} today={today} request={request} saved={saved} close={() => setEdit(null)}/>}
    {complete && <CompleteForm snapshot={complete} accounts={accounts} today={today} request={request} saved={saved} close={() => setComplete(null)}/>}
  </section>;
}
function SnapshotForm({ snapshot, today, request, saved, close }: { snapshot?: Snapshot; today: string; request: Request; saved: () => void; close: () => void }) {
  const [form, setForm] = useState({ name: snapshot?.name || '', platform: snapshot?.platform || '', code: snapshot?.code || '', value: snapshot ? yuan(snapshot.value).replaceAll(',', '') : '',
    profit: snapshot ? (snapshot.holding_profit / 100).toFixed(2) : '0', pending: snapshot ? (snapshot.pending_amount / 100).toFixed(2) : '0', date: snapshot?.as_of || '', note: snapshot?.note || '',
    confirmed: decimal(snapshot?.details.confirmed_value, 100, 2), shares: decimal(snapshot?.details.shares, 10000, 4), available: decimal(snapshot?.details.available_shares, 10000, 4),
    unitCost: decimal(snapshot?.details.unit_cost, 1e6, 6), nav: decimal(snapshot?.details.nav, 1e6, 6), navDate: snapshot?.details.nav_date || '', receivable: decimal(snapshot?.details.receivable_amount, 100, 2), included: snapshot?.details.pending_included == null ? '' : String(snapshot.details.pending_included) });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => setForm(f => ({ ...f, [key]: value }));
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); try {
    const negative = form.profit.startsWith('-'), profit = parseMoney(negative ? form.profit.slice(1) : form.profit);
    if (profit === null) throw new Error('请填写持有收益');
    await request('/funds/snapshots' + (snapshot ? '/' + snapshot.id : ''), { name: form.name, platform: form.platform, code: form.code, value: parseMoney(form.value), holding_profit: negative ? -profit : profit,
      pending_amount: parseMoney(form.pending), as_of: form.date || null, note: form.note, source: snapshot?.source || '手动持仓快照', details: {
        confirmed_value: scaled(form.confirmed, 100, 2), shares: scaled(form.shares, 10000, 4), available_shares: scaled(form.available, 10000, 4), unit_cost: scaled(form.unitCost, 1e6, 6),
        nav: scaled(form.nav, 1e6, 6), nav_date: form.navDate || null, receivable_amount: scaled(form.receivable, 100, 2), pending_included: form.included === '' ? null : form.included === 'true' }
    }, snapshot ? 'PUT' : 'POST'); saved(); close();
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Dialog title="持仓快照" close={close}><form onSubmit={submit}><div className="form-grid"><label>基金名称<input required maxLength={100} value={form.name} onChange={e => set('name', e.target.value)}/></label><label>平台<input required maxLength={60} value={form.platform} onChange={e => set('platform', e.target.value)}/></label><label>基金代码<input pattern="[0-9]{6}" value={form.code} onChange={e => set('code', e.target.value)} placeholder="待确认可留空"/></label><label>截图日期<input type="date" max={today} value={form.date} onInput={e => set('date', e.currentTarget.value)}/></label><label>截图总金额<input required inputMode="decimal" value={form.value} onChange={e => set('value', e.target.value)}/></label><label>持有收益<input required inputMode="decimal" value={form.profit} onChange={e => set('profit', e.target.value)}/></label><label>申购中金额<input required inputMode="decimal" value={form.pending} onChange={e => set('pending', e.target.value)}/></label></div>
    <details open={!!snapshot}><summary>持仓明细</summary><div className="form-grid">
      <label>持有金额<input inputMode="decimal" value={form.confirmed} onChange={e => set('confirmed', e.target.value)}/></label>
      <label>申购款计入总金额<select value={form.included} onChange={e => set('included', e.target.value)}><option value="">待确认</option><option value="true">已计入</option><option value="false">未计入</option></select></label>
      <label>持有份额<input inputMode="decimal" value={form.shares} onChange={e => set('shares', e.target.value)}/></label>
      <label>可用份额<input inputMode="decimal" value={form.available} onChange={e => set('available', e.target.value)}/></label>
      <label>平台单位成本<input inputMode="decimal" value={form.unitCost} onChange={e => set('unitCost', e.target.value)}/></label>
      <label>截图净值<input inputMode="decimal" value={form.nav} onChange={e => set('nav', e.target.value)}/></label>
      <label>净值日期<input type="date" max={form.date || today} value={form.navDate} onInput={e => set('navDate', e.currentTarget.value)}/></label>
      <label>待到账金额<input inputMode="decimal" value={form.receivable} onChange={e => set('receivable', e.target.value)}/></label>
    </div></details><label>备注<textarea value={form.note} onChange={e => set('note', e.target.value)} maxLength={1000}/></label>{error && <p className="error">{error}</p>}<footer><button type="button" className="button" onClick={close}>取消</button><button className="button primary" disabled={busy}><Check size={16}/>保存</button></footer></form></Dialog>;
}
function CompleteForm({ snapshot, accounts, today, request, saved, close }: { snapshot: Snapshot; accounts: Account[]; today: string; request: Request; saved: () => void; close: () => void }) {
  const [form, setForm] = useState({ code: snapshot.code, shares: decimal(snapshot.details.shares, 10000, 4), cost: '', date: snapshot.as_of || '', account: '' });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form, value: string) => setForm(f => ({ ...f, [key]: value }));
  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); try { await request(`/funds/snapshots/${snapshot.id}/complete`, { code: form.code, shares: form.shares, cost: parseMoney(form.cost), date: form.date,
    ...(form.account ? { account_id: Number(form.account) } : {}) }); saved(); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Dialog title={'补全持仓 · ' + snapshot.name} close={close}><form onSubmit={submit}><div className="form-grid"><label>确认基金代码<input required pattern="[0-9]{6}" value={form.code} onChange={e => set('code', e.target.value)}/></label><label>已确认份额<input required inputMode="decimal" value={form.shares} onChange={e => set('shares', e.target.value)}/></label><label>平台剩余持仓成本<input required inputMode="decimal" value={form.cost} onChange={e => set('cost', e.target.value)}/></label><label>持仓日期<input type="date" required max={today} value={form.date} onInput={e => set('date', e.currentTarget.value)}/></label></div><label>关联资金账户<select value={form.account} onChange={e => set('account', e.target.value)}><option value="">新建单独基金账户</option>{accounts.filter(a => a.kind === 'investment' && a.platform === snapshot.platform).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p className="muted">关联账户后，基金净值市值会替代该账户余额。汇总账户请先拆分。</p>{error && <p className="error">{error}</p>}<footer><button type="button" className="button" onClick={close}>取消</button><button className="button primary" disabled={busy}><Check size={16}/>保存确认份额</button></footer></form></Dialog>;
}
