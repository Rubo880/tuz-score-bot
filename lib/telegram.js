import crypto from "crypto";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export const WEBHOOK_SECRET = crypto
  .createHash("sha256")
  .update(BOT_TOKEN)
  .digest("hex")
  .slice(0, 32);

export async function tg(method, body = {}) {
  const response = await fetch(
    "https://api.telegram.org/bot" + BOT_TOKEN + "/" + method,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();
  if (!data.ok) {
    throw new Error(method + ": " + (data.description || "Telegram API error"));
  }
  return data.result;
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
