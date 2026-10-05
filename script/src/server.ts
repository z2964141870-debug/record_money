import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { config, root, dataDir } from './config.js';
import { openDb, setting, setSetting } from './db.js';
import { createEntry, updateEntry, cancelEntry, listEntries, summary, csv, getEntry, today, dateSchema } from './ledger.js';
import { createBot } from './bot.js';
import { processMessage, queueReply, receiveMessage, resolveConfirmation } from './assistant.js';
import { reportText, runSchedule } from './reports.js';
import { backup } from './backup.js';
import { accountOverview, initializeAccounts, saveAccount } from './accounts.js';
export async function buildServer(db = openDb()) {
  initializeAccounts(db);
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.body', 'res.body'] }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 100_000 });
  const csrf = randomBytes(32).toString('hex');
  const bot = createBot(db);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) return reply.code(403).send({ error: '仅允许本机访问' });
    if (request.headers.origin && !origins.has(request.headers.origin)) return reply.code(403).send({ error: '请求来源不允许' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const token = request.headers['x-ledger-token'];
      if (typeof token !== 'string' || Buffer.byteLength(token) !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) return reply.code(403).send({ error: '请刷新页面后重试' });
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof z.ZodError ? '输入无效：' + error.issues.map(i => i.message).join('；') : error instanceof Error ? error.message : '操作失败';
    reply.code(400).send({ error: message.slice(0, 400) });
  });
  const filters = (query: unknown) => z.object({ start: dateSchema.optional(), end: dateSchema.optional(), kind: z.string().optional(), category: z.string().optional(), q: z.string().max(200).optional(), includeCancelled: z.enum(['true', 'false']).optional() }).parse(query);
  app.get('/api/bootstrap', async () => ({ csrf, version: '0.1.0', today: today() }));
  app.get('/api/accounts', async () => accountOverview(db));
  app.post('/api/accounts', async req => saveAccount(db, req.body));
  app.put<{ Params: { id: string } }>('/api/accounts/:id', async req => saveAccount(db, req.body, z.coerce.number().int().positive().parse(req.params.id)));
  app.get<{ Params: { id: string } }>('/api/accounts/:id/history', async req => db.prepare('SELECT * FROM account_audit WHERE account_id=? ORDER BY id DESC').all(z.coerce.number().int().positive().parse(req.params.id)));
  app.get('/api/entries', async req => { const f = filters(req.query); return listEntries(db, { ...f, includeCancelled: f.includeCancelled === 'true' }); });
  app.get('/api/summary', async req => { const q = z.object({ start: dateSchema, end: dateSchema }).parse(req.query); return summary(db, q.start, q.end); });
  app.post('/api/entries', async req => createEntry(db, req.body));
  app.put<{ Params: { id: string } }>('/api/entries/:id', async req => updateEntry(db, z.coerce.number().int().positive().parse(req.params.id), req.body));
  app.delete<{ Params: { id: string } }>('/api/entries/:id', async req => { cancelEntry(db, z.coerce.number().int().positive().parse(req.params.id)); return { ok: true }; });
  app.get('/api/export', async (req, reply) => { const f = filters(req.query); return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="ledger.csv"').send(csv(listEntries(db, { ...f, includeCancelled: f.includeCancelled === 'true' }))); });
  app.get<{ Params: { id: string } }>('/api/entries/:id/history', async req => db.prepare('SELECT * FROM audit WHERE entry_id=? ORDER BY id DESC').all(z.coerce.number().int().positive().parse(req.params.id)));
  app.get('/api/status', async () => ({ bot: bot.status, owner: setting(db, 'owner'), pendingUser: setting(db, 'pending_user'),
    pendingMessages: db.prepare("SELECT id,user_id,text,received_at,attempts,status,error FROM messages WHERE status!='done' ORDER BY received_at DESC LIMIT 100").all(),
    confirmations: db.prepare('SELECT * FROM confirmations WHERE resolved_at IS NULL ORDER BY id DESC').all().map(raw => { const c = raw as { action_json: string }; const saved = JSON.parse(c.action_json); return { ...c, action: saved.action, candidates: saved.candidates.map((id: number) => { try { return getEntry(db, id); } catch { return null; } }).filter(Boolean) }; }),
    outbox: (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='pending'").get() as { n: number }).n,
    lastBackup: setting(db, 'backup_date'), dataDir, model: setting(db, 'model', config.model), reasoning: setting(db, 'reasoning', config.reasoning),
    baseUrl: config.aiBaseUrl, aiConfigured: !!config.aiKey, feishuConfigured: !!config.appId && !!config.appSecret, appId: config.appId }));
  app.post('/api/bind', async req => {
    const { user } = z.object({ user: z.string().min(1).max(100) }).parse(req.body);
    if (setting(db, 'owner') && user !== setting(db, 'owner')) throw new Error('v0.1不支持切换账本所有者');
    if (user !== setting(db, 'pending_user')) throw new Error('请先从飞书私聊机器人发送一条消息');
    setSetting(db, 'owner', user); setSetting(db, 'schedule_start', today());
    queueReply(db, user, '个人账本已绑定，可以开始记账。', 'bound:' + user); return { ok: true };
  });
  app.put('/api/settings', async req => {
    const input = z.object({ model: z.string().trim().min(1).max(100), reasoning: z.enum(['none', 'low', 'medium', 'high']) }).parse(req.body);
    setSetting(db, 'model', input.model); setSetting(db, 'reasoning', input.reasoning); return { ok: true };
  });
  app.post('/api/chat', async req => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body); const id = 'web:' + randomUUID();
    receiveMessage(db, id, 'local', text);
    try { return { result: await processMessage(db, id) }; }
    catch { db.prepare("UPDATE messages SET status='needs_attention',error='模型或输入处理失败，尚未入账' WHERE id=?").run(id); throw new Error('模型或输入处理失败，消息已保存，尚未入账；可在运行状态中重试'); }
  });
  app.post('/api/confirm', async req => {
    const { id, entry } = z.object({ id: z.number().int().positive(), entry: z.number().int().positive() }).parse(req.body);
    const record = db.prepare('SELECT user_id FROM confirmations WHERE id=?').get(id) as { user_id: string } | undefined;
    if (!record) throw new Error('确认单不存在');
    const result = resolveConfirmation(db, id, entry, record.user_id);
    if (record.user_id !== 'local') queueReply(db, record.user_id, result, 'confirm:' + id);
    return { result };
  });
  app.post('/api/messages/retry', async req => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as { status: string; user_id: string } | undefined;
    if (!message || message.status === 'done') throw new Error('消息不存在或已处理');
    if (message.user_id === 'local') { db.prepare("UPDATE messages SET status='pending' WHERE id=?").run(id); return { result: await processMessage(db, id) }; }
    db.prepare("UPDATE messages SET status='pending',attempts=0,next_attempt=0 WHERE id=?").run(id); return { result: '已加入重试队列' };
  });
  app.post('/api/messages/dismiss', async req => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    db.prepare("UPDATE messages SET status='done',result='已由用户忽略',error=NULL WHERE id=? AND status!='done'").run(id); return { ok: true };
  });
  app.get('/api/reports', async () => db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 100').all());
  app.post('/api/reports/preview', async req => { const q = z.object({ start: dateSchema, end: dateSchema, period: z.enum(['daily', 'weekly', 'monthly']) }).parse(req.body); return { text: reportText(db, q.period, q.start, q.end, today() + '（手动生成）') }; });
  app.post('/api/backup', async () => ({ path: await backup(db, true) }));
  const dist = join(root, 'script', 'dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
  }
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); bot.stop(); db.close(); });
  const startBackground = () => {
    void bot.start();
    let ticking = false;
    const tick = async () => { if (ticking) return; ticking = true; try { runSchedule(db); await backup(db); } catch { app.log.warn('Periodic task failed; check local storage'); } finally { ticking = false; } };
    void tick(); timer = setInterval(() => { void tick(); }, 60000); timer.unref();
  };
  return { app, db, bot, startBackground };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, startBackground } = await buildServer();
  await app.listen({ host: '127.0.0.1', port: config.port }); startBackground();
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
