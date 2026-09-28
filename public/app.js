/* UI/UX Pro Max + creative-tool workspace layout.
   Home = composer desk (not library dashboard). Top tabs, no left sidebar. */
const app=document.querySelector('#app');
const VIEWS=new Set(['studio','pool','jobs','stats','schedules','settings']);
const SETTABS=new Set(['google','budget','youtube','telegram','server']);
function readRoute(){
  const q=new URLSearchParams(location.search);
  const v=q.get('view');
  const tab=q.get('tab');
  const id=q.get('id');
  return{
    view:VIEWS.has(v)?v:'studio',
    settingsTab:SETTABS.has(tab)?tab:'google',
    selectedId:id&&/^[a-f0-9]{24}$/.test(id)?id:null
  };
}
const route0=readRoute();
let state,view=route0.view,selected=null,pendingId=route0.selectedId,dirty=false,settingsTab=route0.settingsTab;
function syncRoute(){
  const q=new URLSearchParams();
  if(view!=='studio')q.set('view',view);
  if(view==='settings')q.set('tab',settingsTab);
  if(view==='studio'&&selected?.id){q.set('view','studio');q.set('id',selected.id);}
  const next=q.toString()?`/?${q}`:'/';
  const cur=location.pathname+(location.search||'');
  if(cur!==next)history.replaceState({view,settingsTab,id:selected?.id||null},'',next);
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const media=(p,file)=>`/media/${p.id}/${file}`;
const secs=p=>(p.scenes?.length||(p.length==='long'?6:3))*8;
const icon={
  film:`<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="14" y="10" width="36" height="44" rx="8" fill="#cfe0d4" stroke="#16241c" stroke-width="2"/><rect x="22" y="18" width="20" height="28" rx="4" fill="#f7f3ea"/><circle cx="32" cy="32" r="5" fill="#e25b4a"/></svg>`,
  sprout:`<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M32 54V30" stroke="#16241c" stroke-width="3" stroke-linecap="round"/><path d="M32 34c-10-2-16-10-16-18 10 2 16 10 16 18Z" fill="#7dcea0" stroke="#16241c" stroke-width="2"/><path d="M32 28c10-1 17-8 18-16-11 1-17 8-18 16Z" fill="#e25b4a" stroke="#16241c" stroke-width="2"/></svg>`
};
function toast(s){const t=document.querySelector('#toast');t.textContent=s;t.style.display='block';setTimeout(()=>t.style.display='none',6500);}
async function api(url,method='GET',data,{quietAuth=false}={}){
  const r=await fetch('/api/'+url,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  const j=await r.json().catch(()=>({}));
  if(r.status===401){login();const err=Error(j.error||'Oturum açın.');err.auth=true;if(quietAuth)err.quiet=true;throw err;}
  if(!r.ok)throw Error(j.error||'İşlem başarısız');
  return j;
}
async function load(){
  try{
    state=await api('state','GET',undefined,{quietAuth:true});
    if(pendingId){selected=state.projects.find(p=>p.id===pendingId)||null;pendingId=null;}
    else if(selected)selected=state.projects.find(p=>p.id===selected.id)||null;
    syncRoute();
    render();
  }catch(e){if(!e.quiet&&!e.auth)toast(e.message);}
}
function navigate(next){
  if(dirty&&!confirm('Kaydedilmemiş değişiklikler var. Ayrılmak istiyor musun?'))return;
  dirty=false;view=next;syncRoute();render();
}
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('popstate',()=>{
  const r=readRoute();
  view=r.view;settingsTab=r.settingsTab;
  pendingId=r.selectedId;selected=r.selectedId&&state?state.projects.find(p=>p.id===r.selectedId)||null:selected;
  if(state)render();
});

function login(){
  app.innerHTML=`<div class="login-wrap"><form class="login"><div class="brand">little <b>studio.</b></div><p>Hikâye atölyene hoş geldin.</p><label for="password">Yönetici şifresi</label><input id="password" name="password" type="password" autocomplete="current-password" required><button class="primary">Giriş yap</button></form></div>`;
  app.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await api('login','POST',{password:new FormData(e.target).get('password')});load();}catch(err){toast(err.message);}};
}

function chrome(){
  const web=state.integrations.websession,gem=state.gemini||{},yt=state.accounts.filter(a=>a.active).length,running=state.jobs.filter(j=>['queued','running'].includes(j.status)).length;
  const tabs=[['studio','Yaz'],['pool','Havuz'],['jobs','Kuyruk'],['stats','İstatistik'],['schedules','Ritim'],['settings','Bağlantılar']];
  return `<div class="app"><header class="topbar"><div class="brand">little <b>studio.</b></div><nav class="tabs" aria-label="Ana menü">${tabs.map(([k,l])=>`<button type="button" class="tab ${view===k?'active':''}" data-nav="${k}">${l}</button>`).join('')}</nav><div class="topmeta"><span class="pill ${web&&!gem.stale?'ok':'warn'}">${web?(gem.stale?'Gemini eski':'Gemini açık'):'Gemini yok'}</span><span class="pill">${yt} YT hesap</span><span class="pill">${running?running+' iş':'Boş kuyruk'}</span><button type="button" class="ghost" id="logout">Çıkış</button></div></header><div class="stage" id="content"></div></div>`;
}

