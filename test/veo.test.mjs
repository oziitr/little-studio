import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { defaults } from '../lib/config.mjs';
import { createWorker } from '../lib/worker.mjs';
import { validateProject } from '../core.mjs';
test('Veo operation ID survives failure; resume polls existing job without new charge',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'studio-veo-'));const s=openStore(dir);t.after(async()=>{s.db.close();await rm(dir,{recursive:true,force:true});});
  s.setSecret('gemini','test');s.setSetting('config',{...defaults,paid:true,pricesConfirmed:true,minFreeGB:0.001});
  const p=s.save('d'.repeat(24),{...validateProject({title:'Veo test',scenes:[{visual:'fox',motion:'walk'}]}),scenes:[{visual:'fox',motion:'walk',narration:'Hi',duration:8,image:{file:'e'.repeat(24)+'.png',mimeType:'image/png'}}]});
  await mkdir(path.join(dir,'media',p.id),{recursive:true});await writeFile(path.join(dir,'media',p.id,p.scenes[0].image.file),'fixture');
  let starts=0,polls=0;const w=createWorker(s,{}, {providerFactory:()=>({text:async()=>({safe:true}),startVideo:async()=>{starts++;return 'models/veo/operations/test';},operation:async()=>{polls++;if(polls===1)throw Error('network disconnected');return {done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:'https://generativelanguage.googleapis.com/video'}}]}}};},download:async(_uri,file)=>writeFile(file,'fake-video-test-only')})});
  const j=s.enqueue(p,'video',{index:0},1,defaults);await w.tick();assert.equal(s.job(j.id).status,'failed');assert.equal(s.job(j.id).context.steps['Video 1'].operation,'models/veo/operations/test');
  const retry=s.job(j.id);s.updateJob(retry,'queued','retry');await w.tick();assert.equal(s.job(j.id).status,'done');assert.equal(starts,1);assert.equal(polls,2);assert.ok(s.project(p.id).scenes[0].clip.file.endsWith('.mp4'));
});
