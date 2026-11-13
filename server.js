'use strict';
// Thinkage Triplified: room-based multiplayer server. One Node process, WebSockets, no database.
// Games live in memory, so a server restart ends any game in progress.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const WORDSETS = require('./words');

const PORT = Number(process.env.PORT) || 3000;
const SCALE = Number(process.env.TIME_SCALE) || 1; // tests shrink the clock
// ---- Tuning knobs: change these to rebalance the game after playtesting ----
const ROUND_SECONDS = { 3: 180, 4: 210, 5: 240, 6: 270 }; // one clock for Link and Think together
const WORD_COUNT = n => (n <= 4 ? 14 : 16); // words on the list each round
const SCORE_BY_SLOTS = { 0: 0, 1: 0, 2: 2, 3: 5 }; // points for how many of the 3 blanks are right
const STAR_MULTIPLIER = 2; // a starred guess that scores gets its points times this
const STAR_MISS_PENALTY = 2; // a starred guess that scores nothing loses this many points
const MIN_WORDS = 48; // a list must cover 3 rounds of up to 16 words
const ROUNDS = 3;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};

// Check the word lists at startup so a bad edit fails loudly instead of mid-game.
for (const [key, set] of Object.entries(WORDSETS)) {
  const clean = set.words.map(w => String(w).trim());
  const dupes = clean.filter((w, i) => clean.indexOf(w) !== i);
  if (clean.length < MIN_WORDS) throw new Error('Word list "' + key + '" needs at least ' + MIN_WORDS + ' words (3 rounds of up to 16). It has ' + clean.length + '.');
  if (clean.some(w => !w)) throw new Error('Word list "' + key + '" has an empty word.');
  if (dupes.length) console.warn('Word list "' + key + '" has duplicate words: ' + [...new Set(dupes)].join(', '));
  set.words = clean;
}

const rooms = new Map();

/* ---------- small helpers ---------- */

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
// Duplicates: exact same order OR exact reverse (A-B-C and C-B-A share a key). Any other order is a different chain.
const chainKey = chain => { const f = chain.join('-'), r = chain.slice().reverse().join('-'); return f < r ? f : r; };
const roundMs = n => ROUND_SECONDS[n] * 1000 * SCALE;
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14);

function rate(pct) {
  if (pct >= 90) return 'Excellent';
  if (pct >= 80) return 'Good';
  if (pct >= 70) return 'OK';
  if (pct >= 60) return 'Satisfactory';
  if (pct >= 50) return 'Were you really trying?';
  return 'Not good! Better luck next time.';
}

/* ---------- rooms and players ---------- */

function newRoom() {
  return {
    code: makeCode(),
    hostId: null,
    players: [],
    wordset: 'classic',
    phase: 'lobby', // lobby | link | think | vote | results | over
    round: 0,
    pool: [],
    poolIdx: 0,
    words: [],
    groups: [],
    results: null,
    endReason: null,
    paused: false,
    remainingMs: 0,
    endAt: 0,
    totalMs: 0,
    lastActive: Date.now()
  };
}

function addPlayer(room, name, ws) {
  const p = {
    id: newId(),
    token: newToken(),
    name,
    ws,
    online: true,
    assigned: null,
    chain: null, // three word indexes in order
    clues: null, // two clue words: clues[0] sits between chain[0] and chain[1], clues[1] between chain[1] and chain[2]
    guesses: {},
    locked: false,
    roundPoints: []
  };
  room.players.push(p);
  return p;
}

function resetPlayerRound(p) {
  p.chain = null;
  p.clues = null;
  p.guesses = {};
  p.locked = false;
}

function remaining(room) {
  return room.paused ? room.remainingMs : Math.max(0, room.endAt - Date.now());
}

/* ---------- game flow ---------- */

function startGame(room) {
  const set = WORDSETS[room.wordset];
  room.pool = shuffle(set.words.slice());
  room.poolIdx = 0;
  room.round = 0;
  room.players.forEach(p => {
    p.roundPoints = [];
  });
  startRound(room);
}

