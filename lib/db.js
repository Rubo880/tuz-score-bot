import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);
let schemaPromise;
let gameSchemaPromise;

export const MAX_TUZ_PER_MESSAGE = 3;
export const MAX_TUZ_PER_MINUTE = 5;

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
      await sql.query("CREATE TABLE IF NOT EXISTS groups (chat_id BIGINT PRIMARY KEY, title TEXT, leaderboard_message_id BIGINT, board_key TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await sql.query("CREATE TABLE IF NOT EXISTS users (chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, username TEXT, first_name TEXT, last_name TEXT, score INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (chat_id, user_id))");
      await sql.query("CREATE TABLE IF NOT EXISTS messages (chat_id BIGINT NOT NULL, message_id BIGINT NOT NULL, user_id BIGINT NOT NULL, mention_count INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (chat_id, message_id))");
      await sql.query("CREATE TABLE IF NOT EXISTS score_events (id BIGSERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, message_id BIGINT NOT NULL, delta INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await sql.query("CREATE INDEX IF NOT EXISTS users_chat_score_idx ON users(chat_id, score DESC)");
      await sql.query("CREATE INDEX IF NOT EXISTS score_events_user_time_idx ON score_events(chat_id, user_id, created_at DESC)");
      await sql.query(`
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
          desired_count INTEGER := 0;
          delta INTEGER := 0;
          recent_points INTEGER := 0;
          allowed_points INTEGER := 0;
        BEGIN
          -- Serialize scoring per user and per message so burst spam cannot race the limiter.
          PERFORM pg_advisory_xact_lock(
            hashtextextended('user:' || p_chat_id::text || ':' || p_user_id::text, 0)
          );
          PERFORM pg_advisory_xact_lock(
            hashtextextended('message:' || p_chat_id::text || ':' || p_message_id::text, 0)
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

          -- Anti-cheat #1: 4+ TUZ roots in one message invalidate that message entirely.
          IF p_new_count > 3 THEN
            desired_count := 0;
          ELSE
            desired_count := GREATEST(p_new_count, 0);
          END IF;

          delta := desired_count - old_count;

          -- Anti-cheat #2: at most 5 newly-awarded points per user per rolling 60 seconds.
          IF delta > 0 THEN
            SELECT COALESCE(SUM(se.delta), 0)::int
            INTO recent_points
            FROM score_events se
            WHERE se.chat_id=p_chat_id
              AND se.user_id=p_user_id
              AND se.delta > 0
              AND se.created_at > NOW() - INTERVAL '60 seconds';

            allowed_points := GREATEST(5 - recent_points, 0);
            delta := LEAST(delta, allowed_points);
            desired_count := old_count + delta;
          END IF;

          IF delta <> 0 THEN
            UPDATE users
            SET score=score + delta, updated_at=NOW()
            WHERE chat_id=p_chat_id AND user_id=p_user_id;
          END IF;

          IF delta > 0 THEN
            INSERT INTO score_events(chat_id,user_id,message_id,delta,created_at)
            VALUES(p_chat_id,p_user_id,p_message_id,delta,NOW());
          END IF;

          INSERT INTO messages(chat_id,message_id,user_id,mention_count,updated_at)
          VALUES(p_chat_id,p_message_id,p_user_id,desired_count,NOW())
          ON CONFLICT(chat_id,message_id)
          DO UPDATE SET
            user_id=EXCLUDED.user_id,
            mention_count=EXCLUDED.mention_count,
            updated_at=NOW();

          RETURN delta;
        END;
        $$
      `);

      await sql.query(`
        CREATE OR REPLACE FUNCTION invalidate_tuz_message(
          p_chat_id BIGINT,
          p_message_id BIGINT
        )
        RETURNS INTEGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          target_user_id BIGINT;
          old_count INTEGER := 0;
        BEGIN
          SELECT user_id
          INTO target_user_id
          FROM messages
          WHERE chat_id=p_chat_id AND message_id=p_message_id;

          IF NOT FOUND THEN
            RETURN 0;
          END IF;

          PERFORM pg_advisory_xact_lock(
            hashtextextended('user:' || p_chat_id::text || ':' || target_user_id::text, 0)
          );
          PERFORM pg_advisory_xact_lock(
            hashtextextended('message:' || p_chat_id::text || ':' || p_message_id::text, 0)
          );

          SELECT mention_count
          INTO old_count
          FROM messages
          WHERE chat_id=p_chat_id AND message_id=p_message_id;

          IF old_count > 0 THEN
            UPDATE users
            SET score=score - old_count, updated_at=NOW()
            WHERE chat_id=p_chat_id AND user_id=target_user_id;

            UPDATE messages
            SET mention_count=0, updated_at=NOW()
            WHERE chat_id=p_chat_id AND message_id=p_message_id;
          END IF;

          RETURN old_count;
        END;
        $$
      `);
    })();
  }
  return schemaPromise;
}


