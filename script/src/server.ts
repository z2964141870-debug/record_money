import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
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
import { reminderSettings, runReminder, saveReminderSettings } from './reminders.js';
import { runOperationRecords } from './operation-records.js';
import { listPossessions, savePossession, archivePossession } from './possessions.js';
import { loanOverview, saveLoan, repayLoan, drawLoan, saveInstallment } from './loans.js';
import { createChart,renderChart } from './charts.js';
import { saveImage, decodeImageDataUrl } from './images.js';
import { currentModelService, resolveModelService, saveModelService } from './model-service.js';
import { checkConnections } from './connection-check.js';
import { needsSetup, persistInitialSetup, resolveSetup } from './onboarding.js';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function buildServer(db = openDb(), options: { configDir?: string; runtimeConfig?: typeof config; modelCheck?: typeof checkConnections; setupRoot?: string; fixedStorage?: boolean; restart?: () => void } = {}) {
  const modelConfig = options.runtimeConfig || config;
  initializeAccounts(db);
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.body', 'res.body'] }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 100_000 });
  const csrf = randomBytes(32).toString('hex');
  const bot = createBot(db);
  const hosts = new Set([config.port, config.webPort].flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]));
  const origins = new Set([...hosts].map(host => 'http://' + host));
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host || !hosts.has(host)) return reply.code(403).send({ error: '仅允许本机访问' });
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
  const setupData = options.configDir || dataDir, fixedStorage = options.fixedStorage ?? !!process.env.LEDGER_DATA_DIR;
  let settingUp = false;
  app.get('/api/bootstrap', async () => ({ csrf, product: 'record-money', version: '0.4.0', today: today(), setupRequired: needsSetup(modelConfig) }));
  app.get('/api/setup', async () => ({ required: needsSetup(modelConfig), storage: dirname(setupData), fixedStorage,
    channel: modelConfig.channel,
    canChooseFolder: !!process.env.LEDGER_DIRECTORY_PICKER, appId: modelConfig.appId, baseUrl: modelConfig.aiBaseUrl,
    model: modelConfig.model, reasoning: modelConfig.reasoning, restarting: settingUp }));
  app.post('/api/setup', async (req, reply) => {
    if (!needsSetup(modelConfig) || settingUp) return reply.code(409).send({ error: '初始化已完成或正在保存，请刷新页面' });
    if (!options.restart) throw new Error('此启动方式不支持自动重启，请使用应用或容器启动');
    const next = resolveSetup(modelConfig, setupData, fixedStorage, req.body);
    settingUp = true;
    try {
      const results = await (options.modelCheck || checkConnections)(next.value);
      if (results.some(r => !r.ok)) { settingUp = false; return reply.code(400).send({ error: '配置尚未保存：' + results.filter(r => !r.ok).map(r => r.service + ' · ' + r.detail).join('；'), results }); }
      const result = persistInitialSetup(db, modelConfig, options.setupRoot || process.env.LEDGER_POINTER_ROOT || root, setupData, fixedStorage, req.body);
      const timer = setTimeout(options.restart, 500); timer.unref();
      return result;
    } catch (e) { settingUp = false; throw e; }
  });
  app.post('/api/setup/folder', async (_req, reply) => {
    if (!needsSetup(modelConfig) || fixedStorage || !process.env.LEDGER_DIRECTORY_PICKER) return reply.code(409).send({ error: '当前部署不支持选择文件夹' });
    try { const { stdout } = await promisify(execFile)(process.env.LEDGER_DIRECTORY_PICKER, ['--choose-folder'], { timeout: 120000, maxBuffer: 8192 }); return { storage: stdout.trim() || null }; }
    catch { throw new Error('未能打开文件夹选择器，可直接填写存储路径'); }
  });
  app.get('/api/possessions',async req=>listPossessions(db,today(),z.object({archived:z.enum(['true','false']).optional()}).parse(req.query).archived==='true'));
  app.post('/api/possessions',async req=>savePossession(db,req.body));
  app.put<{Params:{id:string}}>('/api/possessions/:id',async req=>savePossession(db,req.body,z.coerce.number().int().positive().parse(req.params.id)));
  app.post<{Params:{id:string}}>('/api/possessions/:id/archive',async req=>{archivePossession(db,z.coerce.number().int().positive().parse(req.params.id),z.object({archived:z.boolean()}).parse(req.body).archived);return {ok:true};});
  app.get('/api/loans',async()=>loanOverview(db));
  app.post('/api/loans',async req=>saveLoan(db,req.body));
  app.put<{Params:{id:string}}>('/api/loans/:id',async req=>saveLoan(db,req.body,z.coerce.number().int().positive().parse(req.params.id)));
  app.post<{Params:{id:string}}>('/api/loans/:id/repay',async req=>repayLoan(db,z.coerce.number().int().positive().parse(req.params.id),req.body));
  app.post<{Params:{id:string}}>('/api/loans/:id/draw',async req=>drawLoan(db,z.coerce.number().int().positive().parse(req.params.id),req.body));
  app.post<{Params:{id:string}}>('/api/loans/:id/installments',async req=>saveInstallment(db,z.coerce.number().int().positive().parse(req.params.id),req.body));
  app.put<{Params:{id:string;installment:string}}>('/api/loans/:id/installments/:installment',async req=>saveInstallment(db,z.coerce.number().int().positive().parse(req.params.id),req.body,z.coerce.number().int().positive().parse(req.params.installment)));
  app.post('/api/charts',async req=>{const chart=createChart(db,req.body);return {url:chart.url,id:chart.id};});
  app.post<{Params:{id:string}}>('/api/charts/:id/send',async req=>{
    const id=z.uuid().parse(req.params.id),owner=setting(db,'owner');if(!owner)throw new Error('请先绑定机器人用户');
    const chart=db.prepare('SELECT path FROM chart_files WHERE id=?').get(id) as {path:string}|undefined;if(!chart)throw new Error('图表不存在');
    db.prepare('INSERT OR IGNORE INTO outbox(user_id,text,dedup,image_path,created_at) VALUES(?,?,?,?,?)').run(owner,'','chart-web:'+id,chart.path,new Date().toISOString());return {ok:true};
  });
  app.get<{Params:{id:string}}>('/api/charts/file/:id',async(req,reply)=>{
    const id=z.uuid().parse(req.params.id),chart=db.prepare('SELECT path,snapshot_json FROM chart_files WHERE id=?').get(id) as {path:string;snapshot_json:string}|undefined;
    if(!chart)throw new Error('图表不存在');return reply.header('Cache-Control','no-store').type('image/png').send(existsSync(chart.path)?readFileSync(chart.path):renderChart(JSON.parse(chart.snapshot_json)));
  });
  app.post('/api/images',{bodyLimit:12*1024*1024},async req=>{
    const {image}=z.object({image:z.string().max(12*1024*1024)}).parse(req.body),path=await saveImage(decodeImageDataUrl(image)),id='web:'+randomUUID();
    receiveMessage(db,id,'local','[用户上传图片，请提取文字]');db.prepare('INSERT INTO message_images(message_id,path) VALUES(?,?)').run(id,path);
    try{return {result:await processMessage(db,id)};}catch{db.prepare("UPDATE messages SET status='needs_attention',error='图片识别失败，尚未入账' WHERE id=?").run(id);throw new Error('图片已保存，识别失败，尚未入账；可在运行状态重试');}
  });
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
    lastBackup: setting(db, 'backup_date'), dataDir, reminder: reminderSettings(db), model: setting(db, 'model', modelConfig.model), reasoning: setting(db, 'reasoning', modelConfig.reasoning),
    baseUrl: modelConfig.aiBaseUrl, aiConfigured: !!modelConfig.aiKey, feishuConfigured: !!config.appId && !!config.appSecret, appId: config.appId, channel: config.channel }));
  app.post('/api/bind', async req => {
    const { user } = z.object({ user: z.string().min(1).max(100) }).parse(req.body);
    if (setting(db, 'owner') && user !== setting(db, 'owner')) throw new Error('v0.1不支持切换账本所有者');
    if (user !== setting(db, 'pending_user')) throw new Error('请先私聊机器人发送一条消息');
    setSetting(db, 'owner', user); setSetting(db, 'schedule_start', today());
    queueReply(db, user, '个人账本已绑定，可以开始记账。', 'bound:' + user); return { ok: true };
  });
  app.put('/api/settings', async req => saveModelService(db, modelConfig, options.configDir || dataDir, req.body));
  let checkingModel = false;
  app.post('/api/settings/check', async (req, reply) => {
    if (checkingModel) return reply.code(409).send({ error: '已有连接测试正在进行，请稍后重试' });
    const next = resolveModelService(currentModelService(db, modelConfig), req.body);
    checkingModel = true;
    try { return { results: await (options.modelCheck || checkConnections)(next, { feishu: false }) }; }
    finally { checkingModel = false; }
  });
  app.put('/api/reminders', async req => saveReminderSettings(db, req.body));
  app.post('/api/chat', async req => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body); const id = 'web:' + randomUUID();
    receiveMessage(db, id, 'local', text);
    try { const result=await processMessage(db,id);return {result,images:(db.prepare('SELECT id FROM chart_files WHERE message_id=?').all(id) as {id:string}[]).map(c=>'/api/charts/file/'+c.id)}; }
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
    if (needsSetup(modelConfig)) return;
    void bot.start();
    let ticking = false;
    const tick = async () => { if (ticking) return; ticking = true; try { runReminder(db); runSchedule(db); runOperationRecords(db); await backup(db); } catch { app.log.warn('Periodic task failed; check local storage'); } finally { ticking = false; } };
    void tick(); timer = setInterval(() => { void tick(); }, 60000); timer.unref();
  };
  return { app, db, bot, startBackground };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, startBackground } = await buildServer(undefined, { restart: () => { void app.close().then(() => process.exit(75)); } });
  await app.listen({ host: config.host, port: config.port }); startBackground();
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
