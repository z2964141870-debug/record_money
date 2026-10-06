import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { storagePaths } from './config-files.js';
export const root = fileURLToPath(new URL('../../', import.meta.url));
const paths = storagePaths(root);
export const dataDir = paths.data;
export const logsDir = paths.logs;
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(logsDir, { recursive: true, mode: 0o700 });
dotenv.config({ path: join(dataDir, 'config.env'), quiet: true });
export const config = {
  port: Number(process.env.PORT || 4317),
  webPort: Number(process.env.LEDGER_WEB_PORT || process.env.PORT || 4317),
  appId: process.env.FEISHU_APP_ID || '', appSecret: process.env.FEISHU_APP_SECRET || '',
  aiBaseUrl: process.env.AI_BASE_URL || '', aiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || '', reasoning: process.env.AI_REASONING || 'none',
  feishuEnabled: process.env.FEISHU_ENABLED !== 'false',
  host: process.env.LEDGER_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
};