async function ensureGameSchema() {
  if (!gameSchemaPromise) {
    gameSchemaPromise = (async () => {
      await ensureSchema();

      await sql.query(
        "ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_date TIMESTAMPTZ"
      );
      await sql.query(
        "UPDATE messages SET message_date=updated_at WHERE message_date IS NULL AND updated_at >= (((NOW() AT TIME ZONE 'Europe/Moscow')::date)::timestamp AT TIME ZONE 'Europe/Moscow')"
      );

      await sql.query(
        "CREATE TABLE IF NOT EXISTS roll_events (id BIGSERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, kind TEXT NOT NULL, rolled_value INTEGER NOT NULL, applied_delta INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      );
      await sql.query(
        "CREATE INDEX IF NOT EXISTS roll_events_user_time_idx ON roll_events(chat_id,user_id,created_at DESC)"
      );
      await sql.query(
        "CREATE TABLE IF NOT EXISTS daily_winners (chat_id BIGINT NOT NULL, day_date DATE NOT NULL, user_id BIGINT, mention_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(chat_id,day_date))"
      );
      await sql.query(
        "CREATE TABLE IF NOT EXISTS group_tuz_rolls (chat_id BIGINT PRIMARY KEY, last_rolled_at TIMESTAMPTZ NOT NULL, kind TEXT NOT NULL, rolled_value INTEGER NOT NULL, applied_delta INTEGER NOT NULL, target_user_id BIGINT NOT NULL)"
      );


      await sql.query(
        "CREATE TABLE IF NOT EXISTS grow_state (chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, last_grow_date DATE NOT NULL, streak INTEGER NOT NULL DEFAULT 0, total_grows INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id,user_id))"
      );
      await sql.query(
        "CREATE TABLE IF NOT EXISTS grow_events (id BIGSERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, user_id BIGINT NOT NULL, base_delta INTEGER NOT NULL, streak INTEGER NOT NULL, bonus INTEGER NOT NULL, applied_delta INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
      );
      await sql.query(
        "CREATE INDEX IF NOT EXISTS grow_events_user_time_idx ON grow_events(chat_id,user_id,created_at DESC)"
      );
      await sql.query(
        "CREATE TABLE IF NOT EXISTS pvp_challenges (challenge_id TEXT PRIMARY KEY, chat_id BIGINT NOT NULL, creator_id BIGINT NOT NULL, wager INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', accepted_by BIGINT, winner_id BIGINT, loser_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ)"
      );
      await sql.query(
        "CREATE INDEX IF NOT EXISTS pvp_challenges_chat_status_idx ON pvp_challenges(chat_id,status,created_at DESC)"
      );

      await sql.query(`
        CREATE OR REPLACE FUNCTION apply_grow(
          p_chat_id BIGINT,
          p_user_id BIGINT,
          p_username TEXT,
          p_first_name TEXT,
          p_last_name TEXT,
          p_base_delta INTEGER
        )
        RETURNS TABLE(
          was_applied BOOLEAN,
          result_base_delta INTEGER,
          result_streak INTEGER,
          result_bonus INTEGER,
          result_delta INTEGER,
          new_score INTEGER,
          seconds_remaining INTEGER
        )
        LANGUAGE plpgsql
        AS $grow$
        DECLARE
          v_today DATE := (NOW() AT TIME ZONE 'Europe/Moscow')::date;
          v_last_date DATE;
          v_streak INTEGER := 0;
          v_bonus INTEGER := 0;
          v_delta INTEGER := 0;
          v_new_score INTEGER := 0;
          v_remaining INTEGER := 0;
        BEGIN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('grow:' || p_chat_id::text || ':' || p_user_id::text, 0)
          );

          INSERT INTO users(chat_id,user_id,username,first_name,last_name,score,updated_at)
          VALUES(p_chat_id,p_user_id,p_username,p_first_name,p_last_name,0,NOW())
          ON CONFLICT(chat_id,user_id)
          DO UPDATE SET
            username=EXCLUDED.username,
            first_name=EXCLUDED.first_name,
            last_name=EXCLUDED.last_name,
            updated_at=NOW();

          SELECT gs.last_grow_date, gs.streak
          INTO v_last_date, v_streak
          FROM grow_state gs
          WHERE gs.chat_id=p_chat_id AND gs.user_id=p_user_id
          FOR UPDATE;

          IF FOUND AND v_last_date = v_today THEN
            SELECT u.score
            INTO v_new_score
            FROM users u
            WHERE u.chat_id=p_chat_id AND u.user_id=p_user_id;

            v_remaining := GREATEST(
              CEIL(
                EXTRACT(
                  EPOCH FROM (
                    (((v_today + 1)::timestamp) AT TIME ZONE 'Europe/Moscow') - NOW()
                  )
                )
              )::int,
              0
            );

            RETURN QUERY SELECT
              FALSE, 0, v_streak, 0, 0, COALESCE(v_new_score,0), v_remaining;
            RETURN;
          END IF;

          IF v_last_date = v_today - 1 THEN
            v_streak := v_streak + 1;
          ELSE
            v_streak := 1;
          END IF;

          v_bonus :=
            (CASE WHEN v_streak >= 2 THEN 1 ELSE 0 END) +
            (CASE WHEN v_streak >= 4 THEN 1 ELSE 0 END) +
            (CASE WHEN v_streak >= 8 THEN 1 ELSE 0 END) +
            (CASE WHEN v_streak >= 16 THEN 1 ELSE 0 END) +
            (CASE WHEN v_streak >= 32 THEN 1 ELSE 0 END);

          v_delta := p_base_delta + v_bonus;

          UPDATE users
          SET score=score + v_delta, updated_at=NOW()
          WHERE chat_id=p_chat_id AND user_id=p_user_id
          RETURNING score INTO v_new_score;

          INSERT INTO grow_state(chat_id,user_id,last_grow_date,streak,total_grows)
          VALUES(p_chat_id,p_user_id,v_today,v_streak,1)
          ON CONFLICT(chat_id,user_id)
          DO UPDATE SET
            last_grow_date=EXCLUDED.last_grow_date,
            streak=EXCLUDED.streak,
            total_grows=grow_state.total_grows + 1;

          INSERT INTO grow_events(
            chat_id,user_id,base_delta,streak,bonus,applied_delta,created_at
          )
          VALUES(
            p_chat_id,p_user_id,p_base_delta,v_streak,v_bonus,v_delta,NOW()
          );

          RETURN QUERY SELECT
            TRUE, p_base_delta, v_streak, v_bonus, v_delta, v_new_score, 0;
        END;
        $
      `);

      await sql.query(`
        CREATE OR REPLACE FUNCTION settle_pvp(
          p_challenge_id TEXT,
          p_chat_id BIGINT,
          p_acceptor_id BIGINT
        )
        RETURNS TABLE(
          result_status TEXT,
          result_wager INTEGER,
          result_creator_id BIGINT,
          result_acceptor_id BIGINT,
          result_winner_id BIGINT,
          result_loser_id BIGINT,
          winner_score INTEGER,
          loser_score INTEGER
        )
        LANGUAGE plpgsql
        AS $pvp$
        DECLARE
          v_ch pvp_challenges%ROWTYPE;
          v_creator_score INTEGER := 0;
          v_acceptor_score INTEGER := 0;
          v_winner BIGINT;
          v_loser BIGINT;
          v_winner_score INTEGER := 0;
          v_loser_score INTEGER := 0;
        BEGIN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('pvp:' || p_challenge_id, 0)
          );

          SELECT pc.*
          INTO v_ch
          FROM pvp_challenges pc
          WHERE pc.challenge_id=p_challenge_id
            AND pc.chat_id=p_chat_id
          FOR UPDATE;

          IF NOT FOUND THEN
            RETURN QUERY SELECT 'missing',0,NULL::BIGINT,p_acceptor_id,NULL::BIGINT,NULL::BIGINT,0,0;
            RETURN;
          END IF;

          IF v_ch.status <> 'open' THEN
            RETURN QUERY SELECT
              'closed',
              v_ch.wager,
              v_ch.creator_id,
              COALESCE(v_ch.accepted_by,p_acceptor_id),
              v_ch.winner_id,
              v_ch.loser_id,
              0,
              0;
            RETURN;
          END IF;

          IF v_ch.creator_id = p_acceptor_id THEN
            RETURN QUERY SELECT
              'self',v_ch.wager,v_ch.creator_id,p_acceptor_id,NULL::BIGINT,NULL::BIGINT,0,0;
            RETURN;
          END IF;

          IF v_ch.created_at < NOW() - INTERVAL '24 hours' THEN
            UPDATE pvp_challenges
            SET status='expired', settled_at=NOW()
            WHERE challenge_id=p_challenge_id;

            RETURN QUERY SELECT
              'expired',v_ch.wager,v_ch.creator_id,p_acceptor_id,NULL::BIGINT,NULL::BIGINT,0,0;
            RETURN;
          END IF;

          PERFORM 1
          FROM users u
          WHERE u.chat_id=p_chat_id
            AND u.user_id IN (v_ch.creator_id,p_acceptor_id)
          ORDER BY u.user_id
          FOR UPDATE;

          SELECT COALESCE(u.score,0)
          INTO v_creator_score
          FROM users u
          WHERE u.chat_id=p_chat_id AND u.user_id=v_ch.creator_id;

          SELECT COALESCE(u.score,0)
          INTO v_acceptor_score
          FROM users u
          WHERE u.chat_id=p_chat_id AND u.user_id=p_acceptor_id;

          IF v_creator_score < v_ch.wager THEN
            UPDATE pvp_challenges
            SET status='cancelled', settled_at=NOW()
            WHERE challenge_id=p_challenge_id;

            RETURN QUERY SELECT
              'creator_funds',v_ch.wager,v_ch.creator_id,p_acceptor_id,NULL::BIGINT,NULL::BIGINT,v_creator_score,v_acceptor_score;
            RETURN;
          END IF;

          IF v_acceptor_score < v_ch.wager THEN
            RETURN QUERY SELECT
              'acceptor_funds',v_ch.wager,v_ch.creator_id,p_acceptor_id,NULL::BIGINT,NULL::BIGINT,v_creator_score,v_acceptor_score;
            RETURN;
          END IF;

          IF random() < 0.5 THEN
            v_winner := v_ch.creator_id;
            v_loser := p_acceptor_id;
          ELSE
            v_winner := p_acceptor_id;
            v_loser := v_ch.creator_id;
          END IF;

          UPDATE users
          SET score=score + v_ch.wager, updated_at=NOW()
          WHERE chat_id=p_chat_id AND user_id=v_winner
          RETURNING score INTO v_winner_score;

          UPDATE users
          SET score=score - v_ch.wager, updated_at=NOW()
          WHERE chat_id=p_chat_id AND user_id=v_loser
          RETURNING score INTO v_loser_score;

          UPDATE pvp_challenges
          SET
            status='settled',
            accepted_by=p_acceptor_id,
            winner_id=v_winner,
            loser_id=v_loser,
            settled_at=NOW()
          WHERE challenge_id=p_challenge_id;

          RETURN QUERY SELECT
            'settled',
            v_ch.wager,
            v_ch.creator_id,
            p_acceptor_id,
            v_winner,
            v_loser,
            v_winner_score,
            v_loser_score;
        END;
        $
      `);

      await sql.query(`
        CREATE OR REPLACE FUNCTION apply_group_tuz_roll(
          p_chat_id BIGINT,
          p_target_user_id BIGINT,
          p_kind TEXT,
          p_rolled_value INTEGER,
          p_requested_delta INTEGER
        )
        RETURNS TABLE(
          was_applied BOOLEAN,
          result_kind TEXT,
          result_value INTEGER,
          result_delta INTEGER,
          result_target_user_id BIGINT,
          new_score INTEGER,
          seconds_remaining INTEGER
        )
        LANGUAGE plpgsql
        AS $$
        DECLARE
          v_existing group_tuz_rolls%ROWTYPE;
          v_new_score INTEGER := 0;
          v_remaining INTEGER := 0;
        BEGIN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('group-roll:' || p_chat_id::text, 0)
          );

          SELECT *
          INTO v_existing
          FROM group_tuz_rolls
          WHERE chat_id=p_chat_id;

          IF FOUND AND v_existing.last_rolled_at > NOW() - INTERVAL '24 hours' THEN
            SELECT COALESCE(score, 0)
            INTO v_new_score
            FROM users
            WHERE chat_id=p_chat_id AND user_id=v_existing.target_user_id;

            v_remaining := GREATEST(
              CEIL(EXTRACT(EPOCH FROM (v_existing.last_rolled_at + INTERVAL '24 hours' - NOW())))::int,
              0
            );

            RETURN QUERY SELECT
              FALSE,
              v_existing.kind,
              v_existing.rolled_value,
              v_existing.applied_delta,
              v_existing.target_user_id,
              COALESCE(v_new_score, 0),
              v_remaining;
            RETURN;
          END IF;

          UPDATE users
          SET score=score + p_requested_delta, updated_at=NOW()
          WHERE chat_id=p_chat_id AND user_id=p_target_user_id
          RETURNING score INTO v_new_score;

          IF NOT FOUND THEN
            RETURN QUERY SELECT FALSE, NULL::TEXT, 0, 0, p_target_user_id, 0, 0;
            RETURN;
          END IF;

          INSERT INTO group_tuz_rolls(
            chat_id,last_rolled_at,kind,rolled_value,applied_delta,target_user_id
          )
          VALUES(
            p_chat_id,NOW(),p_kind,p_rolled_value,p_requested_delta,p_target_user_id
          )
          ON CONFLICT(chat_id)
          DO UPDATE SET
            last_rolled_at=EXCLUDED.last_rolled_at,
            kind=EXCLUDED.kind,
            rolled_value=EXCLUDED.rolled_value,
            applied_delta=EXCLUDED.applied_delta,
            target_user_id=EXCLUDED.target_user_id;

          INSERT INTO roll_events(chat_id,user_id,kind,rolled_value,applied_delta,created_at)
          VALUES(p_chat_id,p_target_user_id,p_kind,p_rolled_value,p_requested_delta,NOW());

          RETURN QUERY SELECT
            TRUE,
            p_kind,
            p_rolled_value,
            p_requested_delta,
            p_target_user_id,
            v_new_score,
            0;
        END;
        $$
      `);
    })();
  }

  return gameSchemaPromise;
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
