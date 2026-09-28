#!/usr/bin/env node
// Gemini web oturumu: tarayıcı açar, Google'a OTURUM AÇILDIĞINI kendisi algılar,
// çerezleri data/gemini-session.json'a kaydeder. Bu dosyayı asla paylaşma.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
mkdirSync('data', { recursive: true });
if (existsSync('data/gemini-session.json')) console.log('Not: eski oturum dosyası var; yeni giriş üzerine yazılacak.');
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ locale: 'tr-TR', viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 90000 });
console.log('\n1) Açılan tarayıcıda Google hesabınla giriş yap (Pro aboneliğin olan hesap).');
console.log('2) Sağ üstte "Oturum aç" butonu KAYBOLUP hesap fotoğrafın görününce sistem kaydeder.\n');
const start = Date.now();
let ok = false;
while (Date.now() - start < 15 * 60000) {
  await page.waitForTimeout(4000);
  const signin = await page.$('a:has-text("Oturum aç"), button:has-text("Oturum aç"), a:has-text("Sign in"), button:has-text("Sign in"), a[href*="ServiceLogin"]').catch(() => null);
  const box = await page.$('div[contenteditable="true"], div[role="textbox"], textarea').catch(() => null);
  if (box && !signin) { ok = true; break; }
}
if (!ok) { console.log('15 dakikada oturum açıldığı doğrulanamadı. Tekrar çalıştır.'); await browser.close(); process.exit(1); }
await page.waitForTimeout(5000);
const still = await page.$('a:has-text("Oturum aç"), button:has-text("Oturum aç"), a[href*="ServiceLogin"]').catch(() => null);
if (still) { console.log('Oturum aç butonu hâlâ görünüyor; kaydedilmedi. Tekrar çalıştır.'); await browser.close(); process.exit(1); }
await ctx.storageState({ path: 'data/gemini-session.json' });
const state = JSON.parse(readFileSync('data/gemini-session.json', 'utf8'));
console.log(`Oturum kaydedildi: data/gemini-session.json (${state.cookies.length} çerez) — tarayıcı kapatılıyor.`);
await browser.close();
process.exit(0);
