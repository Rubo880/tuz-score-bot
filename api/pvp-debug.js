import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false });
  if (String(req.query.key || "") !== "pvpdiag-9256f1c2") {
    return res.status(403).json({ ok: false });
  }

  try {
    const challenges = await sql.query(
      `SELECT challenge_id,chat_id,creator_id,wager,status,created_at,settled_at,
              acceptor_id,winner_id,loser_id
       FROM pvp_challenges
       WHERE chat_id=$1
       ORDER BY created_at DESC
       LIMIT 20`,
      [-1001513158539]
    );

    const fn = await sql.query(
      `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE p.proname='settle_pvp_with_stats'
       ORDER BY p.oid DESC
       LIMIT 1`
    );

    return res.status(200).json({
      ok: true,
      challenges,
      function_definition: fn[0]?.definition || null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
}
