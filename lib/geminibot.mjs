import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { copyFile, readFile, writeFile, unlink, rm, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SESSION_FILE = 'gemini-session.json';
export const webSessionPath = dir => path.join(dir, SESSION_FILE);
export const hasWebSession = dir => existsSync(webSessionPath(dir));

const delay = ms => new Promise(r => setTimeout(r, ms));
async function pageAlive(page) {
  if (!page || page.isClosed()) throw Error('Tarayıcı kapandı (servis kesildiyse Kuyruk → Devam et).');
}
/** page.waitForTimeout yerine — kapalı sayfada patlamaz, yanıt gelince hemen çıkarız. */
async function pause(page, ms = 1000) {
  await pageAlive(page);
  await delay(ms);
  await pageAlive(page);
}

/** Playwright storageState özeti — gizli çerez değerleri dönmez. */
export function sessionInfo(dir) {
  const file = webSessionPath(dir);
  if (!existsSync(file)) return { connected: false, cookies: 0, updatedAt: null, stale: true };
  try {
    const st = statSync(file);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const cookies = Array.isArray(data.cookies) ? data.cookies.length : 0;
    const updatedAt = st.mtime.toISOString();
    const ageMs = Date.now() - st.mtimeMs;
    const stale = cookies < 10 || ageMs > 2 * 24 * 3600000;
    return { connected: cookies >= 10, cookies, updatedAt, stale };
  } catch {
    return { connected: false, cookies: 0, updatedAt: null, stale: true };
  }
}

const profileDir = dir => path.join(dir, 'chrome-profile');
async function wipeBrowserProfile(dir) {
  await rm(path.join(dir, 'browser-profile'), { recursive: true, force: true }).catch(() => {});
  await rm(profileDir(dir), { recursive: true, force: true }).catch(() => {});
}

let xvfbProc = null;
async function ensureDisplay() {
  if (process.env.DISPLAY) return;
  if (!xvfbProc || xvfbProc.exitCode != null) {
    xvfbProc = spawn('Xvfb', [':99', '-screen', '0', '1400x900x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
    await delay(600);
  }
  process.env.DISPLAY = ':99';
}

export async function saveWebSession(dir, state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.cookies)) throw Error('Geçersiz oturum dosyası (cookies eksik).');
  if (state.cookies.length < 10) throw Error('Oturum çok zayıf görünüyor (az çerez). gemini-login.mjs ile “Oturum aç” kaybolana kadar bekleyip yeniden kaydedin.');
  mkdirSync(dir, { recursive: true });
  const file = webSessionPath(dir);
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  // Eski Chromium profili yeni çerezleri yok sayıyordu — her yüklemede sıfırla
  await wipeBrowserProfile(dir);
  // Yeni hesap / yeni oturum → eski sohbet kilidini bırak (yanlış hesaba gitmesin)
  try { unlinkSync(path.join(dir, 'gemini-sticky-chat.json')); } catch {}
  return sessionInfo(dir);
}

export async function clearWebSession(dir) {
  try { await unlink(webSessionPath(dir)); } catch {}
  await wipeBrowserProfile(dir);
  try { unlinkSync(path.join(dir, 'gemini-sticky-chat.json')); } catch {}
  return sessionInfo(dir);
}

/** Aynı anda tek Chromium: üretim varken nabız bekler, nabız varken üretim bekler. */
let geminiHeld = false;
const geminiWaiters = [];
function acquireGemini() {
  if (!geminiHeld) {
    geminiHeld = true;
    return Promise.resolve();
  }
  return new Promise(resolve => geminiWaiters.push(resolve));
}
function releaseGemini() {
  const next = geminiWaiters.shift();
  if (next) next();
  else geminiHeld = false;
}

const CHAT_URL_RE = /https?:\/\/gemini\.google\.com\/app\/([a-zA-Z0-9_-]+)/;
const stickyFile = dir => path.join(dir, 'gemini-sticky-chat.json');
// Gemini web: hikâye + Veo video → Flash-Lite (kredi tasarrufu). AI Studio yok.
// Google kullanım şartları otomasyonu kısıtlayabilir; düşük hızda, tek iş çalıştır.
export class GeminiWebProvider {
  constructor(dir, { headless = true } = {}) {
    this.dir = dir;
    this.headless = headless;
    this.browser = null;
    this.ctx = null;
    this.chat = null;
    this.chatUrl = null;
    this.ops = new Map();
    this.seenVideoHashes = new Set();
  }
  bindChat(url) {
    if (url && CHAT_URL_RE.test(url)) this.chatUrl = url.match(CHAT_URL_RE)[0];
  }
  currentChatUrl() {
    return this.chatUrl || null;
  }
  clearSticky() {
    this.chatUrl = null;
    try { unlinkSync(stickyFile(this.dir)); } catch {}
  }
  readSticky() {
    try {
      const raw = JSON.parse(readFileSync(stickyFile(this.dir), 'utf8'));
      if (raw?.url && CHAT_URL_RE.test(raw.url)) return raw.url.match(CHAT_URL_RE)[0];
    } catch {}
    return null;
  }
  async writeSticky(url) {
    if (!url || !CHAT_URL_RE.test(url)) return;
    this.chatUrl = url.match(CHAT_URL_RE)[0];
    await writeFile(stickyFile(this.dir), JSON.stringify({ url: this.chatUrl, at: Date.now() }), { mode: 0o600 }).catch(() => {});
  }
  async pinChat(page) {
    try {
      const url = page.url();
      if (CHAT_URL_RE.test(url)) await this.writeSticky(url);
    } catch {}
  }
  async launch() {
    if (this.ctx) return;
    await acquireGemini();
    this._locked = true;
    if (!hasWebSession(this.dir)) {
      this._locked = false;
      releaseGemini();
      throw Error('Gemini web oturumu yok. Kendi bilgisayarında `node deploy/gemini-login.mjs` çalıştır, çıkan data/gemini-session.json dosyasını sunucuya yüklet.');
    }
    try {
      await ensureDisplay();
      const { chromium } = await import('playwright');
      // Kalıcı profil: çerezler Chrome'un kendi kavanozunda döner.
      // Her açılışta json'dan headless context kurmak Google'ın oturumu düşürmesine yol açıyordu.
      const profile = profileDir(this.dir);
      mkdirSync(profile, { recursive: true });
      const cookieDb = path.join(profile, 'Default', 'Cookies');
      this.seededFresh = !existsSync(cookieDb);
      const opts = {
        headless: false,
        locale: 'en-US',
        viewport: { width: 1400, height: 900 },
        acceptDownloads: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--disable-infobars']
      };
      this.ctx = await chromium.launchPersistentContext(profile, opts);
      this.browser = this.ctx.browser();
      await this.ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      }).catch(() => {});
      // launchPersistentContext storageState çerezleri yazmıyor; json'dan elle bas.
      if (this.seededFresh && hasWebSession(this.dir)) {
        const state = JSON.parse(readFileSync(webSessionPath(this.dir), 'utf8'));
        const cookies = (state.cookies || []).filter(c => c?.name && c?.value && c?.domain).map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expires > 0 ? c.expires : undefined,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax'
        }));
        if (cookies.length) await this.ctx.addCookies(cookies);
      }
    } catch (e) {
      try { await this.browser?.close(); } catch {}
      this.browser = null;
      this.ctx = null;
      this._locked = false;
      releaseGemini();
      throw e;
    }
  }
  async close() {
    try { if (this.chat && !this.chat.isClosed?.()) await this.chat.close(); } catch {}
    this.chat = null;
    try { await this.ctx?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = null;
    this.ctx = null;
    if (this._locked) {
      this._locked = false;
      releaseGemini();
    }
  }
  /**
   * Oturumu sıcak tut: Gemini sayfasını aç, giriş duruyorsa çerezleri kaydet, kapat.
   * Mesaj / video yok — kota harcamaz.
   */
  async keepAlive() {
    await this.launch();
    const page = await this.ctx.newPage();
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await pause(page, 2500);
      await this.dismissConsent(page);
      await this.assertSignedIn(page);
      await this.chatBox(page);
      await this.saveState();
      this.seededFresh = false;
      return { ok: true, at: new Date().toISOString() };
    } finally {
      await page.close().catch(() => {});
    }
  }
  async saveState() {
    try {
      if (!this.ctx) return;
      const tmp = webSessionPath(this.dir) + '.part';
      await this.ctx.storageState({ path: tmp });
      const next = JSON.parse(readFileSync(tmp, 'utf8'));
      const auth = list => (list || []).filter(c => /PSID|SAPISID|SSID|^SID$/.test(c.name)).length;
      let prev = 0;
      try { prev = auth(JSON.parse(readFileSync(webSessionPath(this.dir), 'utf8')).cookies); } catch { /* */ }
      if (prev && auth(next.cookies) < prev) {
        await unlink(tmp).catch(() => {});
        return;
      }
      await rename(tmp, webSessionPath(this.dir));
    } catch { /* */ }
  }
  async debug(page, name) {
    try {
      const d = path.join(this.dir, 'debug');
      mkdirSync(d, { recursive: true });
      await page.screenshot({ path: path.join(d, name + '.png'), fullPage: true });
    } catch {}
  }
  /** Aynı Gemini sohbetini pipeline boyunca tut — asla arka arkaya yeni sohbet açma. */
  async ensureChat() {
    await this.launch();
    if (this.chat) {
      try {
        if (!this.chat.isClosed()) {
          await this.pinChat(this.chat);
          return this.chat;
        }
      } catch {}
      this.chat = null;
    }
    if (!this.chatUrl) this.chatUrl = this.readSticky();
    this.chat = await this.ctx.newPage();
    await this.openApp(this.chat, this.chatUrl);
    return this.chat;
  }
  async chatBox(page) {
    for (const sel of ['div[contenteditable="true"]', 'rich-textarea div[role="textbox"]', 'div[role="textbox"]', 'textarea']) {
      const box = await page.$(sel);
      if (box) return box;
    }
    throw Error('Gemini metin kutusu bulunamadı.');
  }
  async dismissConsent(page) {
    for (const sel of ['button:has-text("Tümünü kabul et")', 'button:has-text("Accept all")', 'button:has-text("Anladım")', 'button:has-text("Got it")', 'button:has-text("Kabul et")', 'button:has-text("Tümünü reddet")', 'button:has-text("Reject all")']) {
      const b = await page.$(sel).catch(() => null);
      if (b) {
        await b.click().catch(() => {});
        await pause(page, 800);
      }
    }
  }
  async assertSignedIn(page) {
    const signedOut = await page.$('a:has-text("Oturum aç"), button:has-text("Oturum aç"), a:has-text("Sign in"), button:has-text("Sign in"), a[href*="ServiceLogin"]').catch(() => null);
    if (signedOut) {
      await this.debug(page, 'oturum-kapali');
      throw Error('Gemini oturumu geçersiz: tarayıcıda "Oturum aç" görünüyor. gemini-login.mjs ile oturumu yenile.');
    }
  }
  /** preferUrl varsa o sohbete gir; yoksa tek yeni sohbet. "Yeni sohbet"e tıklama. */
  async openApp(page, preferUrl) {
    const target = preferUrl && CHAT_URL_RE.test(preferUrl)
      ? preferUrl.match(CHAT_URL_RE)[0]
      : 'https://gemini.google.com/app';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await pause(page, 2500);
    await this.dismissConsent(page);
    await this.assertSignedIn(page);
    // Sticky URL açıldıysa ama Gemini yeni boş sohbete düşürdüyse — tekrar sticky'ye zorla
    if (preferUrl && CHAT_URL_RE.test(preferUrl)) {
      const want = preferUrl.match(CHAT_URL_RE)[0];
      const now = page.url();
      if (!now.includes(want.split('/app/')[1])) {
        await page.goto(want, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
        await pause(page, 2000);
        await this.dismissConsent(page);
      }
    }
    await this.chatBox(page);
    await this.pinChat(page);
    await this.saveState();
  }
  async waitUntilIdle(page, { maxMs = 180000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (!(await this.isBusy(page))) return;
      await pause(page, 2000);
    }
  }
  /** Gemini aynı anda en fazla 2 video; slot boşalana kadar bekle, yeni sohbet açma. */
  async waitVideoSlot(page) {
    for (let i = 0; i < 90; i++) {
      await this.waitUntilIdle(page, { maxMs: 30000 });
      const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (/2 video generation requests running|maximum I can do at one time|aynı anda.*2.*video|en fazla 2/i.test(body)) {
        await pause(page, 20000);
        continue;
      }
      return;
    }
    throw Error('Gemini video kuyruğu dolu (2 eşzamanlı). Biraz bekleyip Devam et.');
  }
  async sendPrompt(page, box, prompt) {
    await pageAlive(page);
    await this.waitUntilIdle(page, { maxMs: 120000 });
    await box.click({ force: true }).catch(() => {});
    await pause(page, 200);
    // Uzun sahne metni keyboard.type ile kesiliyor → insertText (tek seferde yapıştır)
    await page.evaluate(text => {
      const el = document.querySelector('div[contenteditable="true"], rich-textarea div[role="textbox"], div[role="textbox"], textarea');
      if (!el) throw new Error('no box');
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = '';
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }, prompt).catch(async () => {
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(prompt.slice(0, 8000), { delay: 0 });
    });
    await pause(page, 400);
    const clickSend = async () => {
      for (const sel of [
        'button[aria-label*="Gönder" i]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="submit" i]',
        'button.send-button',
        'button[data-test-id*="send" i]'
      ]) {
        const b = await page.$(sel).catch(() => null);
        if (!b) continue;
        const disabled = await b.getAttribute('disabled').catch(() => null);
        const aria = await b.getAttribute('aria-disabled').catch(() => null);
        if (disabled != null || aria === 'true') continue;
        await b.click({ force: true }).catch(() => {});
        return true;
      }
      return false;
    };
    if (!(await clickSend())) await page.keyboard.press('Enter');
    for (let i = 0; i < 40; i++) {
      await pause(page, 500);
      await this.pinChat(page); // /app → /app/ID olunca kilitle
      if (await this.isBusy(page)) return;
      const left = ((await box.innerText().catch(() => '')) || '').trim();
      if (!left || left.length < Math.min(30, prompt.length / 4)) return;
      if (i === 3 || i === 10 || i === 20) {
        if (!(await clickSend())) await page.keyboard.press('Enter');
      }
    }
    await this.pinChat(page);
  }
  async lastText(page) {
    await pageAlive(page);
    return page.evaluate(() => {
      const inputs = [...document.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]')];
      const isInput = el => inputs.some(i => i === el || i.contains(el));
      for (const s of ['.model-response-text', 'message-content', '.response-container', '.markdown', '[data-message-author-role="model"]']) {
        const els = [...document.querySelectorAll(s)].filter(el => !isInput(el));
        if (els.length) return els[els.length - 1].innerText || '';
      }
      const blocks = [...document.querySelectorAll('div,p,pre,code')]
        .filter(el => !isInput(el) && (el.innerText || '').includes('{') && (el.innerText || '').includes('scenes') && (el.innerText || '').length > 40);
      return blocks.length ? blocks[blocks.length - 1].innerText : '';
    });
  }
  async isBusy(page) {
    await pageAlive(page);
    return !!(await page.$('button[aria-label*="Durdur"],button[aria-label*="Stop"],button[aria-label*="stop" i]').catch(() => null));
  }
  /**
   * Geçerli JSON gelene kadar bekler. maxMs aşılırsa hata (sonsuz takılma yok).
   */
  async waitJson(page, ok = () => true, { maxMs = 600000 } = {}) {
    let last = '', stable = 0;
    const start = Date.now();
    for (;;) {
      if (Date.now() - start > maxMs) {
        await this.debug(page, 'metin-zamanasim').catch(() => {});
        throw Error('Metin yanıtı zaman aşımı (JSON gelmedi). Yeni sohbetle tekrar deneyin.');
      }
      await pause(page, 1500);
      let busy = false, text = '';
      try {
        busy = await this.isBusy(page);
        text = await this.lastText(page);
      } catch (e) {
        if (/kapandı|closed/i.test(String(e.message))) throw e;
        await pageAlive(page);
        continue;
      }
      const m = text && text.match(/\{[\s\S]*\}/g);
      const candidates = m ? m.slice().reverse() : [];
      for (const raw of candidates) {
        try {
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          const obj = JSON.parse(cleaned);
          if (!ok(obj)) continue;
          if (!busy) return obj;
          if (text === last) stable++;
          else stable = 0;
          if (stable >= 2) return obj;
        } catch { /* yarım */ }
      }
      if (!busy && text && text === last && candidates.length) {
        stable++;
        if (stable >= 4) {
          for (const raw of candidates) {
            try {
              const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
              return JSON.parse(cleaned);
            } catch {}
          }
        }
      } else if (text !== last) {
        stable = 0;
      }
      last = text;
    }
  }
  async attachFile(page, data, mime) {
    const input = await page.$('input[type=file]');
    if (!input) return false;
    const tmp = path.join(this.dir, 'upload-tmp.' + (mime.includes('png') ? 'png' : mime.includes('mp4') ? 'mp4' : 'jpg'));
    await writeFile(tmp, Buffer.from(data, 'base64'));
    await input.setInputFiles(tmp);
    await pause(page, 2000);
    return true;
  }

  // Önce "filigransız / without watermark", sonra normal indirme. Blob yedek.
  async downloadClean(page, { preferVideo = false } = {}) {
    const downloadSels = [
      'button[aria-label*="indir" i]',
      'button[aria-label*="download" i]',
      'button[aria-label*="Download" i]',
      '[role="button"][aria-label*="indir" i]',
      '[role="button"][aria-label*="download" i]'
    ];
    const buttons = [];
    for (const sel of downloadSels) {
      for (const b of await page.$$(sel)) buttons.push(b);
    }
    if (!buttons.length) return null;

    const tryOption = async (label) => {
      const opt = await page.$(`text=/${label}/i`);
      if (!opt) return null;
      try {
        const dl = page.waitForEvent('download', { timeout: 30000 });
        await opt.click({ force: true });
        const d = await dl;
        const p2 = await d.path();
        if (!p2) return null;
        return await readFile(p2);
      } catch {
        return null;
      }
    };

    for (const btn of buttons.slice().reverse()) {
      await btn.click({ force: true, timeout: 5000 }).catch(() => {});
      await pause(page, 600);
      let buf = await tryOption('Filigransız|Without watermark|No watermark|Watermark.?siz|watermark olmadan');
      if (buf) return buf;
      if (preferVideo) {
        buf = await tryOption('Video|MP4|Original|Orijinal');
        if (buf) return buf;
      }
      try {
        const dl = page.waitForEvent('download', { timeout: 15000 });
        await btn.click({ force: true });
        const d = await dl;
        const p2 = await d.path();
        if (p2) return await readFile(p2);
      } catch {}
    }
    return null;
  }

  async waitForChatId(maxMs = 90000) {
    const page = this.chat;
    if (!page) return null;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await this.pinChat(page);
      if (this.chatUrl) return this.chatUrl;
      await pause(page, 1500);
    }
    await this.pinChat(page);
    return this.chatUrl;
  }

  async ensureOnSticky(page) {
    const want = this.chatUrl || this.readSticky();
    if (!want || !CHAT_URL_RE.test(want)) return;
    const id = want.match(CHAT_URL_RE)[1];
    let now = '';
    try { now = page.url(); } catch { return; }
    if (now.includes(id)) return;
    await page.goto(want.match(CHAT_URL_RE)[0], { waitUntil: 'domcontentloaded', timeout: 120000 });
    await pause(page, 2000);
    await this.dismissConsent(page);
    await this.pinChat(page);
  }

  async preferFlashModel(page) {
    // En ucuz: Flash-Lite → Flash. Pro seçme.
    const pickTrigger = async () => {
      const sels = [
        'button[aria-haspopup="listbox"]',
        'button:has-text("Flash-Lite")',
        'button:has-text("Flash Lite")',
        'button:has-text("Flash")',
        'button:has-text("Pro")',
      ];
      for (const sel of sels) {
        const el = await page.$(sel).catch(() => null);
        if (el) return el;
      }
      return null;
    };
    const trigger = await pickTrigger();
    if (!trigger) return;
    const label = ((await trigger.innerText().catch(() => '')) || '').trim();
    if (/Flash-Lite|Flash Lite/i.test(label)) return;
    await trigger.click({ force: true }).catch(() => {});
    await pause(page, 800);
    const patterns = [/Flash-Lite/i, /Flash Lite/i, /^Flash\b/i, /2\.5\s*Flash/i];
    for (const want of patterns) {
      const options = await page.$$('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button');
      for (const opt of options) {
        const t = ((await opt.innerText().catch(() => '')) || '').trim();
        if (!want.test(t)) continue;
        if (/\bPro\b/i.test(t) && !/Flash/i.test(t)) continue;
        await opt.click({ force: true }).catch(() => {});
        await pause(page, 600);
        const after = ((await (await pickTrigger())?.innerText().catch(() => '')) || '').trim();
        if (/Flash/i.test(after) && !/^Pro\b/i.test(after)) return;
        return;
      }
    }
    // Menü açık kaldıysa kapat
    await page.keyboard.press('Escape').catch(() => {});
  }

  async text(model, prompt, opts = {}) {
    // Aynı açık sayfada yeni sohbet. Sayfayı kapatıp /app'e dönmek oturumu düşürüyor.
    const page = await this.freshChat();
    try {
      await this.preferFlashModel(page);
      const box = await this.chatBox(page);
      const full = String(prompt || '') + '\n\nReply ONLY raw JSON. No markdown fences.';
      await this.sendPrompt(page, box, full);
      const defaultOk = obj => Array.isArray(obj.scenes) || typeof obj.safe === 'boolean' || (obj && obj.title && obj.idea);
      let obj = await this.waitJson(page, opts.ok || defaultOk, { maxMs: opts.maxMs || 600000 });
      const need = Number(opts.requireScenes) || 0;
      if (need > 0 && (!Array.isArray(obj.scenes) || obj.scenes.length !== need)) {
        const box2 = await this.chatBox(page);
        await this.sendPrompt(page, box2,
          `Need exactly ${need} scenes. Reply ONLY raw JSON: {"scenes":[{"visual":"","motion":"","narration":""}]}`
        );
        obj = await this.waitJson(page, o => Array.isArray(o.scenes) && o.scenes.length === need, { maxMs: 300000 });
      }
      return obj;
    } catch (e) {
      await this.debug(page, 'metin-hata').catch(() => {});
      throw e;
    }
  }

  async image(model, prompt, reference) {
    const page = await this.ensureChat();
    try {
      const box = await this.chatBox(page);
      if (reference) await this.attachFile(page, reference.data, reference.mimeType).catch(() => {});
      const imgCountBefore = await page.evaluate(() =>
        [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 200 && (i.src.startsWith('blob:') || /googleusercontent|ggpht|data:image/.test(i.src))).length
      );
      await this.sendPrompt(page, box,
        `Continue in THIS same chat (do not start a new story). Generate ONE original image now.\n` +
        `9:16 portrait, child-friendly, no watermark, no logo, no text overlay.\n${prompt}`
      );
      let data = '', mime = 'image/png';
      for (;;) {
        await pause(page, 1500);
        if (await this.isBusy(page)) continue;
        const imgCount = await page.evaluate(() =>
          [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 200 && (i.src.startsWith('blob:') || /googleusercontent|ggpht|data:image/.test(i.src))).length
        );
        if (imgCount <= imgCountBefore) continue;

        const clean = await this.downloadClean(page).catch(() => null);
        if (clean?.length) {
          data = clean.toString('base64');
          break;
        }
        const found = await page.evaluate(async () => {
          const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 200 && (i.src.startsWith('blob:') || /googleusercontent|ggpht|data:image/.test(i.src)));
          const last = imgs[imgs.length - 1];
          if (!last) return null;
          try {
            const r = await fetch(last.src);
            const b = await r.arrayBuffer();
            const bytes = new Uint8Array(b);
            let s = '';
            for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
            return { data: btoa(s), type: r.headers.get('content-type') || '' };
          } catch {
            return null;
          }
        }).catch(() => null);
        if (found?.data) {
          data = found.data;
          mime = /^image\//.test(found.type) ? found.type.split(';')[0] : 'image/png';
          break;
        }
      }
      if (!data) {
        await this.debug(page, 'gorsel-yok');
        throw Error('Gemini görseli üretilemedi veya indirilemedi.');
      }
      return { mimeType: mime, data };
    } catch (e) {
      await this.debug(page, 'gorsel-hata').catch(() => {});
      throw e;
    }
  }

  async enableVideoTool(page) {
    const openers = [
      'button[aria-label*="Araç" i]',
      'button[aria-label*="Tool" i]',
      'button:has-text("Araçlar")',
      'button:has-text("Tools")',
      'button[aria-label*="Add" i]',
      'button[aria-label="+"]',
    ];
    for (const sel of openers) {
      const menu = await page.$(sel).catch(() => null);
      if (!menu) continue;
      await menu.click().catch(() => {});
      await pause(page, 900);
      for (const vsel of [
        '[role="menuitem"]:has-text("Video")',
        '[role="option"]:has-text("Video")',
        'button:has-text("Video")',
        'div:has-text("Veo")',
        'text=/\\bVeo\\b/i',
        'text=/\\bVideo\\b/i',
      ]) {
        const v = await page.$(vsel).catch(() => null);
        if (v) {
          await v.click().catch(() => {});
          await pause(page, 800);
          return;
        }
      }
    }
  }

  async freshChat() {
    this.clearSticky();
    this.chatUrl = null;
    if (this.chat && !this.chat.isClosed?.()) {
      const signedOut = await this.chat.$('a:has-text("Oturum aç"), button:has-text("Oturum aç"), a:has-text("Sign in"), button:has-text("Sign in")').catch(() => null);
      if (!signedOut) {
        const btn = await this.chat.$('a:has-text("Yeni sohbet"), button:has-text("Yeni sohbet"), a:has-text("New chat"), button:has-text("New chat")').catch(() => null);
        if (btn) {
          await btn.click().catch(() => {});
          await pause(this.chat, 1200);
          return this.chat;
        }
        return this.chat;
      }
    }
    return this.ensureChat();
  }

  async preferProModel(page) {
    const trigger = await page.$('button:has-text("Flash"), button:has-text("Pro"), button[aria-haspopup="listbox"]').catch(() => null);
    if (!trigger) return;
    const label = ((await trigger.innerText().catch(() => '')) || '').trim();
    if (/Pro/i.test(label) && !/Flash/i.test(label)) return;
    await trigger.click().catch(() => {});
    await pause(page, 700);
    const options = await page.$$('[role="option"], [role="menuitem"]');
    for (const opt of options) {
      const t = ((await opt.innerText().catch(() => '')) || '').trim();
      if (!/Pro/i.test(t) || /Flash/i.test(t)) continue;
      await opt.click().catch(() => {});
      await pause(page, 500);
      return;
    }
  }

  videoRejected(text) {
    return /can't generate your video|try another prompt|unable to generate (your )?video|videoyu (oluşturamad[ıi]|üretemedim)|başka bir (istem|prompt)|video oluşturulam[ıi]yor/i.test(String(text || ''));
  }

  async reopenVideoChat(page) {
    // Boş /app'e düşersek: sticky URL veya sidebar'daki Veo sohbetine dön
    await this.ensureOnSticky(page).catch(() => {});
    let url = '';
    try { url = page.url(); } catch { return; }
    if (CHAT_URL_RE.test(url)) return;
    const clicked = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a, button, [role="link"], [role="button"]')];
      const want = links.find(el => /Veo video only|Scene\s*\d+\s*\/\s*\d+/i.test(el.innerText || el.getAttribute('aria-label') || ''));
      if (!want) return false;
      want.click();
      return true;
    }).catch(() => false);
    if (clicked) {
      await pause(page, 2500);
      await this.pinChat(page);
    }
  }

  async startVideo(model, prompt, image) {
    // Her klip: taze Gemini sohbeti + Flash-Lite + Veo (Pro yok — kredi)
    const page = await this.freshChat();
    try {
      await this.waitVideoSlot(page);
      await this.preferFlashModel(page);
      const videoCountBefore = await page.evaluate(() => document.querySelectorAll('video').length);
      await this.enableVideoTool(page);
      await this.preferFlashModel(page); // Video aracı Pro'ya çekebiliyor — tekrar Flash-Lite
      if (image?.data) await this.attachFile(page, image.data, image.mimeType).catch(() => {});
      const box = await this.chatBox(page);
      const full = (image?.data ? 'Veo from image. ' : 'Veo video only (no still). ') + prompt;
      await this.sendPrompt(page, box, full);
      // Gönderim sonrası sohbet ID'si gelmeli; yoksa kutuda metin kaldıysa tekrar dene
      let chatUrl = await this.waitForChatId(45000);
      if (!chatUrl) {
        const left = ((await box.innerText().catch(() => '')) || '').trim();
        if (left.length > 40) {
          await this.sendPrompt(page, box, full);
          chatUrl = await this.waitForChatId(60000);
        }
      }
      if (!chatUrl) {
        await this.debug(page, 'video-sohbet-yok').catch(() => {});
        throw Error('Gemini video sohbet URL alınamadı (gönderim takıldı). Devam et ile yeniden dene.');
      }
      await this.debug(page, 'video-gonderildi').catch(() => {});
      const id = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      this.ops.set(id, { page, started: Date.now(), videoCountBefore, lastShot: Date.now(), chatUrl });
      return id;
    } catch (e) {
      await this.debug(page, 'video-baslat-hata').catch(() => {});
      throw e;
    }
  }

  async hashFile(file) {
    const { createHash } = await import('node:crypto');
    const buf = await readFile(file);
    return createHash('sha256').update(buf).digest('hex');
  }

  async operation(name) {
    const op = this.ops.get(name);
    if (!op) throw Error('Web işlem kimliği geçersiz (sunucu yeniden başladıysa işi Devam et ile yeniden başlatın).');
    const { page, videoCountBefore = 0, started = Date.now() } = op;
    await pageAlive(page);
    if (op.chatUrl) this.bindChat(op.chatUrl);
    await this.reopenVideoChat(page).catch(() => {});
    const info = await page.evaluate(before => {
      const vids = [...document.querySelectorAll('video')];
      if (vids.length <= before) return { src: '', count: vids.length };
      const v = vids[vids.length - 1];
      return { src: v ? (v.currentSrc || v.src) : '', count: vids.length };
    }, videoCountBefore);
    if (!info.src) {
      const elapsed = Date.now() - started;
      if (!op.lastShot || Date.now() - op.lastShot > 120000) {
        op.lastShot = Date.now();
        await this.debug(page, 'video-bekliyor').catch(() => {});
      }
      const toast = await page.evaluate(() => {
        const t = document.body?.innerText || '';
        const m = t.match(/Bir hata oluştu[^\n]{0,40}/i) || t.match(/An error occurred[^\n]{0,40}/i);
        return m ? m[0] : '';
      }).catch(() => '');
      if (toast) {
        this.ops.delete(name);
        throw Error('Gemini: ' + toast.slice(0, 120));
      }
      let text = '';
      try { text = await this.lastText(page); } catch { /* */ }
      const busy = await this.isBusy(page).catch(() => false);
      if (!busy && this.videoRejected(text)) {
        await this.debug(page, 'video-reddedildi').catch(() => {});
        this.ops.delete(name);
        throw Error('Gemini video reddetti: ' + String(text || 'Try another prompt').slice(0, 160));
      }
      if (/a lot of requests|too many requests|çok fazla istek/i.test(String(text || ''))) {
        op.rateWaits = (op.rateWaits || 0) + 1;
        if (op.rateWaits > 4) {
          this.ops.delete(name);
          throw Error('Gemini şu an çok fazla istek diyor. Biraz bekleyip Devam et.');
        }
        await delay(3 * 60 * 1000);
        return { done: false };
      }
      if (/generation limit reached|video generation limit|sınırına ulaştınız|kotan[ıi]z|quota (exceeded|reached)|can't create video|unable to (create|generate) video/i.test(String(text || ''))) {
        this.ops.delete(name);
        throw Error('Gemini video kotası / Veo kullanılamıyor: ' + String(text).slice(0, 180));
      }
      if (elapsed > 20 * 60 * 1000) {
        await this.debug(page, 'video-zamanasim').catch(() => {});
        this.ops.delete(name);
        throw Error('Veo video üretmedi (20 dk zaman aşımı).');
      }
      return { done: false };
    }

    const file = path.join(this.dir, 'tmp-' + name + '.mp4');
    const clean = await this.downloadClean(page, { preferVideo: true }).catch(() => null);
    if (clean?.length) {
      await writeFile(file, clean);
    } else if (info.src.startsWith('blob:')) {
      const b64 = await page.evaluate(async u => {
        const r = await fetch(u);
        const b = await r.arrayBuffer();
        let s = '';
        const bytes = new Uint8Array(b);
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        return btoa(s);
      }, info.src);
      await writeFile(file, Buffer.from(b64, 'base64'));
    } else {
      const r = await this.ctx.request.get(info.src, { timeout: 300000 });
      if (!r.ok()) throw Error('Video indirilemedi.');
      await writeFile(file, await r.body());
    }
    const hash = await this.hashFile(file);
    if (this.seenVideoHashes.has(hash)) {
      await this.debug(page, 'video-tekrar').catch(() => {});
      this.ops.delete(name);
      throw Error('Aynı video klipi tekrar indi; Devam et ile yeniden dene.');
    }
    this.seenVideoHashes.add(hash);
    this.ops.delete(name);
    return { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'local:' + file } }] } } };
  }

  async download(uri, destination) {
    if (uri.startsWith('local:')) {
      await copyFile(uri.slice(6), destination);
      return;
    }
    const r = await this.ctx.request.get(uri, { timeout: 180000 });
    if (!r.ok()) throw Error('İndirme başarısız.');
    await writeFile(destination, await r.body());
  }
}
