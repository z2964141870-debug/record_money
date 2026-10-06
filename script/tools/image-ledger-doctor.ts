import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb, setting, setSetting } from '../src/db.js';
import { root, dataDir, config } from '../src/config.js';
import { normalizeImage } from '../src/images.js';
import { initializeAccounts } from '../src/accounts.js';
import { receiveMessage, processMessage } from '../src/assistant.js';
import { pendingDialogue } from '../src/conversation.js';

if (!process.argv[2]) throw new Error('Usage: tsx tools/image-ledger-doctor.ts /absolute/bill/image');
const dir=join(root,'data','qa','structured-image');mkdirSync(dir,{recursive:true,mode:0o700});
const path=join(dir,'input.png');writeFileSync(path,await normalizeImage(readFileSync(resolve(process.argv[2]))),{mode:0o600});
const production=new Database(join(dataDir,'ledger.sqlite'),{readonly:true});
const digest=()=>createHash('sha256').update(JSON.stringify(['entries','accounts','possessions','loans','loan_installments','loan_events'].map(t=>production.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex');
const before=digest(),db=openDb(':memory:');initializeAccounts(db);
setSetting(db,'model',setting(production,'model',config.model));setSetting(db,'reasoning',setting(production,'reasoning',config.reasoning));
try {
  receiveMessage(db,'image','local','[图片]');db.prepare('INSERT INTO message_images(message_id,path) VALUES(?,?)').run('image',path);
  const preview=await processMessage(db,'image');console.log('原图清单：\n'+preview);
  const analysis=JSON.parse((db.prepare('SELECT analysis_json FROM image_drafts WHERE message_id=?').get('image') as {analysis_json:string}).analysis_json);
  assert.ok(analysis.transactions.length);assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);
  receiveMessage(db,'fill','local','2025年，支付宝余额');const filled=await processMessage(db,'fill');console.log('补充年份账户：\n'+filled);
  const hasDuplicate=analysis.duplicate_groups.length>0||preview.includes('疑似重复');
  if(hasDuplicate)assert.equal(pendingDialogue(db,'local'),undefined,'补充年份账户不能擅自确认重复记录');
  receiveMessage(db,'keep','local','清单中所有R记录都保留，我已经核对了疑点。请给我最终方案。');const proposed=await processMessage(db,'keep');console.log('最终方案：\n'+proposed);
  assert.ok(pendingDialogue(db,'local'));assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,0);
  receiveMessage(db,'confirm','local','确认入账');const confirmation=await processMessage(db,'confirm');console.log('仅内存账本确认：\n'+confirmation);
  const count=(db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n;assert.equal(count,analysis.transactions.length);
  receiveMessage(db,'repeat','local','[同图重发]');db.prepare('INSERT INTO message_images(message_id,path) VALUES(?,?)').run('repeat',path);
  const repeated=await processMessage(db,'repeat');assert.match(repeated,/不再次导入/);assert.equal((db.prepare('SELECT COUNT(*) n FROM entries').get() as {n:number}).n,count);
  assert.equal(digest(),before,'实际财务表必须完全不变');
  writeFileSync(join(dir,'result.json'),JSON.stringify({model:setting(db,'model'),analysis,preview,filled,proposed,confirmation,repeated,isolated_entries:count,production_unchanged:true},null,2)+'\n',{mode:0o600});
  console.log('真实模型连续对话通过；所有测试入账仅存在于内存数据库，实际账本未变。');
} finally { db.close();production.close(); }
