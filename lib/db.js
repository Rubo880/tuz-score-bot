import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);
let schemaPromise;

export function countTuz(text = "") {
  return (String(text).match(/(?:туз|tuz)/giu) || []).length;
}

export function displayName(user = {}) {
  if (user.username) return "@" + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "User " + user.id;
}

export async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql("CREATE TABLE IF NOT EXISTS groups (chat_id BIGINT PRIMARY KEY, title TEXT, leaderboard_message_id BIGINT, board_key TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await sql("CREATE TABLE IF NOT EXISTS users (chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, username TEXT, first_name TEXT, last_name TEXT, score INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (chat_id, user_id))");
      await sql("CREATE TABLE IF NOT EXISTS messages (chat_id BIGINT NOT NULL, message_id BIGINT NOT NULL, user_id BIGINT NOT NULL, mention_count INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (chat_id, message_id))");
      await sql("CREATE INDEX IF NOT EXISTS users_chat_score_idx ON users(chat_id, score DESC)");
      await sql(`
        CREATE OR REPLACE FUNCTION process_tuz_message(
          p_chat_id BIGINT,
          p_message_id BIGINT,
          p_user_id BIGINT,
          p_username TEXT,
          p_first_name TEXT,
          p_last_name TEXT,
          p_new_count INTEGER
        )
        RETURNS INTEGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          old_count INTEGER := 0;
          delta INTEGER := 0;
        BEGIN
          PERFORM pg_advisory_xact_lock(
            hashtextextended(p_chat_id::text || ':' || p_message_id::text, 0)
          );

          INSERT INTO users(chat_id,user_id,username,first_name,last_name,score,updated_at)
          VALUES(p_chat_id,p_user_id,p_username,p_first_name,p_last_name,0,NOW())
          ON CONFLICT(chat_id,user_id)
          DO UPDATE SET
            username=EXCLUDED.username,
            first_name=EXCLUDED.first_name,
            last_name=EXCLUDED.last_name,
            updated_at=NOW();

          SELECT mention_count
          INTO old_count
          FROM messages
          WHERE chat_id=p_chat_id AND message_id=p_message_id;

          IF NOT FOUND THEN
            old_count := 0;
          END IF;

          delta := p_new_count - old_count;

          IF delta <> 0 THEN
            UPDATE users
            SET score=GREATEST(score + delta, 0), updated_at=NOW()
            WHERE chat_id=p_chat_id AND user_id=p_user_id;
          END IF;

          INSERT INTO messages(chat_id,message_id,user_id,mention_count,updated_at)
          VALUES(p_chat_id,p_message_id,p_user_id,p_new_count,NOW())
          ON CONFLICT(chat_id,message_id)
          DO UPDATE SET
            user_id=EXCLUDED.user_id,
            mention_count=EXCLUDED.mention_count,
            updated_at=NOW();

          RETURN delta;
        END;
        $$
      `);
    })();
  }
  return schemaPromise;
}

export async function ensureGroup(chat) {
  await ensureSchema();
  const key = crypto.randomBytes(18).toString("hex");
  const rows = await sql(
    "INSERT INTO groups(chat_id,title,board_key,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title, updated_at=NOW() RETURNING chat_id,title,leaderboard_message_id,board_key",
    [chat.id, chat.title || chat.username || String(chat.id), key]
  );
  return rows[0];
}

export async function processMessage(msg) {
  await ensureSchema();
  if (!msg?.chat || !msg?.from || msg.from.is_bot) return 0;
  if (!["group", "supergroup"].includes(msg.chat.type)) return 0;

  await ensureGroup(msg.chat);
  const text = msg.text ?? msg.caption ?? "";
  const newCount = countTuz(text);

  const rows = await sql(
    "SELECT process_tuz_message($1,$2,$3,$4,$5,$6,$7) AS delta",
    [
      msg.chat.id,
      msg.message_id,
      msg.from.id,
      msg.from.username || null,
      msg.from.first_name || null,
      msg.from.last_name || null,
      newCount
    ]
  );
  return Number(rows[0]?.delta || 0);
}

export async function setLeaderboardMessage(chatId, messageId) {
  await ensureSchema();
  await sql(
    "UPDATE groups SET leaderboard_message_id=$1, updated_at=NOW() WHERE chat_id=$2",
    [messageId, chatId]
  );
}

export async function getGroup(chatId) {
  await ensureSchema();
  const rows = await sql(
    "SELECT chat_id,title,leaderboard_message_id,board_key FROM groups WHERE chat_id=$1 LIMIT 1",
    [chatId]
  );
  return rows[0] || null;
}

export async function getGroupByKey(key) {
  await ensureSchema();
  const rows = await sql(
    "SELECT chat_id,title,board_key FROM groups WHERE board_key=$1 LIMIT 1",
    [key]
  );
  return rows[0] || null;
}

export async function getLeaders(chatId, limit = 50) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  return sql(
    "SELECT user_id,username,first_name,last_name,score FROM users WHERE chat_id=$1 AND score>0 ORDER BY score DESC, updated_at ASC, user_id ASC LIMIT $2",
    [chatId, safeLimit]
  );
}

export async function getTotal(chatId) {
  await ensureSchema();
  const rows = await sql(
    "SELECT COALESCE(SUM(score),0)::int AS total FROM users WHERE chat_id=$1",
    [chatId]
  );
  return Number(rows[0]?.total || 0);
}

export async function getUserScore(chatId, userId) {
  await ensureSchema();
  const rows = await sql(
    "SELECT score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
    [chatId, userId]
  );
  return Number(rows[0]?.score || 0);
}
