// ═══════════════════════════════════════════════
//   БУНКЕР — SERVER
//   Express + Telegraf Bot + WebSocket
// ═══════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const { Telegraf, Markup } = require('telegraf');
const { WebSocketServer } = require('ws');
const http       = require('http');
const path       = require('path');
const cors       = require('cors');

const BOT_TOKEN      = process.env.BOT_TOKEN;
const WEBAPP_URL     = process.env.WEBAPP_URL;
const TELEGRAPH_URL  = process.env.TELEGRAPH_URL || `${process.env.WEBAPP_URL}/rules.html`;
const PORT       = process.env.PORT || 3000;

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN не задан!'); process.exit(1); }
if (!WEBAPP_URL) { console.error('❌ WEBAPP_URL не задан!'); process.exit(1); }

// ── EXPRESS ──
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ROOMS STORAGE (in-memory) ──
// Structure: rooms[code] = { code, settings, players, state, chatId, messageId }
const rooms = new Map();

// ── WEBSOCKET SERVER ──
const wss = new WebSocketServer({ server });

// Map: ws → { playerId, roomCode }
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('🔌 WS connected');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWS(ws, msg);
    } catch (e) {
      console.error('WS parse error:', e.message);
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      const room = rooms.get(info.roomCode);
      if (room) {
        const p = room.players.find(x => x.id === info.playerId);
        if (p) p.online = false;
        broadcast(info.roomCode, { type: 'PLAYER_OFFLINE', playerId: info.playerId });
      }
    }
    clients.delete(ws);
  });
});

// ── WS MESSAGE HANDLER ──
function handleWS(ws, msg) {
  switch (msg.type) {

    // Player joins a room via WS
    case 'JOIN_ROOM': {
      const room = rooms.get(msg.roomCode);
      if (!room) { ws.send(JSON.stringify({ type: 'ERROR', text: 'Комната не найдена' })); return; }

      clients.set(ws, { playerId: msg.playerId, roomCode: msg.roomCode });
      const p = room.players.find(x => x.id === msg.playerId);
      if (p) p.online = true;

      // Send full state to the joining player
      ws.send(JSON.stringify({ type: 'STATE', state: room }));

      // Tell everyone else
      broadcast(msg.roomCode, { type: 'PLAYER_ONLINE', playerId: msg.playerId }, ws);
      console.log(`👤 Player ${msg.playerId} joined room ${msg.roomCode}`);
      break;
    }

    // Host starts the game
    case 'START_GAME': {
      const room = rooms.get(msg.roomCode);
      if (!room) return;
      room.phase = 'debate';
      room.round = 1;
      room.timeLeft = room.settings.debateSeconds;

      // Reveal round-1 card for all
      room.players.forEach(p => { if (p.cards && p.cards[0]) p.cards[0].revealed = true; });

      addLog(room, 'system', '☢ ИГРА НАЧАЛАСЬ', `Сценарий: ${room.disaster.name}`);
      addLog(room, 'reveal', 'Раунд 1 — Профессии', 'Все раскрыли профессию. Обсуждайте!');

      broadcastAll(msg.roomCode, { type: 'STATE', state: room });
      startRoomTimer(msg.roomCode);

      // Notify Telegram chat
      notifyChat(room, `▶️ *ИГРА НАЧАЛАСЬ*\n\n☣ Сценарий: ${room.disaster.name}\n🏚 Бункер: ${room.settings.bunkerSize} места\n\nРаунд 1 — все раскрывают *Профессию*\nТаймер: ${room.settings.debateSeconds}с`, true);
      break;
    }

    // Player casts a vote
    case 'CAST_VOTE': {
      const room = rooms.get(msg.roomCode);
      if (!room || room.phase !== 'voting') return;
      if (room.votes[msg.voterId]) return; // already voted

      room.votes[msg.voterId] = msg.targetId;

      const totalVoters = room.players.filter(p => !p.eliminated).length;
      const castCount   = Object.keys(room.votes).length;

      broadcastAll(msg.roomCode, { type: 'VOTE_CAST', voterId: msg.voterId, castCount, totalVoters });

      // All voted → resolve
      if (castCount >= totalVoters) {
        resolveVoting(msg.roomCode);
      }
      break;
    }

    // Use spec card
    case 'USE_SPEC': {
      const room = rooms.get(msg.roomCode);
      if (!room) return;
      const p = room.players.find(x => x.id === msg.playerId);
      if (!p || p.specCard.used) return;
      p.specCard.used = true;
      addLog(room, 'action', `${p.name} применил спецкарту`, `${p.specCard.name}`);
      broadcastAll(msg.roomCode, { type: 'STATE', state: room });
      break;
    }

    // Use action card
    case 'USE_ACTION': {
      const room = rooms.get(msg.roomCode);
      if (!room) return;
      const p = room.players.find(x => x.id === msg.playerId);
      if (!p || p.actionUsed[msg.idx]) return;
      p.actionUsed = p.actionUsed || {};
      p.actionUsed[msg.idx] = true;
      const ac = p.actionCards[msg.idx];
      addLog(room, 'action', `${p.name} применил карту`, `${ac.name}`);
      broadcastAll(msg.roomCode, { type: 'STATE', state: room });
      break;
    }

    // Continue to next round
    case 'NEXT_ROUND': {
      const room = rooms.get(msg.roomCode);
      if (!room) return;
      nextRound(msg.roomCode);
      break;
    }
  }
}

