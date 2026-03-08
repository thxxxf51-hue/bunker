// ═══════════════════════════════════════
//   BUNKER GAME — ENGINE (State Manager)
// ═══════════════════════════════════════

const ENGINE = (() => {
  const STORE_KEY = 'bunker_game_state';

  // ── DEFAULT STATE ──
  const defaultState = () => ({
    version: 1,
    phase: 'lobby',     // lobby | debate | voting | result | gameover
    roomCode: '',
    roomName: '',
    hostId: null,

    // Settings (set in lobby)
    settings: {
      maxPlayers: 6,
      bunkerSize: 3,
      totalRounds: 4,
      debateSeconds: 90,
    },

    // Players array
    players: [],
    myPlayerId: null,

    // Round
    round: 1,           // 1-based, maps to card index (round-1)
    timeLeft: 90,
    timerRunning: false,

    // Voting
    votes: {},          // { voterId: targetId }
    myVoted: false,
    voteResult: null,   // { eliminatedId, voteCount }

    // Disaster
    disaster: null,

    // Log
    log: [],

    // Eliminated history
    eliminated: [],
  });

  // ── PERSISTENCE ──
  function save(state) {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function clear() {
    localStorage.removeItem(STORE_KEY);
  }

  // ── PLAYER GENERATION ──
  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function generateCards() {
    return DATA.CARD_TYPES.map(type => {
      let value;
      switch (type.key) {
        case 'profession': value = rand(DATA.PROFESSIONS); break;
        case 'age':        value = rand(DATA.AGES); break;
        case 'health':     value = rand(DATA.HEALTH); break;
        case 'hobby':      value = rand(DATA.HOBBIES); break;
        case 'skill':      value = rand(DATA.SKILLS); break;
        case 'bio':        value = rand(DATA.BIO); break;
        case 'quality':    value = rand(DATA.QUALITIES); break;
        default:           value = '—';
      }
      return {
        key: type.key,
        label: type.label,
        icon: type.icon,
        value,
        revealed: false,   // becomes true when player reveals in their round
      };
    });
  }

  function generatePlayer(preset) {
    return {
      id: preset.id,
      name: preset.name,
      emoji: preset.emoji,
      isMe: preset.isMe || false,
      isHost: preset.isHost || false,
      ready: preset.ready || false,
      eliminated: false,
      eliminatedRound: null,
      cards: generateCards(),
      baggage: [rand(DATA.BAGGAGE), rand(DATA.BAGGAGE)].filter((v,i,a) => a.indexOf(v) === i),
      specCard: { ...rand(DATA.SPEC_CARDS), used: false },
      actionCards: [rand(DATA.ACTION_CARDS)],
      actionUsed: {},
      votes: 0,
    };
  }

  // ── ROOM CREATION ──
  function createRoom(settings, myName, myEmoji) {
    const state = defaultState();
    state.roomCode = Math.random().toString(36).substr(2, 4).toUpperCase();
    state.roomName = settings.roomName || `Бункер-${state.roomCode}`;
    state.settings = {
      maxPlayers: settings.maxPlayers || 6,
      bunkerSize: settings.bunkerSize || 3,
      totalRounds: Math.min(settings.totalRounds || 4, DATA.CARD_TYPES.length),
      debateSeconds: settings.debateSeconds || 90,
    };

    // Demo: pre-fill with AI players
    const aiNames = [
      { name: "МАРИНА",  emoji: "👩" },
      { name: "ДМИТРИЙ", emoji: "🧑" },
      { name: "СОНЯ",    emoji: "👧" },
      { name: "ИГОРЬ",   emoji: "👴" },
      { name: "КАТЯ",    emoji: "👩‍🦰" },
      { name: "АНТОН",   emoji: "🧔" },
      { name: "ВЕРА",    emoji: "👱‍♀️" },
    ];

    const myPlayer = generatePlayer({
      id: 1, name: myName.toUpperCase(), emoji: myEmoji,
      isMe: true, isHost: true, ready: true,
    });
    state.myPlayerId = 1;
    state.hostId = 1;

    const totalAI = Math.min(state.settings.maxPlayers - 1, aiNames.length);
    const aiPlayers = aiNames.slice(0, totalAI).map((p, i) => generatePlayer({
      id: i + 2, ...p, ready: i < totalAI - 1,
    }));

    state.players = [myPlayer, ...aiPlayers];
    state.disaster = rand(DATA.DISASTERS);
    state.phase = 'lobby';
    state.timeLeft = state.settings.debateSeconds;
    save(state);
    return state;
  }

  // ── GAME START ──
  function startGame(state) {
    state.phase = 'debate';
    state.round = 1;
    state.timeLeft = state.settings.debateSeconds;
    state.votes = {};
    state.myVoted = false;
    state.voteResult = null;

    // Reveal round-1 card (index 0 = profession) for all players
    state.players.forEach(p => {
      if (!p.eliminated) {
        p.cards[0].revealed = true;
      }
    });

    addLog(state, 'system', '☢ ИГРА НАЧАЛАСЬ',
      `Сценарий: ${state.disaster.name} · Бункер вмещает ${state.settings.bunkerSize} чел.`);
    addLog(state, 'reveal', 'Раунд 1 — Профессии',
      'Каждый игрок раскрыл свою профессию. Обсуждайте!');

    save(state);
    return state;
  }

  // ── TIMER TICK ──
  function tick(state) {
    if (state.timeLeft > 0) {
      state.timeLeft--;
    }
    if (state.timeLeft === 0 && state.phase === 'debate') {
      state.phase = 'voting';
      addLog(state, 'system', `⏰ Время вышло — Раунд ${state.round}`,
        'Начинается голосование. Кто покинет бункер?');
    }
    save(state);
    return state;
  }

  // ── VOTING ──
  function castVote(state, targetId) {
    const me = state.players.find(p => p.id === state.myPlayerId);
    if (!me || state.myVoted || state.phase !== 'voting') return state;

    state.votes[state.myPlayerId] = targetId;
    state.myVoted = true;

    // Simulate AI votes
    const alive = state.players.filter(p => !p.eliminated && p.id !== state.myPlayerId);
    alive.forEach(p => {
      if (!state.votes[p.id]) {
        // AI votes: bias toward selected target
        const r = Math.random();
        if (r < 0.55) {
          state.votes[p.id] = targetId;
        } else {
          const others = alive.filter(x => x.id !== p.id);
          if (others.length > 0) {
            state.votes[p.id] = rand(others).id;
          } else {
            state.votes[p.id] = targetId;
          }
        }
      }
    });

    // Tally
    const tally = {};
    const aliveIds = state.players.filter(p => !p.eliminated).map(p => p.id);
    aliveIds.forEach(id => { tally[id] = 0; });
    Object.values(state.votes).forEach(tid => {
      if (tally[tid] !== undefined) tally[tid]++;
    });

    // Find max
    let maxVotes = 0;
    let eliminatedId = null;
    Object.entries(tally).forEach(([id, v]) => {
      state.players.find(p => p.id === +id).votes = v;
      if (v > maxVotes) { maxVotes = v; eliminatedId = +id; }
    });

    state.voteResult = { eliminatedId, voteCount: maxVotes };
    state.phase = 'result';

    const elim = state.players.find(p => p.id === eliminatedId);
    if (elim) {
      elim.eliminated = true;
      elim.eliminatedRound = state.round;
      state.eliminated.push(eliminatedId);
      addLog(state, 'eliminated', `☠ ${elim.name} ИСКЛЮЧЁН`,
        `${maxVotes} голосов против · Раунд ${state.round}`);
    }

    save(state);
    return state;
  }

  // ── NEXT ROUND ──
  function nextRound(state) {
    state.round++;
    state.votes = {};
    state.myVoted = false;
    state.voteResult = null;
    state.timeLeft = state.settings.debateSeconds;

    const aliveCount = state.players.filter(p => !p.eliminated).length;

    // Check game over
    if (aliveCount <= state.settings.bunkerSize || state.round > state.settings.totalRounds) {
      state.phase = 'gameover';
      const survivors = state.players.filter(p => !p.eliminated).map(p => p.name).join(', ');
      addLog(state, 'survival', '☢ ИГРА ЗАВЕРШЕНА',
        `В бункере: ${survivors}`);
      save(state);
      return state;
    }

    state.phase = 'debate';

    // Reveal card for this round (index = round - 1)
    const cardIdx = state.round - 1;
    if (cardIdx < DATA.CARD_TYPES.length) {
      state.players.forEach(p => {
        if (!p.eliminated && p.cards[cardIdx]) {
          p.cards[cardIdx].revealed = true;
        }
      });
      const cardType = DATA.CARD_TYPES[cardIdx];
      addLog(state, 'reveal', `Раунд ${state.round} — ${cardType.label}`,
        `Все игроки раскрыли: ${cardType.icon} ${cardType.label}`);
    }

    save(state);
    return state;
  }

  // ── SPEC CARD USE ──
  function useSpecCard(state) {
    const me = state.players.find(p => p.id === state.myPlayerId);
    if (!me || me.specCard.used) return state;
    me.specCard.used = true;
    addLog(state, 'action', `ВЫ применили спецкарту`,
      `${me.specCard.name}: ${me.specCard.desc}`);
    save(state);
    return state;
  }

  // ── ACTION CARD USE ──
  function useActionCard(state, idx) {
    const me = state.players.find(p => p.id === state.myPlayerId);
    if (!me || me.actionUsed[idx]) return state;
    me.actionUsed[idx] = true;
    const ac = me.actionCards[idx];
    addLog(state, 'action', `ВЫ применили карту действия`,
      `${ac.name}: ${ac.desc}`);
    save(state);
    return state;
  }

  // ── LOG ──
  function addLog(state, type, title, body) {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    state.log.unshift({ type, title, body, ts, round: state.round });
  }

  // ── GETTERS ──
  function getMe(state) {
    return state.players.find(p => p.id === state.myPlayerId);
  }

  function getAlive(state) {
    return state.players.filter(p => !p.eliminated);
  }

  function getVoteCount(state) {
    return Object.keys(state.votes).length;
  }

  function getTotalVoters(state) {
    return getAlive(state).length;
  }

  return {
    save, load, clear, createRoom, startGame,
    tick, castVote, nextRound, useSpecCard, useActionCard,
    getMe, getAlive, getVoteCount, getTotalVoters, addLog,
    defaultState,
  };
})();
