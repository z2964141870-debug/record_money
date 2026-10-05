import { GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
const candidates=[process.env.CHART_FONT_PATH,'/System/Library/Fonts/Supplemental/Arial Unicode.ttf','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'].filter((p):p is string=>!!p);
const font=candidates.find(p=>existsSync(p));
if(font)GlobalFonts.registerFromPath(font,'LedgerChinese');
export const chartFont=font?'LedgerChinese':'Noto Sans CJK SC, Hiragino Sans GB, Microsoft YaHei, sans-serif';
