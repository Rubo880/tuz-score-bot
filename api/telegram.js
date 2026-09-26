import crypto from "crypto";
import {
  applyGrow,
  applyGroupTuzRoll,
  buyVaultShield,
  collectVault,
  createPvpChallenge,
  claimHumanCheckPrompt,
  displayName,
  ensureGroup,
  getGroup,
  getRandomRollTarget,
  getPvpStats,
  getUserById,
  getUserByUsername,
  getUserScore,
  getVaultState,
  invalidateMessage,
  processMessage,
  raidVault,
  resolveHumanCheck,
  setLeaderboardMessage,
  settlePvpChallenge
} from "../lib/db.js";
import { leaderboardText } from "../lib/leaderboard.js";
import { escapeHtml, tg, WEBHOOK_SECRET } from "../lib/telegram.js";

const BOT_COMMANDS = [
  { command: "setup", description: "Создать и закрепить лидерборд" },
  { command: "leaderboard", description: "Обновить текущий топ" },
  { command: "grow", description: "Растить туз раз в день" },
  { command: "pvp", description: "PvP-дуэль: /pvp 10" },
  { command: "me", description: "Показать мой счёт" },
  { command: "vault", description: "Хранилище: сбор и щит" },
  { command: "raid", description: "Налёт: /raid @username или ответом" },
  { command: "rules", description: "Правила и античит" },
  { command: "undo", description: "Владелец: отменить очки за сообщение" },
  { command: "tuzroll", description: "Общий Tuz Roll группы раз в 24ч" }
];

async function syncBotCommands(chatId = null) {
  try {
    // Telegram can keep different command lists for different scopes.
    // Clear the old scoped menus first so removed commands such as /top
    // and /web cannot survive in a more specific group scope.
    const scopes = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" }
    ];

    if (chatId) {
      scopes.push(
        { type: "chat", chat_id: chatId },
        { type: "chat_administrators", chat_id: chatId }
      );
    }

    for (const scope of scopes) {
      for (const language_code of [undefined, "ru", "en"]) {
        const body = { scope };
        if (language_code) body.language_code = language_code;
        await tg("deleteMyCommands", body).catch(() => {});
      }
    }

    const setScopes = [
      { type: "default" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" }
    ];

    if (chatId) {
      setScopes.push(
        { type: "chat", chat_id: chatId },
        { type: "chat_administrators", chat_id: chatId }
      );
    }

    // Do not only delete old scopes: an administrator-specific command list
    // has higher priority than the regular group list. Explicitly overwrite
    // every relevant scope so removed commands (/top, /web) disappear for
    // group owners/admins as well.
    for (const scope of setScopes) {
      await tg("setMyCommands", {
        scope,
        commands: BOT_COMMANDS
      });
    }

    return true;
  } catch (error) {
    console.error("setMyCommands sync failed", error);
    return false;
  }
}

function getBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

async function send(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
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
  const group = await getGroup(chatId);
  let messageId = group?.leaderboard_message_id || null;
  let recreated = false;
  let adoptedPinned = false;
  let currentPinnedId = null;

  // First prefer the TUZ leaderboard that is ACTUALLY pinned in Telegram.
  // This lets admins pin the board manually once; the bot only edits that
  // same pinned message afterwards and does not need Pin messages permission.
  try {
    const chat = await tg("getChat", { chat_id: chatId });
    const pinned = chat?.pinned_message || null;
    currentPinnedId = pinned?.message_id || null;

    if (
      currentPinnedId &&
      String(pinned?.text || "").includes("TUZ LEADERBOARD")
    ) {
      try {
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: currentPinnedId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        });
        messageId = currentPinnedId;
        adoptedPinned = true;
        await setLeaderboardMessage(chatId, messageId);
      } catch (error) {
        if (String(error.message).includes("message is not modified")) {
          messageId = currentPinnedId;
          adoptedPinned = true;
          await setLeaderboardMessage(chatId, messageId);
        } else {
          console.error("refreshPinned pinned-board edit failed", error);
        }
      }
    }
  } catch (error) {
    console.error("refreshPinned getChat failed", error);
  }

  // If there is no usable manually pinned TUZ board, update the board stored
  // in the database as before.
  if (!adoptedPinned && messageId) {
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
        console.error("refreshPinned tracked-board edit failed, recreating", error);
        messageId = null;
      }
    }
  }

  if (!messageId) {
    const board = await send(chatId, text);
    messageId = board.message_id;
    recreated = true;
    await setLeaderboardMessage(chatId, messageId);
  }

  // If admins manually pinned a TUZ board, no pin permission is needed:
  // editing a bot-authored pinned message is enough.
  if (adoptedPinned) {
    return {
      messageId,
      pinOk: true,
      recreated,
      adoptedPinned: true
    };
  }

  // Only try to pin automatically when explicitly requested or after creating
  // a replacement board. If the bot lacks pin rights, admins can pin the
  // created TUZ leaderboard manually once and future updates will adopt it.
  let pinOk = currentPinnedId === messageId;
  if ((pin || recreated) && !pinOk) {
    try {
      await tg("pinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true
      });

      const verifiedChat = await tg("getChat", { chat_id: chatId });
      pinOk = verifiedChat?.pinned_message?.message_id === messageId;
    } catch (error) {
      pinOk = false;
      console.error("refreshPinned automatic pin failed", error);
    }
  }

  return { messageId, pinOk, recreated, adoptedPinned: false };
}