function render(){
  app.innerHTML=chrome();
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.nav));
  document.querySelector('#logout').onclick=async()=>{await api('logout','POST',{});location.reload();};
  ({studio,pool,jobs,stats,schedules,settings}[view]||studio)();
}

function studio(){
  const p=selected||{title:'',idea:'',language:'en',length:'short',age:'6-8',style:'Yumuşak 3D animasyon',character:'',scenes:[],subtitles:true};
  const active=selected&&state.jobs.some(j=>j.project===selected.id&&['queued','running'].includes(j.status));
  const ready=state.projects.filter(x=>x.output&&!x.youtube).length;
  const status=p.youtube?`Yayında · ${esc(p.youtube.accountLabel||'hesap')}`:p.output?'Havuzda hazır':(selected?'Taslak':'Yeni hikâye');
  document.querySelector('#content').innerHTML=`
  <div class="desk">
    <section class="composer">
      <h1>Hikâyeni yaz</h1>
      <p class="lede">Kısa veya uzun seç. Karakteri (tilki, ayı…) yazarsan o kullanılır; yazmazsan sistem kurar. Sahne ve görseller otomatik.</p>
      ${active?'<div class="notice">Bu hikâye üretiliyor. Bitince havuza düşer.</div>':''}
      <textarea id="idea" class="storybox" ${active?'disabled':''} placeholder="Örn: Milo adında meraklı turuncu bir tilki, yağmurlu bir gecede kaybettiği yıldızını arıyor…">${esc(p.idea)}</textarea>
      <div class="controls">
        <div class="seg" role="group" aria-label="Uzunluk">
          <button type="button" data-len="short" class="${p.length!=='long'?'on':''}">Kısa · 24 sn</button>
          <button type="button" data-len="long" class="${p.length==='long'?'on':''}">Uzun · 48 sn</button>
        </div>
        <div class="seg" role="group" aria-label="Dil">
          <button type="button" data-lang="en" class="${p.language!=='tr'?'on':''}">EN</button>
          <button type="button" data-lang="tr" class="${p.language==='tr'?'on':''}">TR</button>
        </div>
      </div>
      <div class="cta-row">
        <button type="button" class="primary" id="produce" ${active?'disabled':''}>Üret ve paylaş</button>
        <label class="check"><input type="checkbox" id="autoshare" checked> Bitince YouTube’a sırayla yükle (herkese açık)</label>
        ${selected?`<button type="button" class="secondary" id="newstory">Yeni boş hikâye</button>`:''}
      </div>
      <p class="muted">Hikâyeyi boş bırakırsan Gemini kendisi uydurur. ${status}</p>
    </section>
    <aside class="sidepanel">
      <div class="phone-wrap"><div class="phone">${p.output?`<video controls preload="metadata" src="${media(p,p.output.file)}"></video>`:`${icon.film}<strong>9:16 önizleme</strong><p class="muted">Üretim bitince burada</p>`}</div>${p.output?`<p style="margin:10px 0 0;text-align:center"><a href="${media(p,p.output.file)}" download>Videoyu indir</a></p>`:''}</div>
      <div class="sidebits">
        <h2>Durum</h2>
        <div class="bit"><span>Havuzda</span><span>${ready}</span></div>
        <div class="bit"><span>Hikâye</span><span>${state.projects.length}</span></div>
        <div class="bit"><span>Disk</span><span>${state.freeGB.toFixed(1)} GB</span></div>
        <div class="bit"><span>Kanal</span><span>${state.config.provider==='web'?'Gemini web':'API'}</span></div>
      </div>
    </aside>
  </div>
  <section class="library">
    <h2>Son hikâyeler</h2>
    ${state.projects.length?`<div class="rows">${state.projects.map((x,i)=>`
      <button type="button" class="row-item" data-id="${x.id}">
        <div class="thumb">${x.scenes[0]?.image?`<img src="${media(x,x.scenes[0].image.file)}" alt="">`:icon.sprout}</div>
        <div><h3>${esc(x.title)}</h3><p>~${secs(x)} sn · ${x.length==='long'?'Uzun':'Kısa'} · ${x.language==='tr'?'TR':'EN'}${x.youtube?.accountLabel?' · '+esc(x.youtube.accountLabel):''}</p></div>
        <span class="badge ${x.youtube?'live':x.output?'ready':''}">${x.youtube?'Yayında':x.output?'Havuzda':'Taslak'}</span>
      </button>`).join('')}</div>`:`<div class="empty">Henüz hikâye yok. Yukarıya yazıp üret.</div>`}
  </section>`;

  let length=p.length==='long'?'long':'short', language=p.language==='tr'?'tr':'en';
  document.querySelectorAll('[data-len]').forEach(b=>b.onclick=()=>{length=b.dataset.len;document.querySelectorAll('[data-len]').forEach(x=>x.classList.toggle('on',x.dataset.len===length));dirty=true;});
  document.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{language=b.dataset.lang;document.querySelectorAll('[data-lang]').forEach(x=>x.classList.toggle('on',x.dataset.lang===language));dirty=true;});
  document.querySelector('#idea').oninput=()=>dirty=true;
  document.querySelector('#newstory')?.addEventListener('click',()=>{selected=null;dirty=false;syncRoute();render();});
  document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selected=state.projects.find(x=>x.id===b.dataset.id);dirty=false;syncRoute();render();});
  document.querySelector('#produce').onclick=async()=>{
    try{
      const idea=document.querySelector('#idea').value.trim();
      const title=idea?(idea.split(/[.!?\n]/)[0]||idea).slice(0,80).trim():'Auto Short';
      const body={title:title||'Auto Short',idea,length,language,age:p.age||'6-8',style:p.style||'Yumuşak 3D animasyon',character:p.character||'',subtitles:true,scenes:[]};
      selected=await api(selected?`projects/${selected.id}`:'projects',selected?'PUT':'POST',body);dirty=false;
      await api(`projects/${selected.id}/jobs`,'POST',{
        kind:'pipeline',
        autoUpload:document.querySelector('#autoshare').checked,
        autoIdea:!idea,
        publish:{privacy:'public'}
      });
      view='jobs';syncRoute();await load();toast(idea?'Üretim + paylaşım kuyruğa alındı.':'AI hikâye + paylaşım kuyruğa alındı.');
    }catch(e){toast(e.message);}
  };
}

