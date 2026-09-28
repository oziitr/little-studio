import { normalizePublishSchedule } from './publish.mjs';

export const defaults = {
  provider: 'api',
  textModel: 'gemini-2.5-flash',
  imageModel: 'gemini-2.5-flash-image',
  videoModel: 'veo-3.1-fast-generate-preview',
  paid: false,
  daily: 10,
  monthly: 50,
  perVideo: 8,
  imagePrice: 0.04,
  videoSecondPrice: 0.10,
  textReserve: 0.10,
  pricesConfirmed: false,
  minFreeGB: 5,
  publicUrl: '',
  clientId: '',
  autoPublish: false,
  autoSharePool: false,
  notifyTelegram: false,
  telegramChatId: '',
  telegramEnabled: false,
  publishSchedule: {
    enabled: false,
    mode: 'global',
    intervalHours: 2,
    maxRuns: 0,
    runsDone: 0,
    nextAt: null,
    privacy: 'private'
  },
  autoPilot: {
    enabled: false,
    intervalHours: 3,
    language: 'en',
    length: 'short',
    privacy: 'public',
    runsDone: 0,
    nextAt: null
  }
};

export function config(store) {
  const c = { ...defaults, ...store.setting('config', {}) };
  c.textModel = process.env.TEXT_MODEL || c.textModel;
  c.imageModel = process.env.IMAGE_MODEL || c.imageModel;
  c.videoModel = process.env.VEO_MODEL || c.videoModel;
  if (process.env.ENABLE_PAID_GENERATION === 'true') c.paid = true;
  c.publicUrl = process.env.PUBLIC_URL || c.publicUrl;
  c.clientId = process.env.YOUTUBE_CLIENT_ID || c.clientId;
  c.publishSchedule = normalizePublishSchedule({ ...defaults.publishSchedule, ...(c.publishSchedule || {}) });
  c.autoPilot = { ...defaults.autoPilot, ...(c.autoPilot || {}) };
  // Telegram şimdilik pasif
  c.telegramEnabled = false;
  c.notifyTelegram = false;
  return c;
}

export function validateConfig(input) {
  const c = { ...defaults };
  for (const k of ['textModel', 'imageModel', 'videoModel']) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(input[k] || '')) throw Error('Model adı geçersiz.');
    c[k] = input[k];
  }
  for (const k of ['daily', 'monthly', 'perVideo', 'imagePrice', 'videoSecondPrice', 'textReserve', 'minFreeGB']) {
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n <= 0 || n > 10000) throw Error('Limitler ve birim fiyatlar sıfırdan büyük olmalı.');
    c[k] = n;
  }
  for (const k of ['paid', 'pricesConfirmed', 'autoPublish', 'autoSharePool']) c[k] = input[k] === true;
  c.notifyTelegram = false;
  c.telegramEnabled = false;
  c.provider = ['api', 'web'].includes(input.provider) ? input.provider : 'api';
  c.telegramChatId = String(input.telegramChatId || '').trim().slice(0, 64);
  c.clientId = String(input.clientId || '').trim().slice(0, 250);
  c.publicUrl = String(input.publicUrl || '').trim().replace(/\/$/, '');
  if (c.publicUrl) {
    const u = new URL(c.publicUrl);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw Error('Panel adresi HTTPS olmalı (yerelde localhost olabilir).');
  }
  const prev = input.publishSchedule || {};
  c.publishSchedule = normalizePublishSchedule({
    ...prev,
    enabled: prev.enabled === true,
    mode: prev.mode,
    intervalHours: prev.intervalHours,
    maxRuns: prev.maxRuns,
    privacy: prev.privacy,
    runsDone: prev.runsDone,
    nextAt: prev.enabled === true && !prev.nextAt ? new Date().toISOString() : prev.nextAt
  });
  if (c.publishSchedule.enabled && !c.publishSchedule.nextAt) c.publishSchedule.nextAt = new Date().toISOString();
  const ap = input.autoPilot || {};
  const ih = Number(ap.intervalHours);
  c.autoPilot = {
    enabled: ap.enabled === true,
    intervalHours: Math.min(168, Math.max(1, Number.isFinite(ih) && ih > 0 ? Math.round(ih) : 3)),
    language: ap.language === 'tr' ? 'tr' : 'en',
    length: ap.length === 'long' ? 'long' : 'short',
    privacy: ap.privacy === 'unlisted' ? 'unlisted' : (ap.privacy === 'private' ? 'private' : 'public'),
    runsDone: Math.max(0, Math.round(Number(ap.runsDone) || 0)),
    nextAt: ap.nextAt && Number.isFinite(new Date(ap.nextAt).getTime()) ? new Date(ap.nextAt).toISOString() : null
  };
  if (c.autoPilot.enabled && !c.autoPilot.nextAt) c.autoPilot.nextAt = new Date().toISOString();
  return c;
}
