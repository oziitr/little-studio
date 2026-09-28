import http from 'node:http';
import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from './core.mjs';
import { openStore } from './lib/store.mjs';
import { config, validateConfig } from './lib/config.mjs';
import { YouTube } from './lib/youtube.mjs';
import { createWorker, estimate } from './lib/worker.mjs';
import { mediaAvailable, diskSpace, inspect } from './lib/media.mjs';
import { GoogleProvider } from './lib/google.mjs';
import { hasWebSession, sessionInfo, saveWebSession, clearWebSession, GeminiWebProvider, webSessionPath } from './lib/geminibot.mjs';
import { notify } from './lib/notify.mjs';
import { publishTick, normalizePublishSchedule } from './lib/publish.mjs';


const root=path.dirname(fileURLToPath(import.meta.url));
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3210),password=process.env.STUDIO_PASSWORD||'';
if((!['127.0.0.1','localhost','::1'].includes(host)||process.env.PUBLIC_HTTPS==='true')&&password.length<20)throw Error('Dış erişim için en az 20 karakter yönetici şifresi gerekli.');
const store=openStore(process.env.DATA_DIR||path.join(root,'data'));
const youtube=new YouTube(store),worker=createWorker(store,youtube);
// Restart sonrası yarım kalan "running" işleri tekrar kuyruğa al
{
  const stuck=store.db.prepare("SELECT id,context FROM jobs WHERE status='running'").all();
  for(const row of stuck){
    let ctx={};try{ctx=JSON.parse(row.context||'{}');}catch{}
    for(const v of Object.values(ctx.steps||{})){
      if(v&&typeof v==='object'){delete v.sending;delete v.operation;}
    }
    store.db.prepare("UPDATE jobs SET status='queued', message=?, context=?, updated=? WHERE id=?")
      .run('Kesinti sonrası devam',JSON.stringify(ctx),new Date().toISOString(),row.id);
  }
  if(stuck.length)console.log(`Yeniden kuyruğa alınan iş: ${stuck.length}`);
}
const sessions=new Map(),attempts=new Map();let mediaReady=await mediaAvailable();
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
async function body(req,limit=8000000){let data='';for await(const c of req){data+=c;if(Buffer.byteLength(data)>limit)throw Error('İstek boyutu sınırı aşıldı.');}return JSON.parse(data||'{}');}
function active(id){return store.db.prepare("SELECT id FROM jobs WHERE project=? AND status IN ('queued','running')").get(id);}
function enqueue(p,kind,input={}){
  const c=config(store);if(!['story','image','video','render','pipeline','upload'].includes(kind))throw Error('İş türü geçersiz.');
  const needsKey=['story','image','video'].includes(kind)||(kind==='pipeline'&&(!p.scenes.length||p.scenes.some(s=>!s.clip)));
  if(needsKey){
    if(c.provider==='web'){if(!hasWebSession(store.directory))throw Error('Gemini web oturumu yok. deploy/gemini-login.mjs ile oturum dosyası oluşturulup sunucuya yüklenmeli.');}
    else if(!c.paid||!c.pricesConfirmed||!(process.env.GEMINI_API_KEY||store.secret('gemini')))throw Error('Google anahtarı ve fiyat onayı ile ücretli üretimi etkinleştirin. Bütün sahneleri elle yüklediyseniz anahtar gerekmez.');
  }
  const index=Number(input.index);if(['image','video'].includes(kind)&&(!Number.isInteger(index)||!p.scenes[index]))throw Error('Sahne bulunamadı.');
  if(kind==='image'&&p.scenes[index].image)throw Error('Bu sahnenin görseli zaten var. Yeniden üretmek için sahne görsel açıklamasını değiştirin.');
  if(kind==='video'&&p.scenes[index].clip)throw Error('Mevcut klip yeniden üretilmez.');
  if(['render','pipeline'].includes(kind)&&!mediaReady)throw Error('Sunucuda FFmpeg/FFprobe eksik.');
  const publish={privacy:['private','unlisted','public'].includes(input.publish?.privacy)?input.publish.privacy:'private',description:String(input.publish?.description||'').slice(0,4500)};
  if(input.publish?.publishAt){const date=new Date(input.publish.publishAt);if(!Number.isFinite(date.getTime())||date.getTime()<Date.now()+60000)throw Error('Geçerli bir gelecek yayın tarihi seçin.');publish.publishAt=date.toISOString();}
  if((kind==='upload'||input.autoUpload===true||(kind==='pipeline'&&input.autoUpload!==false&&c.autoSharePool))&&!youtube.accounts().length)throw Error('YouTube hesabını bağlayın.');
  if((publish.privacy==='public'||publish.publishAt)&&!c.autoPublish)throw Error('Herkese açık yayın ayarlardan açılmalı.');
  if(kind==='upload'&&p.youtube)throw Error('Bu projenin videosu zaten yüklendi.');
  if(kind==='upload'&&!p.output)throw Error('Havuzda monte edilmiş video yok.');
  const autoUpload=input.autoUpload===true?true:input.autoUpload===false?false:undefined;
  return store.enqueue(p,kind,{
    index,
    autoUpload,
    publish,
    accountId:typeof input.account==='string'?input.account.slice(0,12):undefined,
    autoIdea:input.autoIdea===true
  },c.provider==='web'?0:estimate(kind,p,c,index),c);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try{
    const url=new URL(req.url,'http://localhost');
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin){const expected=config(store).publicUrl||`http://${req.headers.host}`;if(new URL(req.headers.origin).origin!==new URL(expected).origin)return json(res,403,{error:'Geçersiz kaynak.'});}
    if(url.pathname==='/health'&&req.method==='GET')return json(res,200,{ok:true});
    if(url.pathname==='/api/login'&&req.method==='POST'){
      const ip=req.socket.remoteAddress;const a=attempts.get(ip)||{n:0,until:Date.now()+600000};if(a.until<Date.now()){a.n=0;a.until=Date.now()+600000;}
      if(a.n>=10)return json(res,429,{error:'Çok fazla deneme. 10 dakika bekleyin.'});const input=await body(req);
      if(password&&!equal(String(input.password||''),password)){a.n++;attempts.set(ip,a);return json(res,401,{error:'Şifre yanlış.'});}
      const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+43200000);attempts.delete(ip);
      res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.PUBLIC_HTTPS==='true'?'; Secure':''}`);return json(res,200,{ok:true});
    }
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);
    if((url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/'))&&password&&!(sessions.get(token)>Date.now()))return json(res,401,{error:'Oturum açın.'});
    if(url.pathname==='/api/logout'&&req.method==='POST'){sessions.delete(token);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
    if(url.pathname==='/api/state'&&req.method==='GET'){
      const c=config(store);return json(res,200,{projects:store.db.prepare('SELECT id FROM projects ORDER BY updated DESC').all().map(r=>store.project(r.id)),jobs:store.db.prepare("SELECT id,project,status,message,created,kind,json_extract(context,'$.estimate') AS estimate FROM jobs ORDER BY created DESC LIMIT 100").all(),integrations:{google:!!(process.env.GEMINI_API_KEY||store.secret('gemini')),paid:c.paid,youtube:youtube.accounts().length>0,ffmpeg:mediaReady,oauth:!!(c.clientId&&(store.secret('youtubeClientSecret')||process.env.YOUTUBE_CLIENT_SECRET)),websession:hasWebSession(store.directory),telegram:!!store.secret('telegramToken')},gemini:sessionInfo(store.directory),accounts:youtube.accounts(),config:c,budget:store.totals(),freeGB:await diskSpace(store.directory),system:{version:pkg.version,node:process.version,uptime:Math.floor(process.uptime()),mediaReady},schedules:store.db.prepare('SELECT * FROM schedules').all().map(s=>({...s,body:JSON.parse(s.body)}))});
    }
    if(url.pathname==='/api/gemini/session'&&req.method==='POST'){
      const input=await body(req,2*1024*1024);
      const info=await saveWebSession(store.directory,input.session||input);
      const prev=config(store);
      store.setSetting('config',{...prev,provider:'web'});
      return json(res,200,{ok:true,gemini:info,provider:'web'});
    }
    if(url.pathname==='/api/gemini/session'&&req.method==='DELETE'){
      return json(res,200,{ok:true,gemini:await clearWebSession(store.directory)});
    }
    if(url.pathname==='/api/settings'&&req.method==='PUT'){
      const input=await body(req);
      // mevcut publishSchedule sayaçlarını koru (UI göndermezse)
      const prev=config(store);
      if(input.publishSchedule&&typeof input.publishSchedule==='object'){
        const merged={...prev.publishSchedule,...input.publishSchedule};
        merged.runsDone=prev.publishSchedule.runsDone;
        if(input.publishSchedule.nextAt===undefined)merged.nextAt=prev.publishSchedule.nextAt;
        if(merged.enabled===true&&!merged.nextAt)merged.nextAt=new Date().toISOString();
        input.publishSchedule=merged;
      }else input.publishSchedule=prev.publishSchedule;
      if(input.autoPilot&&typeof input.autoPilot==='object'){
        const merged={...prev.autoPilot,...input.autoPilot};
        merged.runsDone=prev.autoPilot?.runsDone||0;
        if(input.autoPilot.nextAt===undefined)merged.nextAt=prev.autoPilot?.nextAt||null;
        if(merged.enabled===true&&!merged.nextAt)merged.nextAt=new Date().toISOString();
        input.autoPilot=merged;
      }else input.autoPilot=prev.autoPilot||{};
      const c=validateConfig(input);store.setSetting('config',c);
      if(input.apiKey)store.setSecret('gemini',String(input.apiKey).trim());
      if(input.clientSecret)store.setSecret('youtubeClientSecret',String(input.clientSecret).trim());
      // telegram token kabul edilmez (pasif)
      mediaReady=await mediaAvailable();return json(res,200,{ok:true});
    }
    if(url.pathname==='/api/telegram/test'&&req.method==='POST'){return json(res,400,{error:'Telegram şimdilik kapalı.'});}
    if(url.pathname==='/api/settings/test/google'&&req.method==='POST'){const key=process.env.GEMINI_API_KEY||store.secret('gemini');if(!key)throw Error('Önce Gemini API anahtarını kaydedin.');const c=config(store),probe=new GoogleProvider(key);const [text,image,video]=await Promise.all([probe.modelInfo(c.textModel),probe.modelInfo(c.imageModel),probe.modelInfo(c.videoModel)]);return json(res,200,{ok:true,found:{text,image,video}});}
    if(url.pathname==='/api/settings/test/youtube'&&req.method==='POST'){await youtube.token();return json(res,200,{ok:true});}
    if(url.pathname==='/api/youtube/connect'&&req.method==='POST')return json(res,200,{url:youtube.authorization(token||'local')});
    if(url.pathname==='/api/youtube/callback'&&req.method==='GET'){await youtube.callback(url.searchParams.get('code'),url.searchParams.get('state'),token||'local');res.writeHead(302,{Location:'/?view=settings&tab=youtube'});return res.end();}
    if(url.pathname==='/api/youtube/disconnect'&&req.method==='POST'){const input=await body(req);if(input.id)youtube.removeAccount(String(input.id).slice(0,12));else store.setSecret('youtubeTokens','');return json(res,200,{ok:true});}
    if(url.pathname==='/api/youtube/account'&&req.method==='POST'){
      const input=await body(req);const id=String(input.id||'').slice(0,12);
      if(input.refresh===true)return json(res,200,{account:await youtube.refreshAccount(id)});
      const patch={};
      if(input.active!==undefined)patch.active=input.active===true;
      if(typeof input.label==='string')patch.label=input.label;
      if(input.schedule&&typeof input.schedule==='object'){
        const prev=youtube.accounts().find(a=>a.id===id)?.schedule||{};
        patch.schedule={...prev,...input.schedule};
        if(patch.schedule.enabled===true&&!patch.schedule.nextAt)patch.schedule.nextAt=new Date().toISOString();
      }
      return json(res,200,{account:youtube.updateAccount(id,patch)});
    }
    if(url.pathname==='/api/youtube/refresh'&&req.method==='POST'){return json(res,200,{accounts:await youtube.refreshAll()});}
    if(url.pathname==='/api/stats'&&req.method==='GET'){
      const projects=store.db.prepare('SELECT id FROM projects').all().map(r=>store.project(r.id)).filter(p=>p.youtube?.id);
      const byAcc={};for(const p of projects){const acc=p.youtube.accountId||youtube.accounts()[0]?.id;if(!acc)continue;(byAcc[acc]??=[]).push(p.youtube.id);}
      const stats=await youtube.stats(byAcc);
      return json(res,200,{videos:projects.map(p=>({project:p.id,title:p.title,videoId:p.youtube.id,url:p.youtube.url,accountId:p.youtube.accountId,accountLabel:p.youtube.accountLabel||youtube.accounts().find(a=>a.id===(p.youtube.accountId||youtube.accounts()[0]?.id))?.label||'Hesap',publishedAt:p.youtube.publishedAt||p.pool?.publishedAt||null,stats:stats[p.youtube.id]||null})),monetization:null,note:'Para kazanma (RPM/tahmini gelir) kanal monetizasyonu açıldığında eklenecek.'});
    }
    if(url.pathname==='/api/pool'&&req.method==='GET'){
      const items=store.db.prepare('SELECT id FROM projects ORDER BY updated DESC').all().map(r=>store.project(r.id))
        .filter(p=>p.output||p.pool||p.youtube)
        .map(p=>({
          id:p.id,title:p.title,length:p.length,language:p.language,
          scenes:p.scenes?.length||0,duration:(p.scenes?.length||0)*8,
          output:p.output||null,youtube:p.youtube||null,
          pool:p.pool||(p.youtube?{status:'published',accountLabel:p.youtube.accountLabel}:{status:p.output?'ready':'draft'}),
          updated:p.updated
        }));
      return json(res,200,{items,ready:items.filter(i=>i.pool?.status==='ready').length,published:items.filter(i=>i.pool?.status==='published'||i.youtube).length});
    }
    if(url.pathname==='/api/projects'&&req.method==='POST'){
      const raw=await body(req);
      if(!String(raw.title||'').trim()&&!String(raw.idea||'').trim())throw Error('Hikâyeni yaz.');
      const p=validateProject(raw);const id=randomBytes(12).toString('hex');return json(res,201,store.save(id,p));
    }
    const poolShare=url.pathname.match(/^\/api\/pool\/([a-f0-9]{24})\/share$/);
    if(poolShare&&req.method==='POST'){
      const p=store.project(poolShare[1]);if(!p)throw Error('Proje bulunamadı.');
      if(!p.output)throw Error('Önce video üretilmeli.');
      if(p.youtube)throw Error('Bu video zaten yüklendi.');
      if(active(p.id))throw Error('Bu proje için çalışan iş var.');
      const input=await body(req);
      return json(res,202,enqueue(p,'upload',{publish:input.publish||{privacy:'public'},account:input.account,autoUpload:true}));
    }
    const projectMatch=url.pathname.match(/^\/api\/projects\/([a-f0-9]{24})(?:\/(jobs|reference))?$/);
    if(projectMatch){const p=store.project(projectMatch[1]);if(!p)return json(res,404,{error:'Proje bulunamadı.'});
      if(req.method==='PUT'&&!projectMatch[2]){if(active(p.id))throw Error('Üretim sürerken proje düzenlenemez.');const raw=await body(req),next=validateProject(raw);
        const sameCharacter=next.character===p.character&&next.style===p.style&&next.age===p.age;next.reference=p.reference;
        next.scenes=next.scenes.map((s,i)=>{const old=p.scenes[i];if(sameCharacter&&old?.visual===s.visual){s.image=old.image;if(old.motion===s.motion&&old.narration===s.narration&&next.language===p.language)s.clip=old.clip;}return s;});
        if(JSON.stringify(next.scenes)===JSON.stringify(p.scenes)&&next.subtitles===p.subtitles){next.output=p.output;next.youtube=p.youtube;}
        return json(res,200,store.save(p.id,next));
      }
      if(req.method==='POST'&&projectMatch[2]==='jobs'){const input=await body(req);return json(res,202,enqueue(p,input.kind,input));}
      if(req.method==='POST'&&projectMatch[2]==='reference'){
        if(active(p.id))throw Error('Üretim sırasında referans değiştirilemez.');const input=await body(req);const bytes=Buffer.from(String(input.data||''),'base64');const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
        if(bytes.length>5*1024*1024||(!png&&!jpg))throw Error('En fazla 5 MB PNG veya JPEG yükleyin.');const file=randomBytes(12).toString('hex')+(png?'.png':'.jpg');const dir=path.join(store.directory,'media',p.id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,file),bytes);p.reference={file,mimeType:png?'image/png':'image/jpeg'};p.scenes=p.scenes.map(({image,clip,...s})=>s);delete p.output;delete p.youtube;store.save(p.id,p);return json(res,200,{ok:true});
      }
    }
    const sceneMedia=url.pathname.match(/^\/api\/projects\/([a-f0-9]{24})\/scenes\/(\d+)\/media$/);
    if(sceneMedia&&req.method==='POST'){
      const p=store.project(sceneMedia[1]);if(!p)throw Error('Proje bulunamadı.');
      const i=Number(sceneMedia[2]);if(!p.scenes[i])throw Error('Sahne bulunamadı.');
      if(active(p.id))throw Error('Üretim sürerken dosya yüklenemez.');
      if(p.youtube)throw Error('Video YouTube\'a yüklendi; değişiklik için yeni proje oluşturun.');
      const input=await body(req,140*1024*1024);const clip=input.kind==='clip';
      const bytes=Buffer.from(String(input.data||''),'base64');
      const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.length>12&&bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP',mp4=bytes.length>12&&bytes.subarray(4,8).toString('latin1')==='ftyp';
      const dir=path.join(store.directory,'media',p.id);await mkdir(dir,{recursive:true});
      if(!clip){
        if(bytes.length>10*1024*1024||(!png&&!jpg&&!webp))throw Error('En fazla 10 MB PNG, JPEG veya WebP yükleyin.');
        const file=randomBytes(12).toString('hex')+(png?'.png':jpg?'.jpg':'.webp');await writeFile(path.join(dir,file),bytes);
        p.scenes[i].image={file,mimeType:png?'image/png':jpg?'image/jpeg':'image/webp'};delete p.scenes[i].clip;
      }else{
        if(bytes.length>100*1024*1024||!mp4)throw Error('En fazla 100 MB MP4 yükleyin.');
        const file=randomBytes(12).toString('hex')+'.mp4',full=path.join(dir,file);await writeFile(full,bytes);
        let meta;try{meta=await inspect(full);}catch{await rm(full,{force:true});throw Error('Video dosyası okunamadı.');}
        const dur=Number(meta.format?.duration||0);
        if(!meta.streams?.some(s=>s.codec_type==='video')||dur<7||dur>15){await rm(full,{force:true});throw Error('7–15 saniye arası, video akışı olan bir MP4 yükleyin. Montaj ilk 8 saniyeyi kullanır.');}
        p.scenes[i].clip={file};
      }
      delete p.output;store.save(p.id,p);return json(res,200,{ok:true});
    }
    const retry=url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})\/resume$/);
    if(retry&&req.method==='POST'){const j=store.job(retry[1]);if(!j||!['failed','interrupted'].includes(j.status))throw Error('İş devam ettirilemez.');if(active(j.project))throw Error('Proje için çalışan iş var.');const p=store.project(j.project);if(j.context.projectVersion&&p.updated!==j.context.projectVersion)throw Error('Proje değişti; eski iş devam ettirilemez.');store.updateJob(j,'queued','Kayıtlı aşamalardan devam ediliyor');return json(res,200,{ok:true});}
    if(url.pathname==='/api/schedules'&&req.method==='POST'){
      const input=await body(req),p=store.project(input.project);if(!p)throw Error('Şablon proje bulunamadı.');const date=new Date(input.next),hours=Number(input.hours||24);if(!Number.isFinite(date.getTime())||date.getTime()<Date.now()||!Number.isInteger(hours)||hours<6||hours>720)throw Error('Geçerli başlangıç ve 6–720 saat aralığı seçin.');
      const id=randomBytes(12).toString('hex');store.db.prepare('INSERT INTO schedules VALUES(?,?,?,?)').run(id,JSON.stringify({project:p.id,hours,autoUpload:input.autoUpload===true,privacy:input.privacy==='public'?'public':'private'}),date.toISOString(),1);return json(res,201,{id});
    }
    const schedule=url.pathname.match(/^\/api\/schedules\/([a-f0-9]{24})$/);if(schedule&&req.method==='DELETE'){store.db.prepare('DELETE FROM schedules WHERE id=?').run(schedule[1]);return json(res,200,{ok:true});}
    if(url.pathname.startsWith('/media/')){
      const parts=url.pathname.slice(7).split('/');if(parts.length<2||parts.length>3||!parts.every((p,i)=>i===parts.length-1?/^[a-f0-9]{24}\.(png|jpg|webp|mp4)$|^output\.mp4$/.test(p):/^[a-f0-9]{24}$/.test(p)))return json(res,404,{error:'Dosya bulunamadı.'});
      const file=path.join(store.directory,'media',...parts);let info;try{info=await stat(file);}catch{return json(res,404,{error:'Dosya bulunamadı.'});}const type={'.mp4':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(file)];const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);let start=0,end=info.size-1;if(range){start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),end):end;if(start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});return res.end();}res.setHeader('Content-Range',`bytes ${start}-${end}/${info.size}`);}res.writeHead(range?206:200,{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':end-start+1});if(req.method==='HEAD')return res.end();const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);return;
    }
    if(url.pathname.startsWith('/api/'))return json(res,404,{error:'İşlem bulunamadı.'});
    if(url.pathname.startsWith('/fonts/')&&req.method==='GET'){
      const name=path.basename(url.pathname);
      if(!/^[a-z0-9-]+\.woff2$/i.test(name)){res.writeHead(404);return res.end();}
      const file=path.join(root,'public','fonts',name);
      try{const info=await stat(file);res.writeHead(200,{'Content-Type':'font/woff2','Cache-Control':'public, max-age=31536000, immutable','Content-Length':info.size});createReadStream(file).pipe(res);return;}catch{res.writeHead(404);return res.end();}
    }
    const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/extra.css':'extra.css'};const file=files[url.pathname];if(!file){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.end(await readFile(path.join(root,'public',file)));
  }catch(e){if(!res.headersSent)json(res,400,{error:String(e.message).slice(0,500)});else res.destroy();}
});
async function scheduleTick(){for(const row of store.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next<=?').all(new Date().toISOString())){
  const spec=JSON.parse(row.body);try{const source=store.project(spec.project);if(!source)throw Error('Şablon bulunamadı.');const id=randomBytes(12).toString('hex');const p=validateProject({...source,title:source.title+' · '+new Date().toLocaleDateString('tr-TR'),idea:source.idea+' Create a new, different adventure. Variation seed: '+id,scenes:[]});store.save(id,p);enqueue(store.project(id),'pipeline',{autoUpload:spec.autoUpload,publish:{privacy:spec.privacy}});store.db.prepare('UPDATE schedules SET next=? WHERE id=?').run(new Date(Date.now()+spec.hours*3600000).toISOString(),row.id);
  }catch(e){spec.error=e.message;store.db.prepare('UPDATE schedules SET enabled=0,body=? WHERE id=?').run(JSON.stringify(spec),row.id);}}
}
async function autoPilotTick(){
  const c=config(store);
  const ap={...(c.autoPilot||{})};
  if(ap.enabled!==true)return;
  if(ap.nextAt&&new Date(ap.nextAt).getTime()>Date.now())return;
  if(c.provider==='web'&&!hasWebSession(store.directory))return;
  if(c.provider==='web'&&geminiLoginDead()){
    ap.nextAt=new Date(Date.now()+60*60*1000).toISOString();
    store.setSetting('config',{...c,autoPilot:ap});
    console.log('gemini oturum kapalı, otomatik tur 1 saat ertelendi');
    return;
  }
  const accounts=youtube.accounts().filter(a=>a.active!==false);
  if(!accounts.length)return;
  // Önceki dalga hâlâ kuyruktaysa yenisini basma
  if(store.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running') AND kind='pipeline'").get())return;
  const privacy=ap.privacy==='private'?'private':ap.privacy==='unlisted'?'unlisted':'public';
  const lang=ap.language==='tr'?'tr':'en';
  const length=ap.length==='long'?'long':'short';
  for(const acc of accounts){
    const id=randomBytes(12).toString('hex');
    const p=validateProject({
      title:`Auto · ${acc.label||'YT'}`,
      idea:'',
      language:lang,
      length,
      age:'6-8',
      style:'Yumuşak 3D animasyon',
      scenes:[]
    });
    store.save(id,{...p,id,created:new Date().toISOString()});
    enqueue(store.project(id),'pipeline',{
      autoUpload:true,
      autoIdea:true,
      account:acc.id,
      publish:{privacy}
    });
  }
  const hours=Math.min(168,Math.max(1,Number(ap.intervalHours)||3));
  ap.runsDone=Math.max(0,Number(ap.runsDone)||0)+1;
  ap.nextAt=new Date(Date.now()+hours*3600000).toISOString();
  store.setSetting('config',{...c,autoPilot:ap});
}
let keepAliveBusy = false;
function geminiLoginDead(){
  try{
    const stamp=JSON.parse(readFileSync(path.join(store.directory,'gemini-keepalive.json'),'utf8'));
    if(stamp.ok!==false||!/Oturum aç|Sign in/i.test(String(stamp.error||'')))return false;
    const mtime=statSync(webSessionPath(store.directory)).mtimeMs;
    return mtime<=new Date(stamp.at).getTime()+5000;
  }catch{return false;}
}
async function sessionKeepAlive(){
  if(keepAliveBusy)return;
  const c=config(store);
  if(c.provider!=='web'||!hasWebSession(store.directory))return;
  if(geminiLoginDead())return;
  if(worker.busy)return;
  if(store.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").get())return;
  keepAliveBusy=true;
  const bot=new GeminiWebProvider(store.directory);
  const stamp=path.join(store.directory,'gemini-keepalive.json');
  try{
    const r=await bot.keepAlive();
    await writeFile(stamp,JSON.stringify({ok:true,at:r.at}),{mode:0o600});
    console.log('gemini keepalive ok');
  }catch(e){
    const msg=String(e.message||e).slice(0,180);
    await writeFile(stamp,JSON.stringify({ok:false,at:new Date().toISOString(),error:msg}),{mode:0o600}).catch(()=>{});
    console.log('gemini keepalive fail:',msg);
  }finally{
    await bot.close().catch(()=>{});
    keepAliveBusy=false;
  }
}
setInterval(()=>worker.tick().catch(()=>{}),2000).unref();
setTimeout(()=>sessionKeepAlive().catch(()=>{}),45000).unref();
setInterval(()=>sessionKeepAlive().catch(()=>{}),10*60*1000).unref();
setInterval(()=>scheduleTick().catch(()=>{}),30000).unref();
setInterval(()=>publishTick(store,youtube,enqueue).catch(()=>{}),30000).unref();
setInterval(()=>autoPilotTick().catch(()=>{}),30000).unref();
setInterval(()=>{for(const [key,expiry]of sessions)if(expiry<Date.now())sessions.delete(key);for(const[key,a]of attempts)if(a.until<Date.now())attempts.delete(key);},60000).unref();
server.listen(port,host,()=>console.log(`Studio http://${host}:${server.address().port}`));
