import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(process.env.DATABASE_URL);
let schemaPromise;
let gameSchemaPromise;
let vaultSchemaPromise;

export const MAX_TUZ_PER_MESSAGE = 3;
export const MAX_TUZ_PER_MINUTE = 2;
export const VAULT_CAPACITY = 10;
export const VAULT_SHIELD_COST = 7;
export const VAULT_SHIELD_HOURS = 2;
export const RAID_COOLDOWN_HOURS = 6;

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

async function ensureVaultSchema() {
  if (!vaultSchemaPromise) {
    vaultSchemaPromise = sql.query(`
      DO $vault$
      BEGIN
        PERFORM pg_advisory_xact_lock(
          hashtextextended('tuz-vault-schema-v1', 0)
        );

        IF to_regclass('public.tuz_vaults') IS NULL THEN
          CREATE TABLE public.tuz_vaults (
            chat_id BIGINT NOT NULL,
            user_id BIGINT NOT NULL,
            stored_points INTEGER NOT NULL DEFAULT 0,
            last_accrual_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            shield_until TIMESTAMPTZ,
            last_shield_purchase_at TIMESTAMPTZ,
            last_raid_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(chat_id,user_id),
            CHECK(stored_points >= 0 AND stored_points <= 10)
          );
        END IF;

        CREATE INDEX IF NOT EXISTS tuz_vaults_chat_idx
          ON public.tuz_vaults(chat_id);
      END
      $vault$;
    `).catch((error) => {
      vaultSchemaPromise = null;
      throw error;
    });
  }

  return vaultSchemaPromise;
}

async function ensureVaultRowsForChat(chatId) {
  await ensureVaultSchema();
  await sql.query(
    `INSERT INTO tuz_vaults(chat_id,user_id,stored_points,last_accrual_at,created_at,updated_at)
     SELECT u.chat_id,u.user_id,0,NOW(),NOW(),NOW()
     FROM users u
     WHERE u.chat_id=$1
     ON CONFLICT(chat_id,user_id) DO NOTHING`,
    [chatId]
  );
}

async function ensureVaultRow(chatId, userId) {
  await ensureVaultSchema();
  await sql.query(
    `INSERT INTO tuz_vaults(chat_id,user_id,stored_points,last_accrual_at,created_at,updated_at)
     VALUES($1,$2,0,NOW(),NOW(),NOW())
     ON CONFLICT(chat_id,user_id) DO NOTHING`,
    [chatId, userId]
  );
}

export async function ensureGameUser(chatId, user = {}) {
  if (!user?.id) return;
  await ensureSchema();
  await sql.query(
    `INSERT INTO users(chat_id,user_id,username,first_name,last_name,score,updated_at)
     VALUES($1,$2,$3,$4,$5,0,NOW())
     ON CONFLICT(chat_id,user_id)
     DO UPDATE SET
       username=EXCLUDED.username,
       first_name=EXCLUDED.first_name,
       last_name=EXCLUDED.last_name,
       updated_at=NOW()`,
    [
      chatId,
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    ]
  );
  await ensureVaultRow(chatId, user.id);
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
  await ensureVaultRowsForChat(chatId);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  return sql.query(
    `SELECT
       u.user_id,u.username,u.first_name,u.last_name,u.score,
       LEAST(
         10,
         v.stored_points +
         GREATEST(
           0,
           FLOOR(EXTRACT(EPOCH FROM (NOW()-v.last_accrual_at))/3600)::int
         )
       )::int AS vault_points,
       (
         LEAST(
           10,
           v.stored_points +
           GREATEST(
             0,
             FLOOR(EXTRACT(EPOCH FROM (NOW()-v.last_accrual_at))/3600)::int
           )
         ) * 10
       )::int AS vault_percent,
       (v.shield_until IS NOT NULL AND v.shield_until > NOW()) AS vault_shielded
     FROM users u
     JOIN tuz_vaults v
       ON v.chat_id=u.chat_id AND v.user_id=u.user_id
     WHERE u.chat_id=$1
     ORDER BY u.score DESC,u.updated_at ASC,u.user_id ASC
     LIMIT $2`,
    [chatId, safeLimit]
  );
}

