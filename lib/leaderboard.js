import { displayName, getLeaders, getTotal } from "./db.js";
import { escapeHtml } from "./telegram.js";

export async function leaderboardText(chatId) {
  const [rows, total] = await Promise.all([
    getLeaders(chatId, 25),
    getTotal(chatId)
  ]);

  const medals = ["🥇", "🥈", "🥉"];
  const body = rows.length
    ? rows.map((row, index) => {
        const prefix = medals[index] || String(index + 1) + ".";
        return prefix + " <b>" + escapeHtml(displayName(row)) + "</b> — " + row.score;
      }).join("\n")
    : "Пока ни одного упоминания.";

  const rankTitles = rows.length
    ? [
        "👑 <b>Козырной туз рейтинга:</b> " +
          escapeHtml(displayName(rows[0])) +
          " — <b>" +
          rows[0].score +
          "</b>",
        rows.length > 1
          ? "💀 <b>Опущенный туз рейтинга:</b> " +
            escapeHtml(displayName(rows[rows.length - 1])) +
            " — <b>" +
            rows[rows.length - 1].score +
            "</b>"
          : null
      ].filter(Boolean).join("\n")
    : "";

  return [
    "🏆 <b>TUZ LEADERBOARD</b>",
    "",
    body,
    rankTitles ? "" : null,
    rankTitles || null,
    "",
    "Суммарный счёт: <b>" + total + "</b>",
    "",
    "Каждое вхождение <code>туз</code> или <code>tuz</code> = +1.",
    "🛡 Античит: 4+ в одном сообщении = 0; максимум +5 очков за 60 сек."
  ].filter((line) => line !== null).join("\n");
}
