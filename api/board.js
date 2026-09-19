import { displayName, getGroupByKey, getLeaders, getTotal } from "../lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const key = String(req.query.key || "");
    const group = await getGroupByKey(key);
    if (!group) return res.status(404).json({ error: "not_found" });

    const [leaders, total] = await Promise.all([
      getLeaders(group.chat_id, 100),
      getTotal(group.chat_id)
    ]);

    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      title: group.title || "TUZ Leaderboard",
      total,
      updatedAt: new Date().toISOString(),
      leaders: leaders.map((row, index) => ({
        rank: index + 1,
        name: displayName(row),
        score: row.score
      }))
    });
  } catch (error) {
    console.error("board api error", error);
    return res.status(500).json({ error: "server_error" });
  }
}
