import { useEffect, useState } from 'react';
import { Check, CircleAlert, CircleCheck, LoaderCircle, PlugZap } from 'lucide-react';
import './model-settings.css';
type Result = { service: string; ok: boolean; detail: string };
export function ModelSettings({ value, request, saved, notify }: {
  value: { baseUrl: string; aiConfigured: boolean; model: string; reasoning: string; aiMode?:string;apiType?:string;chatThinking?:string;capabilities?:Record<string,string> };
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  saved: () => void; notify: (s: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(value.baseUrl), [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(value.model), [reasoning, setReasoning] = useState(value.reasoning);
  const [aiMode,setMode]=useState(value.aiMode||'ai'),[apiType,setApiType]=useState(value.apiType||'responses');
  const [chatThinking,setThinking]=useState(value.chatThinking||'reasoning_effort');
  const [busy, setBusy] = useState<'save' | 'check' | null>(null), [error, setError] = useState(''), [results, setResults] = useState<Result[]>([]);
  useEffect(() => { setBaseUrl(value.baseUrl); setModel(value.model); setReasoning(value.reasoning);setMode(value.aiMode||'ai');setApiType(value.apiType||'responses');setThinking(value.chatThinking||'reasoning_effort'); }, [value.baseUrl, value.model, value.reasoning,value.aiMode,value.apiType,value.chatThinking]);
  function changed() { setResults([]); setError(''); }
  async function run(action: 'save' | 'check') {
    setBusy(action); setError(''); setResults([]);
    const payload = { baseUrl, apiKey, model, reasoning,aiMode,apiType,chatThinking };
    try {
      if (action === 'save') {
        await request('/settings', payload, 'PUT'); setApiKey(''); saved(); notify('模型服务已保存');
      } else { setResults((await request<{ results: Result[] }>('/settings/check', payload)).results); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  return <section className="setting-section"><h2>模型服务</h2>
    <dl><dt>API Key</dt><dd>{value.aiConfigured ? '已配置' : '未配置'}</dd>{[['text','文字'],['structured','结构化输出'],['vision','图片']].map(([id,label])=><div key={id} style={{display:'contents'}}><dt>{label}</dt><dd>{{verified:'已验证',unsupported:'不支持',unverified:'未验证'}[value.capabilities?.[id]||'unverified']}</dd></div>)}</dl>
    <form onSubmit={e => { e.preventDefault(); void run('save'); }}>
      <div className="segments">{[['fixed','固定格式'],['ai','固定格式 + AI']].map(([id,label])=><button type="button" key={id} disabled={!!busy} className={aiMode===id?'selected':''} onClick={()=>{setMode(id);changed();}}>{label}</button>)}</div>
      {aiMode==='ai' && <div className="form-grid"><label>接口类型<select aria-label="接口类型" value={apiType} onChange={e=>{setApiType(e.target.value);changed();}} disabled={!!busy}><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></select></label><label className="model-wide">服务地址（Base URL）<input aria-label="模型服务地址" type="url" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); changed(); }} placeholder="https://example.com/v1" maxLength={1000} required disabled={!!busy}/></label>
        <label className="model-wide">API Key<input aria-label="模型API Key" type="password" autoComplete="new-password" value={apiKey} onChange={e => { setApiKey(e.target.value); changed(); }} placeholder={value.aiConfigured ? '留空保留现有密钥' : '填写API Key'} maxLength={1000} required={!value.aiConfigured} disabled={!!busy}/></label>
        <label>模型名称<input aria-label="模型名称" value={model} onChange={e => { setModel(e.target.value); changed(); }} maxLength={100} required disabled={!!busy}/></label>
        {apiType==='chat_completions'&&<label>思考参数<select aria-label="思考参数" value={chatThinking} onChange={e=>{setThinking(e.target.value);changed();}} disabled={!!busy}><option value="reasoning_effort">reasoning_effort</option><option value="enable_thinking">enable_thinking</option></select></label>}
        <label>推理强度<select aria-label="推理强度" value={reasoning} onChange={e => { setReasoning(e.target.value); changed(); }} disabled={!!busy}><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      </div>}<div className="model-actions"><button className="button primary" disabled={!!busy}>{busy === 'save' ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}保存设置</button>
        {aiMode==='ai' && <button type="button" className="button" onClick={() => { void run('check'); }} disabled={!!busy || !baseUrl.trim() || !model.trim() || (!value.aiConfigured && !apiKey.trim())}>{busy === 'check' ? <LoaderCircle className="spin" size={16}/> : <PlugZap size={16}/>}测试连接</button>}</div>
      {error && <p className="error model-error" role="alert">{error}</p>}
      {results.length > 0 && <div className="model-results" role="status">{results.map(r => <div key={r.service} className={r.ok ? 'model-result' : 'model-result error'}>{r.ok ? <CircleCheck size={16}/> : <CircleAlert size={16}/>}<div><strong>{r.service === 'vision' ? '图片识别' : r.service==='structured'?'结构化输出':'文字理解'} · {r.ok ? '通过' : '未通过'}</strong><p>{r.detail}</p></div></div>)}</div>}
    </form>
  </section>;
}