// ── ROOM TIMERS ──
const roomTimers = new Map();

function startRoomTimer(code) {
  clearInterval(roomTimers.get(code));
  const t = setInterval(() => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'debate') { clearInterval(t); return; }

    room.timeLeft--;
    broadcastAll(code, { type: 'TICK', timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      clearInterval(t);
      room.phase = 'voting';
      room.votes = {};
      addLog(room, 'system', `⏰ Время раунда ${room.round} вышло`, 'Начинается голосование!');
      broadcastAll(code, { type: 'STATE', state: room });

      // Notify Telegram
      notifyChat(room,
        `☠ *ГОЛОСОВАНИЕ — Раунд ${room.round}*\n\nВремя вышло! Кто покинет бункер?\n\n[Голосовать →](${WEBAPP_URL}/game.html?room=${code})`,
        false
      );
    }
  }, 1000);
  roomTimers.set(code, t);
}

// ── RESOLVE VOTING ──
function resolveVoting(code) {
  const room = rooms.get(code);
  if (!room) return;

  // Tally votes
  const tally = {};
  room.players.filter(p => !p.eliminated).forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(tid => { if (tally[tid] !== undefined) tally[tid]++; });

  // Find most voted
  let maxV = 0, eliminatedId = null;
  Object.entries(tally).forEach(([id, v]) => {
    room.players.find(p => p.id === +id).votes = v;
    if (v > maxV) { maxV = v; eliminatedId = +id; }
  });

  const elim = room.players.find(p => p.id === eliminatedId);
  if (elim) {
    elim.eliminated = true;
    elim.eliminatedRound = room.round;
    room.eliminated = room.eliminated || [];
    room.eliminated.push(eliminatedId);
    addLog(room, 'eliminated', `☠ ${elim.name} ИСКЛЮЧЁН`, `${maxV} голосов против`);
  }

  room.voteResult = { eliminatedId, voteCount: maxV };
  room.phase = 'result';

  const alive = room.players.filter(p => !p.eliminated);
  const isGameover = alive.length <= room.settings.bunkerSize || room.round >= room.settings.totalRounds;
  if (isGameover) room.phase = 'gameover';

  broadcastAll(code, { type: 'STATE', state: room });

  // Notify Telegram chat
  const elimInfo = elim ? `\n\n💀 *${elim.name}* исключён\nПрофессия: ${elim.cards[0]?.value}\nВозраст: ${elim.cards[1]?.value}\n${maxV} голосов против` : '';
  const survivorList = alive.map(p => `${p.emoji} ${p.name} — ${p.cards[0]?.value}`).join('\n');
  const msg = isGameover
    ? `🏆 *ИГРА ЗАВЕРШЕНА*${elimInfo}\n\n✅ В бункере выжили:\n${survivorList}`
    : `☠ *Раунд ${room.round} завершён*${elimInfo}\n\nВыжило: ${alive.length} · Осталось раундов: ${room.settings.totalRounds - room.round}`;

  notifyChat(room, msg, false);
}