async function pool(){
  document.querySelector('#content').innerHTML=`<div class="pagehead"><h1>Video havuzu</h1><button type="button" class="secondary" id="refreshpool">Yenile</button></div><p class="muted">Hazır videolar aktif YouTube hesaplarına sırayla, herkese açık yüklenir.</p><div id="poollist"><div class="empty">Yükleniyor…</div></div>`;
  const fill=async()=>{
    const box=document.querySelector('#poollist');
    try{
      const d=await api('pool');
      const buckets={ready:[],publishing:[],published:[]};
      for(const v of d.items){const st=v.pool?.status||(v.youtube?'published':'ready');(buckets[st]||buckets.ready).push(v);}
      const col=(title,items,key)=>`<div class="col"><h2>${title}<span class="count">${items.length}</span></h2>${items.length?items.map(v=>`<div class="poolcard"><h3>${esc(v.title)}</h3><p>${v.length==='long'?'Uzun':'Kısa'} · ~${v.duration} sn${v.youtube?.accountLabel||v.pool?.accountLabel?' · '+esc(v.youtube?.accountLabel||v.pool.accountLabel):''}</p><div class="row">${key==='ready'?`<button type="button" class="primary share" data-id="${v.id}">Paylaş (herkese açık)</button>`:''}${v.youtube?.url?`<a class="secondary" href="${esc(v.youtube.url)}" target="_blank" rel="noreferrer">YouTube</a>`:''}${v.output?`<a class="secondary" href="/media/${v.id}/${v.output.file}" download>İndir</a>`:''}</div></div>`).join(''):`<div class="empty" style="padding:16px;font-size:12px">Boş</div>`}</div>`;
      box.innerHTML=`<div class="poolboard">${col('Hazır',buckets.ready,'ready')}${col('Yükleniyor',buckets.publishing,'publishing')}${col('Yayında',buckets.published,'published')}</div>`;
      document.querySelectorAll('.share').forEach(b=>b.onclick=async()=>{try{await api(`pool/${b.dataset.id}/share`,'POST',{publish:{privacy:'public'}});toast('Herkese açık paylaşım kuyruğa alındı.');fill();load();}catch(e){toast(e.message);}});
    }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
  };
  document.querySelector('#refreshpool').onclick=fill;fill();
}

function jobs(){
  document.querySelector('#content').innerHTML=`<div class="pagehead"><h1>Üretim kuyruğu</h1><button type="button" class="secondary" id="refresh">Yenile</button></div><p class="muted">Tarayıcı kapalıyken de sürer. Belirsiz ücretli istek otomatik tekrarlanmaz.</p><div class="jobs">${state.jobs.length?state.jobs.map(j=>`<div class="job"><div><h3>${esc(state.projects.find(p=>p.id===j.project)?.title||'Hikâye')}</h3><p>${esc(j.message)}</p><p class="muted">${esc(j.kind)} · ${new Date(j.created).toLocaleString('tr-TR')}</p></div><div><span class="badge">${esc({queued:'Bekliyor',running:'Çalışıyor',done:'Tamamlandı',failed:'Hata',interrupted:'Kesildi'}[j.status]||j.status)}</span>${['failed','interrupted'].includes(j.status)?`<p style="margin-top:8px"><button type="button" class="secondary resume" data-id="${j.id}">Devam et</button></p>`:''}</div></div>`).join(''):`<div class="empty">Kuyruk boş. Studio’dan bir hikâye üret.</div>`}</div>`;
  document.querySelector('#refresh').onclick=load;
  document.querySelectorAll('.resume').forEach(b=>b.onclick=async()=>{try{await api(`jobs/${b.dataset.id}/resume`,'POST',{});load();}catch(e){toast(e.message);}});
}

