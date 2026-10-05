import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import dotenv from 'dotenv';
export const root = fileURLToPath(new URL('../../', import.meta.url));
const pointer = join(root, 'data', 'runtime-location.txt');
const runtimeRoot = existsSync(pointer) ? readFileSync(pointer, 'utf8').trim() : root;
export const dataDir = process.env.LEDGER_DATA_DIR || join(runtimeRoot, 'data');
export const logsDir = join(runtimeRoot, 'logs');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(logsDir, { recursive: true, mode: 0o700 });
dotenv.config({ path: join(dataDir, 'config.env'), quiet: true });
export const config = {
  port: Number(process.env.PORT || 4317),
  appId: process.env.FEISHU_APP_ID || '', appSecret: process.env.FEISHU_APP_SECRET || '',
  aiBaseUrl: process.env.AI_BASE_URL || '', aiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || 'gpt-6-luna', reasoning: process.env.AI_REASONING || 'medium',
  feishuEnabled: process.env.FEISHU_ENABLED !== 'false',
};
