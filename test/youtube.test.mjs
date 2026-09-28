import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { defaults } from '../lib/config.mjs';
import { YouTube } from '../lib/youtube.mjs';
import { notify } from '../lib/notify.mjs';

function fixture(t){const dir=mkdtempSync(path.join(tmpdir(),'studio-yt-'));const store=openStore(dir);t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});return store;}
function mockFetch(t,handler){const original=globalThis.fetch;globalThis.fetch=handler;t.after(()=>{globalThis.fetch=original;});}

test('multi-account YouTube: connect labels channel, round-robin alternates, stats parse, remove works',async t=>{
  const s=fixture(t);s.setSecret('youtubeClientSecret','sec');s.setSetting('config',{...defaults,clientId:'cid',publicUrl:'https://p.example'});
  let codeN=0;
  mockFetch(t,async(url,opts)=>{
    const u=String(url);
    if(u.includes('oauth2.googleapis.com/token')){
      const grant=new URLSearchParams(opts.body).get('grant_type');
      if(grant==='authorization_code'){codeN++;return {ok:true,json:async()=>({refresh_token:'r'+codeN,access_token:'a'+codeN})};}
      return {ok:true,json:async()=>({access_token:'fresh'})};
    }
    if(u.includes('/channels'))return {ok:true,json:async()=>({items:[{id:'CH'+codeN,snippet:{title:'Kanal '+codeN,customUrl:'@kanal'+codeN}}]})};
    if(u.includes('/videos'))return {ok:true,json:async()=>({items:[{id:'v1',statistics:{viewCount:'42',likeCount:'5',commentCount:'1'},status:{privacyStatus:'private'}}]})};
    throw Error('beklenmeyen istek: '+u);
  });
  const yt=new YouTube(s);
  const st1=new URL(yt.authorization('sess')).searchParams.get('state');
  await yt.callback('c1',st1,'sess');
  const st2=new URL(yt.authorization('sess')).searchParams.get('state');
  await yt.callback('c2',st2,'sess');
  assert.equal(yt.accounts().length,2);
  assert.equal(yt.accounts()[0].label,'Kanal 1');
  assert.equal(yt.accounts()[1].label,'Kanal 2');
  assert.match(yt.accounts()[0].channelUrl,/youtube\.com\/channel\/CH1/);
  assert.match(yt.accounts()[0].handleUrl,/youtube\.com\/@kanal1/);
  const peek=yt.pickAccount(undefined,{advance:false});
  const peek2=yt.pickAccount(undefined,{advance:false});
  assert.equal(peek.id,peek2.id,'test peek must not advance round-robin');
  const first=yt.pickAccount(),second=yt.pickAccount();
  assert.notEqual(first.id,second.id);
  assert.ok(yt.authorization('sess').includes('youtube.readonly'));
  const stats=await yt.stats({[yt.accounts()[0].id]:['v1']});
  assert.equal(stats.v1.views,42);assert.equal(stats.v1.likes,5);
  yt.setActive(yt.accounts()[0].id,false);assert.equal(yt.accounts().filter(a=>a.active).length,1);
  yt.removeAccount(yt.accounts()[0].id);assert.equal(yt.accounts().length,1);
});

test('telegram notify is passivated for now',async t=>{
  const s=fixture(t);
  assert.equal(await notify(s,'test'),false);
  s.setSecret('telegramToken','tok');s.setSetting('config',{...defaults,telegramChatId:'123',notifyTelegram:true,telegramEnabled:true});
  assert.equal(await notify(s,'merhaba'),false);
});
