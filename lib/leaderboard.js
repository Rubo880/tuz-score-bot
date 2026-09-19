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

  return [
    "🏆 <b>TUZ LEADERBOARD</b>",
    "",
    body,
    "",
    "Всего упоминаний: <b>" + total + "</b>",
    "",
    "Каждое вхождение <code>туз</code> или <code>tuz</code> = +1."
  ].join("\n");
}
