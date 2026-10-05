import { chmodSync, mkdirSync, readdirSync, unlinkSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { setting, setSetting, type DB } from './db.js';
import { today } from './ledger.js';
import {backupAssets} from './backup-assets.js';
export async function backup(db: DB, force = false) {
  const date = today(); if (!force && setting(db, 'backup_date') === date) return null;
  const dir = join(dataDir, 'backups'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `ledger-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  await db.backup(path); chmodSync(path, 0o600);backupAssets(path); setSetting(db, 'backup_date', date);
  const files = readdirSync(dir).filter(f => /^ledger-.*\.sqlite$/.test(f)).sort();
  for (const old of files.slice(0, -30)){unlinkSync(join(dir, old));rmSync(join(dir,old+'.files'),{recursive:true,force:true});}
  return path;
}
