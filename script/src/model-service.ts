import { z } from 'zod';
import type { DB } from './db.js';
import { setting, setSetting } from './db.js';
import { saveConfigFields, setupSchema } from './config-files.js';

export type ModelRuntime = { aiBaseUrl: string; aiKey: string; model: string; reasoning: string; port: number };
const inputSchema = z.object({
  model: setupSchema.shape.model, reasoning: setupSchema.shape.reasoning,
  baseUrl: setupSchema.shape.aiBaseUrl.optional(),
  apiKey: z.string().trim().max(1000).refine(v => !/['\r\n\0]/.test(v), '密钥包含不支持的字符').optional(),
});
export function resolveModelService(runtime: ModelRuntime, raw: unknown) {
  const input = inputSchema.parse(raw);
  const next = { aiBaseUrl: (input.baseUrl ?? runtime.aiBaseUrl).replace(/\/$/, ''),
    aiKey: input.apiKey || runtime.aiKey, model: input.model, reasoning: input.reasoning, port: runtime.port };
  // Retain compatibility with the existing model-only settings endpoint.
  if (input.baseUrl !== undefined || input.apiKey) setupSchema.omit({ appId: true, appSecret: true }).parse(next);
  if (input.baseUrl && runtime.aiBaseUrl && new URL(input.baseUrl).origin !== new URL(runtime.aiBaseUrl).origin && !input.apiKey) {
    throw new Error('更换服务域名时请填写新服务的API Key');
  }
  return next;
}
export function saveModelService(db: DB, runtime: ModelRuntime, directory: string, raw: unknown) {
  const next = resolveModelService(runtime, raw);
  db.transaction(() => {
    setSetting(db, 'model', next.model); setSetting(db, 'reasoning', next.reasoning);
    try { saveConfigFields(directory, { AI_BASE_URL: next.aiBaseUrl, AI_API_KEY: next.aiKey, AI_MODEL: next.model, AI_REASONING: next.reasoning }); }
    catch { throw new Error('配置文件保存失败，模型服务未更换，请检查数据目录权限'); }
  })();
  Object.assign(runtime, { aiBaseUrl: next.aiBaseUrl, aiKey: next.aiKey, model: next.model, reasoning: next.reasoning });
  return { ok: true };
}
export function currentModelService(db: DB, runtime: ModelRuntime) {
  return { ...runtime, model: setting(db, 'model', runtime.model), reasoning: setting(db, 'reasoning', runtime.reasoning) };
}
