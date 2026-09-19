import express from "express";
import pg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!DB) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: DB,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

const app = express();
app.use(express.json());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

const tg = async (method, body = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || method);
  return j.result;
};

const countTuz = (s = "") => (String(s).match(/(?:туз|tuz)/giu) || []).length;
const esc = s => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const nameOf = u => u.username ? "@" + u.username : ([u.first_name, u.last_name].filter(Boolean).join(" ") || "User " + u.id);

await pool.query(`
CREATE TABLE IF NOT EXISTS groups(
  chat_id BIGINT PRIMARY KEY,
  title TEXT,
  leaderboard_message_id BIGINT,
  board_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS users(
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  score INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE IF NOT EXISTS messages(
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  count INT NOT NULL DEFAULT 0,
  hash TEXT,
  PRIMARY KEY(chat_id,message_id)
);
`);

async function ensureGroup(chat) {
  await pool.query(
    `INSERT INTO groups(chat_id,title,board_key) VALUES($1,$2,$3)
     ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title`,
    [chat.id, chat.title || String(chat.id), crypto.randomBytes(18).toString("base64url")]
  );
}

async function applyMessage(msg) {
  if (!msg?.chat || !msg?.from || msg.from.is_bot || !["group","supergroup"].includes(msg.chat.type)) return 0;
  const text = msg.text ?? msg.caption ?? "";
  const now = countTuz(text);
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  await ensureGroup(msg.chat);

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO users(chat_id,user_id,username,first_name,last_name)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(chat_id,user_id) DO UPDATE
       SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name`,
      [msg.chat.id, msg.from.id, msg.from.username || null, msg.from.first_name || null, msg.from.last_name || null]
    );

    const p = await c.query(
      "SELECT count,hash FROM messages WHERE chat_id=$1 AND message_id=$2 FOR UPDATE",
      [msg.chat.id, msg.message_id]
    );

    if (p.rowCount && p.rows[0].hash === hash) {
      await c.query("COMMIT");
      return 0;
    }

    const old = p.rowCount ? p.rows[0].count : 0;
    const delta = now - old;

    if (delta) {
      await c.query(
        "UPDATE users SET score=GREATEST(score+$1,0),updated_at=NOW() WHERE chat_id=$2 AND user_id=$3",
        [delta, msg.chat.id, msg.from.id]
      );
    }

    await c.query(
      `INSERT INTO messages(chat_id,message_id,user_id,count,hash)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(chat_id,message_id) DO UPDATE
       SET user_id=EXCLUDED.user_id,count=EXCLUDED.count,hash=EXCLUDED.hash`,
      [msg.chat.id, msg.message_id, msg.from.id, now, hash]
    );

    await c.query("COMMIT");
    return delta;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function leaders(chatId, limit = 50) {
  return (await pool.query(
    "SELECT user_id,username,first_name,last_name,score FROM users WHERE chat_id=$1 AND score>0 ORDER BY score DESC,updated_at ASC LIMIT $2",
    [chatId, limit]
  )).rows;
}

async function total(chatId) {
  return Number((await pool.query(
    "SELECT COALESCE(SUM(score),0) t FROM users WHERE chat_id=$1",
    [chatId]
  )).rows[0].t);
}

async function boardText(chatId) {
  const rows = await leaders(chatId, 25);
  const t = await total(chatId);
  const medals = ["🥇","🥈","🥉"];
  const body = rows.length
    ? rows.map((r, i) => `${medals[i] || ((i + 1) + ".")} <b>${esc(nameOf(r))}</b> — ${r.score}`).join("\n")
    : "Пока ни одного упоминания.";

  return `🏆 <b>TUZ LEADERBOARD</b>\n\n${body}\n\nВсего упоминаний: <b>${t}</b>\n\nКаждое вхождение <code>туз</code> или <code>tuz</code> = +1.`;
}

async function isAdmin(chatId, userId) {
  try {
    const m = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    return ["creator","administrator"].includes(m.status);
  } catch {
    return false;
  }
}

async function send(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function refreshPinned(chatId) {
  const g = (await pool.query(
    "SELECT leaderboard_message_id FROM groups WHERE chat_id=$1",
    [chatId]
  )).rows[0];
  if (!g?.leaderboard_message_id) return;

  try {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: g.leaderboard_message_id,
      text: await boardText(chatId),
      parse_mode: "HTML"
    });
  } catch (e) {
    if (!String(e.message).includes("message is not modified")) console.error(e.message);
  }
}

async function command(msg) {
  const cmd = (msg.text || "").trim().split(/\s+/)[0].toLowerCase().split("@")[0];
  const chatId = msg.chat.id;

  if (msg.chat.type === "private") {
    if (cmd === "/start") {
      await send(chatId, "Добавьте меня в группу, отключите Privacy Mode через @BotFather и выполните там <code>/setup</code>.");
    }
    return true;
  }

  if (cmd === "/setup") {
    if (!await isAdmin(chatId, msg.from.id)) {
      await send(chatId, "Только администратор группы может выполнить <code>/setup</code>.");
      return true;
    }

    await ensureGroup(msg.chat);
    const m = await send(chatId, await boardText(chatId));
    await pool.query("UPDATE groups SET leaderboard_message_id=$1 WHERE chat_id=$2", [m.message_id, chatId]);

    try {
      await tg("pinChatMessage", {
        chat_id: chatId,
        message_id: m.message_id,
        disable_notification: true
      });
    } catch {}

    const g = (await pool.query("SELECT board_key FROM groups WHERE chat_id=$1", [chatId])).rows[0];
    if (BASE) await send(chatId, `🌐 Веб-лидерборд:\n${BASE}/g/${g.board_key}`);
    return true;
  }

  if (cmd === "/leaderboard" || cmd === "/top") {
    await send(chatId, await boardText(chatId));
    return true;
  }

  if (cmd === "/me") {
    const r = (await pool.query(
      "SELECT score FROM users WHERE chat_id=$1 AND user_id=$2",
      [chatId, msg.from.id]
    )).rows[0];
    await send(chatId, `👤 <b>${esc(nameOf(msg.from))}</b>\nТвой счёт: <b>${r?.score || 0}</b>`);
    return true;
  }

  if (cmd === "/rules") {
    await send(chatId,
      "📌 <b>Правила</b>\n" +
      "• каждое <code>туз</code> или <code>tuz</code> = +1\n" +
      "• регистр не важен\n" +
      "• внутри длинного слова тоже считается\n" +
      "• <code>Bluetooth</code> не считается\n" +
      "• 3 совпадения в одном сообщении = +3"
    );
    return true;
  }

  return false;
}

async function handle(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  if (msg.text?.startsWith("/") && await command(msg)) return;

  const delta = await applyMessage(msg);
  if (delta) await refreshPinned(msg.chat.id);
}

let offset = 0;

async function poll() {
  await tg("deleteWebhook", { drop_pending_updates: false });
  await tg("setMyCommands", {
    commands: [
      { command: "setup", description: "Создать лидерборд" },
      { command: "leaderboard", description: "Показать топ" },
      { command: "me", description: "Мой счёт" },
      { command: "rules", description: "Правила подсчёта" }
    ]
  }).catch(() => {});

  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message","edited_message"]
      });

      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handle(u).catch(e => console.error(e.message));
      }
    } catch (e) {
      console.error("poll", e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get("/api/board/:key", async (req, res) => {
  const g = (await pool.query(
    "SELECT chat_id,title FROM groups WHERE board_key=$1",
    [req.params.key]
  )).rows[0];

  if (!g) return res.status(404).json({ error: "not_found" });

  const rs = await leaders(g.chat_id, 100);
  res.json({
    title: g.title || "TUZ Leaderboard",
    total: await total(g.chat_id),
    leaders: rs.map((r, i) => ({ rank: i + 1, name: nameOf(r), score: r.score }))
  });
});

app.get("/g/:key", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "board.html"));
});

app.listen(PORT, "0.0.0.0", () => console.log("listening", PORT));

const lock = await pool.connect();
const ok = (await lock.query("SELECT pg_try_advisory_lock(88442211) locked")).rows[0].locked;
if (ok) poll();
else {
  lock.release();
  console.log("polling owned by another replica");
}
