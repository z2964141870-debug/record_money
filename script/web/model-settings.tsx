import { useEffect, useState } from 'react';
import { Check, CircleAlert, CircleCheck, LoaderCircle, PlugZap } from 'lucide-react';
import './model-settings.css';
type Result = { service: string; ok: boolean; detail: string };
export function ModelSettings({ value, request, saved, notify }: {
  value: { baseUrl: string; aiConfigured: boolean; model: string; reasoning: string };
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  saved: () => void; notify: (s: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(value.baseUrl), [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(value.model), [reasoning, setReasoning] = useState(value.reasoning);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null), [error, setError] = useState(''), [results, setResults] = useState<Result[]>([]);
  useEffect(() => { setBaseUrl(value.baseUrl); setModel(value.model); setReasoning(value.reasoning); }, [value.baseUrl, value.model, value.reasoning]);
  function changed() { setResults([]); setError(''); }
  async function run(action: 'save' | 'check') {
    setBusy(action); setError(''); setResults([]);
    const payload = { baseUrl, apiKey, model, reasoning };
    try {
      if (action === 'save') {
        await request('/settings', payload, 'PUT'); setApiKey(''); saved(); notify('模型服务已保存');
      } else { setResults((await request<{ results: Result[] }>('/settings/check', payload)).results); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  return <section className="setting-section"><h2>模型服务</h2>
    <dl><dt>接口</dt><dd>Responses</dd><dt>API Key</dt><dd>{value.aiConfigured ? '已配置' : '未配置'}</dd></dl>
    <form onSubmit={e => { e.preventDefault(); void run('save'); }}>
      <div className="form-grid"><label className="model-wide">服务地址（Base URL）<input aria-label="模型服务地址" type="url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); changed(); }} placeholder="https://example.com/v1" maxLength={1000} required disabled={!!busy}/></label>
        <label className="model-wide">API Key<input aria-label="模型API Key" type="password" autoComplete="new-password" value={apiKey} onChange={e => { setApiKey(e.target.value); changed(); }} placeholder={value.aiConfigured ? '留空保留现有密钥' : '填写API Key'} maxLength={1000} required={!value.aiConfigured} disabled={!!busy}/></label>
        <label>模型名称<input aria-label="模型名称" value={model} onChange={e => { setModel(e.target.value); changed(); }} maxLength={100} required disabled={!!busy}/></label>
        <label>推理强度<select aria-label="推理强度" value={reasoning} onChange={e => { setReasoning(e.target.value); changed(); }} disabled={!!busy}><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      </div><div className="model-actions"><button className="button primary" disabled={!!busy}>{busy === 'save' ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}保存设置</button>
        <button type="button" className="button" onClick={() => { void run('check'); }} disabled={!!busy || !baseUrl.trim() || !model.trim() || (!value.aiConfigured && !apiKey.trim())}>{busy === 'check' ? <LoaderCircle className="spin" size={16}/> : <PlugZap size={16}/>}测试连接</button></div>
      {error && <p className="error model-error" role="alert">{error}</p>}
      {results.length > 0 && <div className="model-results" role="status">{results.map(r => <div key={r.service} className={r.ok ? 'model-result' : 'model-result error'}>{r.ok ? <CircleCheck size={16}/> : <CircleAlert size={16}/>}<div><strong>{r.service === 'vision' ? '图片识别' : '文字理解'} · {r.ok ? '通过' : '失败'}</strong><p>{r.detail}</p></div></div>)}</div>}
    </form>
  </section>;
}
