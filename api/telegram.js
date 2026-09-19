import {
  displayName,
  ensureGroup,
  getGroup,
  getUserScore,
  processMessage,
  setLeaderboardMessage
} from "../lib/db.js";
import { leaderboardText } from "../lib/leaderboard.js";
import { escapeHtml, tg, WEBHOOK_SECRET } from "../lib/telegram.js";

function getBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

async function send(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function isAdmin(chatId, userId) {
  try {
    const member = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

async function refreshPinned(chatId) {
  const group = await getGroup(chatId);
  if (!group?.leaderboard_message_id) return;

  try {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: group.leaderboard_message_id,
      text: await leaderboardText(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (error) {
    if (!String(error.message).includes("message is not modified")) {
      console.error("refreshPinned", error);
    }
  }
}

function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? "https://" + host : "";
}

async function handleCommand(msg, req) {
  const raw = (msg.text || "").trim().split(/\s+/)[0] || "";
  const command = raw.toLowerCase().split("@")[0];
  const chatId = msg.chat.id;

  if (msg.chat.type === "private") {
    if (command === "/start") {
      await send(
        chatId,
        "Я считаю каждое вхождение <code>туз</code> / <code>tuz</code> в группах.\n\n" +
        "Добавьте меня в группу, отключите Privacy Mode через @BotFather и выполните там <code>/setup</code>."
      );
    }
    return true;
  }

  if (command === "/setup") {
    if (!await isAdmin(chatId, msg.from.id)) {
      await send(chatId, "Команду <code>/setup</code> может выполнить только администратор группы.");
      return true;
    }

    const group = await ensureGroup(msg.chat);
    const board = await send(chatId, await leaderboardText(chatId));
    await setLeaderboardMessage(chatId, board.message_id);

    try {
      await tg("pinChatMessage", {
        chat_id: chatId,
        message_id: board.message_id,
        disable_notification: true
      });
    } catch {
      await send(
        chatId,
        "Лидерборд создан. Чтобы я закреплял его автоматически, дайте мне право <b>Pin messages</b>."
      );
    }

    const base = baseUrl(req);
    if (base) {
      await send(chatId, "🌐 Веб-лидерборд:\n" + base + "/g/" + group.board_key);
    }
    return true;
  }

  if (command === "/leaderboard" || command === "/top") {
    await send(chatId, await leaderboardText(chatId));
    return true;
  }

  if (command === "/me") {
    const score = await getUserScore(chatId, msg.from.id);
    await send(
      chatId,
      "👤 <b>" + escapeHtml(displayName(msg.from)) + "</b>\nТвой счёт: <b>" + score + "</b>"
    );
    return true;
  }

  if (command === "/rules") {
    await send(
      chatId,
      "📌 <b>Правила подсчёта</b>\n\n" +
      "• каждое вхождение <code>туз</code> или <code>tuz</code> = +1;\n" +
      "• регистр не важен: <code>ТУЗ</code>, <code>ТуЗ</code>, <code>TUZ</code>, <code>TuZ</code>;\n" +
      "• корень может быть частью более длинного слова: <code>растузовка</code> считается;\n" +
      "• <code>Bluetooth</code> не считается;\n" +
      "• три подходящих вхождения в одном сообщении = +3;\n" +
      "• подписи к фото и видео тоже считаются;\n" +
      "• после редактирования сообщения результат пересчитывается."
    );
    return true;
  }

  if (command === "/web") {
    const group = await ensureGroup(msg.chat);
    const base = baseUrl(req);
    await send(
      chatId,
      base ? "🌐 " + base + "/g/" + group.board_key : "Веб-ссылка пока недоступна."
    );
    return true;
  }

  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const suppliedSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (suppliedSecret !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }

  const update = getBody(req);
  const msg = update.message || update.edited_message;

  if (!msg) {
    return res.status(200).json({ ok: true });
  }

  try {
    if (msg.text?.startsWith("/")) {
      const handled = await handleCommand(msg, req);
      if (handled) return res.status(200).json({ ok: true });
    }

    const delta = await processMessage(msg);
    if (delta !== 0) {
      await refreshPinned(msg.chat.id);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("telegram webhook error", error);
    return res.status(500).json({ ok: false });
  }
}
