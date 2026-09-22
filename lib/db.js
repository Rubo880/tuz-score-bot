import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);
let schemaPromise;
let gameSchemaPromise;

export const MAX_TUZ_PER_MESSAGE = 3;
export const MAX_TUZ_PER_MINUTE = 2;

export function countTuz(text = "") {
  return (String(text).match(/(?:туз|tuz)/giu) || []).length;
}

export function displayName(user = {}) {
  if (user.username) return "@" + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "User " + user.id;
}

export async function ensureSchema() {
  // Production schema is managed as a database migration.
  // Do not run CREATE/ALTER statements from Telegram webhook requests:
  // concurrent Vercel cold starts can race on DDL and return HTTP 500.
  return true;
}

async function ensureGameSchema() {
  return ensureSchema();
}

export async function ensureGroup(chat) {
  await ensureSchema();
  const key = crypto.randomBytes(18).toString("hex");
  const rows = await sql.query(
    "INSERT INTO groups(chat_id,title,board_key,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title, updated_at=NOW() RETURNING chat_id,title,leaderboard_message_id,board_key",
    [chat.id, chat.title || chat.username || String(chat.id), key]
  );
  return rows[0];
}

export async function processMessage(msg) {
  await ensureGameSchema();
  if (!msg?.chat || !msg?.from || msg.from.is_bot) return 0;
  if (!["group", "supergroup"].includes(msg.chat.type)) return 0;

  await ensureGroup(msg.chat);
  const text = msg.text ?? msg.caption ?? "";
  const rawCount = countTuz(text);

  const rows = await sql.query(
    "SELECT process_tuz_message($1,$2,$3,$4,$5,$6,$7) AS delta",
    [
      msg.chat.id,
      msg.message_id,
      msg.from.id,
      msg.from.username || null,
      msg.from.first_name || null,
      msg.from.last_name || null,
      rawCount
    ]
  );

  if (msg.date) {
    await sql.query(
      "UPDATE messages SET message_date=to_timestamp($3) WHERE chat_id=$1 AND message_id=$2",
      [msg.chat.id, msg.message_id, Number(msg.date)]
    );
  }

  return Number(rows[0]?.delta || 0);
}

export async function invalidateMessage(chatId, messageId) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT invalidate_tuz_message($1,$2) AS removed",
    [chatId, messageId]
  );
  return Number(rows[0]?.removed || 0);
}

export async function setLeaderboardMessage(chatId, messageId) {
  await ensureSchema();
  await sql.query(
    "UPDATE groups SET leaderboard_message_id=$1, updated_at=NOW() WHERE chat_id=$2",
    [messageId, chatId]
  );
}

export async function getGroup(chatId) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT chat_id,title,leaderboard_message_id,board_key FROM groups WHERE chat_id=$1 LIMIT 1",
    [chatId]
  );
  return rows[0] || null;
}

export async function getGroupByKey(key) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT chat_id,title,board_key FROM groups WHERE board_key=$1 LIMIT 1",
    [key]
  );
  return rows[0] || null;
}

export async function getLeaders(chatId, limit = 50) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  return sql.query(
    "SELECT user_id,username,first_name,last_name,score FROM users WHERE chat_id=$1 AND score<>0 ORDER BY score DESC, updated_at ASC, user_id ASC LIMIT $2",
    [chatId, safeLimit]
  );
}

export async function getNegativeLeaders(chatId, limit = 25) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  return sql.query(
    "SELECT user_id,username,first_name,last_name,score FROM users WHERE chat_id=$1 AND score<0 ORDER BY score DESC, updated_at ASC, user_id ASC LIMIT $2",
    [chatId, safeLimit]
  );
}

export async function getTotal(chatId) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT COALESCE(SUM(score),0)::int AS total FROM users WHERE chat_id=$1",
    [chatId]
  );
  return Number(rows[0]?.total || 0);
}


export async function getRandomRollTarget(chatId, invoker = {}) {
  await ensureGameSchema();

  if (invoker?.id) {
    await sql.query(
      "INSERT INTO users(chat_id,user_id,username,first_name,last_name,score,updated_at) VALUES($1,$2,$3,$4,$5,0,NOW()) ON CONFLICT(chat_id,user_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name",
      [
        chatId,
        invoker.id,
        invoker.username || null,
        invoker.first_name || null,
        invoker.last_name || null
      ]
    );
  }

  const rows = await sql.query(
    "SELECT user_id,username,first_name,last_name,score FROM users WHERE chat_id=$1 ORDER BY RANDOM() LIMIT 1",
    [chatId]
  );

  return rows[0] || null;
}

