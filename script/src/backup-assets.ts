import Database from 'better-sqlite3';
import {basename,join} from 'node:path';
import {chmodSync,copyFileSync,existsSync,mkdirSync} from 'node:fs';
import {dataDir} from './config.js';
const validName=(path:string)=>/^[0-9a-f-]{36}\.png$/.test(basename(path));
export function backupAssets(databasePath:string) {
  const db=new Database(databasePath,{readonly:true,fileMustExist:true});
  try {
    for(const [table,folder] of [['message_images','images'],['chart_files','charts']]) {
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))continue;
      const rows=db.prepare(`SELECT path FROM ${table} WHERE path IS NOT NULL`).all() as {path:string}[];
      for(const row of rows){if(!existsSync(row.path)||!validName(row.path))continue;const dir=join(databasePath+'.files',folder);mkdirSync(dir,{recursive:true,mode:0o700});const target=join(dir,basename(row.path));copyFileSync(row.path,target);chmodSync(target,0o600);}
    }
  }finally{db.close();}
}
export function restoreAssets(databasePath:string,targetDatabase:string,directory=dataDir) {
  const db=new Database(targetDatabase,{fileMustExist:true});
  try{db.transaction(()=>{
    for(const [table,folder] of [['message_images','images'],['chart_files','charts']]) {
      if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))continue;
      const rows=db.prepare(`SELECT rowid,path FROM ${table} WHERE path IS NOT NULL`).all() as {rowid:number;path:string}[];
      for(const row of rows){if(!validName(row.path))continue;const target=join(directory,folder,basename(row.path)),source=join(databasePath+'.files',folder,basename(row.path));
        if(existsSync(source)){mkdirSync(join(directory,folder),{recursive:true,mode:0o700});copyFileSync(source,target);chmodSync(target,0o600);}
        db.prepare(`UPDATE ${table} SET path=? WHERE rowid=?`).run(target,row.rowid);
      }
    }
    if((db.pragma('table_info(outbox)') as {name:string}[]).some(c=>c.name==='image_path')) {
      const queued=db.prepare('SELECT id,image_path FROM outbox WHERE image_path IS NOT NULL').all() as {id:number;image_path:string}[];
      for(const row of queued)if(validName(row.image_path))db.prepare('UPDATE outbox SET image_path=? WHERE id=?').run(join(directory,'charts',basename(row.image_path)),row.id);
    }
  })();}finally{db.close();}
}
