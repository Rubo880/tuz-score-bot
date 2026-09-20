import crypto from "crypto";
import {
  applyTuzRoll,
  displayName,
  ensureGroup,
  getGroup,
  getUserScore,
  invalidateMessage,
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

async function isCreator(chatId, userId) {
  try {
    const member = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    return member.status === "creator";
  } catch {
    return false;
  }
}

async function refreshPinned(chatId, { pin = false } = {}) {
  const text = await leaderboardText(chatId);
  let group = await getGroup(chatId);
  let messageId = group?.leaderboard_message_id || null;

  if (messageId) {
    try {
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    } catch (error) {
      if (!String(error.message).includes("message is not modified")) {
        console.error("refreshPinned edit failed, recreating board", error);
        messageId = null;
      }
    }
  }

  if (!messageId) {
    const board = await send(chatId, text);
    messageId = board.message_id;
    await setLeaderboardMessage(chatId, messageId);
  }

  if (pin) {
    try {
      await tg("pinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true
      });
    } catch (error) {
      console.error("refreshPinned pin failed", error);
    }
  }

  return messageId;
}


function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = crypto.randomInt(total);
  for (const item of items) {
    if (roll < item.weight) return item.value;
    roll -= item.weight;
  }
  return items[items.length - 1].value;
}

function rollTuzFate() {
  const positive = crypto.randomInt(2) === 0;

  const minus = [
    { value: 1, weight: 5 }, { value: 2, weight: 7 }, { value: 3, weight: 9 },
    { value: 4, weight: 11 }, { value: 5, weight: 14 }, { value: 6, weight: 14 },
    { value: 7, weight: 12 }, { value: 8, weight: 9 }, { value: 9, weight: 7 },
    { value: 10, weight: 5 }, { value: 11, weight: 3 }, { value: 12, weight: 2 },
    { value: 13, weight: 1 }, { value: 14, weight: 1 }, { value: 15, weight: 1 }
  ];

  const plus = [
    { value: 1, weight: 5 }, { value: 2, weight: 7 }, { value: 3, weight: 9 },
    { value: 4, weight: 11 }, { value: 5, weight: 14 }, { value: 6, weight: 14 },
    { value: 7, weight: 12 }, { value: 8, weight: 10 }, { value: 9, weight: 8 },
    { value: 10, weight: 6 }, { value: 11, weight: 5 }, { value: 12, weight: 4 },
    { value: 13, weight: 3 }, { value: 14, weight: 2 }, { value: 15, weight: 2 },
    { value: 16, weight: 1 }, { value: 17, weight: 1 }, { value: 18, weight: 1 },
    { value: 19, weight: 1 }, { value: 20, weight: 1 }
  ];

  const value = weightedPick(positive ? plus : minus);
  return {
    kind: positive ? "kozyrnoy" : "opushenniy",
    value,
    delta: positive ? value : -value
  };
}

