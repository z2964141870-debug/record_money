import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import dotenv from 'dotenv';
import { z } from 'zod';

const field = z.string().trim().min(1).max(1000).refine(v => !/[\r\n\0]/.test(v), '配置不能包含换行');
export const setupSchema = z.object({
  channel: z.enum(['feishu', 'dingtalk']).default('feishu'), appId: field, appSecret: field,
  aiMode: z.enum(['fixed', 'ai']).default('ai'), apiType: z.enum(['responses', 'chat_completions']).default('responses'),
  chatThinking: z.enum(['reasoning_effort','enable_thinking']).default('reasoning_effort'),
  aiBaseUrl: z.union([z.literal(''), field.refine(v => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }, '请输入HTTP或HTTPS基础地址，不包含密钥或查询参数')]).default(''),
  aiKey: field.or(z.literal('')).default(''), model: field.max(100).or(z.literal('')).default(''), reasoning: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  port: z.number().int().min(1024).max(65535).default(4317),
});
export type SetupConfig = z.infer<typeof setupSchema>;
export function validateModelConfig(c: Pick<SetupConfig, 'aiMode' | 'aiBaseUrl' | 'aiKey' | 'model'>) {
  if (c.aiMode === 'ai' && (!c.aiBaseUrl || !c.aiKey || !c.model)) throw new Error('启用AI时请填写服务地址、API Key和模型名称');
}
export function storagePaths(root: string, env: NodeJS.ProcessEnv = process.env) {
  const pointerRoot = env.LEDGER_POINTER_ROOT || root;
  const pointer = join(pointerRoot, 'data', 'runtime-location.txt');
  const storage = existsSync(pointer) ? readFileSync(pointer, 'utf8').trim() : pointerRoot;
  const data = resolve(env.LEDGER_DATA_DIR || join(storage || root, 'data'));
  return { data, logs: resolve(env.LEDGER_LOGS_DIR || join(env.LEDGER_DATA_DIR ? dirname(data) : storage || root, 'logs')) };
}
export function storageRoot(value: string) {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error('存储位置须为绝对路径');
  return resolve(expanded);
}
export function readSetupConfig(data: string) {
  const path = join(data, 'config.env');
  return existsSync(path) ? dotenv.parse(readFileSync(path)) : {};
}
export function saveConfigFields(data: string, updates: Record<string, string>) {
  const body = Object.entries({ ...readSetupConfig(data), ...updates }).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /['\r\n\0]/.test(v)) throw new Error('配置包含不支持的字段或字符');
    return `${k}='${v}'`;
  }).join('\n') + '\n';
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const path = join(data, 'config.env'), temp = path + '.tmp';
  writeFileSync(temp, body, { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path);
  return path;
}
export function saveSetupConfig(root: string, storage: string, raw: unknown, options: { writePointer?: boolean } = {}) {
  const c = setupSchema.parse(raw), base = storageRoot(storage), data = join(base, 'data');
  validateModelConfig(c);
  for (const dir of [data, join(base, 'logs'), ...(options.writePointer === false ? [] : [join(root, 'data')])]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (c.channel === 'feishu' && !/^cli_[a-zA-Z0-9]+$/.test(c.appId)) throw new Error('请输入飞书应用App ID');
  const values = { PORT: String(c.port), CHAT_CHANNEL: c.channel, FEISHU_ENABLED: 'true',
    ...(c.channel === 'dingtalk' ? { DINGTALK_CLIENT_ID: c.appId, DINGTALK_CLIENT_SECRET: c.appSecret } : { FEISHU_APP_ID: c.appId, FEISHU_APP_SECRET: c.appSecret }),
    AI_MODE: c.aiMode, AI_API_TYPE: c.apiType, AI_CHAT_THINKING:c.chatThinking,AI_BASE_URL: c.aiBaseUrl.replace(/\/$/, ''), AI_API_KEY: c.aiKey, AI_MODEL: c.model, AI_REASONING: c.reasoning };
  // Single quotes preserve #, $, double quotes and backticks in dotenv values.
  if (Object.values(values).some(v => v.includes("'"))) throw new Error('配置暂不支持单引号');
  const path = saveConfigFields(data, values);
  if (options.writePointer !== false) writeFileSync(join(root, 'data', 'runtime-location.txt'), base + '\n', { mode: 0o600 });
  return path;
}
