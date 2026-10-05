import { useState } from 'react';
import { ChartPie,Download,LoaderCircle,Send } from 'lucide-react';
import { type Request } from './inventory.js';
export function ChartControls({range,request,notify}:{range:{start:string;end:string};request:Request;notify:(s:string)=>void}) {
  const [kind,setKind]=useState('bill'),[chart,setChart]=useState<{id:string;url:string}|null>(null),[busy,setBusy]=useState(false);
  async function generate(){setBusy(true);try{setChart(await request('/charts',{...range,kind}));}catch(e){notify((e as Error).message);}finally{setBusy(false);}}
  return <section className="chart-export-section"><div className="report-toolbar"><select aria-label="图表类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="bill">账单图片</option><option value="pie">支出饼图</option><option value="funds">资金分布图</option></select><button className="button" disabled={busy} onClick={generate}>{busy?<LoaderCircle size={16} className="spin"/>:<ChartPie size={16}/>}绘制图表</button></div>{chart&&<div className="chart-output"><img className="generated-image" src={chart.url} alt="根据账本绘制的图表"/><div className="report-toolbar"><a className="button" href={chart.url} download="账本图表.png"><Download size={16}/>下载 PNG</a><button className="button" onClick={async()=>{try{await request('/charts/'+chart.id+'/send',{});notify('图表已加入飞书发送队列');}catch(e){notify((e as Error).message);}}}><Send size={16}/>发送飞书</button></div></div>}</section>;
}
