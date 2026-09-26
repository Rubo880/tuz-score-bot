import { displayName, getLeaders, getNegativeLeaders, getTotal } from "./db.js";
import { escapeHtml } from "./telegram.js";

export async function leaderboardText(chatId) {
  const [topRows, negativeRows, total] = await Promise.all([
    getLeaders(chatId, 25),
    getNegativeLeaders(chatId, 25),
    getTotal(chatId)
  ]);

  // Keep the regular top, but always append negative-score players so they
  // cannot disappear below the display limit. Then re-sort by score.
  const byUser = new Map();
  for (const row of [...topRows, ...negativeRows]) {
    byUser.set(String(row.user_id), row);
  }
  const rows = [...byUser.values()].sort((a, b) => {
    const scoreDiff = Number(b.score) - Number(a.score);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(a.user_id) - Number(b.user_id);
  });

  const medals = ["🥇", "🥈", "🥉"];
  const body = rows.length
    ? rows.map((row, index) => {
        const prefix = medals[index] || String(index + 1) + ".";
        const vault = Math.max(0, Math.min(100, Number(row.vault_percent || 0)));
        const vaultPoints = Math.max(0, Number(row.vault_points || 0));
        const shield = row.vault_shielded === true || String(row.vault_shielded) === "true";
        const raidable = vaultPoints > 0 && !shield;
        return (
          prefix +
          " <b>" +
          escapeHtml(displayName(row)) +
          "</b> — " +
          row.score +
          "   <code>[🧪" +
          vault +
          "%]</code>" +
          (shield ? " 🛡" : "") +
          (raidable ? " 🏴‍☠️" : "")
        );
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
    "🧪 Хранилище: максимум 50; полностью заполняется за 6 часов. Процент справа показывает заполненность.",
    "🛡 Щит рядом с процентом = хранилище временно защищено от налётов.",
    "🏴‍☠️ = в хранилище есть добыча и сейчас нет щита: цель открыта для налёта.",
    "🛡 Античит: 4+ в одном сообщении = 0; максимум +2 очка за 60 сек."
  ].filter((line) => line !== null).join("\n");
}
