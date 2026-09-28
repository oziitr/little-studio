import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';

export function openStore(directory) {
  mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(path.join(directory,'studio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,body TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations(job TEXT PRIMARY KEY,amount REAL NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,body TEXT NOT NULL,next TEXT NOT NULL,enabled INTEGER NOT NULL);
  `);
  const columns=db.prepare('PRAGMA table_info(jobs)').all().map(x=>x.name);
  for(const [name,type] of [['kind',"TEXT NOT NULL DEFAULT 'story'"],['context',"TEXT NOT NULL DEFAULT '{}'"],['updated',"TEXT NOT NULL DEFAULT ''"]])if(!columns.includes(name))db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  db.exec("UPDATE jobs SET status='queued',message='Sunucu yeniden başladı; kayıtlı aşamadan devam edilecek' WHERE status='running'");
  const keyPath=path.join(directory,'vault.key');
  if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
  const key=readFileSync(keyPath);
  function setting(name,fallback=null){const r=db.prepare('SELECT value FROM settings WHERE key=?').get(name);return r?JSON.parse(r.value):fallback;}
  function setSetting(name,value){db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name,JSON.stringify(value));}
  function secret(name){const data=setting('secret:'+name);if(!data)return '';const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(data.iv,'hex'));decipher.setAuthTag(Buffer.from(data.tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(data.data,'hex')),decipher.final()]).toString();}
  function setSecret(name,value){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(String(value)),cipher.final()]);setSetting('secret:'+name,{iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')});}
  const project=id=>{const r=db.prepare('SELECT * FROM projects WHERE id=?').get(id);return r?{...JSON.parse(r.body),id:r.id,updated:r.updated}:null;};
  const save=(id,p)=>{const {id:unused,updated,...body}=p;db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(id,JSON.stringify(body),new Date().toISOString());return project(id);};
  const job=id=>{const r=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);return r?{...r,context:JSON.parse(r.context)}:null;};
  function updateJob(j,status,message){j.status=status;j.message=message;db.prepare('UPDATE jobs SET status=?,message=?,context=?,updated=? WHERE id=?').run(status,message,JSON.stringify(j.context),new Date().toISOString(),j.id);}
  function totals(now=new Date()){return {day:Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM reservations WHERE created>=?').get(now.toISOString().slice(0,10)).total),month:Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM reservations WHERE created>=?').get(now.toISOString().slice(0,7)+'-01').total)};}
  function enqueue(p,kind,context,cost,limits){db.exec('BEGIN IMMEDIATE');try{
    if(db.prepare("SELECT id FROM jobs WHERE project=? AND status IN ('queued','running','waiting')").get(p.id))throw Error('Bu proje için zaten çalışan veya bekleyen bir iş var.');
    const t=totals();if(cost>limits.perVideo||t.day+cost>limits.daily||t.month+cost>limits.monthly)throw Error('Tahmini maliyet bütçe sınırını aşıyor. Ayarlardaki limitleri kontrol edin.');
    const id=randomBytes(12).toString('hex'),now=new Date().toISOString();
    db.prepare('INSERT INTO jobs(id,project,status,message,created,kind,context,updated) VALUES(?,?,?,?,?,?,?,?)').run(id,p.id,'queued','Sıraya alındı',now,kind,JSON.stringify({...context,snapshot:p,projectVersion:p.updated,estimate:cost,models:{textModel:limits.textModel,imageModel:limits.imageModel,videoModel:limits.videoModel}}),now);
    if(cost)db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(id,cost,now);db.exec('COMMIT');return job(id);
  }catch(e){db.exec('ROLLBACK');throw e;}}
  return {db,setting,setSetting,secret,setSecret,project,save,job,updateJob,totals,enqueue,directory};
}