function stats(){
  document.querySelector('#content').innerHTML=`<div class="pagehead"><h1>İstatistikler</h1><button type="button" class="secondary" id="refreshstats">Yenile</button></div><p class="muted">İzlenme / beğeni canlı. Para kazanma şimdilik kapalı.</p><div id="statslist" class="statlist"><div class="empty">Yükleniyor…</div></div>`;
  const fill=async()=>{
    const box=document.querySelector('#statslist');
    try{
      const d=await api('stats');
      box.innerHTML=d.videos.length?d.videos.map(v=>`<div class="statrow"><div><h3 style="margin:0 0 4px;font-size:14px">${esc(v.title)}</h3><p class="muted">${esc(v.accountLabel)}${v.stats?` · ${v.stats.views} görüntülenme · ${v.stats.likes} beğeni · ${v.stats.comments} yorum`:''}</p></div><a class="secondary" href="${esc(v.url)}" target="_blank" rel="noreferrer">YouTube</a></div>`).join(''):`<div class="empty">Henüz yüklenmiş video yok.</div>`;
    }catch(e){box.innerHTML=`<div class="empty">${esc(e.message)}</div>`;}
  };
  document.querySelector('#refreshstats').onclick=fill;fill();
}

function field(label,name,value,type='text'){return `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}">`;}
function modelField(label,name,value,list){return `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="text" value="${esc(value)}" list="${list}" autocomplete="off" spellcheck="false">`;}
function usage(label,used,limit){const u=Math.max(0,Number(used)||0),l=Math.max(0.0001,Number(limit)||0);return `<label>${label}</label><progress value="${Math.min(u,l)}" max="${l}"></progress><p class="muted">$${u.toFixed(2)} / $${l.toFixed(2)}</p>`;}