// ── NEXT ROUND ──
function nextRound(code) {
  const room = rooms.get(code);
  if (!room) return;

  room.round++;
  room.votes = {};
  room.voteResult = null;
  room.timeLeft = room.settings.debateSeconds;

  const alive = room.players.filter(p => !p.eliminated);
  if (alive.length <= room.settings.bunkerSize) {
    room.phase = 'gameover';
    broadcastAll(code, { type: 'STATE', state: room });
    return;
  }

  room.phase = 'debate';
  const cardIdx = room.round - 1;
  const CARD_TYPES = ['profession','age','health','hobby','skill','bio','quality'];
  const CARD_LABELS = ['Профессия','Возраст','Здоровье','Хобби','Навык','Биоданные','Личн. качество'];

  // Reveal this round's card for all alive players
  alive.forEach(p => {
    if (p.cards[cardIdx]) p.cards[cardIdx].revealed = true;
  });

  const label = CARD_LABELS[cardIdx] || `Карта ${room.round}`;
  addLog(room, 'reveal', `Раунд ${room.round} — ${label}`, 'Все раскрыли следующую карту. Обсуждайте!');

  broadcastAll(code, { type: 'STATE', state: room });
  startRoomTimer(code);

  notifyChat(room,
    `🔔 *РАУНД ${room.round} — ${label.toUpperCase()}*\n\nВсе открыли новую карту!\nТаймер: ${room.settings.debateSeconds}с\n\n[Открыть →](${WEBAPP_URL}/game.html?room=${code})`,
    false
  );
}

// ── BROADCAST HELPERS ──
function broadcast(code, msg, excludeWs = null) {
  const json = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (info.roomCode === code && ws !== excludeWs && ws.readyState === 1) {
      ws.send(json);
    }
  }
}

function broadcastAll(code, msg) {
  broadcast(code, msg, null);
}

// ── LOG ──
function addLog(room, type, title, body) {
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  room.log = room.log || [];
  room.log.unshift({ type, title, body, ts, round: room.round });
}

// ═══════════════════════════════════════════════
//   REST API
// ═══════════════════════════════════════════════

// Create room
app.post('/api/rooms', (req, res) => {
  const { settings, player, disaster } = req.body;
  const code = Math.random().toString(36).substr(2, 4).toUpperCase();

  const room = {
    code,
    phase: 'lobby',
    settings: {
      maxPlayers:     Math.max(4, Math.min(8,  settings.maxPlayers     || 6)),
      bunkerSize:     Math.max(1, Math.min(5,  settings.bunkerSize     || 3)),
      totalRounds:    Math.max(2, Math.min(7,  settings.totalRounds    || 4)),
      debateSeconds:  Math.max(30, Math.min(180, settings.debateSeconds || 90)),
    },
    players:   [{ ...player, id: 1, isHost: true, online: true, eliminated: false, votes: 0, actionUsed: {} }],
    disaster,
    round:     1,
    timeLeft:  settings.debateSeconds || 90,
    votes:     {},
    voteResult: null,
    eliminated: [],
    log:       [],
    chatId:    settings.chatId || null,
    messageId: null,
  };

  addLog(room, 'system', '☢ Комната создана', `Код: ${code} · Хост: ${player.name}`);
  rooms.set(code, room);

  console.log(`🏚 Room created: ${code}`);
  res.json({ ok: true, roomCode: code, room });
});

// Join room
app.post('/api/rooms/:code/join', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: 'Комната не найдена' });
  if (room.phase !== 'lobby') return res.status(400).json({ ok: false, error: 'Игра уже идёт' });
  if (room.players.length >= room.settings.maxPlayers)
    return res.status(400).json({ ok: false, error: 'Комната заполнена' });

  const newId = Math.max(...room.players.map(p => p.id)) + 1;
  const player = { ...req.body.player, id: newId, isHost: false, online: true, eliminated: false, votes: 0, actionUsed: {} };
  room.players.push(player);

  addLog(room, 'system', `${player.name} вошёл в комнату`, '');
  broadcastAll(req.params.code, { type: 'PLAYER_JOINED', player });
  broadcastAll(req.params.code, { type: 'STATE', state: room });

  res.json({ ok: true, playerId: newId, room });
});