function formatCooldown(seconds) {
  const totalMinutes = Math.max(1, Math.ceil(Number(seconds || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return minutes + " мин.";
  if (minutes === 0) return hours + " ч.";
  return hours + " ч. " + minutes + " мин.";
}

function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? "https://" + host : "";
}

function rulesText() {
  return (
    "📌 <b>Правила подсчёта</b>\n\n" +
    "• каждое вхождение <code>туз</code> или <code>tuz</code> = +1;\n" +
    "• регистр не важен: <code>ТУЗ</code>, <code>ТуЗ</code>, <code>TUZ</code>, <code>TuZ</code>;\n" +
    "• корень может быть частью более длинного слова: <code>растузовка</code> считается;\n" +
    "• <code>Bluetooth</code> не считается;\n" +
    "• 1–3 вхождения в одном сообщении считаются обычно;\n" +
    "• 🛡 <b>античит:</b> 4+ вхождения в одном сообщении = 0 очков за всё сообщение;\n" +
    "• 🛡 максимум +5 очков одному человеку за 60 секунд;\n" +
    "• подписи к фото и видео тоже считаются;\n" +
    "• после редактирования сообщения результат пересчитывается;\n" +
    "• только <b>создатель группы</b> может ответить <code>/undo</code> на читерское сообщение и снять начисленные за него очки;\n" +
    "• <code>/tuzroll</code> — раз в 24 часа: либо <b>Козырной туз</b> (+1…+20), либо <b>Опущенный туз</b> (−1…−15); большие значения выпадают реже;\n" +
    "• каждый день бот автоматически объявляет <b>Тузоида дня</b> по числу засчитанных упоминаний за сутки."
  );
}

async function handleCommand(msg, req) {
  const raw = (msg.text || "").trim().split(/\s+/)[0] || "";
  const command = raw.toLowerCase().split("@")[0];
  const chatId = msg.chat.id;

  if (msg.chat.type === "private") {
    if (command === "/start") {
      await send(
        chatId,
        "Я считаю вхождения <code>туз</code> / <code>tuz</code> в группах и защищаю рейтинг от спама.\n\n" +
        "Добавьте меня в группу, отключите Privacy Mode через @BotFather и выполните там <code>/setup</code>."
      );
    } else if (command === "/rules") {
      await send(chatId, rulesText());
    } else if (["/setup", "/leaderboard", "/top", "/me", "/web", "/undo", "/tuzroll", "/roll"].includes(command)) {
      await send(chatId, "Эта команда работает <b>в группе</b>, где я веду лидерборд.");
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
    await refreshPinned(chatId, { pin: true });
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
    await send(chatId, rulesText());
    return true;
  }

  if (command === "/undo") {
    if (!await isCreator(chatId, msg.from.id)) {
      await send(chatId, "Команду <code>/undo</code> может использовать только <b>создатель группы</b>.");
      return true;
    }

    const target = msg.reply_to_message;
    if (!target) {
      await send(chatId, "Ответь командой <code>/undo</code> прямо на читерское сообщение.");
      return true;
    }

    const removed = await invalidateMessage(chatId, target.message_id);
    if (removed > 0) {
      await refreshPinned(chatId);
      await send(chatId, "🛡 Античит: снято <b>" + removed + "</b> очков за это сообщение.");
    } else {
      await send(chatId, "За это сообщение уже нет начисленных очков.");
    }
    return true;
  }


  if (command === "/tuzroll" || command === "/roll") {
    const fate = rollTuzFate();
    const result = await applyTuzRoll(
      chatId,
      msg.from,
      fate.kind,
      fate.value,
      fate.delta
    );

    const remaining = Number(result.seconds_remaining || 0);
    if (remaining > 0) {
      await send(
        chatId,
        "⏳ <b>Туз уже был вытянут.</b>\nСледующая попытка через <b>" +
          formatCooldown(remaining) +
          "</b>."
      );
      return true;
    }

    const applied = Number(result.applied_delta || 0);
    const score = Number(result.new_score || 0);
    const name = escapeHtml(displayName(msg.from));

    if (fate.kind === "kozyrnoy") {
      await send(
        chatId,
        "🃏 <b>КОЗЫРНОЙ ТУЗ</b>\n\n" +
          name +
          " вытянул козырного туза: <b>+" +
          fate.value +
          "</b> очков.\n\nСчёт: <b>" +
          score +
          "</b>"
      );
    } else {
      const actuallyRemoved = Math.abs(Math.min(applied, 0));
      const extra =
        actuallyRemoved < fate.value
          ? "\n<i>Снято фактически: " + actuallyRemoved + " — счёт не уходит ниже нуля.</i>"
          : "";

      await send(
        chatId,
        "💀 <b>ОПУЩЕННЫЙ ТУЗ</b>\n\n" +
          name +
          " не повезло: выпало <b>−" +
          fate.value +
          "</b> очков." +
          extra +
          "\n\nСчёт: <b>" +
          score +
          "</b>"
      );
    }

    if (applied !== 0) {
      await refreshPinned(chatId);
    }
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