function startRound(room) {
  const n = room.players.length;
  const count = WORD_COUNT(n);
  room.round += 1;
  room.words = room.pool.slice(room.poolIdx, room.poolIdx + count);
  room.poolIdx += count;
  const order = shuffle([...Array(count).keys()]);
  room.players.forEach((p, i) => {
    resetPlayerRound(p);
    p.assigned = order[i];
  });
  room.groups = [];
  room.results = null;
  room.endReason = null;
  room.phase = 'link';
  room.totalMs = roundMs(n);
  room.paused = false;
  room.endAt = Date.now() + room.totalMs;
}

function startThink(room) {
  room.phase = 'think';
}

// The round clock ran out while someone was still linking: no Think phase, zero points.
function failLink(room) {
  const points = {};
  room.players.forEach(p => {
    points[p.id] = 0;
    p.roundPoints.push(0);
  });
  room.results = {
    failedLink: true,
    reason: 'time',
    teamPoints: 0,
    points,
    linkStatus: room.players.map(p => ({ id: p.id, submitted: p.chain !== null })),
    targets: [],
    groups: [],
    cells: {}
  };
  room.phase = 'results';
}

// Think is over (everyone locked in, or time ran out). Players with the identical chain trigger a vote.
function endThink(room) {
  const byKey = new Map();
  room.players.forEach(p => {
    if (p.chain === null) return;
    const k = chainKey(p.chain);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p.id);
  });
  room.groups = [];
  for (const [key, members] of byKey) {
    if (members.length > 1) {
      const first = room.players.find(p => p.id === members[0]);
      room.groups.push({ id: room.groups.length, key, chain: first.chain.slice(), members, votes: {}, same: null });
    }
  }
  if (room.groups.length) room.phase = 'vote';
  else finishRound(room);
}

function votesComplete(room) {
  return room.groups.every(g =>
    room.players.every(p => g.members.includes(p.id) || g.votes[p.id] !== undefined)
  );
}

function slotsRight(guess, chain) {
  if (!guess) return 0;
  let k = 0;
  for (let i = 0; i < 3; i++) if (guess.slots[i] !== null && guess.slots[i] === chain[i]) k++;
  return k;
}
function pointsFor(k, star) {
  const base = SCORE_BY_SLOTS[k] || 0;
  if (!star) return base;
  return base > 0 ? base * STAR_MULTIPLIER : -STAR_MISS_PENALTY;
}

function scoreRound(room) {
  const players = room.players;
  const subs = players.filter(p => p.chain !== null);
  const byKey = new Map();
  subs.forEach(p => {
    const k = chainKey(p.chain);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p.id);
  });
  const sameByKey = new Map(room.groups.map(g => [g.key, g.same]));
  const chainOf = new Map(subs.map(p => [p.id, p.chain]));
  const points = {};
  players.forEach(p => (points[p.id] = 0));
  const cells = {};
  subs.forEach(t => (cells[t.id] = {}));

  for (const g of players) {
    for (const [key, members] of byKey) {
      const targets = members.filter(m => m !== g.id);
      if (!targets.length) continue;
      const voided = members.length > 1 && sameByKey.get(key) === true;
      const evals = targets.map(tid => {
        const gs = g.guesses[tid];
        if (!gs) return { tid, status: 'none', star: false, k: 0, slots: null, pts: 0 };
        const k = slotsRight(gs, chainOf.get(tid));
        return {
          tid,
          status: k === 3 ? 'correct' : k > 0 ? 'partial' : 'wrong',
          star: !!gs.star,
          k,
          slots: gs.slots,
          pts: pointsFor(k, !!gs.star)
        };
      });
      // A chain shared by two players scores once per guesser: the best result counts.
      let carrier = null;
      if (!voided) carrier = evals.reduce((best, e) => (!best || e.pts > best.pts ? e : best), null);
      evals.forEach(e => {
        const cell = { status: e.status, star: e.star, k: e.k, slots: e.slots, pts: 0, note: null };
        if (voided) cell.note = 'void';
        else if (e === carrier) cell.pts = e.pts;
        else if (members.length > 1 && e.status !== 'none') cell.note = 'once';
        cells[e.tid][g.id] = cell;
      });
      if (carrier) points[g.id] += carrier.pts;
    }
  }
  return { points, cells };
}

