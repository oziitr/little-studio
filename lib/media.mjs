import { spawn } from 'node:child_process';
import { writeFile, stat, rename, statfs } from 'node:fs/promises';
import path from 'node:path';
export function run(command,args,{cwd,timeout=600000}={}){return new Promise((resolve,reject)=>{const p=spawn(command,args,{cwd,windowsHide:true});let output='';p.stdout.on('data',c=>output=(output+c).slice(-100000));p.stderr.on('data',c=>output=(output+c).slice(-100000));const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('Montaj zaman aşımı.'));},timeout);p.on('error',()=>{clearTimeout(timer);reject(Error(`${path.basename(command)} çalıştırılamadı. Sunucuda FFmpeg kurulmalı.`));});p.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(`Medya işlemi başarısız (kod ${code}). Dosya ve FFmpeg kurulumunu kontrol edin.`));else resolve(output);});});}
export const ffmpeg=()=>process.env.FFMPEG_PATH||'ffmpeg';
export const ffprobe=()=>process.env.FFPROBE_PATH||'ffprobe';
export async function mediaAvailable(){try{await run(ffmpeg(),['-version'],{timeout:5000});await run(ffprobe(),['-version'],{timeout:5000});return true;}catch{return false;}}
export async function diskSpace(dir){const fs=await statfs(dir);return Number(fs.bavail)*Number(fs.bsize)/1024**3;}
export async function inspect(file){return JSON.parse(await run(ffprobe(),['-v','quiet','-print_format','json','-show_format','-show_streams',file],{timeout:15000}));}
export async function renderVideo(directory,clips,scenes,{subtitles=true}={}){
  const normalized=[];
  const durations=[];
  for(let i=0;i<clips.length;i++){
    const source=clips[i],meta=await inspect(source);if(!meta.streams.some(s=>s.codec_type==='video'))throw Error('Klipte video akışı yok.');
    const output=path.join(directory,`normalized-${i}.mp4`),audio=meta.streams.some(s=>s.codec_type==='audio');
    // Veo ~10 sn üretir; sabit -t 8 cümleyi/hareketi yarıda kesiyordu — klip süresini koru (max 12 sn)
    const raw=Number(meta.format?.duration)||8;
    const dur=Math.min(Math.max(raw,1),12);
    durations.push(dur);
    const args=['-y','-i',source];if(!audio)args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
    args.push('-map','0:v:0','-map',audio?'0:a:0':'1:a:0','-vf','scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1','-af','aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11','-t',String(dur),'-c:v','libx264','-preset','veryfast','-crf','21','-threads','2','-c:a','aac','-ar','48000','-ac','2','-pix_fmt','yuv420p',output);await run(ffmpeg(),args);normalized.push(output);
  }
  await writeFile(path.join(directory,'concat.txt'),normalized.map((_,i)=>`file 'normalized-${i}.mp4'`).join('\n'));
  const ass=['[Script Info]','ScriptType: v4.00+','PlayResX: 720','PlayResY: 1280','[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding','Style: Default,DejaVu Sans,38,&H00FFFFFF,&H00FFFFFF,&H0033261C,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,55,55,190,1','[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const time=s=>`${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(Math.floor(s)%60).padStart(2,'0')}.${String(Math.floor((s%1)*100)).padStart(2,'0')}`;
  let cursor=0;
  scenes.forEach((s,i)=>{
    const d=durations[i]||8;
    const text=String(s.narration||'').replace(/[{}\\]/g,'').replace(/\r?\n/g,' ').slice(0,250);
    if(text)ass.push(`Dialogue: 0,${time(cursor)},${time(cursor+d)},Default,,0,0,0,,${text}`);
    cursor+=d;
  });
  await writeFile(path.join(directory,'captions.ass'),ass.join('\n'));
  const args=['-y','-f','concat','-safe','1','-i','concat.txt'];if(subtitles)args.push('-vf','ass=captions.ass');args.push('-c:v','libx264','-preset','veryfast','-crf','21','-threads','2','-c:a','aac','-movflags','+faststart','output.partial.mp4');await run(ffmpeg(),args,{cwd:directory});
  const final=path.join(directory,'output.mp4');await rename(path.join(directory,'output.partial.mp4'),final);const meta=await inspect(final);const v=meta.streams.find(s=>s.codec_type==='video');
  const expected=durations.reduce((a,b)=>a+b,0);
  if(v?.width!==720||v?.height!==1280||Math.abs(Number(meta.format.duration)-expected)>3)throw Error('Son videonun boyutu veya süresi beklenen değerde değil.');
  return {bytes:(await stat(final)).size,duration:Number(meta.format.duration),width:v.width,height:v.height};
}
