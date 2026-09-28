import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { config } from './config.mjs';
import { defaultAccountSchedule, normalizeAccountSchedule } from './publish.mjs';

const endpoint = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

function channelUrls(channelId, customUrl) {
  const urls = {};
  if (channelId) urls.channelUrl = `https://www.youtube.com/channel/${channelId}`;
  if (customUrl) {
    const handle = String(customUrl).replace(/^@/, '');
    urls.handleUrl = `https://www.youtube.com/@${handle}`;
    urls.customUrl = customUrl.startsWith('@') ? customUrl : '@' + handle;
  }
  return urls;
}

export class YouTube {
  constructor(store, { request = fetch } = {}) { this.store = store; this.states = new Map(); this.request = request; }
  client() {
    const c = config(this.store);
    return { id: c.clientId, secret: process.env.YOUTUBE_CLIENT_SECRET || this.store.secret('youtubeClientSecret'), redirect: c.publicUrl + '/api/youtube/callback' };
  }
  _migrate() {
    const legacy = this.store.secret('youtubeTokens');
    if (!legacy) return;
    try {
      const tokens = JSON.parse(legacy);
      if (tokens.refresh_token && !this._all().length) {
        this._saveAll([{ id: randomBytes(6).toString('hex'), label: 'Bağlı hesap', channelId: '', tokens, active: true, added: new Date().toISOString(), schedule: defaultAccountSchedule() }]);
        this.store.setSecret('youtubeTokens', '');
      }
    } catch {}
  }
  _all() { return this.store.setting('youtubeAccounts', []); }
  _saveAll(list) { this.store.setSetting('youtubeAccounts', list); }
  accounts() {
    this._migrate();
    return this._all().map(a => {
      const urls = channelUrls(a.channelId, a.customUrl);
      return {
        id: a.id,
        label: a.label || 'YouTube hesabı',
        channelId: a.channelId || '',
        customUrl: a.customUrl || '',
        channelUrl: urls.channelUrl || '',
        handleUrl: urls.handleUrl || '',
        active: a.active !== false,
        added: a.added,
        schedule: normalizeAccountSchedule(a.schedule || {}),
        lastUploadAt: a.lastUploadAt || null
      };
    });
  }
  removeAccount(id) { this._saveAll(this._all().filter(a => a.id !== id)); }
  setActive(id, active) {
    const list = this._all();
    const a = list.find(a => a.id === id);
    if (a) { a.active = !!active; this._saveAll(list); }
  }
  updateAccount(id, patch = {}) {
    const list = this._all();
    const a = list.find(x => x.id === id);
    if (!a) throw Error('Hesap bulunamadı.');
    if (typeof patch.label === 'string' && patch.label.trim()) a.label = patch.label.trim().slice(0, 120);
    if (patch.schedule) a.schedule = normalizeAccountSchedule({ ...normalizeAccountSchedule(a.schedule || {}), ...patch.schedule });
    if (patch.active !== undefined) a.active = !!patch.active;
    this._saveAll(list);
    return this.accounts().find(x => x.id === id);
  }
  authorization(session) {
    const c = this.client();
    if (!c.id || !c.secret || !config(this.store).publicUrl) throw Error('Önce panel adresi, OAuth istemci kimliği ve sırrını ayarlayın.');
    const state = randomBytes(32).toString('hex');
    this.states.set(state, { session, expires: Date.now() + 600000 });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({ client_id: c.id, redirect_uri: c.redirect, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state }).toString();
    return u.toString();
  }
  async fetchChannel(accessToken) {
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000) });
    if (!ch.ok) return null;
    const d = await ch.json();
    const item = d.items?.[0];
    if (!item) return null;
    return {
      label: item.snippet?.title || 'YouTube hesabı',
      channelId: item.id || '',
      customUrl: item.snippet?.customUrl || ''
    };
  }
  async callback(code, state, session) {
    const match = this.states.get(state); this.states.delete(state);
    if (!match || match.session !== session || match.expires < Date.now()) throw Error('OAuth oturumu geçersiz veya süresi doldu.');
    const c = this.client();
    const r = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, redirect_uri: c.redirect, code, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Error('Google hesap bağlantısı tamamlanamadı.');
    const data = await r.json();
    if (!data.refresh_token) throw Error('Yenileme anahtarı alınamadı. Google izinlerini kaldırıp yeniden bağlayın.');
    let meta = { label: 'YouTube hesabı', channelId: '', customUrl: '' };
    if (data.access_token) {
      try { meta = (await this.fetchChannel(data.access_token)) || meta; } catch {}
    }
    this._migrate();
    const list = this._all();
    const existing = meta.channelId ? list.find(a => a.channelId === meta.channelId) : null;
    if (existing) {
      existing.tokens = data;
      existing.label = meta.label;
      existing.channelId = meta.channelId;
      existing.customUrl = meta.customUrl;
    } else {
      list.push({
        id: randomBytes(6).toString('hex'),
        label: meta.label,
        channelId: meta.channelId,
        customUrl: meta.customUrl,
        tokens: data,
        active: true,
        added: new Date().toISOString(),
        schedule: defaultAccountSchedule()
      });
    }
    this._saveAll(list);
  }
  async refreshAccount(id) {
    const list = this._all();
    const a = list.find(x => x.id === id);
    if (!a) throw Error('Hesap bulunamadı.');
    const access = await this.tokenFor(a);
    const meta = await this.fetchChannel(access);
    if (!meta) throw Error('Kanal bilgisi alınamadı.');
    a.label = meta.label;
    a.channelId = meta.channelId;
    a.customUrl = meta.customUrl;
    this._saveAll(list);
    return this.accounts().find(x => x.id === id);
  }
  async refreshAll() {
    const out = [];
    for (const a of this._all()) {
      try { out.push(await this.refreshAccount(a.id)); }
      catch (e) { out.push({ id: a.id, error: e.message }); }
    }
    return out;
  }
  pickAccount(preferId, { advance = true } = {}) {
    this._migrate();
    const list = this._all().filter(a => a.active !== false);
    if (!list.length) throw Error('Bağlı YouTube hesabı yok.');
    if (preferId) {
      const p = list.find(a => a.id === preferId);
      if (p) return p;
    }
    const last = Number(this.store.setting('youtubeLast', -1));
    const next = (last + 1) % list.length;
    if (advance) this.store.setSetting('youtubeLast', next);
    return list[next];
  }
  async tokenFor(account) {
    const c = this.client();
    const r = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: account.tokens.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Error(`"${account.label}" erişimi yenilenemedi; hesabı yeniden bağlayın.`);
    return (await r.json()).access_token;
  }
  async token() { return this.tokenFor(this.pickAccount(undefined, { advance: false })); }

  async upload(job, file, project, persist) {
    if (job.context.youtubeId) return { id: job.context.youtubeId, accountId: job.context.youtubeAccount, accountLabel: job.context.youtubeAccountLabel };
    const active = this._all().filter(a => a.active !== false);
    if (!active.length) throw Error('Bağlı YouTube hesabı yok.');
    const tried = new Set();
    let lastErr = null;
    while (tried.size < active.length) {
      const prefer = job.context.accountId && !tried.has(job.context.accountId) ? job.context.accountId : undefined;
      let acc;
      try { acc = this.pickAccount(prefer); } catch (e) { throw lastErr || e; }
      if (tried.has(acc.id)) {
        acc = active.find(a => !tried.has(a.id));
        if (!acc) break;
      }
      tried.add(acc.id);
      try {
        return await this._uploadOnce(job, file, project, persist, acc);
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        if (/401|403|yenilenemedi|oturumu açılamadı/i.test(msg)) {
          delete job.context.uploadUrl;
          delete job.context.uploadSending;
          delete job.context.accountId;
          persist();
          continue;
        }
        throw e;
      }
    }
    throw lastErr || Error('YouTube yüklemesi başarısız; hesapları yeniden bağlayın.');
  }

  async _uploadOnce(job, file, project, persist, acc) {
    const access = await this.tokenFor(acc);
    const length = (await stat(file)).size;
    const publishing = job.context.publish || {};
    if (!job.context.uploadUrl) {
      if (job.context.uploadSending) throw Error('Yükleme oturumu belirsiz. YouTube Studio kontrol edilmeden tekrar başlatılmadı.');
      job.context.uploadSending = true; persist();
      const status = { privacyStatus: publishing.privacy || 'private', selfDeclaredMadeForKids: true, containsSyntheticMedia: true };
      if (publishing.publishAt) {
        if (new Date(publishing.publishAt).getTime() <= Date.now()) throw Error('Yayın tarihi geçmişte.');
        status.privacyStatus = 'private';
        status.publishAt = publishing.publishAt;
      }
      const r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(length) },
        body: JSON.stringify({ snippet: { title: project.title.slice(0, 100), description: (publishing.description || project.idea || '').slice(0, 4500), categoryId: '1', defaultLanguage: project.language, defaultAudioLanguage: project.language }, status }),
        signal: AbortSignal.timeout(30000)
      });
      if (!r.ok) throw Error(`YouTube yükleme oturumu açılamadı (${r.status}).`);
      const location = r.headers.get('location');
      this.validateUrl(location);
      job.context.uploadUrl = location;
      job.context.uploadSending = false;
      persist();
    }
    this.validateUrl(job.context.uploadUrl);
    const check = await fetch(job.context.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${access}`, 'Content-Length': '0', 'Content-Range': `bytes */${length}` }, signal: AbortSignal.timeout(30000) });
    if (check.ok) {
      const r = await check.json();
      if (!r.id) throw Error('YouTube video kimliği alınamadı.');
      job.context.youtubeId = r.id;
      job.context.youtubeAccount = acc.id;
      job.context.youtubeAccountLabel = acc.label;
      persist();
      this._markUpload(acc.id);
      return { id: r.id, accountId: acc.id, accountLabel: acc.label };
    }
    if (check.status !== 308) throw Error(`YouTube yükleme oturumu kontrolü başarısız (${check.status}). Otomatik yeni yükleme açılmadı.`);
    let offset = Number(check.headers.get('range')?.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1;
    const handle = await open(file, 'r');
    try {
      while (offset < length) {
        const bytes = Math.min(8 * 1024 * 1024, length - offset), buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, offset);
        if (bytesRead !== bytes) throw Error('Video dosyası okunamadı.');
        const r = await fetch(job.context.uploadUrl, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'video/mp4', 'Content-Length': String(bytes), 'Content-Range': `bytes ${offset}-${offset + bytes - 1}/${length}` },
          body: buffer,
          signal: AbortSignal.timeout(180000)
        });
        if (r.ok) {
          const result = await r.json();
          if (!result.id) throw Error('Video kimliği eksik.');
          job.context.youtubeId = result.id;
          job.context.youtubeAccount = acc.id;
          job.context.youtubeAccountLabel = acc.label;
          persist();
          this._markUpload(acc.id);
          return { id: result.id, accountId: acc.id, accountLabel: acc.label };
        }
        if (r.status !== 308) throw Error(`YouTube yükleme durdu (${r.status}). Kayıtlı oturumdan devam edilebilir.`);
        const next = Number(r.headers.get('range')?.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1;
        if (next <= offset) throw Error('YouTube yükleme ilerlemedi.');
        offset = next;
      }
    } finally { await handle.close(); }
    throw Error('Yükleme sonucu henüz doğrulanamadı.');
  }
  _markUpload(id) {
    const list = this._all();
    const a = list.find(x => x.id === id);
    if (a) { a.lastUploadAt = new Date().toISOString(); this._saveAll(list); }
  }
  async stats(idsByAccount) {
    const out = {};
    for (const [accountId, videoIds] of Object.entries(idsByAccount)) {
      const account = this._all().find(a => a.id === accountId);
      if (!account || !videoIds.length) continue;
      try {
        const access = await this.tokenFor(account);
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,status&id=${videoIds.slice(0, 50).join(',')}`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        const d = await r.json();
        for (const item of d.items || []) out[item.id] = { views: Number(item.statistics?.viewCount || 0), likes: Number(item.statistics?.likeCount || 0), comments: Number(item.statistics?.commentCount || 0), privacy: item.status?.privacyStatus || '' };
      } catch {}
    }
    return out;
  }
  validateUrl(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !['www.googleapis.com', 'youtube.googleapis.com'].includes(u.hostname)) throw Error('YouTube yükleme adresi geçersiz.');
  }
}