function finishRound(room) {
  room.groups.forEach(g => {
    const vals = Object.values(g.votes);
    g.yes = vals.filter(v => v === true).length;
    g.no = vals.filter(v => v === false).length;
    g.same = g.yes > g.no; // a tie counts as "different"
  });
  const { points, cells } = scoreRound(room);
  let team = 0;
  room.players.forEach(p => {
    p.roundPoints.push(points[p.id]);
    team += points[p.id];
  });
  const groupOf = new Map();
  room.groups.forEach(g => g.members.forEach(m => groupOf.set(m, g.id)));
  room.results = {
    failedLink: false,
    reason: room.endReason || 'all',
    teamPoints: team,
    points,
    cells,
    targets: room.players
      .filter(p => p.chain !== null)
      .map(p => ({
        id: p.id,
        name: p.name,
        chain: p.chain,
        clues: p.clues,
        assigned: p.assigned,
        group: groupOf.has(p.id) ? groupOf.get(p.id) : null
      })),
    groups: room.groups.map(g => ({
      id: g.id,
      chain: g.chain,
      members: g.members,
      same: g.same,
      yes: g.yes,
      no: g.no
    }))
  };
  room.phase = 'results';
}

/* ---------- views sent to each phone (never leaks hidden info) ---------- */

function doneFlag(room, p) {
  if (room.phase === 'link') return p.chain !== null;
  if (room.phase === 'think') return p.locked;
  if (room.phase === 'vote') {
    return !room.groups.some(g => !g.members.includes(p.id) && g.votes[p.id] === undefined);
  }
  return false;
}

function scoreboard(room) {
  const n = room.players.length;
  const byPlayer = {};
  let team = 0;
  room.players.forEach(p => {
    const total = p.roundPoints.reduce((a, b) => a + b, 0);
    byPlayer[p.id] = { rounds: p.roundPoints.slice(), total };
    team += total;
  });
  const perfect = n * (n - 1) * ROUNDS * SCORE_BY_SLOTS[3] * 1.25; // everyone nails everyone, plus 25% for stars
  const pct = perfect > 0 ? Math.max(0, Math.floor((team / perfect) * 100)) : 0;
  return { byPlayer, team, perfect, pct, rating: rate(pct) };
}

function viewFor(room, me) {
  const v = {
    code: room.code,
    you: me.id,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    rounds: ROUNDS,
    wordset: room.wordset,
    wordsets: Object.entries(WORDSETS).map(([key, w]) => ({ key, name: w.name })),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    times: ROUND_SECONDS,
    scoring: { full: SCORE_BY_SLOTS[3], two: SCORE_BY_SLOTS[2], starMultiplier: STAR_MULTIPLIER, starPenalty: STAR_MISS_PENALTY },
    endReason: room.endReason,
    players: room.players.map(p => ({ id: p.id, name: p.name, online: p.online, done: doneFlag(room, p) }))
  };
  if (room.phase === 'link' || room.phase === 'think') {
    v.timer = { total: room.totalMs, remainingMs: remaining(room), paused: room.paused };
    v.words = room.words;
    v.me = { assigned: me.assigned, chain: me.chain, clues: me.clues, guesses: me.guesses, locked: me.locked };
  }
  if (room.phase === 'think') {
    v.targets = room.players
      .filter(p => p.id !== me.id)
      .map(p => ({ id: p.id, name: p.name, clues: p.clues }));
  }
  if (room.phase === 'vote') {
    v.words = room.words;
    v.vote = {
      groups: room.groups.map(g => ({
        id: g.id,
        chain: g.chain,
        members: g.members.map(id => {
          const p = room.players.find(x => x.id === id);
          return { id, name: p.name, clues: p.clues, chain: p.chain };
        }),
        canVote: !g.members.includes(me.id),
        myVote: g.votes[me.id],
        voters: room.players.filter(p => !g.members.includes(p.id)).map(p => p.id),
        voted: Object.keys(g.votes)
      }))
    };
  }
  if (room.phase === 'results') {
    v.words = room.words;
    v.results = room.results;
  }
  if (room.round > 0) v.score = scoreboard(room);
  return v;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) if (p.online) send(p.ws, { t: 'state', state: viewFor(room, p) });
}
function fail(ws, msg) {
  send(ws, { t: 'error', msg });
}