// Get room
app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: 'Не найдена' });
  res.json({ ok: true, room });
});

// ═══════════════════════════════════════════════
//   TELEGRAM BOT
// ═══════════════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);

// ── Главное сообщение с кнопкой игры ──
async function sendBunkerMessage(ctx) {
  const chatId = ctx.chat.id;
  const text =
    `☢ *БУНКЕР* — игра на выживание\n\n` +
    `Мир погибает\\. В бункере ограниченное количество мест\\.\n` +
    `Убеди остальных, что ты нужен — или останешься снаружи\\.\n\n` +
    `👥 *4–8 игроков*\n` +
    `🃏 *Случайные персонажи*\n` +
    `💬 *Дебаты \\+ тайное голосование*\n` +
    `☠ *Каждый раунд кто\\-то выбывает*`;

  try {
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🏚 Создать игру', `${WEBAPP_URL}?chatId=${chatId}`)],
        [Markup.button.url('📖 Правила', telegraphUrl)],
      ]),
    });
  } catch (e) {
    // fallback без markdown если ошибка
    await ctx.reply('☢ БУНКЕР — игра на выживание\n\n4–8 игроков · Дебаты · Тайное голосование', {
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🏚 Создать игру', `${WEBAPP_URL}?chatId=${chatId}`)],
        [Markup.button.url('📖 Правила', telegraphUrl)],
      ]),
    });
  }
}

// /start
bot.start(async (ctx) => {
  await sendBunkerMessage(ctx);
});

// /бункер — кириллица (ГЛАВНАЯ команда)
bot.command('бункер', async (ctx) => {
  await sendBunkerMessage(ctx);
});

// /bunker — латиница
bot.command('bunker', async (ctx) => {
  await sendBunkerMessage(ctx);
});

// /newgame, /game — алиасы
bot.command('newgame', async (ctx) => { await sendBunkerMessage(ctx); });
bot.command('game',    async (ctx) => { await sendBunkerMessage(ctx); });

// /join XXXX
bot.command('join', async (ctx) => {
  const code = ctx.message.text.split(' ')[1]?.toUpperCase();
  if (!code || code.length !== 4) {
    await ctx.reply('Укажи код: /join XXXX');
    return;
  }
  await ctx.reply(`☢ Войти в комнату ${code}:`, {
    ...Markup.inlineKeyboard([
      [Markup.button.webApp(`→ Войти в ${code}`, `${WEBAPP_URL}/game.html?room=${code}`)],
    ]),
  });
});

// /rooms — дебаг
bot.command('rooms', async (ctx) => {
  if (rooms.size === 0) { await ctx.reply('Нет активных комнат'); return; }
  const list = [...rooms.values()].map(r =>
    `• ${r.code} · ${r.players.length} игроков · ${r.phase}`
  ).join('\n');
  await ctx.reply(`☢ Активные комнаты:\n${list}`);
});

// ── Ловим текстовые триггеры в группах ──
// Срабатывает если написать "бункер" или "бункер!" или "@botname bunker" и т.д.
bot.hears(/^(бункер|bunker|бунк)(@\w+)?$/i, async (ctx) => {
  await sendBunkerMessage(ctx);
});

// Ловим ошибки — чтобы бот не крашился
bot.catch((err, ctx) => {
  console.error(`Bot error [${ctx?.updateType}]:`, err.message);
});

