import { z } from 'zod';
import { dateSchema, today } from './ledger.js';
import { scaled, type FundQuote } from './fund-math.js';
export const fundCode = z.string().regex(/^\d{6}$/, '基金代码需为6位数字');
export const benchmarkCode = z.string().regex(/^(?:sh(?:51|56|58)\d{4}|sz15\d{4})$/, 'ETF代码格式例如 sh512400、sh518880、sz159915');
export type ReferenceQuote = { symbol: string; name: string; price: number; previous_close: number; quoted_at: string; fetched_at: string; source: string };
type Fetcher = typeof fetch;
async function responseBytes(url: string, fetcher: Fetcher, signal?: AbortSignal) {
  const r = await fetcher(url, { headers: { Referer: 'https://fund.eastmoney.com/', 'User-Agent': 'RecordMoney/0.7' },
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`行情接口HTTP ${r.status}`);
  if (!r.body) throw new Error('行情接口没有返回数据');
  const reader = r.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > 2_000_000) throw new Error('行情响应过大'); parts.push(next.value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}
export function parseNavResponse(code: string, raw: unknown, now = new Date()): FundQuote[] {
  fundCode.parse(code);
  const value = z.object({ ErrCode: z.number(), Data: z.object({ LSJZList: z.array(z.object({ FSRQ: dateSchema, DWJZ: z.string(), NAVTYPE: z.string() })).max(100) }).nullable() }).parse(raw);
  if (value.ErrCode !== 0 || !value.Data?.LSJZList.length) throw new Error('没有该基金的净值，请检查基金代码');
  return value.Data.LSJZList.map(row => {
    if (row.NAVTYPE !== '1') throw new Error('暂不支持货币基金万份收益，请使用普通净值型基金');
    if (row.FSRQ > today(now)) throw new Error('行情返回未来日期');
    return { code, date: row.FSRQ, nav: scaled(row.DWJZ, 6), source: '天天基金公布净值', fetched_at: now.toISOString() };
  });
}
export function parseReference(symbol: string, raw: string, now = new Date()): ReferenceQuote {
  if (symbol !== 'sh000001') benchmarkCode.parse(symbol);
  const match = raw.trim().match(/^v_([a-z]{2}\d{6})="([^"\r\n]+)";$/);
  if (!match || match[1] !== symbol) throw new Error('实时参考行情格式无效');
  const fields = match[2].split('~'), stamp = fields[30];
  if (fields[2] !== symbol.slice(2) || !/^\d{14}$/.test(stamp || '')) throw new Error('实时参考行情代码或时间无效');
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  dateSchema.parse(day);
  const clock = `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(clock)) throw new Error('行情时间无效');
  const quoted_at = new Date(`${day}T${clock}+08:00`).toISOString();
  if (Date.parse(quoted_at) > now.getTime() + 300000) throw new Error('行情返回未来时间');
  return { symbol, name: z.string().min(1).max(100).parse(fields[1]), price: scaled(fields[3], 6), previous_close: scaled(fields[4], 6),
    quoted_at, fetched_at: now.toISOString(), source: '腾讯行情·ETF参考' };
}
export function parseFundMetadata(code: string, raw: string) {
  const readString = (key: string) => {
    const match = raw.match(new RegExp('\\bvar\\s+' + key + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*;'));
    if (!match) throw new Error('基金基本信息格式无效');
    return z.string().min(1).max(100).parse(JSON.parse(match[1]));
  };
  const name = readString('fS_name');
  if (readString('fS_code') !== code) throw new Error('基金信息代码不匹配');
  if (/美元|港币|USD|HKD/i.test(name)) throw new Error('当前仅支持人民币净值型基金');
  if (/\bvar\s+ishb\s*=\s*true\s*;/.test(raw)) throw new Error('暂不支持货币基金万份收益');
  return name;
}
export async function fetchNav(code: string, fetcher: Fetcher = fetch, now = new Date(), signal?: AbortSignal) {
  fundCode.parse(code);
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=60`;
  const [nav, metadata] = await Promise.all([responseBytes(url, fetcher, signal), responseBytes(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, fetcher, signal)]);
  const name = parseFundMetadata(code, metadata.toString('utf8'));
  return parseNavResponse(code, JSON.parse(nav.toString('utf8')), now).map(q => ({ ...q, source: `天天基金公布净值 · ${name}` }));
}
export async function fetchReference(symbol: string, fetcher: Fetcher = fetch, now = new Date(), signal?: AbortSignal) {
  if (symbol !== 'sh000001') benchmarkCode.parse(symbol);
  return parseReference(symbol, new TextDecoder('gb18030').decode(await responseBytes(`https://qt.gtimg.cn/q=${symbol}`, fetcher, signal)), now);
}
export function freshReference(quote: ReferenceQuote, now = new Date()) {
  return today(new Date(quote.quoted_at)) === today(now) && now.getTime() - Date.parse(quote.quoted_at) <= 20 * 60000 && Date.parse(quote.quoted_at) <= now.getTime();
}