function fmtWhen(iso){
  if(!iso)return '—';
  const t=new Date(iso).getTime();
  if(!Number.isFinite(t))return '—';
  return new Date(t).toLocaleString('tr-TR');
}
function intervalOptions(selected){
  const opts=[[1,'1 saat'],[2,'2 saat'],[3,'3 saat'],[4,'4 saat'],[6,'6 saat'],[8,'8 saat'],[12,'12 saat'],[24,'1 gün'],[48,'2 gün'],[72,'3 gün'],[168,'1 hafta']];
  const v=Number(selected)||2;
  const extra=opts.some(([h])=>h===v)?'':`<option value="${v}" selected>${v} saat</option>`;
  return extra+opts.map(([h,l])=>`<option value="${h}" ${v===h?'selected':''}>${l}</option>`).join('');
}
function accountCard(a,{schedule=false}={}){
  const s=a.schedule||{};
  const handle=a.customUrl?(a.customUrl.startsWith('@')?a.customUrl:'@'+a.customUrl):'';
  const links=[
    a.handleUrl?`<a href="${esc(a.handleUrl)}" target="_blank" rel="noreferrer">${esc(handle||a.handleUrl)}</a>`:'',
    a.channelUrl?`<a href="${esc(a.channelUrl)}" target="_blank" rel="noreferrer">Kanal</a>`:'',
    a.channelId?`<span class="muted">ID · ${esc(a.channelId)}</span>`:''
  ].filter(Boolean).join('')||'<span class="muted">Kanal linki yok — Yenile’ye bas</span>';
  const sched=schedule?`<div class="account-sched">
      <label class="check"><input type="checkbox" class="acc-sched-on" data-id="${a.id}" ${s.enabled?'checked':''}> Bu hesaba özel ritim</label>
      <label>Aralık<select class="acc-interval" data-id="${a.id}">${intervalOptions(s.intervalHours)}</select></label>
      <label>Tekrar (0=sınırsız)<input type="number" class="acc-max" data-id="${a.id}" min="0" max="10000" value="${s.maxRuns||0}"></label>
      <p class="muted" style="margin:0;align-self:end">Yapılan ${s.runsDone||0}${s.maxRuns?` / ${s.maxRuns}`:''} · Sonraki ${fmtWhen(s.nextAt)}</p>
      <button type="button" class="secondary saveacc" data-id="${a.id}">Hesap ritmini kaydet</button>
    </div>`:'';
  return `<div class="account" data-acc="${a.id}">
    <div class="account-head">
      <div class="account-meta">
        <div><b>${esc(a.label||'YouTube hesabı')}</b> <span class="badge ${a.active?'live':''}">${a.active?'aktif':'pasif'}</span></div>
        <div class="account-links">${links}</div>
        <p class="muted" style="margin:0">Eklenme ${fmtWhen(a.added)}${a.lastUploadAt?' · Son yükleme '+fmtWhen(a.lastUploadAt):''}</p>
      </div>
      <div class="cta-row">
        <button type="button" class="secondary refacc" data-id="${a.id}">Yenile</button>
        <button type="button" class="secondary tgacc" data-id="${a.id}" data-active="${a.active?'1':''}">${a.active?'Pasifleştir':'Aktifleştir'}</button>
        <button type="button" class="secondary rmacc" data-id="${a.id}">Kaldır</button>
      </div>
    </div>${sched}
  </div>`;
}
function geminiPanel(){
  const g=state.gemini||{connected:false,cookies:0,updatedAt:null,stale:true};
  const status=g.connected?(g.stale?'Oturum var ama eski olabilir — yenile':'Gemini bağlı'):'Gemini bağlı değil';
  const badge=g.connected?(g.stale?'warn':'ok'):'warn';
  return `<div class="sched-box">
    <h3>Gemini hesabı (web · Flash-Lite)</h3>
    <p class="muted"><span class="pill ${badge}">${status}</span> · ${g.cookies||0} çerez · güncelleme ${fmtWhen(g.updatedAt)}</p>
    <p class="muted">PC’de: <code>node deploy/gemini-login.mjs</code> — giriş yap. Hikâye + video: Flash-Lite. Çıkış olunca 10 dakikalık kontrol durur; yeni dosya yüklenince devam eder.</p>
    <label for="gemsession">Oturum dosyası (.json)</label>
    <input id="gemsession" type="file" accept="application/json,.json">
    <div class="cta-row" style="margin-top:12px">
      <button type="button" class="primary" id="uploadgem">Gemini’yi bağla</button>
      <button type="button" class="secondary" id="cleargem" ${g.connected?'':'disabled'}>Bağlantıyı kes</button>
    </div>
    <p class="testresult" id="gemtest"></p>
  </div>`;
}
function bindGemini(){
  document.querySelector('#uploadgem')?.addEventListener('click',async()=>{
    const out=document.querySelector('#gemtest');const f=document.querySelector('#gemsession')?.files?.[0];
    if(!f){out.textContent='Önce gemini-session.json seç.';return;}
    out.textContent='Yükleniyor…';
    try{
      const session=JSON.parse(await f.text());
      const r=await api('gemini/session','POST',{session});
      await load();out.textContent=`Bağlandı · ${r.gemini.cookies} çerez · kanal web`;
      toast('Gemini oturumu kaydedildi.');
    }catch(e){out.textContent=e.message;}
  });
  document.querySelector('#cleargem')?.addEventListener('click',async()=>{
    if(!confirm('Gemini oturumu silinsin mi?'))return;
    try{await api('gemini/session','DELETE');await load();toast('Gemini bağlantısı kesildi.');}catch(e){toast(e.message);}
  });
}
function settings(){
  const c=state.config;
  const panels={
    google:`<h2>Google AI</h2>
      ${geminiPanel()}
      <label for="provider">Üretim kanalı</label><select id="provider" name="provider"><option value="web" ${c.provider!=='api'?'selected':''}>Gemini web · Flash hikâye + Veo</option><option value="api" ${c.provider==='api'?'selected':''}>Google API (ücretli)</option></select>
      ${field('Gemini API anahtarı (yalnız API kanalı, boş = koru)','apiKey','','password')}
      ${modelField('Senaryo modeli','textModel',c.textModel,'textmodels')}
      ${modelField('Görsel modeli','imageModel',c.imageModel,'imagemodels')}
      ${modelField('Veo modeli','videoModel',c.videoModel,'videomodels')}
      <datalist id="textmodels"><option value="gemini-2.5-flash"></option><option value="gemini-3.6-flash"></option></datalist>
      <datalist id="imagemodels"><option value="gemini-2.5-flash-image"></option></datalist>
      <datalist id="videomodels"><option value="veo-3.1-fast-generate-preview"></option></datalist>
      <p class="muted">AI Studio kapalı. Hikâye + Veo: Gemini Flash-Lite, her iş yeni sohbet (Pro yok).</p>
      <label class="check"><input type="checkbox" name="paid" ${c.paid?'checked':''}> Ücretli üretimi aç (API)</label>
      <div class="cta-row" style="margin-top:12px"><button type="button" class="secondary" id="testgoogle">API modellerini test et</button></div><p class="testresult" id="googletest"></p>`,
    budget:`<h2>Bütçe · USD</h2><p class="muted">Tahmini rezervler; gerçek fatura değil. Web kanalında rezerv 0.</p>
      ${usage('Bugün',state.budget.day,c.daily)}${usage('Bu ay',state.budget.month,c.monthly)}
      <div class="formgrid">${field('Günlük','daily',c.daily,'number')}${field('Aylık','monthly',c.monthly,'number')}${field('İş başına','perVideo',c.perVideo,'number')}${field('Görsel','imagePrice',c.imagePrice,'number')}${field('Veo / sn','videoSecondPrice',c.videoSecondPrice,'number')}${field('Metin rezerv','textReserve',c.textReserve,'number')}</div>
      <label class="check"><input type="checkbox" name="pricesConfirmed" ${c.pricesConfirmed?'checked':''}> Fiyatları kontrol ettim</label>`,
    youtube:`<h2>YouTube hesapları</h2><p class="muted">Her hesabın adı ve kanal linki. Yükleme ritmi için üstteki <b>Ritim</b> sekmesi.</p>
      ${state.accounts.length?`<div class="accounts">${state.accounts.map(a=>accountCard(a)).join('')}</div>`:'<div class="empty">Hesap yok — aşağıdan ekle.</div>'}
      <div class="cta-row" style="margin-bottom:12px">
        <button type="button" class="secondary" id="connect">Hesap ekle</button>
        <button type="button" class="secondary" id="refreshyt">Tümünü yenile</button>
        <button type="button" class="secondary" id="testyoutube">Test et</button>
      </div><p class="testresult" id="youtubetest"></p>
      ${field('Panel HTTPS','publicUrl',c.publicUrl,'url')}${field('OAuth istemci kimliği','clientId',c.clientId)}${field('OAuth sırrı (boş = koru)','clientSecret','','password')}
      <p class="muted">Callback: ${esc(c.publicUrl||'https://SENIN-PANELIN')}/api/youtube/callback</p>
      <label class="check"><input type="checkbox" name="autoPublish" ${c.autoPublish!==false?'checked':''}> Herkese açık yayına izin</label>
      <label class="check"><input type="checkbox" name="autoSharePool" ${c.autoSharePool!==false?'checked':''}> Üretim bitince otomatik yükle</label>`,
    telegram:`<h2>Telegram</h2>
      <div class="passive-note">Telegram bildirimleri şimdilik pasif. Ayarlar kaydedilmez; test kapalı.</div>
      <p class="muted">İleride iş bitince / hatada bildirim için tekrar açılacak.</p>`,
    server:`<h2>Sunucu</h2><p class="muted">Montaj: ${state.integrations.ffmpeg?'FFmpeg hazır':'eksik'} · ${state.freeGB.toFixed(1)} GB boş · v${esc(state.system.version)}</p>
      ${field('Min boş alan (GB)','minFreeGB',c.minFreeGB,'number')}`
  };
  document.querySelector('#content').innerHTML=`<div class="pagehead"><h1>Bağlantılar</h1><button type="submit" form="settings" class="primary">Kaydet</button></div>
  <form id="settings" class="settings">
    <div class="snav">${[['google','Google AI'],['budget','Bütçe'],['youtube','YouTube'],['telegram','Telegram'],['server','Sunucu']].map(([k,l])=>`<button type="button" data-stab="${k}" class="${settingsTab===k?'on':''}">${l}</button>`).join('')}</div>
    <div class="spanel" id="spanel">${panels[settingsTab]}</div>
  </form>`;
  const form=document.querySelector('#settings');
  document.querySelectorAll('[data-stab]').forEach(b=>b.onclick=()=>{settingsTab=b.dataset.stab;syncRoute();settings();});
  bindGemini();
  form.onsubmit=async e=>{
    e.preventDefault();
    try{
      const data=Object.fromEntries(new FormData(form));
      const merged={...c,...data};
      for(const k of ['paid','pricesConfirmed','autoPublish','autoSharePool'])merged[k]=!!form.elements[k]?.checked;
      for(const k of ['paid','pricesConfirmed','autoPublish','autoSharePool']){
        if(!form.elements[k])merged[k]=c[k];
      }
      for(const k of ['textModel','imageModel','videoModel','provider','publicUrl','clientId','daily','monthly','perVideo','imagePrice','videoSecondPrice','textReserve','minFreeGB']){
        if(form.elements[k]==null)merged[k]=c[k];
      }
      merged.notifyTelegram=false;
      merged.telegramEnabled=false;
      merged.publishSchedule=c.publishSchedule;
      await api('settings','PUT',merged);
      await load();toast('Ayarlar kaydedildi.');
    }catch(err){toast(err.message);}
  };
  document.querySelector('#testgoogle')?.addEventListener('click',async()=>{const out=document.querySelector('#googletest');out.textContent='…';try{const r=await api('settings/test/google','POST',{});out.textContent=`Senaryo ${r.found.text?'✓':'✗'} · Görsel ${r.found.image?'✓':'✗'} · Veo ${r.found.video?'✓':'✗'}`;}catch(e){out.textContent=e.message;}});
  document.querySelector('#connect')?.addEventListener('click',async()=>{try{location.href=(await api('youtube/connect','POST',{})).url;}catch(e){toast(e.message);}});
  document.querySelector('#testyoutube')?.addEventListener('click',async()=>{const out=document.querySelector('#youtubetest');out.textContent='…';try{await api('settings/test/youtube','POST',{});out.textContent='Bağlantı OK';}catch(e){out.textContent=e.message;}});
  document.querySelector('#refreshyt')?.addEventListener('click',async()=>{const out=document.querySelector('#youtubetest');out.textContent='Yenileniyor…';try{await api('youtube/refresh','POST',{});await load();out.textContent='Kanal adları güncellendi.';}catch(e){out.textContent=e.message;}});
  document.querySelectorAll('.rmacc').forEach(b=>b.onclick=async()=>{if(!confirm('Kaldırılsın mı?'))return;try{await api('youtube/disconnect','POST',{id:b.dataset.id});await load();}catch(e){toast(e.message);}});
  document.querySelectorAll('.tgacc').forEach(b=>b.onclick=async()=>{try{await api('youtube/account','POST',{id:b.dataset.id,active:b.dataset.active!=='1'});await load();}catch(e){toast(e.message);}});
  document.querySelectorAll('.refacc').forEach(b=>b.onclick=async()=>{try{await api('youtube/account','POST',{id:b.dataset.id,refresh:true});await load();toast('Kanal bilgisi güncellendi.');}catch(e){toast(e.message);}});
}

