import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Clipboard, FolderOpen, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import './onboarding.css';
type Setup = { channel: 'feishu' | 'dingtalk'; storage: string; fixedStorage: boolean; canChooseFolder: boolean; appId: string; baseUrl: string; model: string; reasoning: string };
type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export function SetupView({ request }: { request: Request }) {
  const [initial, setInitial] = useState<Setup | null>(null), [form, setForm] = useState({ channel: 'feishu', storage: '', appId: '', appSecret: '', aiBaseUrl: '', aiKey: '', model: '', reasoning: 'none' });
  const [busy, setBusy] = useState(false), [restarting, setRestarting] = useState(false), [error, setError] = useState('');
  useEffect(() => { request<Setup>('/setup').then(v => { setInitial(v); setForm(f => ({ ...f, channel: v.channel, storage: v.storage, appId: v.appId, aiBaseUrl: v.baseUrl, model: v.model, reasoning: v.reasoning })); }).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (!restarting) return; let active = true; const timer = setInterval(() => { void request<{ setupRequired: boolean }>('/bootstrap').then(v => { if (active && !v.setupRequired) location.reload(); }).catch(() => {}); }, 2000); return () => { active = false; clearInterval(timer); }; }, [restarting]);
  function set(key: string, value: string) { setForm(f => ({ ...f, [key]: value })); setError(''); }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await request('/setup', form); setForm(f => ({ ...f, appSecret: '', aiKey: '' })); setRestarting(true); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <main className="setup-page"><header className="setup-brand"><Wallet size={26}/><strong>私人记账助手</strong><span>首次配置</span></header>
    <div className="setup-layout"><form className="setup-form" onSubmit={save}><h1>连接你的账本</h1>
      <fieldset disabled={busy || !initial}><legend>聊天渠道</legend><div className="segments">{[['feishu', '飞书'], ['dingtalk', '钉钉']].map(([id, label]) => <button type="button" key={id} className={form.channel === id ? 'selected' : ''} onClick={() => { set('channel', id); set('appId', ''); set('appSecret', ''); }}>{label}</button>)}</div>
        <label>{form.channel === 'dingtalk' ? 'Client ID / AppKey' : 'App ID'}<input aria-label="应用ID" value={form.appId} onChange={e => set('appId', e.target.value)} placeholder={form.channel === 'dingtalk' ? 'ding…' : 'cli_…'} required maxLength={1000}/></label>
        <label>{form.channel === 'dingtalk' ? 'Client Secret / AppSecret' : 'App Secret'}<input aria-label="应用Secret" type="password" autoComplete="new-password" value={form.appSecret} onChange={e => set('appSecret', e.target.value)} required maxLength={1000}/></label></fieldset>
      <fieldset disabled={busy || !initial}><legend>模型服务</legend><label>Base URL<input aria-label="模型Base URL" type="url" value={form.aiBaseUrl} onChange={e => set('aiBaseUrl', e.target.value)} placeholder="https://example.com/v1" required maxLength={1000}/></label>
        <label>API Key<input aria-label="模型API Key" type="password" autoComplete="new-password" value={form.aiKey} onChange={e => set('aiKey', e.target.value)} required maxLength={1000}/></label>
        <label>多模态模型名称<input aria-label="多模态模型名称" value={form.model} onChange={e => set('model', e.target.value)} required maxLength={100}/></label></fieldset>
      <details className="setup-advanced"><summary>存储位置与高级设置</summary><label>存储文件夹<div className="setup-folder"><input aria-label="存储文件夹" value={form.storage} onChange={e => set('storage', e.target.value)} disabled={busy || initial?.fixedStorage}/>{initial?.canChooseFolder && !initial.fixedStorage && <button type="button" className="icon-button" title="选择文件夹" aria-label="选择文件夹" disabled={busy} onClick={async () => { try { const r = await request<{ storage: string | null }>('/setup/folder', {}); if (r.storage) set('storage', r.storage); } catch (e) { setError((e as Error).message); } }}><FolderOpen size={18}/></button>}</div></label>
        <label>推理强度<select aria-label="推理强度" value={form.reasoning} disabled={busy} onChange={e => set('reasoning', e.target.value)}><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label></details>
      {error && <p className="error" role="alert">{error}</p>}<button className="button primary setup-submit" disabled={busy || !initial}>{busy ? <LoaderCircle size={18} className="spin"/> : <Check size={18}/>} {restarting ? '已保存，正在启动…' : busy ? '正在检查连接…' : '连接并保存'}</button>
      {restarting && <button type="button" className="text-button" onClick={() => location.reload()}><RefreshCw size={16}/>刷新连接</button>}
    </form><aside className="setup-help"><h2>{form.channel === 'dingtalk' ? '钉钉' : '飞书'}应用准备</h2><p>创建自己的企业内部应用，启用机器人能力。</p><a className="button" href={form.channel === 'dingtalk' ? 'https://open-dev.dingtalk.com/' : 'https://open.feishu.cn/app'} target="_blank" rel="noreferrer"><ArrowUpRight size={16}/>开发者后台</a><p>{form.channel === 'dingtalk' ? '应用凭证位于“凭证与基础信息”，机器人接收模式选择 Stream。' : 'App ID 与 App Secret 位于应用的“凭证与基础信息”。'}</p><h2>模型接口</h2><p>选择支持 Responses、JSON 输出和图片输入的服务。连接检查使用虚构文字与收据图，不写入账本。</p><h2>数据位置</h2><p>配置、账本、附件和备份保存在所选文件夹，密钥不会回显。</p></aside></div>
  </main>;
}
export function FeishuGuide({ appId, owner, pendingUser, request, saved }: { appId: string; owner: string; pendingUser: string; request: Request; saved: () => void }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const base = 'https://open.feishu.cn/app/' + appId;
  async function bind() { setBusy(true); try { await request('/bind', { user: pendingUser }); saved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <section className="feishu-guide"><h2>{owner ? '飞书应用配置' : '完成飞书连接'}</h2><ol>
    <li><a href={base + '/auth'} target="_blank" rel="noreferrer">开通应用权限<ArrowUpRight size={15}/></a><button className="button" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify({ scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:resource', 'im:message:readonly'], user: [] } }, null, 2)); setCopied(true); } catch { setError('复制失败，请按安装说明填写权限'); } }}><Clipboard size={15}/>{copied ? '已复制' : '复制权限清单'}</button></li>
    <li><a href={base + '/event'} target="_blank" rel="noreferrer">设置长连接与事件<ArrowUpRight size={15}/></a><p>选择“使用长连接接收事件”，添加“接收消息”事件 im.message.receive_v1。</p></li>
    <li><a href={base + '/version'} target="_blank" rel="noreferrer">发布应用版本<ArrowUpRight size={15}/></a><p>可用范围选择自己，完成发布与审批。</p></li>
    {!owner && <li>在飞书搜索机器人，私聊发送“绑定账本”。{pendingUser ? <div className="bind-candidate"><span>待绑定用户：{pendingUser}</span><button className="button primary" onClick={bind} disabled={busy}><Check size={16}/>绑定此用户</button></div> : <p>等待首次私聊消息…</p>}</li>}
  </ol>{error && <p role="alert" className="error">{error}</p>}</section>;
}
export function DingTalkGuide({ pendingUser, request, saved }: { pendingUser: string; request: Request; saved: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="feishu-guide"><h2>完成钉钉连接</h2><a className="button" href="https://open-dev.dingtalk.com/" target="_blank" rel="noreferrer"><ArrowUpRight size={16}/>钉钉开发者后台</a><ol>
    <li>企业内部应用添加机器人，接收模式选择 Stream。</li><li>开通机器人消息发送、机器人文件下载及媒体上传权限，发布版本，可用范围选择自己。</li><li>在钉钉搜索机器人并私聊发送“绑定账本”。</li></ol>
    {pendingUser ? <div className="bind-candidate"><span>待绑定用户：{pendingUser}</span><button className="button primary" disabled={busy} onClick={async () => { setBusy(true); try { await request('/bind', { user: pendingUser }); saved(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Check size={16}/>绑定此用户</button></div> : <p>等待首次私聊消息…</p>}{error && <p role="alert" className="error">{error}</p>}
  </section>;
}
