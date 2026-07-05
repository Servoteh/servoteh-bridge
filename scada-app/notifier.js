// Telegram alarm notifier (uzeto iz servoteh-bridge obrasca). Opciono — ako nema
// tokena, tiho ne radi nista. Rate-limit 1h po istom alarmu (bez spama).
const TOKEN = () => process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
const CHAT = () => process.env.ALERT_TELEGRAM_CHAT_ID || '';
const RATE_MS = 60 * 60 * 1000;
const last = new Map();

async function send(text) {
  if (!TOKEN() || !CHAT()) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT(), text, disable_web_page_preview: true }),
    });
  } catch (e) { /* nikad ne ruši server */ }
}

// edge-triggered alarm (zove se samo na prelaz 0->1)
function alarm(key, label) {
  const now = Date.now();
  if (last.get(key) && now - last.get(key) < RATE_MS) return;
  last.set(key, now);
  send(`🚨 KOTLARNICA — ALARM: ${label}\n${new Date().toLocaleString('sr-RS')}`);
}
function clear(key, label) {
  send(`✅ KOTLARNICA — alarm prošao: ${label}`);
}
function configured() { return !!(TOKEN() && CHAT()); }

module.exports = { send, alarm, clear, configured };