function schedules(){
  const c=state.config;
  const ps=c.publishSchedule||{enabled:false,mode:'global',intervalHours:2,maxRuns:0,privacy:'public'};
  const ap=c.autoPilot||{enabled:false,intervalHours:3,language:'en',length:'short',privacy:'public'};
  document.querySelector('#content').innerHTML=`<div class="pagehead"><h1>Yükleme ritmi</h1><button type="button" class="primary" id="saverhythm">Kaydet</button></div>
  <p class="muted">Otomatik Shorts + havuzdan sırayla herkese açık yükleme. Aktif YouTube hesapları round-robin.</p>
  <div class="spanel" style="max-width:720px;margin-bottom:18px">
    <h2 style="font-size:1.05rem;margin:0 0 10px">Otomatik üretim (AutoPilot)</h2>
    <div class="sched-box" style="margin:0;background:transparent;border:0;padding:0">
      <label class="check"><input type="checkbox" id="apEnabled" ${ap.enabled?'checked':''}> Her X saatte bir — her aktif hesaba ayrı Short (AI hikâye → video → herkese açık)</label>
      <div class="formgrid">
        <label>Aralık (saat)<select id="apInterval">${intervalOptions(ap.intervalHours||3)}</select></label>
        <label>Uzunluk<select id="apLength"><option value="short" ${ap.length!=='long'?'selected':''}>Kısa</option><option value="long" ${ap.length==='long'?'selected':''}>Uzun</option></select></label>
        <label>Dil<select id="apLang"><option value="en" ${ap.language!=='tr'?'selected':''}>EN</option><option value="tr" ${ap.language==='tr'?'selected':''}>TR</option></select></label>
        <label>Görünürlük<select id="apPrivacy"><option value="public" ${ap.privacy!=='private'&&ap.privacy!=='unlisted'?'selected':''}>Herkese açık</option><option value="unlisted" ${ap.privacy==='unlisted'?'selected':''}>Liste dışı</option><option value="private" ${ap.privacy==='private'?'selected':''}>Gizli</option></select></label>
      </div>
      <p class="muted">Yapılan ${ap.runsDone||0} · Sonraki ${fmtWhen(ap.nextAt)}</p>
    </div>
  </div>
  <div class="spanel" style="max-width:720px;margin-bottom:18px">
    <h2 style="font-size:1.05rem;margin:0 0 10px">Havuz yükleme ritmi</h2>
    <div class="sched-box" style="margin:0;background:transparent;border:0;padding:0">
      <label class="check"><input type="checkbox" id="psEnabled" ${ps.enabled?'checked':''}> Havuzdakileri aralıklarla yükle</label>
      <label for="psMode">Mod</label>
      <select id="psMode">
        <option value="global" ${ps.mode!=='per_account'?'selected':''}>Ortak · tüm hesaplara X saatte bir (sırayla)</option>
        <option value="per_account" ${ps.mode==='per_account'?'selected':''}>Hesap başına · her hesabın kendi aralığı</option>
      </select>
      <div class="formgrid">
        <label>Ortak aralık<select id="psInterval">${intervalOptions(ps.intervalHours)}</select></label>
        <label>Tekrar sayısı (0=sürekli)<input type="number" id="psMax" min="0" max="10000" value="${ps.maxRuns||0}"></label>
        <label>Görünürlük<select id="psPrivacy"><option value="public" ${ps.privacy==='public'||!ps.privacy?'selected':''}>Herkese açık</option><option value="unlisted" ${ps.privacy==='unlisted'?'selected':''}>Liste dışı</option><option value="private" ${ps.privacy==='private'?'selected':''}>Gizli</option></select></label>
      </div>
      <p class="muted">Yapılan ${ps.runsDone||0}${ps.maxRuns?` / ${ps.maxRuns}`:''} · Sonraki ${fmtWhen(ps.nextAt)}</p>
    </div>
  </div>
  <h2 style="font-size:1.05rem;margin:0 0 8px">Hesap ritmi</h2>
  <p class="muted">Mod “Hesap başına” iken her hesabın kendi aralığı kullanılır. Tüm aktif hesaplar sırayla kullanılır.</p>
  ${state.accounts.length?`<div class="accounts">${state.accounts.map(a=>accountCard(a,{schedule:true})).join('')}</div>`:'<div class="empty">Önce Bağlantılar → YouTube’dan hesap ekle.</div>'}
  <details style="margin-top:28px" class="spanel">
    <summary style="cursor:pointer;font-weight:800">Şablon üretim planı (eski otomasyon)</summary>
    <p class="muted">Şablon hikâyeden aralıklı yeni üretim.</p>
    <form id="schedule">
      <label for="project">Şablon</label><select id="project" name="project" required>${state.projects.map(p=>`<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select>
      <div class="formgrid">${field('İlk zaman','next','','datetime-local')}${field('Saat aralığı (min 6)','hours',24,'number')}</div>
      <label for="privacy">Görünürlük</label><select id="privacy" name="privacy"><option value="public">Herkese açık</option><option value="private">Gizli</option></select>
      <label class="check"><input type="checkbox" name="autoUpload" checked> YouTube’a yükle</label>
      <div class="cta-row" style="margin-top:14px"><button class="primary" ${!state.projects.length?'disabled':''}>Oluştur</button></div>
    </form>
    <div class="jobs" style="margin-top:16px">${state.schedules.length?state.schedules.map(s=>`<div class="job"><div><h3>${esc(state.projects.find(p=>p.id===s.body.project)?.title||'Şablon')}</h3><p class="muted">${s.enabled?'Sonraki '+new Date(s.next).toLocaleString('tr-TR'):'Durdu: '+esc(s.body.error)} · ${s.body.hours} saatte bir</p></div><button type="button" class="secondary stop" data-id="${s.id}">Kaldır</button></div>`).join(''):`<div class="empty">Plan yok.</div>`}</div>
  </details>`;
  document.querySelector('#saverhythm').onclick=async()=>{
    try{
      const merged={...c,
        autoPublish:true,
        autoSharePool:true,
        autoPilot:{
          enabled:document.querySelector('#apEnabled').checked,
          intervalHours:Number(document.querySelector('#apInterval').value)||3,
          length:document.querySelector('#apLength').value,
          language:document.querySelector('#apLang').value,
          privacy:document.querySelector('#apPrivacy').value
        },
        publishSchedule:{
          enabled:document.querySelector('#psEnabled').checked,
          mode:document.querySelector('#psMode').value,
          intervalHours:Number(document.querySelector('#psInterval').value)||2,
          maxRuns:Number(document.querySelector('#psMax').value)||0,
          privacy:document.querySelector('#psPrivacy').value
        },
        notifyTelegram:false,telegramEnabled:false};
      await api('settings','PUT',merged);
      await load();toast('Ritim kaydedildi.');
    }catch(e){toast(e.message);}
  };
  document.querySelectorAll('.saveacc').forEach(b=>b.onclick=async()=>{
    const id=b.dataset.id;
    try{
      await api('youtube/account','POST',{id,schedule:{
        enabled:document.querySelector(`.acc-sched-on[data-id="${id}"]`).checked,
        intervalHours:Number(document.querySelector(`.acc-interval[data-id="${id}"]`).value)||2,
        maxRuns:Number(document.querySelector(`.acc-max[data-id="${id}"]`).value)||0
      }});
      await load();toast('Hesap ritmi kaydedildi.');
    }catch(e){toast(e.message);}
  });
  document.querySelectorAll('.rmacc').forEach(b=>b.onclick=async()=>{if(!confirm('Kaldırılsın mı?'))return;try{await api('youtube/disconnect','POST',{id:b.dataset.id});await load();}catch(e){toast(e.message);}});
  document.querySelectorAll('.tgacc').forEach(b=>b.onclick=async()=>{try{await api('youtube/account','POST',{id:b.dataset.id,active:b.dataset.active!=='1'});await load();}catch(e){toast(e.message);}});
  document.querySelectorAll('.refacc').forEach(b=>b.onclick=async()=>{try{await api('youtube/account','POST',{id:b.dataset.id,refresh:true});await load();toast('Kanal bilgisi güncellendi.');}catch(e){toast(e.message);}});
  document.querySelector('#schedule')?.addEventListener('submit',async e=>{e.preventDefault();try{const form=e.target,data=Object.fromEntries(new FormData(form));data.next=new Date(data.next).toISOString();data.autoUpload=form.elements.autoUpload.checked;await api('schedules','POST',data);load();}catch(err){toast(err.message);}});
  document.querySelectorAll('.stop').forEach(b=>b.onclick=async()=>{await api('schedules/'+b.dataset.id,'DELETE');load();});
}

setInterval(()=>{if(['jobs','pool'].includes(view)&&state)load();},8000);
load();
