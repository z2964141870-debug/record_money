import { useState } from 'react';
import { Bell, Check } from 'lucide-react';
export function ReminderSettings({ value, save, notify }: { value: { enabled: boolean; time: string }; save: (value: { enabled: boolean; time: string }) => Promise<unknown>; notify: (s: string) => void }) {
  const [enabled, setEnabled] = useState(value.enabled), [time, setTime] = useState(value.time), [busy, setBusy] = useState(false);
  return <section className="setting-section"><h2>记账提醒</h2><form onSubmit={async e => {
    e.preventDefault(); setBusy(true);
    try { await save({ enabled, time }); notify('记账提醒已保存'); } catch(e) { notify((e as Error).message); } finally { setBusy(false); }
  }}><label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/><Bell size={16}/>启用记账提醒</label>
    <div className="form-grid" style={{ marginTop: 18 }}><label>每日时间（北京时间）<input aria-label="记账提醒时间" type="time" value={time} onInput={e => setTime(e.currentTarget.value)} required/></label></div>
    <dl><dt>触发条件</dt><dd>当天没有收支记录</dd><dt>频率</dt><dd>每天最多一次</dd></dl>
    <button className="button primary" disabled={busy}><Check size={16}/>保存提醒</button>
  </form></section>;
}