// ── Send notification to Telegram chat ──
async function notifyChat(room, text, withJoinBtn) {
  if (!room.chatId) return;
  try {
    const keyboard = withJoinBtn
      ? Markup.inlineKeyboard([[Markup.button.webApp('🏚 Войти в игру', `${WEBAPP_URL}/game.html?room=${room.code}`)]])
      : Markup.inlineKeyboard([[Markup.button.webApp('→ Открыть', `${WEBAPP_URL}/game.html?room=${room.code}`)]]);

    const sent = await bot.telegram.sendMessage(room.chatId, text, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
    room.messageId = sent.message_id;
  } catch (e) {
    console.error('Telegram notify error:', e.message);
  }
}

// ── Bot webhook on Railway ──
const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
app.use(WEBHOOK_PATH, (req, res) => bot.handleUpdate(req.body, res));

// ═══════════════════════════════════════════════
//   AUTO-CREATE TELEGRAPH PAGE
// ═══════════════════════════════════════════════
const https = require('https');

let telegraphUrl = TELEGRAPH_URL;

function telegraphRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegra.ph',
      path: `/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function createTelegraphPage() {
  // Если уже задан через env — не создаём
  if (process.env.TELEGRAPH_URL) {
    telegraphUrl = process.env.TELEGRAPH_URL;
    console.log('✅ Telegraph URL из env:', telegraphUrl);
    return;
  }

  console.log('📝 Создаём страницу правил на Telegraph...');
  try {
    const account = await telegraphRequest('createAccount', {
      short_name: 'Bunker Game',
      author_name: 'БУНКЕР — игра выживания',
      author_url: WEBAPP_URL,
    });
    if (!account.ok) throw new Error(account.error);
    const token = account.result.access_token;

    const content = [
      { tag: 'p', children: ['☢ Постапокалиптическая игра на дебаты для 4–8 игроков. Мир погибает — в бункере ограниченное количество мест. Убеди остальных, что ты нужен, или останешься снаружи.'] },
      { tag: 'hr' },
      { tag: 'h3', children: ['🏚 Цель игры'] },
      { tag: 'p', children: ['Каждый игрок получает случайного персонажа с уникальными характеристиками. Раскрывая их по одной за раунд — убеждай остальных, что именно ты достоин места в бункере. Кто не убедил — выбывает.'] },
      { tag: 'hr' },
      { tag: 'h3', children: ['👥 Участники'] },
      { tag: 'p', children: ['4 до 8 игроков. Хост создаёт комнату и задаёт параметры: количество мест в бункере, число раундов, время на дебаты. Остальные входят по 4-значному коду.'] },
      { tag: 'hr' },
      { tag: 'h3', children: ['🃏 Карточки персонажа'] },
      { tag: 'p', children: ['Каждый получает 7 характеристик. Они скрыты — раскрываются по одной за раунд:'] },
      { tag: 'ul', children: [
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 1 — 👤 Профессия.'] }, ' Хирург, Биолог, Мародёр, Инженер...'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 2 — 🎂 Возраст.'] }, ' От 8 лет до 75. Влияет на выносливость и опыт.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 3 — ❤️ Здоровье.'] }, ' Абсолютно здоров, Астма, Диабет, Беременность...'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 4 — 🎯 Хобби.'] }, ' Огородничество, Стрельба, Радиолюбитель...'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 5 — 🔧 Навык.'] }, ' Чинит генераторы, Знает 3 языка, Первая помощь...'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 6 — 🧬 Биоданные.'] }, ' Семья, дети, особые обстоятельства.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд 7 — 🧠 Личное качество.'] }, ' Лидер, Паникёр, Манипулятор...'] },
      ]},
      { tag: 'hr' },
      { tag: 'h3', children: ['🔄 Ход игры'] },
      { tag: 'ol', children: [
        { tag: 'li', children: [{ tag: 'b', children: ['Раунд начинается.'] }, ' Все одновременно видят одну новую карту.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['⏱ Дебаты.'] }, ' Пока идёт таймер — обсуждайте голосом. Голосование заблокировано.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🗳 Тайное голосование.'] }, ' Таймер истёк — все голосуют в приложении. Кто наберёт больше голосов — выбывает.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['☠ Исключение.'] }, ' Выбывший уходит. Его карточка раскрывается всем.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🏆 Финал.'] }, ' Когда остаётся столько игроков, сколько мест — они победили.'] },
      ]},
      { tag: 'hr' },
      { tag: 'h3', children: ['✨ Спецкарты (1 раз за игру)'] },
      { tag: 'ul', children: [
        { tag: 'li', children: [{ tag: 'b', children: ['🛡 Иммунитет'] }, ' — нельзя исключить в этом раунде.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🔍 Разведка'] }, ' — узнать одну скрытую карту любого игрока.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🗣 Двойной голос'] }, ' — твой голос считается за два.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['📣 Обвинение'] }, ' — принудительно раскрыть карту соперника.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🎭 Маскировка'] }, ' — раскрыть фальшивую характеристику.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['⚡ Саботаж'] }, ' — аннулировать характеристику соперника на раунд.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🔄 Обмен'] }, ' — поменяться нераскрытой картой с любым игроком.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🤝 Союз'] }, ' — вы и партнёр не голосуете друг против друга.'] },
      ]},
      { tag: 'hr' },
      { tag: 'h3', children: ['☣ Сценарии катастроф'] },
      { tag: 'ul', children: [
        { tag: 'li', children: [{ tag: 'b', children: ['☢ Ядерная война'] }, ' — 12 лет изоляции. Медики и аграрии в приоритете.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['☣ Пандемия'] }, ' — биологи и фармацевты спасают всех.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🌊 Потоп'] }, ' — горный бункер. Строители и рыбаки нужны.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🌑 Метеорит'] }, ' — ядерная зима. Гидропоника и инженеры.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🧟 Зомби'] }, ' — военные, снайперы, психологи.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['🌪 Климатический коллапс'] }, ' — агрономы и ботаники решают всё.'] },
      ]},
      { tag: 'hr' },
      { tag: 'h3', children: ['💡 Советы выжившим'] },
      { tag: 'ul', children: [
        { tag: 'li', children: [{ tag: 'b', children: ['Не раскрывай всё сразу.'] }, ' Лучшие карты держи в запасе — покажи когда тебя хотят выгнать.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Создавай союзы.'] }, ' Найди игрока с дополняющими навыками и договорись голосовать вместе.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Атакуй молчунов.'] }, ' Тот, кто прячет карты — самая лёгкая цель.'] },
        { tag: 'li', children: [{ tag: 'b', children: ['Спецкарту — в финал.'] }, ' Иммунитет бесполезен в раунде 1. Придержи до критического момента.'] },
      ]},
      { tag: 'hr' },
      { tag: 'p', children: [{ tag: 'b', children: ['Удачи. Бункер ждёт. ☢'] }] },
    ];

    const page = await telegraphRequest('createPage', {
      access_token: token,
      title: '☢ БУНКЕР — Правила игры',
      author_name: 'БУНКЕР — игра выживания',
      author_url: WEBAPP_URL,
      content: JSON.stringify(content),
    });

    if (!page.ok) throw new Error(page.error);
    telegraphUrl = page.result.url;
    console.log('✅ Telegraph страница создана:', telegraphUrl);
    console.log('💡 Добавь в Railway: TELEGRAPH_URL=' + telegraphUrl);
  } catch (e) {
    console.error('⚠️ Telegraph не создан, используем fallback:', e.message);
    telegraphUrl = `${WEBAPP_URL}/rules.html`;
  }
}

// ═══════════════════════════════════════════════
//   START SERVER
// ═══════════════════════════════════════════════
server.listen(PORT, async () => {
  console.log(`\n☢ БУНКЕР сервер запущен на порту ${PORT}`);
  console.log(`📱 Webapp: ${WEBAPP_URL}`);

  // Создаём Telegraph страницу автоматически
  await createTelegraphPage();

  console.log(`🤖 Bot: @${(await bot.telegram.getMe().catch(() => ({ username: '?' }))).username}\n`);

  // Set webhook
  try {
    await bot.telegram.setWebhook(`${WEBAPP_URL}${WEBHOOK_PATH}`, {
      allowed_updates: ['message', 'callback_query', 'inline_query'],
    });
    console.log('✅ Webhook установлен');

    const cmds = [
      { command: 'бункер',  description: '☢ Создать игру' },
      { command: 'bunker',  description: '☢ Create game (English)' },
      { command: 'join',    description: '→ Войти по коду: /join XXXX' },
      { command: 'rooms',   description: '📋 Активные комнаты' },
    ];
    await bot.telegram.setMyCommands(cmds);
    await bot.telegram.setMyCommands(cmds, { scope: { type: 'all_group_chats' } });
    await bot.telegram.setMyCommands(cmds, { scope: { type: 'all_private_chats' } });
    console.log('✅ Команды установлены для групп и личных чатов');
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
    bot.launch({ allowedUpdates: ['message', 'callback_query'] });
    console.log('🔄 Запущен polling (локальный режим)');
  }
});

// Graceful shutdown
process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