export async function applyGroupTuzRoll(chatId, targetUserId, kind, rolledValue, requestedDelta) {
  await ensureGameSchema();
  const rows = await sql.query(
    "SELECT * FROM apply_group_tuz_roll($1,$2,$3,$4,$5)",
    [chatId, targetUserId, kind, rolledValue, requestedDelta]
  );
  return rows[0] || null;
}

export async function getUserById(chatId, userId) {
  await ensureGameSchema();
  const rows = await sql.query(
    "SELECT user_id,username,first_name,last_name,score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
    [chatId, userId]
  );
  return rows[0] || null;
}


export async function applyGrow(chatId, user = {}, baseDelta) {
  await ensureGameSchema();
  const rows = await sql.query(
    "SELECT * FROM apply_grow($1,$2,$3,$4,$5,$6)",
    [
      chatId,
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null,
      baseDelta
    ]
  );
  return rows[0] || null;
}

export async function createPvpChallenge(chatId, user = {}, wager) {
  await ensureGameSchema();

  const amount = Number(wager);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }

  await sql.query(
    "INSERT INTO users(chat_id,user_id,username,first_name,last_name,score,updated_at) VALUES($1,$2,$3,$4,$5,0,NOW()) ON CONFLICT(chat_id,user_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, updated_at=NOW()",
    [
      chatId,
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    ]
  );

  const scoreRows = await sql.query(
    "SELECT score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
    [chatId, user.id]
  );
  const score = Number(scoreRows[0]?.score || 0);

  if (score < amount) {
    return { ok: false, reason: "insufficient_funds", score };
  }

  await sql.query(
    "UPDATE pvp_challenges SET status='cancelled', settled_at=NOW() WHERE chat_id=$1 AND creator_id=$2 AND status='open'",
    [chatId, user.id]
  );

  const challengeId = crypto.randomBytes(8).toString("hex");
  await sql.query(
    "INSERT INTO pvp_challenges(challenge_id,chat_id,creator_id,wager,status,created_at) VALUES($1,$2,$3,$4,'open',NOW())",
    [challengeId, chatId, user.id, amount]
  );

  return { ok: true, challenge_id: challengeId, wager: amount, score };
}

export async function settlePvpChallenge(chatId, challengeId, acceptor = {}) {
  await ensureGameSchema();

  await sql.query(
    "INSERT INTO users(chat_id,user_id,username,first_name,last_name,score,updated_at) VALUES($1,$2,$3,$4,$5,0,NOW()) ON CONFLICT(chat_id,user_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, updated_at=NOW()",
    [
      chatId,
      acceptor.id,
      acceptor.username || null,
      acceptor.first_name || null,
      acceptor.last_name || null
    ]
  );

  const rows = await sql.query(
    "SELECT * FROM settle_pvp($1,$2,$3)",
    [challengeId, chatId, acceptor.id]
  );
  return rows[0] || null;
}

export async function getPreviousMoscowDay() {
  await ensureGameSchema();
  const rows = await sql.query(
    "SELECT ((NOW() AT TIME ZONE 'Europe/Moscow')::date - 1)::text AS day"
  );
  return rows[0]?.day || null;
}

export async function listActiveGroups() {
  await ensureGameSchema();
  return sql.query(
    "SELECT chat_id,title,leaderboard_message_id,board_key FROM groups WHERE leaderboard_message_id IS NOT NULL ORDER BY chat_id"
  );
}

export async function getDailyWinner(chatId, day) {
  await ensureGameSchema();
  const rows = await sql.query(
    `SELECT
       m.user_id,
       u.username,
       u.first_name,
       u.last_name,
       COALESCE(SUM(m.mention_count),0)::int AS mention_count
     FROM messages m
     JOIN users u ON u.chat_id=m.chat_id AND u.user_id=m.user_id
     WHERE m.chat_id=$1
       AND m.message_date IS NOT NULL
       AND (m.message_date AT TIME ZONE 'Europe/Moscow')::date=$2::date
       AND m.mention_count>0
     GROUP BY m.user_id,u.username,u.first_name,u.last_name,u.score
     ORDER BY mention_count DESC,u.score DESC,m.user_id ASC
     LIMIT 1`,
    [chatId, day]
  );
  return rows[0] || null;
}

export async function claimDailyWinner(chatId, day, winner) {
  await ensureGameSchema();
  const rows = await sql.query(
    `INSERT INTO daily_winners(chat_id,day_date,user_id,mention_count,created_at)
     VALUES($1,$2::date,$3,$4,NOW())
     ON CONFLICT(chat_id,day_date) DO NOTHING
     RETURNING chat_id`,
    [chatId, day, winner?.user_id || null, Number(winner?.mention_count || 0)]
  );
  return rows.length > 0;
}

export async function getUserScore(chatId, userId) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
    [chatId, userId]
  );
  return Number(rows[0]?.score || 0);
}
