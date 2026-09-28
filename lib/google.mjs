import { writeFile } from 'node:fs/promises';
const base='https://generativelanguage.googleapis.com/v1beta';
export class GoogleProvider {
  constructor(key){this.key=key;}
  async request(endpoint,body){const r=await fetch(`${base}/${endpoint}`,{method:body?'POST':'GET',headers:{'x-goog-api-key':this.key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error(`Google API ${r.status}. Model erişimi, kota ve faturalandırmayı kontrol edin.`);return r.json();}
  async text(model,prompt){const r=await this.request(`models/${model}:generateContent`,{contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',maxOutputTokens:8192}});const text=r.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');if(!text)throw Error('Google metin yanıtı boş veya engellendi.');return JSON.parse(text);}
  async image(model,prompt,reference){const parts=[{text:prompt}];if(reference)parts.push({inlineData:reference});const r=await this.request(`models/${model}:generateContent`,{contents:[{parts}],generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:'9:16'}}});const image=r.candidates?.[0]?.content?.parts?.find(p=>p.inlineData)?.inlineData;if(!image?.data||!['image/png','image/jpeg','image/webp'].includes(image.mimeType))throw Error('Görsel üretilemedi veya güvenlik filtresine takıldı.');return image;}
  async startVideo(model,prompt,image,{aspectRatio='9:16',durationSeconds=8,resolution='720p'}={}){
    const instance={prompt};
    if(image?.data&&image?.mimeType)instance.image={inlineData:{mimeType:image.mimeType,data:image.data}};
    const r=await this.request(`models/${model}:predictLongRunning`,{
      instances:[instance],
      parameters:{
        aspectRatio:aspectRatio==='16:9'?'16:9':'9:16',
        durationSeconds:Math.min(8,Math.max(4,Number(durationSeconds)||8)),
        resolution:resolution==='1080p'?'1080p':'720p',
        numberOfVideos:1
      }
    });
    if(!r.name||!/^models\/[\w.-]+\/operations\/[\w.-]+$|^operations\/[\w.-]+$/.test(r.name))throw Error('Google işlem kimliği alınamadı; tekrar göndermeden hesabı kontrol edin.');
    return r.name;
  }
  async operation(name){if(!/^models\/[\w.-]+\/operations\/[\w.-]+$|^operations\/[\w.-]+$/.test(name))throw Error('Geçersiz işlem kimliği.');return this.request(name);}
  async modelInfo(name){if(!/^[a-zA-Z0-9_.-]{1,100}$/.test(name))throw Error('Model adı geçersiz.');const r=await fetch(`${base}/models/${name}`,{headers:{'x-goog-api-key':this.key},signal:AbortSignal.timeout(30000)});if(r.status===404)return false;if(!r.ok)throw Error(`Google API ${r.status}. Anahtar, kota ve faturalandırmayı kontrol edin.`);return true;}
  async download(uri,destination){let u=new URL(uri);if(u.protocol!=='https:'||u.hostname!=='generativelanguage.googleapis.com')throw Error('Beklenmeyen Google indirme adresi.');let r;
    for(let i=0;i<5;i++){r=await fetch(u,{headers:u.hostname==='generativelanguage.googleapis.com'?{'x-goog-api-key':this.key}:{},redirect:'manual',signal:AbortSignal.timeout(180000)});if([301,302,303,307,308].includes(r.status)){u=new URL(r.headers.get('location'),u);if(u.protocol!=='https:'||!(u.hostname.endsWith('.googleapis.com')||u.hostname.endsWith('.googleusercontent.com')))throw Error('İndirme yönlendirmesi reddedildi.');continue;}break;}
    if(!r.ok)throw Error(`Video indirilemedi (${r.status}).`);const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>250*1024*1024)throw Error('Klip boyutu sınırı aşıldı.');chunks.push(chunk);}await writeFile(destination,Buffer.concat(chunks));
  }
}
