import { GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const candidates=[process.env.CHART_FONT_PATH,...(process.platform==='win32'?[join(process.env.SystemRoot||'C:\\Windows','Fonts/msyh.ttc'),join(process.env.SystemRoot||'C:\\Windows','Fonts/simhei.ttf')]:[]),'/System/Library/Fonts/Supplemental/Arial Unicode.ttf','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'].filter((p):p is string=>!!p);
const font=candidates.find(p=>existsSync(p));
if(font)GlobalFonts.registerFromPath(font,'LedgerChinese');
export const chartFont=font?'LedgerChinese':'Noto Sans CJK SC, Hiragino Sans GB, Microsoft YaHei, sans-serif';
