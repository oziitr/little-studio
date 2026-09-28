import { config } from './config.mjs';

export async function notify(store, text) {
  const c = config(store);
  if (!c.telegramEnabled || !c.notifyTelegram) return false;
  const token = store.secret('telegramToken');
  const chatId = c.telegramChatId;
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
    return r.ok;
  } catch { return false; }
}