const HUMAN_EMOJIS = {
  frog: "🐸",
  lemon: "🍋",
  car: "🚗",
  ace: "🃏",
  cat: "🐱",
  rocket: "🚀",
  pizza: "🍕",
  ghost: "👻"
};

function humanCheckOptions(targetCode) {
  const all = Object.keys(HUMAN_EMOJIS).filter((code) => code !== targetCode);
  const chosen = [targetCode];

  while (chosen.length < 4 && all.length) {
    const index = crypto.randomInt(all.length);
    chosen.push(all.splice(index, 1)[0]);
  }

  for (let i = chosen.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }

  return chosen;
}

function humanCheckMarkup(challengeId, ownerId, targetCode) {
  return {
    inline_keyboard: [[
      ...humanCheckOptions(targetCode).map((code) => ({
        text: HUMAN_EMOJIS[code] || "❓",
        callback_data: "human:" + challengeId + ":" + ownerId + ":" + code
      }))
    ]]
  };
}

async function sendHumanCheck(chatId, user, check) {
  const targetEmoji = HUMAN_EMOJIS[check.target_code] || "❓";
  await send(
    chatId,
    "🤖 <b>HUMAN CHECK</b>\n\n" +
      "<b>" + escapeHtml(displayName(user)) + "</b> набрал 10 обычных очков за 15 минут.\n" +
      "Подтверди, что это не автоматический фарм: нажми <b>" + targetEmoji + "</b>.\n\n" +
      "Пока проверка не пройдена, новые очки за <code>туз/tuz</code> не начисляются. " +
      "После успешной проверки повторный Human Check не появится 2 часа.",
    {
      reply_markup: humanCheckMarkup(check.challenge_id, user.id, check.target_code)
    }
  );
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


function vaultBar(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  const filled = Math.max(0, Math.min(10, Math.round(safe / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function vaultKeyboard(userId) {
  return {
    inline_keyboard: [
      [
        {
          text: "📥 Забрать тузы",
          callback_data: "vault:collect:" + userId
        }
      ],
      [
        {
          text: "🛡 Купить щит — 7",
          callback_data: "vault:shield:" + userId
        }
      ]
    ]
  };
}

function vaultCardText(user, state, score, notice = "") {
  const points = Number(state?.vault_points || 0);
  const percent = Number(state?.vault_percent || 0);
  const next = Number(state?.next_point_seconds || 0);
  const shield = Number(state?.shield_seconds || 0);
  const raid = Number(state?.raid_cooldown_seconds || 0);
  const collect = Number(state?.collect_cooldown_seconds || 0);

  const lines = [
    "🏦 <b>TUZ ХРАНИЛИЩЕ</b>",
    "",
    "<b>" + escapeHtml(displayName(user)) + "</b>",
    "🃏 Рейтинг: <b>" + Number(score || 0) + "</b>",
    "🧪 Хранилище: <b>" + points + "/50</b> — <b>" + percent + "%</b>",
    "<code>" + vaultBar(percent) + "</code>",
    points >= 50
      ? "⚡ Статус: <b>FULL</b>"
      : "⏱ Следующий туз через <b>" + formatCooldown(next) + "</b>",
    "🛡 Защита: " + (shield > 0 ? "<b>" + formatCooldown(shield) + "</b>" : "нет"),
    "📥 Сбор: " + (collect > 0 ? "через <b>" + formatCooldown(collect) + "</b>" : "<b>готов</b>"),
    "⚔️ Налёт: " + (raid > 0 ? "через <b>" + formatCooldown(raid) + "</b>" : "<b>готов</b>"),
    "",
    "Хранилище заполняется от <b>0 до 50 за 6 часов</b>.",
    "Собрать накопленное можно <b>раз в 6 часов</b>; оно сразу переходит в основной рейтинг."
  ];

  if (notice) {
    lines.splice(2, 0, notice, "");
  }

  return lines.join("\n");
}

function signed(value) {
  const n = Number(value || 0);
  if (n > 0) return "+" + n;
  if (n < 0) return "−" + Math.abs(n);
  return "0";
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
    "• 🛡 максимум +2 очка одному человеку за 60 секунд;\n" +
    "• 🤖 если человек набрал 10 обычных очков за 15 минут, бот просит пройти Human Check; до подтверждения новые очки за <code>туз/tuz</code> не начисляются; после успешной проверки действует доверие на 2 часа;\n" +
    "• подписи к фото и видео тоже считаются;\n" +
    "• после редактирования сообщения результат пересчитывается;\n" +
    "• только <b>создатель группы</b> может ответить <code>/undo</code> на читерское сообщение и снять начисленные за него очки;\n" +
    "• <code>/tuzroll</code> — один общий розыгрыш на всю группу раз в 24 часа: случайному участнику выпадает либо <b>Козырной туз</b> (+1…+20), либо <b>Опущенный туз</b> (−1…−15); большие значения выпадают реже;\n" +
    "• в минус уходить можно: например, при счёте 3 и результате −10 станет −7;\n" +
    "• <code>/grow</code> — раз в календарный день растит твой туз на случайное значение от −10 до +40; серия дней даёт бонус на 2, 4, 8, 16 и 32-й день;\n" +
    "• <code>/pvp N</code> — предложить группе дуэль на N очков. Ставка не может превышать твой текущий счёт; сопернику тоже должно хватать очков;\n" +
    "• <code>/vault</code> — хранилище заполняется от 0 до <b>50 за 6 часов</b>. Забрать накопленное в рейтинг можно <b>раз в 6 часов</b>;\n" +
    "• щит стоит <b>7</b> рейтинговых очков и защищает хранилище <b>2 часа</b>; повторная покупка — не чаще чем раз в 2 часа;\n" +
    "• <code>/raid</code> — налёт на другого игрока раз в <b>3 часа</b>. Шанс успеха <b>30%</b>; успешная добыча сразу идёт в рейтинг нападающего;\n" +
    "• при налёте собственный щит нападающего снимается. Жертва после действительного налёта получает защиту на <b>2 часа</b>;\n" +
    "• при 50/50 успешный налёт крадёт <b>45–47</b> тузов; при меньшем запасе добыча уменьшается примерно пропорционально;\n" +
    "• каждый день бот автоматически объявляет <b>Тузоида дня</b> по числу засчитанных упоминаний за сутки."
  );
}

async function handleCommand(msg, req) {
  const raw = (msg.text || "").trim().split(/\s+/)[0] || "";
  const command = raw.toLowerCase().split("@")[0];
  const chatId = msg.chat.id;

  await syncBotCommands(chatId);

  if (msg.chat.type === "private") {
    if (command === "/start") {
      await send(
        chatId,
        "Я считаю вхождения <code>туз</code> / <code>tuz</code> в группах и защищаю рейтинг от спама.\n\n" +
        "Добавьте меня в группу, отключите Privacy Mode через @BotFather и выполните там <code>/setup</code>."
      );
    } else if (command === "/rules") {
      await send(chatId, rulesText());
    } else if (["/setup", "/leaderboard", "/me", "/undo", "/tuzroll", "/roll", "/grow", "/pvp", "/vault", "/raid"].includes(command)) {
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

  if (command === "/leaderboard") {
    const refreshed = await refreshPinned(chatId, { pin: true });
    if (refreshed.adoptedPinned) {
      await send(
        chatId,
        "🏆 <b>Текущий топ обновлён.</b> Обновил именно тот TUZ-лидерборд, который сейчас закреплён."
      );
    } else if (refreshed.pinOk) {
      await send(chatId, "🏆 <b>Текущий топ обновлён.</b> Лидерборд синхронизирован.");
    } else {
      await send(
        chatId,
        "🏆 <b>Текущий топ обновлён.</b> Закрепи созданный TUZ-лидерборд вручную один раз — дальше бот будет обновлять именно его без права <b>Pin messages</b>."
      );
    }
    return true;
  }

  if (command === "/me") {
    const [score, pvp, vault] = await Promise.all([
      getUserScore(chatId, msg.from.id),
      getPvpStats(chatId, msg.from.id),
      getVaultState(chatId, msg.from.id)
    ]);
    const winRate = pvp.battles_total > 0
      ? ((pvp.wins / pvp.battles_total) * 100).toFixed(2)
      : "0.00";

    await send(
      chatId,
      "👤 <b>" + escapeHtml(displayName(msg.from)) + "</b>\n" +
        "🃏 Твой счёт: <b>" + score + "</b>\n" +
        "🧪 Хранилище: <b>" + Number(vault.vault_points || 0) + "/50</b> — <b>" +
        Number(vault.vault_percent || 0) + "%</b>\n\n" +
        "⚔️ <b>PvP-статистика</b>\n" +
        "🏆 Процент выигрышей: <b>" + winRate + "%</b>\n" +
        "🔥 Текущий стрик побед: <b>" + pvp.win_streak_current + "</b>\n" +
        "👑 Лучший стрик побед: <b>" + pvp.win_streak_max + "</b>"
    );
    return true;
  }

  if (command === "/vault") {
    const [score, state] = await Promise.all([
      getUserScore(chatId, msg.from.id),
      getVaultState(chatId, msg.from.id)
    ]);

    await send(
      chatId,
      vaultCardText(msg.from, state, score),
      { reply_markup: vaultKeyboard(msg.from.id) }
    );
    return true;
  }

  if (command === "/raid") {
    let victim = null;
    const replied = msg.reply_to_message?.from;

    if (replied && !replied.is_bot) {
      victim = await getUserById(chatId, replied.id);
      if (!victim) {
        victim = {
          user_id: replied.id,
          username: replied.username || null,
          first_name: replied.first_name || null,
          last_name: replied.last_name || null
        };
      }
    } else {
      const parts = (msg.text || "").trim().split(/\s+/);
      if (parts[1]) {
        victim = await getUserByUsername(chatId, parts[1]);
      }
    }

    if (!victim) {
      await send(
        chatId,
        "🏴‍☠️ <b>TUZ RAID</b>\n\nОтветь командой <code>/raid</code> на сообщение игрока или напиши <code>/raid @username</code>."
      );
      return true;
    }

    const victimId = Number(victim.user_id || victim.id || 0);
    if (!victimId || victimId === msg.from.id) {
      await send(chatId, "🏴‍☠️ Нельзя устроить налёт на собственное хранилище.");
      return true;
    }

    const result = await raidVault(chatId, msg.from, victimId);
    if (!result) {
      await send(chatId, "🏴‍☠️ Не удалось провести налёт. Попробуй ещё раз.");
      return true;
    }

    const status = String(result.result_status || "");
    const victimName = escapeHtml(displayName(victim));

    if (status === "cooldown") {
      await send(
        chatId,
        "⏳ Следующий налёт будет доступен через <b>" +
          formatCooldown(result.raid_cooldown_seconds) +
          "</b>."
      );
      return true;
    }

    if (status === "shielded") {
      await send(
        chatId,
        "🚫 <b>Налёт невозможен.</b>\n\n" +
          "🛡 Хранилище <b>" + victimName + "</b> сейчас под щитом.\n" +
          "Защита спадёт примерно через <b>" +
          formatCooldown(result.victim_shield_seconds) +
          "</b>. Попытка налёта не потрачена."
      );
      return true;
    }

    if (status === "empty") {
      await send(
        chatId,
        "🚫 <b>Налёт невозможен.</b>\n\n" +
          "🏚 У <b>" + victimName + "</b> хранилище <b>0/50</b> — красть нечего.\n" +
          "Попытка налёта не потрачена."
      );
      return true;
    }

    if (status !== "go") {
      await send(chatId, "🏴‍☠️ Этот налёт сейчас недоступен.");
      return true;
    }

    const success = result.success === true || String(result.success) === "true";
    if (success) {
      await send(
        chatId,
        "🏴‍☠️ <b>TUZ RAID — УСПЕХ</b>\n\n" +
          "<b>" + escapeHtml(displayName(msg.from)) + "</b> налетел на <b>" + victimName + "</b>.\n" +
          "💰 Украдено: <b>+" + Number(result.loot || 0) + "</b> очков прямо в рейтинг.\n" +
          "🧪 У жертвы осталось: <b>" + Number(result.victim_points_after || 0) + "/50</b>.\n" +
          "🛡 Жертва получает защиту на <b>2 часа</b>.\n" +
          "⚠️ Щит нападающего, если был, снят. Следующий налёт — через <b>3 часа</b>.\n\n" +
          "🃏 Новый счёт нападающего: <b>" + Number(result.attacker_score || 0) + "</b>."
      );
    } else {
      await send(
        chatId,
        "💨 <b>TUZ RAID — ПРОМАХ</b>\n\n" +
          "<b>" + escapeHtml(displayName(msg.from)) + "</b> не смог ограбить <b>" + victimName + "</b>.\n" +
          "Шанс успеха был <b>30%</b>.\n" +
          "🛡 Жертва получает защиту на <b>2 часа</b>.\n" +
          "⚠️ Щит нападающего, если был, снят. Следующий налёт — через <b>3 часа</b>."
      );
    }

    await refreshPinned(chatId);
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
    const candidate = await getRandomRollTarget(chatId, msg.from);
    if (!candidate) {
      await send(chatId, "Пока некого выбирать для <b>Tuz Roll</b>.");
      return true;
    }

    const fate = rollTuzFate();
    const result = await applyGroupTuzRoll(
      chatId,
      candidate.user_id,
      fate.kind,
      fate.value,
      fate.delta
    );

    if (!result) {
      await send(chatId, "Не удалось провести <b>Tuz Roll</b>. Попробуй ещё раз.");
      return true;
    }

    const applied = result.was_applied === true || String(result.was_applied) === "true";
    const kind = result.result_kind;
    const value = Number(result.result_value || 0);
    const delta = Number(result.result_delta || 0);
    const score = Number(result.new_score || 0);
    const remaining = Number(result.seconds_remaining || 0);
    const target = await getUserById(chatId, result.result_target_user_id);
    const targetName = escapeHtml(displayName(target || { id: result.result_target_user_id }));

    if (!applied) {
      const title = kind === "kozyrnoy" ? "🃏 <b>КОЗЫРНОЙ ТУЗ</b>" : "💀 <b>ОПУЩЕННЫЙ ТУЗ</b>";
      const sign = delta >= 0 ? "+" : "−";
      await send(
        chatId,
        "⏳ <b>Tuz Roll уже был разыгран.</b>\n\n" +
          title +
          "\n" +
          targetName +
          " — <b>" +
          sign +
          Math.abs(delta) +
          "</b> очков.\n\nСледующий выбор через <b>" +
          formatCooldown(remaining) +
          "</b>."
      );
      return true;
    }

    if (kind === "kozyrnoy") {
      await send(
        chatId,
        "🃏 <b>КОЗЫРНОЙ ТУЗ</b>\n\n" +
          "Сегодня козырь достаётся <b>" +
          targetName +
          "</b>: <b>+" +
          value +
          "</b> очков.\n\nНовый счёт: <b>" +
          score +
          "</b>\n\nСледующий Tuz Roll — через 24 часа."
      );
    } else {
      await send(
        chatId,
        "💀 <b>ОПУЩЕННЫЙ ТУЗ</b>\n\n" +
          "Сегодня не повезло <b>" +
          targetName +
          "</b>: <b>−" +
          value +
          "</b> очков.\n\nНовый счёт: <b>" +
          score +
          "</b>\n\nСледующий Tuz Roll — через 24 часа."
      );
    }

    await refreshPinned(chatId);
    return true;
  }


  if (command === "/grow") {
    const baseDelta = crypto.randomInt(51) - 10;
    const result = await applyGrow(chatId, msg.from, baseDelta);

    if (!result) {
      await send(chatId, "Не удалось вырастить туз. Попробуй ещё раз.");
      return true;
    }

    const applied = result.was_applied === true || String(result.was_applied) === "true";
    const streak = Number(result.result_streak || 0);
    const bonus = Number(result.result_bonus || 0);
    const delta = Number(result.result_delta || 0);
    const score = Number(result.new_score || 0);
    const remaining = Number(result.seconds_remaining || 0);
    const name = escapeHtml(displayName(msg.from));

    if (!applied) {
      await send(
        chatId,
        "🌱 <b>Ты уже растил туз сегодня.</b>\n" +
          name +
          ", возвращайся через <b>" +
          formatCooldown(remaining) +
          "</b>.\n🔥 Серия: <b>" +
          streak +
          "</b> дн."
      );
      return true;
    }

    await send(
      chatId,
      "🌱 <b>TUZ GROW</b>\n\n" +
        name +
        " растит туз...\n" +
        "🎲 Выпало: <b>" +
        signed(result.result_base_delta) +
        "</b>\n" +
        "🔥 Серия: <b>" +
        streak +
        "</b> дн.\n" +
        "⚡ Бонус серии: <b>+" +
        bonus +
        "</b>\n" +
        "📈 Итоговое изменение: <b>" +
        signed(delta) +
        "</b>\n\n" +
        "🃏 Размер туза: <b>" +
        score +
        "</b>"
    );

    if (delta !== 0) {
      await refreshPinned(chatId);
    }
    return true;
  }

  if (command === "/pvp") {
    const parts = (msg.text || "").trim().split(/\s+/);
    const wager = Number(parts[1]);

    if (!Number.isInteger(wager) || wager <= 0) {
      await send(
        chatId,
        "⚔️ Использование: <code>/pvp 10</code>\nУкажи целое положительное число очков для ставки."
      );
      return true;
    }

    const challenge = await createPvpChallenge(chatId, msg.from, wager);

    if (!challenge?.ok) {
      if (challenge?.reason === "insufficient_funds") {
        await send(
          chatId,
          "⚔️ Ставка слишком большая.\nТвой текущий счёт: <b>" +
            Number(challenge.score || 0) +
            "</b>. Нельзя поставить больше своего счёта."
        );
      } else {
        await send(chatId, "⚔️ Не удалось создать PvP-вызов.");
      }
      return true;
    }

    const name = escapeHtml(displayName(msg.from));
    await send(
      chatId,
      "⚔️ <b>TUZ PVP</b>\n\n" +
        "<b>" +
        name +
        "</b> вызывает группу на дуэль.\n" +
        "Ставка: <b>" +
        wager +
        "</b> очков.\n\n" +
        "Победитель получает <b>+" +
        wager +
        "</b>, проигравший теряет <b>−" +
        wager +
        "</b>.\nКто принимает?",
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: "⚔️ Принять ставку " + wager,
              callback_data: "pvp:" + challenge.challenge_id
            }
          ]]
        }
      }
    );
    return true;
  }

  return false;
}


async function handleCallback(query) {
  const data = String(query?.data || "");
  const msg = query.message;

  if (data.startsWith("vault:")) {
    if (!msg?.chat) return true;

    const parts = data.split(":");
    const action = parts[1] || "";
    const ownerId = Number(parts[2]);

    if (!Number.isSafeInteger(ownerId) || query.from.id !== ownerId) {
      await tg("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Это хранилище другого игрока.",
        show_alert: true
      }).catch(() => {});
      return true;
    }

    if (action === "collect") {
      const result = await collectVault(msg.chat.id, query.from);
      if (!result) {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Не удалось собрать тузы.",
          show_alert: true
        }).catch(() => {});
        return true;
      }

      const status = String(result.result_status || "");
      const collected = Number(result.collected || 0);
      const payout = Number(result.payout || 0);

      if (status === "cooldown") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Следующий сбор через " + formatCooldown(result.seconds_remaining) + ".",
          show_alert: true
        }).catch(() => {});
      } else if (status === "empty") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Хранилище пока пустое."
        }).catch(() => {});
      } else if (status === "ok") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Собрано +" + payout
        }).catch(() => {});
      }

      const [score, state] = await Promise.all([
        getUserScore(msg.chat.id, ownerId),
        getVaultState(msg.chat.id, ownerId)
      ]);
      const notice = status === "ok"
        ? "📥 Собрано в рейтинг: <b>+" + payout + "</b>."
        : status === "cooldown"
          ? "⏳ Следующий сбор будет доступен через <b>" +
            formatCooldown(result.seconds_remaining) +
            "</b>."
          : "⏳ Пока нечего собирать.";

      await tg("editMessageText", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        text: vaultCardText(query.from, state, score, notice),
        parse_mode: "HTML",
        reply_markup: vaultKeyboard(ownerId)
      });

      if (collected > 0) {
        await refreshPinned(msg.chat.id);
      }
      return true;
    }

    if (action === "shield") {
      const result = await buyVaultShield(msg.chat.id, query.from);
      const status = String(result?.result_status || "");

      if (status === "ok") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Щит включён на 2 часа 🛡"
        }).catch(() => {});
      } else if (status === "funds") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Нужно минимум 7 рейтинговых очков.",
          show_alert: true
        }).catch(() => {});
      } else if (status === "active") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Щит уже активен ещё " + formatCooldown(result.seconds_remaining) + ".",
          show_alert: true
        }).catch(() => {});
      } else if (status === "cooldown") {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Щит можно купить через " + formatCooldown(result.seconds_remaining) + ".",
          show_alert: true
        }).catch(() => {});
      } else {
        await tg("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "Не удалось включить щит.",
          show_alert: true
        }).catch(() => {});
      }

      const [score, state] = await Promise.all([
        getUserScore(msg.chat.id, ownerId),
        getVaultState(msg.chat.id, ownerId)
      ]);
      const notice = status === "ok"
        ? "🛡 Щит куплен за <b>7</b> очков и включён на <b>2 часа</b>."
        : "";

      await tg("editMessageText", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        text: vaultCardText(query.from, state, score, notice),
        parse_mode: "HTML",
        reply_markup: vaultKeyboard(ownerId)
      });

      if (status === "ok") {
        await refreshPinned(msg.chat.id);
      }
      return true;
    }

    return true;
  }

  if (data.startsWith("human:")) {
    if (!msg?.chat) return true;

    const parts = data.split(":");
    const challengeId = parts[1] || "";
    const ownerId = Number(parts[2]);
    const choiceCode = parts[3] || "";

    if (!Number.isSafeInteger(ownerId) || query.from.id !== ownerId) {
      await tg("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Это Human Check другого игрока.",
        show_alert: true
      }).catch(() => {});
      return true;
    }

    const result = await resolveHumanCheck(
      msg.chat.id,
      ownerId,
      challengeId,
      choiceCode
    );
    const status = String(result?.result_status || "");

    if (status === "passed") {
      await tg("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Проверка пройдена ✅"
      }).catch(() => {});

      await tg("editMessageText", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "HTML",
        text:
          "✅ <b>HUMAN CHECK ПРОЙДЕН</b>\n\n" +
          "<b>" + escapeHtml(displayName(query.from)) + "</b> подтвердил, что он человек.\n" +
          "Обычные очки за <code>туз/tuz</code> снова начисляются. Следующая проверка возможна не раньше чем через 2 часа."
      });
      return true;
    }

    if (status === "wrong") {
      const nextChallengeId = result.result_challenge_id;
      const nextTargetCode = result.result_target_code;
      const targetEmoji = HUMAN_EMOJIS[nextTargetCode] || "❓";

      await tg("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Не та кнопка. Попробуй новую проверку.",
        show_alert: true
      }).catch(() => {});

      await tg("editMessageText", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "HTML",
        text:
          "🤖 <b>HUMAN CHECK</b>\n\n" +
          "<b>" + escapeHtml(displayName(query.from)) + "</b>, нажми <b>" + targetEmoji + "</b>.\n\n" +
          "Пока проверка не пройдена, новые очки за <code>туз/tuz</code> не начисляются.",
        reply_markup: humanCheckMarkup(nextChallengeId, ownerId, nextTargetCode)
      });
      return true;
    }

    await tg("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Эта проверка уже завершена или устарела.",
      show_alert: true
    }).catch(() => {});
    return true;
  }

  if (!data.startsWith("pvp:")) return false;

  if (!msg?.chat) return true;

  const chatId = msg.chat.id;
  const challengeId = data.slice(4);

  const result = await settlePvpChallenge(chatId, challengeId, query.from);
  if (!result) {
    await send(chatId, "⚔️ Не удалось завершить PvP.");
    return true;
  }

  const status = String(result.result_status || "");

  if (status === "self") {
    await tg("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Нельзя принять собственный вызов.",
      show_alert: true
    }).catch(() => {});
    return true;
  }

  if (status === "acceptor_funds") {
    await tg("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "У тебя недостаточно очков для этой ставки.",
      show_alert: true
    }).catch(() => {});
    return true;
  }

  if (status === "creator_funds") {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
      text:
        "⚔️ <b>TUZ PVP отменён</b>\n\nУ автора вызова больше не хватает очков для ставки <b>" +
        Number(result.result_wager || 0) +
        "</b>."
    });
    return true;
  }

  if (status === "expired") {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "HTML",
      text: "⌛ <b>TUZ PVP истёк.</b> Создай новый вызов командой <code>/pvp N</code>."
    });
    return true;
  }

  if (status === "closed") {
    await tg("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Эта дуэль уже завершена.",
      show_alert: true
    }).catch(() => {});
    return true;
  }

  if (status !== "settled") {
    await tg("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Этот вызов больше недоступен.",
      show_alert: true
    }).catch(() => {});
    return true;
  }

  await tg("answerCallbackQuery", {
    callback_query_id: query.id,
    text: "⚔️ Дуэль завершена!"
  }).catch(() => {});

  const winner = await getUserById(chatId, result.result_winner_id);
  const loser = await getUserById(chatId, result.result_loser_id);
  const wager = Number(result.result_wager || 0);
  const winnerBattles = Number(result.winner_battles_total || 0);
  const winnerWins = Number(result.winner_wins || 0);
  const winnerStreak = Number(result.winner_win_streak || 0);
  const loserBattles = Number(result.loser_battles_total || 0);
  const loserWins = Number(result.loser_wins || 0);
  const winnerWinRate = winnerBattles > 0
    ? ((winnerWins / winnerBattles) * 100).toFixed(2)
    : "0.00";
  const loserWinRate = loserBattles > 0
    ? ((loserWins / loserBattles) * 100).toFixed(2)
    : "0.00";

  await tg("editMessageText", {
    chat_id: chatId,
    message_id: msg.message_id,
    parse_mode: "HTML",
    text:
      "⚔️ <b>TUZ PVP — РЕЗУЛЬТАТ</b>\n\n" +
      "Ставка: <b>" +
      wager +
      "</b>\n\n" +
      "🏆 <b>" +
      escapeHtml(displayName(winner || { id: result.result_winner_id })) +
      "</b> получает <b>+" +
      wager +
      "</b> → <b>" +
      Number(result.winner_score || 0) +
      "</b>\n" +
      "💀 <b>" +
      escapeHtml(displayName(loser || { id: result.result_loser_id })) +
      "</b> теряет <b>−" +
      wager +
      "</b> → <b>" +
      Number(result.loser_score || 0) +
      "</b>\n\n" +
      "📊 <b>PvP-статистика</b>\n" +
      "Процент выигрышей победителя — <b>" +
      winnerWinRate +
      "%</b>\n" +
      "🔥 Текущая серия побед — <b>" +
      winnerStreak +
      "</b>\n" +
      "Процент выигрышей проигравшего — <b>" +
      loserWinRate +
      "%</b>"
  });

  await refreshPinned(chatId);
  return true;
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
  const callback = update.callback_query;
  const msg = update.message || update.edited_message;

  try {
    if (callback) {
      await handleCallback(callback);
      return res.status(200).json({ ok: true });
    }

    if (!msg) {
      return res.status(200).json({ ok: true });
    }
    if (msg.text?.startsWith("/")) {
      const handled = await handleCommand(msg, req);
      if (handled) return res.status(200).json({ ok: true });
    }

    const delta = await processMessage(msg);
    if (delta !== 0) {
      await refreshPinned(msg.chat.id);
    }

    if (
      msg.from &&
      !msg.from.is_bot &&
      ["group", "supergroup"].includes(msg.chat?.type)
    ) {
      const humanCheck = await claimHumanCheckPrompt(msg.chat.id, msg.from.id);
      if (humanCheck) {
        await sendHumanCheck(msg.chat.id, msg.from, humanCheck);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("telegram webhook error", error);
    return res.status(500).json({ ok: false });
  }
}
