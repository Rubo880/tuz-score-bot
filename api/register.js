import { tg, WEBHOOK_SECRET } from "../lib/telegram.js";

function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? "https://" + host : "";
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const base = baseUrl(req);
    if (!base) return res.status(400).json({ ok: false, error: "host_missing" });

    const webhookUrl = base + "/api/telegram";
    const requestUrl = new URL(req.url || "/api/register", base);
    const dropPending = requestUrl.searchParams.get("drop") === "1";

    await tg("setWebhook", {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: dropPending
    });

    await tg("setMyCommands", {
      commands: [
        { command: "setup", description: "Создать и закрепить лидерборд" },
        { command: "leaderboard", description: "Показать текущий топ" },
        { command: "me", description: "Показать мой счёт" },
        { command: "rules", description: "Правила и античит" },
        { command: "undo", description: "Владелец: отменить очки за сообщение" },
        { command: "web", description: "Открыть веб-лидерборд" }
      ]
    });

    const info = await tg("getWebhookInfo");

    return res.status(200).json({
      ok: true,
      webhook: info.url,
      pending_update_count: info.pending_update_count,
      dropped_pending_updates: dropPending,
      last_error_message: info.last_error_message || null,
      last_error_date: info.last_error_date || null
    });
  } catch (error) {
    console.error("register webhook error", error);
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
}
