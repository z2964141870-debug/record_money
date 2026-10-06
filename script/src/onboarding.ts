import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { DB } from './db.js';
import { saveSetupConfig, storageRoot } from './config-files.js';
import type { config } from './config.js';

export function needsSetup(runtime: typeof config) {
  return !runtime.appId || !runtime.appSecret || !runtime.aiBaseUrl || !runtime.aiKey || !runtime.model;
}
export function resolveSetup(runtime: typeof config, data: string, fixedStorage: boolean, raw: unknown) {
  const input = z.object({ channel: z.enum(['feishu', 'dingtalk']).default('feishu'), storage: z.string().max(2000).optional(), appId: z.string(), appSecret: z.string(),
    aiBaseUrl: z.string(), aiKey: z.string(), model: z.string(), reasoning: z.enum(['none', 'low', 'medium', 'high']).default('none') }).parse(raw);
  const storage = input.storage ? storageRoot(input.storage) : dirname(data);
  if (fixedStorage && storage !== dirname(data)) throw new Error('存储位置已由部署配置指定');
  return { storage, value: { ...input, port: runtime.port } };
}
export function persistInitialSetup(db: DB, runtime: typeof config, root: string, data: string, fixedStorage: boolean, raw: unknown) {
  if (!needsSetup(runtime)) throw new Error('初始化已完成，请在设置中修改模型服务');
  const next = resolveSetup(runtime, data, fixedStorage, raw);
  const target = join(next.storage, 'data');
  if (resolve(target) !== resolve(data)) {
    const hasData = db.prepare("SELECT (SELECT COUNT(*) FROM entries)+(SELECT COUNT(*) FROM possessions)+(SELECT COUNT(*) FROM loans)+(SELECT COUNT(*) FROM messages)+(SELECT COUNT(*) FROM settings WHERE key='owner') AS n").get() as { n: number };
    if (hasData.n) throw new Error('已有账本不能通过初始化切换存储位置，请先备份');
    if (existsSync(join(target, 'ledger.sqlite')) || existsSync(join(target, 'config.env'))) throw new Error('所选位置已有账本或配置，请选择新的文件夹');
  }
  try { saveSetupConfig(root, next.storage, next.value, { writePointer: !fixedStorage }); }
  catch { throw new Error('配置保存失败，请检查填写内容和存储目录权限'); }
  return { ok: true, restarting: true };
}