/* ---------- connection handling ---------- */

function goOffline(ws) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const { room, player } = ctx;
  if (player.ws === ws) {
    player.online = false;
    player.ws = null;
    if (room.hostId === player.id) {
      const next = room.players.find(x => x.online);
      if (next) room.hostId = next.id;
    }
    broadcast(room);
  }
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      const name = cleanName(msg.name);
      if (!name) return fail(ws, 'Enter your name first.');
      goOffline(ws);
      const room = newRoom();
      rooms.set(room.code, room);
      const p = addPlayer(room, name, ws);
      room.hostId = p.id;
      ws.ctx = { room, player: p };
      send(ws, { t: 'joined', code: room.code, token: p.token });
      return broadcast(room);
    }
    case 'join': {
      const name = cleanName(msg.name);
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!name) return fail(ws, 'Enter your name first.');
      if (!room) return fail(ws, 'No game with that code.');
      if (room.phase !== 'lobby') return fail(ws, 'That game has already started.');
      if (room.players.length >= MAX_PLAYERS) return fail(ws, 'That game is full (6 players).');
      if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        return fail(ws, 'Someone already has that name. Pick another.');
      }
      goOffline(ws);
      const p = addPlayer(room, name, ws);
      ws.ctx = { room, player: p };
      send(ws, { t: 'joined', code: room.code, token: p.token });
      return broadcast(room);
    }
    case 'rejoin': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      const p = room && room.players.find(x => x.token === msg.token);
      if (!p) return send(ws, { t: 'gone' });
      goOffline(ws);
      if (p.ws && p.ws !== ws) {
        const old = p.ws;
        old.ctx = null;
        try {
          old.terminate();
        } catch (e) {}
      }
      p.ws = ws;
      p.online = true;
      ws.ctx = { room, player: p };
      send(ws, { t: 'joined', code: room.code, token: p.token });
      return broadcast(room);
    }
    case 'ping':
      return;
  }

  const ctx = ws.ctx;
  if (!ctx) return fail(ws, 'You are not in a game.');
  const { room, player: me } = ctx;
  const isHost = room.hostId === me.id;
  const timed = room.phase === 'link' || room.phase === 'think';
  const words = room.words;

  switch (msg.t) {
    case 'leave': {
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== me.id);
        ws.ctx = null;
        if (!room.players.length) rooms.delete(room.code);
        else {
          if (room.hostId === me.id) room.hostId = (room.players.find(p => p.online) || room.players[0]).id;
          broadcast(room);
        }
      } else goOffline(ws);
      return;
    }
    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return;
      const target = room.players.find(p => p.id === msg.id);
      if (!target || target.id === me.id) return;
      room.players = room.players.filter(p => p.id !== target.id);
      if (target.ws) {
        send(target.ws, { t: 'gone' });
        target.ws.ctx = null;
      }
      return broadcast(room);
    }
    case 'setWordset': {
      if (!isHost || room.phase !== 'lobby' || !WORDSETS[msg.wordset]) return;
      room.wordset = msg.wordset;
      return broadcast(room);
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      const n = room.players.length;
      if (n < MIN_PLAYERS || n > MAX_PLAYERS) return fail(ws, 'Thinkage Triplified needs 3 to 6 players.');
      const off = room.players.find(p => !p.online);
      if (off) return fail(ws, off.name + ' is offline. Wait for them to return or remove them.');
      startGame(room);
      return broadcast(room);
    }
    case 'pause': {
      if (!isHost || !timed || room.paused) return;
      room.remainingMs = remaining(room);
      room.paused = true;
      return broadcast(room);
    }
    case 'resume': {
      if (!isHost || !timed || !room.paused) return;
      room.endAt = Date.now() + room.remainingMs;
      room.paused = false;
      return broadcast(room);
    }
    case 'link': {
      if (room.phase !== 'link' || room.paused) return;
      const chain = msg.chain;
      const ok = Array.isArray(chain) && chain.length === 3 && chain.every(i => Number.isInteger(i) && i >= 0 && i < words.length);
      if (!ok) return fail(ws, 'Fill all three word slots.');
      if (new Set(chain).size !== 3) return fail(ws, 'Use three different words.');
      if (!chain.includes(me.assigned)) return fail(ws, 'Your own word must be one of the three.');
      if (!Array.isArray(msg.clues) || msg.clues.length !== 2) return fail(ws, 'Type both link words.');
      const clues = msg.clues.map(c => String(c || '').trim());
      if (clues.some(c => !c)) return fail(ws, 'Type both link words.');
      if (clues.some(c => /\s/.test(c))) return fail(ws, 'Each link word must be one word.');
      if (clues.some(c => c.length > 30)) return fail(ws, 'That link word is too long.');
      me.chain = chain;
      me.clues = clues;
      if (room.players.every(p => p.chain !== null)) {
        room.endReason = 'all';
        startThink(room);
      }
      return broadcast(room);
    }
    case 'withdraw': {
      if (room.phase !== 'link') return;
      me.chain = null;
      me.clues = null;
      return broadcast(room);
    }
    case 'guess': {
      if (room.phase !== 'think' || room.paused || me.locked) return;
      const target = room.players.find(p => p.id === msg.target);
      if (!target || target.id === me.id) return;
      const slots = msg.slots;
      if (!Array.isArray(slots) || slots.length !== 3) return;
      if (!slots.every(x => x === null || (Number.isInteger(x) && x >= 0 && x < words.length))) return;
      const filled = slots.filter(x => x !== null);
      if (new Set(filled).size !== filled.length) return;
      if (!filled.length) delete me.guesses[target.id];
      else me.guesses[target.id] = { slots: slots.slice(), star: !!msg.star };
      return broadcast(room);
    }
    case 'lock': {
      if (room.phase !== 'think' || room.paused) return;
      me.locked = true; // partial guesses are fine: blanks simply score nothing
      if (room.players.every(p => p.locked)) {
        room.endReason = 'all';
        endThink(room);
      }
      return broadcast(room);
    }
    case 'unlock': {
      if (room.phase !== 'think') return;
      me.locked = false;
      return broadcast(room);
    }
    case 'vote': {
      if (room.phase !== 'vote') return;
      const g = room.groups[msg.group];
      if (!g || g.members.includes(me.id)) return;
      g.votes[me.id] = !!msg.same;
      if (votesComplete(room)) finishRound(room);
      return broadcast(room);
    }
    case 'skipVotes': {
      if (!isHost || room.phase !== 'vote') return;
      finishRound(room);
      return broadcast(room);
    }
    case 'next': {
      if (!isHost || room.phase !== 'results') return;
      if (room.round < ROUNDS) startRound(room);
      else room.phase = 'over';
      return broadcast(room);
    }
    case 'again': {
      if (!isHost || room.phase !== 'over') return;
      room.phase = 'lobby';
      room.round = 0;
      room.words = [];
      room.results = null;
      room.groups = [];
      room.players.forEach(p => {
        p.roundPoints = [];
        resetPlayerRound(p);
      });
      // Drop anyone who left during the game so the next lobby starts clean.
      room.players = room.players.filter(p => p.online);
      if (!room.players.some(p => p.id === room.hostId)) room.hostId = room.players[0].id;
      return broadcast(room);
    }
  }
}

/* ---------- servers ---------- */

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      console.error(e);
      fail(ws, 'Something went wrong.');
    }
  });
  ws.on('close', () => goOffline(ws));
  ws.on('error', () => {});
});

// Keep connections alive through Render's proxy and drop dead sockets.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  });
}, 25000);

// Round clock, plus clean-up of abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if ((room.phase === 'link' || room.phase === 'think') && !room.paused && now >= room.endAt) {
      room.endReason = 'time';
      if (room.phase === 'link') failLink(room);
      else endThink(room);
      broadcast(room);
    }
    const idle = now - room.lastActive;
    const nobody = room.players.every(p => !p.online);
    if (idle > 6 * 3600 * 1000 || (nobody && idle > 30 * 60 * 1000)) rooms.delete(room.code);
  }
}, 250);

server.listen(PORT, '0.0.0.0', () => console.log('Thinkage Triplified listening on port ' + PORT));
