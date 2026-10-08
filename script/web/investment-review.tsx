import { useEffect, useState } from 'react';
import { RefreshCw, CalendarClock, Download, ChevronRight } from 'lucide-react';
import type { Request } from './inventory.js';
type Settings = { enabled: boolean; time: string; goal: string; push: boolean };
type Report = { id: number; day: string; status: string; text: string; model: string; error: string; updated_at: string;
  analysis: { summary: string; observations: { text: string; evidence: string[] }[]; suggestions: { target: string; condition: string; reason: string; checks: string[] }[] } | null;
  evidence: { facts: { id: string; text: string }[]; targetLabels: Record<string,string> } };
type Pool = { settings: Settings; reports: Report[]; source: string };
export function InvestmentReviewView({ request }: { request: Request }) {
  const [pool, setPool] = useState<Pool | null>(null), [selected, setSelected] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load() { try { setPool(await request('/investment-reviews')); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 15000); return () => clearInterval(timer); }, []);
  async function save(patch: Partial<Settings>) { if (!pool) return; setError(''); try { await request('/investment-reviews/settings', { ...pool.settings, ...patch }, 'PUT'); await load(); } catch (e) { setError((e as Error).message); } }
  const report = pool?.reports.find(r => r.id === selected) || pool?.reports[0];
  return <div className="review-view"><div className="account-toolbar"><span className="review-schedule"><CalendarClock size={18}/>每天 14:30 · 北京时间</span><button className="button primary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const r = await request<Report>('/investment-reviews/generate', {}); setSelected(r.id); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? '分析中' : '现在分析'}</button></div>
    {pool && <div className="review-settings"><label className="checkbox-label"><input type="checkbox" checked={pool.settings.enabled} onChange={e => { void save({ enabled: e.target.checked }); }}/>每日分析</label><label className="checkbox-label"><input type="checkbox" checked={pool.settings.push} onChange={e => { void save({ push: e.target.checked }); }}/>推送到机器人</label><label>目标<select aria-label="分析目标" value={pool.settings.goal} onChange={e => { void save({ goal: e.target.value }); }}><option value="risk_control">控制风险</option><option value="long_term">长期定投</option><option value="swing">短期波段</option></select></label></div>}
    {error && <p className="error">{error}</p>}
    {report ? <section className="review-report"><div className="section-heading"><h2>{report.day} 理财分析</h2><button className="icon-button" title="下载分析记录" aria-label="下载分析记录" onClick={() => { const url = URL.createObjectURL(new Blob([report.text], { type: 'text/markdown;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = report.day + '-理财分析.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={17}/></button></div><small className="muted">{new Date(report.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {report.model || '规则分析'}</small>
      {report.error && <p className="error">{report.error}</p>}{report.status === 'running' ? <p>分析中</p> : <><p className="review-summary">{report.analysis?.summary}</p>{report.analysis?.observations.map((o, i) => <p key={i} className="review-observation">{o.text}</p>)}<div className="review-suggestions">{report.analysis?.suggestions.map((s, i) => <article key={i}><small>{report.evidence.targetLabels[s.target]}</small><br/><strong>{s.condition}</strong><p>{s.reason}</p><small>先核对：{s.checks.join('；')}</small></article>)}</div></>}
      <details className="review-evidence"><summary>数据依据与行情时间</summary>{report.evidence.facts.map(f => <p key={f.id}><small>{f.id}</small>{f.text}</p>)}</details><p className="muted fund-data-note">建议供你决定，不执行交易。ETF参考不是基金估值；休市或资料不足时仅作核对与观察。</p></section> : <div className="empty"><CalendarClock size={32}/><p>暂无分析记录</p></div>}
    {pool && pool.reports.length > 1 && <section className="review-history"><h2>历史分析</h2>{pool.reports.map(r => <button key={r.id} onClick={() => setSelected(r.id)}><span>{r.day}</span><small>{r.status === 'fallback' ? '规则核对' : r.status === 'running' ? '分析中' : '已完成'}</small><ChevronRight size={16}/></button>)}</section>}
    {pool && <a className="review-source" href={pool.source} target="_blank" rel="noreferrer">分析方法参考</a>}
  </div>;
}
