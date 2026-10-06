import type { Action } from './ai.js';
import { cents, dateSchema } from './ledger.js';
import { ZodError } from 'zod';

export const fixedHint = '请按固定格式发送，例如：支出 20 餐饮 奶茶。';
export class CommandError extends Error {}
function tokens(text: string): string[] {
  const parts: string[] = [];
  let word = '', quoted = false, started = false;
  for (const char of text.trim()) {
    if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) parts.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  if (quoted) throw new CommandError('双引号未闭合');
  if (started) parts.push(word);
  return parts;
}
function numberId(value?: string) {
  if (!value || !/^#[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value.slice(1)))) throw new CommandError('请填写有效账目编号，例如 #123');
  return Number(value.slice(1));
}
export function fixedCommands(text: string, date: string): Action[] | null {
  const input = text.trim();
  const quick: Record<string, Action> = {
    今日账单: {type:'query',start:date,end:date}, 本月账单: {type:'query',start:date.slice(0,7)+'-01',end:date},
    本月饼图: {type:'chart',kind:'pie',start:date.slice(0,7)+'-01',end:date},
    本月账单图: {type:'chart',kind:'bill',start:date.slice(0,7)+'-01',end:date}, 资金分布图: {type:'chart',kind:'funds'},
  };
  if (quick[input]) return [quick[input]];
  // An explicit command remains a command even when its arguments are invalid.
  if (!/^(支出|收入|退款|修改|撤销)(?:\s|#|$)|^(今日账单|本月账单|本月饼图|资金分布图)/.test(input)) return null;
  try {
    const [command, ...args] = tokens(input), options: Record<string,string> = {};
    while (args.length && /^(日期|账户)=/.test(args.at(-1)!)) {
      const last=args.pop()!, at=last.indexOf('='), key=last.slice(0,at);
      if (options[key] !== undefined || !last.slice(at+1)) throw new CommandError('日期或账户选项重复或为空');
      options[key]=last.slice(at+1);
    }
    const when = dateSchema.parse(options.日期 || date), account=options.账户;
    if(command==='支出'||command==='收入') {
      if(args.length<3) throw new CommandError('格式：支出 金额 分类 说明，例如 支出 20 餐饮 奶茶');
      cents(args[0]);
      return [{type:'add',kind:command==='支出'?'expense':'income',amount:args[0],category:args[1],merchant:args.slice(2).join(' '),date:when,...(account?{account}:{})}];
    }
    const id=numberId(args[0]);
    if(command==='退款') {
      if(args.length!==2) throw new CommandError('格式：退款 #编号 金额');
      cents(args[1]); return [{type:'refund',id,amount:args[1],date:when,...(account?{account}:{})}];
    }
    if(command==='修改') {
      if(args.length!==3||args[1]!=='金额'||Object.keys(options).length) throw new CommandError('格式：修改 #编号 金额 新金额');
      cents(args[2]); return [{type:'update',id,amount:args[2]}];
    }
    if(command==='撤销') {
      if(args.length!==1||Object.keys(options).length) throw new CommandError('格式：撤销 #编号');
      return [{type:'cancel',id}];
    }
    throw new CommandError('该命令不接受额外参数');
  } catch(error) {
    if (error instanceof ZodError) throw new CommandError('日期无效，请填写 YYYY-MM-DD');
    throw new CommandError(error instanceof Error ? error.message : '命令格式无效');
  }
}
