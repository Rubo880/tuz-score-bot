import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  const result = {
    ok: true,
    telegramTokenPresent: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    databaseUrlPresent: Boolean(process.env.DATABASE_URL),
    telegram: null,
    database: null
  };

  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing");
    const r = await fetch("https://api.telegram.org/bot" + process.env.TELEGRAM_BOT_TOKEN + "/getMe");
    const j = await r.json();
    result.telegram = j.ok
      ? { ok: true, username: j.result?.username || null }
      : { ok: false, error: j.description || "Telegram API error" };
  } catch (e) {
    result.telegram = { ok: false, error: String(e.message || e) };
  }

  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql("SELECT 1 AS ok");
    result.database = { ok: Number(rows?.[0]?.ok) === 1 };
  } catch (e) {
    result.database = { ok: false, error: String(e.message || e).slice(0, 300) };
  }

  result.ok = Boolean(result.telegram?.ok && result.database?.ok);
  return res.status(result.ok ? 200 : 500).json(result);
}