export async function getNegativeLeaders(chatId, limit = 25) {
  await ensureVaultRowsForChat(chatId);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  return sql.query(
    `SELECT
       u.user_id,u.username,u.first_name,u.last_name,u.score,
       LEAST(
         10,
         v.stored_points +
         GREATEST(
           0,
           FLOOR(EXTRACT(EPOCH FROM (NOW()-v.last_accrual_at))/3600)::int
         )
       )::int AS vault_points,
       (
         LEAST(
           10,
           v.stored_points +
           GREATEST(
             0,
             FLOOR(EXTRACT(EPOCH FROM (NOW()-v.last_accrual_at))/3600)::int
           )
         ) * 10
       )::int AS vault_percent,
       (v.shield_until IS NOT NULL AND v.shield_until > NOW()) AS vault_shielded
     FROM users u
     JOIN tuz_vaults v
       ON v.chat_id=u.chat_id AND v.user_id=u.user_id
     WHERE u.chat_id=$1 AND u.score<0
     ORDER BY u.score DESC,u.updated_at ASC,u.user_id ASC
     LIMIT $2`,
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

export async function getUserByUsername(chatId, username) {
  await ensureGameSchema();
  const normalized = String(username || "").replace(/^@/, "").trim();
  if (!normalized) return null;

  const rows = await sql.query(
    `SELECT user_id,username,first_name,last_name,score
     FROM users
     WHERE chat_id=$1 AND LOWER(username)=LOWER($2)
     LIMIT 1`,
    [chatId, normalized]
  );
  return rows[0] || null;
}

export async function getVaultState(chatId, userId) {
  await ensureVaultRow(chatId, userId);
  const rows = await sql.query(
    `WITH v AS (
       SELECT *,
         LEAST(
           10,
           stored_points +
           GREATEST(
             0,
             FLOOR(EXTRACT(EPOCH FROM (NOW()-last_accrual_at))/3600)::int
           )
         )::int AS current_points
       FROM tuz_vaults
       WHERE chat_id=$1 AND user_id=$2
     )
     SELECT
       current_points AS vault_points,
       (current_points * 10)::int AS vault_percent,
       CASE
         WHEN current_points >= 10 THEN 0
         ELSE GREATEST(
           1,
           3600 - (
             GREATEST(
               0,
               FLOOR(EXTRACT(EPOCH FROM (NOW()-last_accrual_at)))::int
             ) % 3600
           )
         )
       END::int AS next_point_seconds,
       CASE
         WHEN shield_until IS NOT NULL AND shield_until > NOW()
           THEN CEIL(EXTRACT(EPOCH FROM (shield_until-NOW())))::int
         ELSE 0
       END AS shield_seconds,
       CASE
         WHEN last_raid_at IS NOT NULL
          AND last_raid_at + INTERVAL '6 hours' > NOW()
           THEN CEIL(EXTRACT(EPOCH FROM (last_raid_at + INTERVAL '6 hours' - NOW())))::int
         ELSE 0
       END AS raid_cooldown_seconds
     FROM v`,
    [chatId, userId]
  );

  return rows[0] || {
    vault_points: 0,
    vault_percent: 0,
    next_point_seconds: 3600,
    shield_seconds: 0,
    raid_cooldown_seconds: 0
  };
}

export async function collectVault(chatId, user = {}) {
  await ensureGameUser(chatId, user);
  const rows = await sql.query(
    `WITH locked AS MATERIALIZED (
       SELECT
         v.*,
         LEAST(
           10,
           v.stored_points +
           GREATEST(
             0,
             FLOOR(EXTRACT(EPOCH FROM (NOW()-v.last_accrual_at))/3600)::int
           )
         )::int AS available
       FROM tuz_vaults v
       WHERE v.chat_id=$1 AND v.user_id=$2
       FOR UPDATE
     ),
     vault_update AS (
       UPDATE tuz_vaults v
       SET stored_points=0,last_accrual_at=NOW(),updated_at=NOW()
       FROM locked
       WHERE v.chat_id=$1 AND v.user_id=$2 AND locked.available>0
       RETURNING v.user_id
     ),
     user_update AS (
       UPDATE users u
       SET score=u.score + locked.available,
           updated_at=NOW()
       FROM locked
       WHERE u.chat_id=$1 AND u.user_id=$2 AND locked.available>0
       RETURNING u.score
     )
     SELECT
       locked.available::int AS collected,
       locked.available::int AS payout,
       COALESCE(
         (SELECT score FROM user_update LIMIT 1),
         (SELECT score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1),
         0
       )::int AS new_score
     FROM locked`,
    [chatId, user.id]
  );
  return rows[0] || null;
}

export async function buyVaultShield(chatId, user = {}) {
  await ensureGameUser(chatId, user);
  const rows = await sql.query(
    `WITH v AS MATERIALIZED (
       SELECT * FROM tuz_vaults
       WHERE chat_id=$1 AND user_id=$2
       FOR UPDATE
     ),
     u AS MATERIALIZED (
       SELECT score FROM users
       WHERE chat_id=$1 AND user_id=$2
       FOR UPDATE
     ),
     decision AS MATERIALIZED (
       SELECT
         u.score,
         v.shield_until,
         v.last_shield_purchase_at,
         CASE
           WHEN v.shield_until IS NOT NULL AND v.shield_until > NOW()
             THEN 'active'
           WHEN v.last_shield_purchase_at IS NOT NULL
            AND v.last_shield_purchase_at + INTERVAL '2 hours' > NOW()
             THEN 'cooldown'
           WHEN u.score < 7
             THEN 'funds'
           ELSE 'ok'
         END AS status
       FROM v,u
     ),
     pay AS (
       UPDATE users x
       SET score=x.score-7,updated_at=NOW()
       FROM decision d
       WHERE x.chat_id=$1 AND x.user_id=$2 AND d.status='ok'
       RETURNING x.score
     ),
     shield AS (
       UPDATE tuz_vaults x
       SET shield_until=NOW()+INTERVAL '2 hours',
           last_shield_purchase_at=NOW(),
           updated_at=NOW()
       FROM decision d
       WHERE x.chat_id=$1 AND x.user_id=$2 AND d.status='ok'
       RETURNING x.shield_until
     )
     SELECT
       d.status AS result_status,
       COALESCE(
         (SELECT score FROM pay LIMIT 1),
         d.score
       )::int AS new_score,
       CASE
         WHEN d.status='ok' THEN 7200
         WHEN d.status='active' THEN
           GREATEST(0,CEIL(EXTRACT(EPOCH FROM (d.shield_until-NOW())))::int)
         WHEN d.status='cooldown' THEN
           GREATEST(
             0,
             CEIL(EXTRACT(EPOCH FROM (
               d.last_shield_purchase_at + INTERVAL '2 hours' - NOW()
             )))::int
           )
         ELSE 0
       END AS seconds_remaining
     FROM decision d`,
    [chatId, user.id]
  );
  return rows[0] || null;
}

export async function raidVault(chatId, attacker = {}, victimUserId) {
  await ensureGameUser(chatId, attacker);
  await ensureVaultRow(chatId, victimUserId);

  const rows = await sql.query(
    `WITH locked AS MATERIALIZED (
       SELECT *
       FROM tuz_vaults
       WHERE chat_id=$1 AND user_id IN ($2,$3)
       ORDER BY user_id
       FOR UPDATE
     ),
     a AS MATERIALIZED (
       SELECT * FROM locked WHERE user_id=$2
     ),
     v0 AS MATERIALIZED (
       SELECT * FROM locked WHERE user_id=$3
     ),
     v AS MATERIALIZED (
       SELECT
         v0.*,
         LEAST(
           10,
           v0.stored_points +
           GREATEST(
             0,
             FLOOR(EXTRACT(EPOCH FROM (NOW()-v0.last_accrual_at))/3600)::int
           )
         )::int AS current_points
       FROM v0
     ),
     decision AS MATERIALIZED (
       SELECT
         a.last_raid_at,
         a.shield_until AS attacker_shield_until,
         v.shield_until AS victim_shield_until,
         v.current_points,
         CASE
           WHEN a.last_raid_at IS NOT NULL
            AND a.last_raid_at + INTERVAL '6 hours' > NOW()
             THEN 'cooldown'
           WHEN v.shield_until IS NOT NULL AND v.shield_until > NOW()
             THEN 'shielded'
           WHEN v.current_points <= 0
             THEN 'empty'
           ELSE 'go'
         END AS status,
         (random() < 0.30) AS success
       FROM a,v
     ),
     bounds AS MATERIALIZED (
       SELECT
         d.*,
         CASE d.current_points
           WHEN 10 THEN 5 WHEN 9 THEN 4 WHEN 8 THEN 4 WHEN 7 THEN 3
           WHEN 6 THEN 3 WHEN 5 THEN 2 WHEN 4 THEN 2
           WHEN 3 THEN 1 WHEN 2 THEN 1 WHEN 1 THEN 1
           ELSE 0
         END::int AS min_loot,
         CASE d.current_points
           WHEN 10 THEN 7 WHEN 9 THEN 6 WHEN 8 THEN 5 WHEN 7 THEN 5
           WHEN 6 THEN 4 WHEN 5 THEN 4 WHEN 4 THEN 3
           WHEN 3 THEN 2 WHEN 2 THEN 2 WHEN 1 THEN 1
           ELSE 0
         END::int AS max_loot
       FROM decision d
     ),
     roll AS MATERIALIZED (
       SELECT
         b.*,
         CASE
           WHEN b.status='go' AND b.success THEN
             FLOOR(
               random() * (b.max_loot-b.min_loot+1)
             )::int + b.min_loot
           ELSE 0
         END::int AS loot
       FROM bounds b
     ),
     attacker_update AS (
       UPDATE tuz_vaults x
       SET
         last_raid_at=NOW(),
         shield_until=NULL,
         updated_at=NOW()
       FROM roll r
       WHERE x.chat_id=$1 AND x.user_id=$2 AND r.status='go'
       RETURNING x.user_id
     ),
     victim_update AS (
       UPDATE tuz_vaults x
       SET
         stored_points=CASE
           WHEN r.success THEN GREATEST(0,r.current_points-r.loot)
           ELSE x.stored_points
         END,
         last_accrual_at=CASE
           WHEN r.success THEN NOW()
           ELSE x.last_accrual_at
         END,
         shield_until=NOW()+INTERVAL '2 hours',
         updated_at=NOW()
       FROM roll r
       WHERE x.chat_id=$1 AND x.user_id=$3 AND r.status='go'
       RETURNING x.stored_points,x.shield_until
     ),
     score_update AS (
       UPDATE users u
       SET score=u.score+r.loot,updated_at=NOW()
       FROM roll r
       WHERE u.chat_id=$1
         AND u.user_id=$2
         AND r.status='go'
         AND r.success
       RETURNING u.score
     )
     SELECT
       r.status AS result_status,
       (r.status='go' AND r.success) AS success,
       r.loot::int AS loot,
       r.current_points::int AS victim_points_before,
       CASE
         WHEN r.status='go' AND r.success
           THEN GREATEST(0,r.current_points-r.loot)
         ELSE r.current_points
       END::int AS victim_points_after,
       CASE
         WHEN r.status='cooldown' THEN
           GREATEST(
             0,
             CEIL(EXTRACT(EPOCH FROM (
               r.last_raid_at + INTERVAL '6 hours' - NOW()
             )))::int
           )
         WHEN r.status='go' THEN 21600
         ELSE 0
       END AS raid_cooldown_seconds,
       CASE
         WHEN r.status='shielded' THEN
           GREATEST(
             0,
             CEIL(EXTRACT(EPOCH FROM (r.victim_shield_until-NOW())))::int
           )
         WHEN r.status='go' THEN 7200
         ELSE 0
       END AS victim_shield_seconds,
       COALESCE(
         (SELECT score FROM score_update LIMIT 1),
         (SELECT score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1),
         0
       )::int AS attacker_score
     FROM roll r`,
    [chatId, attacker.id, victimUserId]
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
    "SELECT * FROM settle_pvp_with_stats($1,$2,$3)",
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

export async function claimHumanCheckPrompt(chatId, userId) {
  await ensureSchema();
  const rows = await sql.query(
    `UPDATE human_check_state
     SET prompted_at=NOW(), updated_at=NOW()
     WHERE chat_id=$1
       AND user_id=$2
       AND is_pending=TRUE
       AND prompted_at IS NULL
     RETURNING challenge_id,target_code`,
    [chatId, userId]
  );
  return rows[0] || null;
}

export async function resolveHumanCheck(chatId, userId, challengeId, choiceCode) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT * FROM resolve_human_check($1,$2,$3,$4)",
    [chatId, userId, challengeId, choiceCode]
  );
  return rows[0] || null;
}

export async function getPvpStats(chatId, userId) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT battles_total,wins,win_streak_current,win_streak_max FROM pvp_stats WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
    [chatId, userId]
  );

  const row = rows[0];
  if (!row) {
    return {
      battles_total: 0,
      wins: 0,
      win_streak_current: 0,
      win_streak_max: 0
    };
  }

  return {
    battles_total: Number(row.battles_total || 0),
    wins: Number(row.wins || 0),
    win_streak_current: Number(row.win_streak_current || 0),
    win_streak_max: Number(row.win_streak_max || 0)
  };
}

export async function getUserScore(chatId, userId) {
  await ensureSchema();
  const rows = await sql.query(
    "SELECT score FROM users WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
    [chatId, userId]
  );
  return Number(rows[0]?.score || 0);
}
