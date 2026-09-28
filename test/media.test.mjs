import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mediaAvailable, run, ffmpeg, renderVideo, inspect } from '../lib/media.mjs';
test('real FFmpeg: silent and voiced scenes, Turkish subtitles, vertical output',async t=>{
  if(!await mediaAvailable())return t.skip('FFmpeg bu makinede yok; VDS üzerinde çalıştırılır.');
  const dir=await mkdtemp(path.join(tmpdir(),'studio-render-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const a=path.join(dir,'a.mp4'),b=path.join(dir,'b.mp4');
  await run(ffmpeg(),['-y','-f','lavfi','-i','color=c=green:s=360x640:r=24','-t','8','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',a]);
  await run(ffmpeg(),['-y','-f','lavfi','-i','color=c=blue:s=640x360:r=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-threads','1','-c:a','aac','-pix_fmt','yuv420p',b]);
  const result=await renderVideo(dir,[a,b],[{narration:'Küçük tilki, yıldızı buldu.'},{narration:'Birlikte başardık!'}]);assert.equal(result.width,720);assert.equal(result.height,1280);assert.ok(Math.abs(result.duration-16)<1);assert.ok((await inspect(path.join(dir,'output.mp4'))).streams.some(x=>x.codec_type==='audio'));
});
