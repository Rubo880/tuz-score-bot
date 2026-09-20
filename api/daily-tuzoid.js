import {
  claimDailyWinner,
  displayName,
  getDailyWinner,
  getPreviousMoscowDay,
  listActiveGroups
} from "../lib/db.js";
import { escapeHtml, tg } from "../lib/telegram.js";

function formatDay(day) {
  const [y, m, d] = String(day || "").split("-");
  if (!y || !m || !d) return day || "";
  return d + "." + m + "." + y;
}

function isAuthorizedCron(req) {
  const auth = req.headers.authorization || "";
  if (process.env.CRON_SECRET) {
    return auth === "Bearer " + process.env.CRON_SECRET;
  }
  return String(req.headers["user-agent"] || "").includes("vercel-cron/1.0");
}

async function send(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false });
  }

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ ok: false });
  }

  try {
    const day = await getPreviousMoscowDay();
    const groups = await listActiveGroups();
    let sent = 0;

    for (const group of groups) {
      try {
        const winner = await getDailyWinner(group.chat_id, day);
        const claimed = await claimDailyWinner(group.chat_id, day, winner);
        if (!claimed) continue;

        if (winner) {
          await send(
            group.chat_id,
            "🏆 <b>ТУЗОИД ДНЯ</b>\n\n" +
              "За <b>" + formatDay(day) + "</b>:\n" +
              "<b>" + escapeHtml(displayName(winner)) + "</b> — " +
              "<b>" + Number(winner.mention_count || 0) + "</b> засчитанных упоминаний."
          );
        } else {
          await send(
            group.chat_id,
            "🏆 <b>ТУЗОИД ДНЯ</b>\n\n" +
              "За <b>" + formatDay(day) + "</b> тузоид не выявлен — " +
              "ни одного засчитанного упоминания."
          );
        }
        sent += 1;
      } catch (error) {
        console.error("daily tuzoid group error", group.chat_id, error);
      }
    }

    return res.status(200).json({ ok: true, day, groups: groups.length, sent });
  } catch (error) {
    console.error("daily tuzoid cron error", error);
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
}
