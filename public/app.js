(function () {
  'use strict';

  var $app = document.getElementById('app');
  var $toast = document.getElementById('toast');

  /* ---------- helpers ---------- */
  var L = function (i) { return String.fromCharCode(65 + i); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (ms) {
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  var num = function (x) { return Number.isInteger(x) ? String(x) : x.toFixed(1); };
  var sign = function (n) { return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function loadSession() {
    try { return JSON.parse(lsGet('triplified.session')); } catch (e) { return null; }
  }

  /* ---------- state ---------- */
  var ws = null;
  var S = null; // latest state from the server
  var localEnd = 0;
  var conn = false;
  var retry = 0;
  var rejoining = !!loadSession();
  var ui = { name: lsGet('triplified.name') || '', code: '', round: -1, chain: [null, null, null], clues: ['', ''], active: 0, gs: {}, star: {}, target: null };

  function nm(id) {
    var p = S && S.players.filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '?';
  }
  var isHost = function () { return S && S.hostId === S.you; };

  /* ---------- connection ---------- */
  function send(o) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  }
  function connect() {
    if (ws && ws.readyState <= 1) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = function () {
      conn = true;
      retry = 0;
      var s = loadSession();
      if (s) send({ t: 'rejoin', code: s.code, token: s.token });
      else rejoining = false;
      render();
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      onMsg(m);
    };
    ws.onclose = function () {
      conn = false;
      render();
      retry++;
      setTimeout(connect, Math.min(4000, 400 + retry * 600));
    };
    ws.onerror = function () {};
  }
  setInterval(function () { send({ t: 'ping' }); }, 20000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      connect();
      if (S && (S.phase === 'link' || S.phase === 'think')) getWake();
    }
  });

  function onMsg(m) {
    if (m.t === 'joined') {
      lsSet('triplified.session', JSON.stringify({ code: m.code, token: m.token }));
    } else if (m.t === 'gone') {
      lsDel('triplified.session');
      S = null;
      rejoining = false;
      render();
    } else if (m.t === 'error') {
      if (rejoining) { rejoining = false; render(); }
      toast(m.msg);
    } else if (m.t === 'state') {
      var prev = S;
      S = m.state;
      rejoining = false;
      if (S.timer) localEnd = Date.now() + S.timer.remainingMs;
      if (S.round !== ui.round) {
        ui.round = S.round;
        ui.chain = [null, null, null];
        ui.clues = ['', ''];
        ui.active = 0;
        ui.gs = {};
        ui.star = {};
        ui.target = null;
      }
      var timed = function (p) { return p === 'link' || p === 'think'; };
      if (prev && timed(prev.phase) && !timed(S.phase) && S.endReason === 'time') beep();
      if (timed(S.phase)) getWake(); else dropWake();
      render();
    }
  }

  /* ---------- sound, vibration, wake lock, toast ---------- */
  var audio = null;
  function unlockAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    if (!audio) return;
    try {
      [0, 0.28, 0.56].forEach(function (d) {
        var o = audio.createOscillator();
        var g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        o.connect(g);
        g.connect(audio.destination);
        var t = audio.currentTime + d;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.start(t);
        o.stop(t + 0.25);
      });
    } catch (e) {}
  }
  var wake = null;
  function getWake() {
    try {
      if (!wake && navigator.wakeLock && document.visibilityState === 'visible') {
        navigator.wakeLock.request('screen').then(function (w) {
          wake = w;
          w.addEventListener('release', function () { wake = null; });
        }).catch(function () {});
      }
    } catch (e) {}
  }
  function dropWake() {
    try { if (wake) wake.release(); } catch (e) {}
    wake = null;
  }
  var toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove('show'); }, 3200);
  }

  /* ---------- guess helpers ---------- */
  var blank = function () { return [null, null, null]; };
  function firstEmpty(arr) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === null) return i;
    return -1;
  }
  // Put word i in the active slot. A word already in another slot moves here; tapping the word in the active slot clears it.
  function placeWord(slots, active, i) {
    var c = slots.slice();
    var at = c.indexOf(i);
    if (at === active) { c[active] = null; return { slots: c, active: active }; }
    if (at >= 0) c[at] = null;
    c[active] = i;
    var next = firstEmpty(c);
    return { slots: c, active: next >= 0 ? next : active };
  }
  function gstate(tid) {
    if (ui.gs[tid]) return ui.gs[tid];
    var g = S.me.guesses[tid];
    var slots = g ? g.slots.slice() : blank();
    var a = firstEmpty(slots);
    return { slots: slots, active: a >= 0 ? a : 0 };
  }
  function gFilled(tid) {
    return gstate(tid).slots.filter(function (x) { return x !== null; }).length;
  }
  function starOf(tid) {
    if (ui.star[tid] !== undefined) return ui.star[tid];
    var g = S.me.guesses[tid];
    return !!(g && g.star);
  }
  function sendGuess(tid) {
    send({ t: 'guess', target: tid, slots: gstate(tid).slots, star: starOf(tid) });
  }
  var validClue = function (c) { return /^\S{1,30}$/.test(String(c).trim()); };

  /* ---------- screens ---------- */
  function header() {
    var t = S.timer;
    return '<header class="top"><div class="top-row"><span class="rd">Round ' + S.round + '/' + S.rounds + '</span>' +
      '<span class="pill">' + (t.paused ? 'Paused' : S.phase === 'link' ? 'Link' : 'Think') + '</span><span class="sp"></span>' +
      '<span class="clock js-time"></span>' +
      (isHost() ? '<button class="mini" data-act="' + (t.paused ? 'resume' : 'pause') + '">' + (t.paused ? 'Resume' : 'Pause') + '</button>' : '') +
      '</div><div class="bar"><i class="js-bar"></i></div></header>';
  }

  function screenRejoin() {
    return '<main class="screen"><h1 class="brand">Thinkage<span class="sub">Triplified</span></h1><p class="muted">Rejoining your game…</p></main>';
  }

  function screenHome() {
    return '<main class="screen">' +
      '<div><div class="lab">Party game</div><h1 class="brand">Thinkage<span class="sub">Triplified</span></h1></div>' +
      '<p class="muted">Chain three words with two link words, then fill in the blanks to find the chains your friends built. Everyone plays on their own phone.</p>' +
      '<div class="field"><label for="name">Your name</label><input id="name" class="input" maxlength="14" autocomplete="off" value="' + esc(ui.name) + '"></div>' +
      '<button class="btn primary big" data-act="create">Start a new game</button>' +
      '<div class="divider">or join a friend’s game</div>' +
      '<div class="field"><label for="code">Game code</label><input id="code" class="input code" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABCD" value="' + esc(ui.code) + '"></div>' +
      '<button class="btn" data-act="join">Join game</button>' +
      '</main>';
  }

  function screenLobby() {
    var host = isHost();
    var n = S.players.length;
    var secs = S.times[n];
    var list = S.players.map(function (p) {
      var tags = '';
      if (p.id === S.hostId) tags += '<span class="tag">Host</span>';
      if (p.id === S.you) tags += '<span class="tag">You</span>';
      var kick = host && p.id !== S.you ? '<button class="mini" data-act="kick" data-id="' + p.id + '">Remove</button>' : '';
      return '<li><span class="dot ' + (p.online ? '' : 'off') + '"></span><span class="nm">' + esc(p.name) + (p.online ? '' : ' <span class="muted small">(offline)</span>') + '</span>' + tags + kick + '</li>';
    }).join('');
    var ws_ = S.wordsets.map(function (w) {
      return '<label class="' + (S.wordset === w.key ? 'on' : '') + '"><input type="radio" name="wordset" data-act="wordset" data-v="' + w.key + '"' + (S.wordset === w.key ? ' checked' : '') + '><span>' + esc(w.name) + '</span></label>';
    }).join('');
    var current = S.wordsets.filter(function (w) { return w.key === S.wordset; })[0];
    return '<main class="screen">' +
      '<div><div class="lab center">Game code</div><div class="roomcode">' + esc(S.code) + '</div>' +
      '<p class="muted small center">Friends open <b>' + esc(location.host) + '</b> and enter this code.</p></div>' +
      '<section class="field"><h2>Players (' + n + ' of ' + S.maxPlayers + ')</h2><ul class="plist">' + list + '</ul></section>' +
      (host ? '<section class="field"><h2>Word list</h2><div class="seg">' + ws_ + '</div></section>'
            : '<p class="muted">Word list: <b>' + esc(current ? current.name : '') + '</b></p>') +
      '<p class="muted small">' + (secs ? 'The clock for ' + n + ' players is ' + fmt(secs * 1000) + ' per round. It covers linking and thinking together.' : 'Thinkage Triplified needs 3 to 6 players.') + '</p>' +
      '<details class="card"><summary>How a round works</summary><div class="small muted" style="display:grid;gap:6px;margin-top:8px">' +
      '<p><b>Link.</b> You get a secret word. Build a chain of three words with your word in it, in any position, and type a link word between each neighbouring pair. Example: Bread \u2192 <i>toast</i> \u2192 Sun \u2192 <i>shine</i> \u2192 Moon.</p>' +
      '<p><b>Think.</b> You see each other player\u2019s two link words, in order, with three blanks. Fill in the blanks. Partial guesses are fine.</p>' +
      '<p><b>Scoring.</b> Words must be in the right place. Two blanks right +' + S.scoring.two + ', all three +' + S.scoring.full + '. A star multiplies a scoring guess by ' + S.scoring.starMultiplier + ' and costs ' + S.scoring.starPenalty + ' if it scores nothing. Your team score is rated at the end of round 3.</p></div></details>' +
      (host ? '<button class="btn primary big" data-act="start"' + (n < S.minPlayers ? ' disabled' : '') + '>' + (n < S.minPlayers ? 'Need at least 3 players' : 'Start game') + '</button>'
            : '<p class="muted center">Waiting for the host to start…</p>') +
      '<button class="link" data-act="leave">Leave game</button>' +
      '</main>';
  }

  /* ---------- chains ---------- */
  var COLS = 3;
  function gridDims(n) { return 'style="--cols:' + COLS + ';--rows:' + Math.ceil(n / COLS) + '"'; }

  function chainSummary(words, slots) {
    return slots.map(function (w) { return w === null ? '?' : words[w]; }).join(' → ');
  }

  // Full vertical chain: word, link word, word, link word, word.
  function chainFull(words, chain, clues) {
    var h = '<div class="chainfull">';
    for (var s = 0; s < 3; s++) {
      h += '<div class="cw"><span class="ltr">' + L(chain[s]) + '</span><span>' + esc(words[chain[s]]) + '</span></div>';
      if (s < 2) h += '<div class="ck">' + esc(clues[s]) + '</div>';
    }
    return h + '</div>';
  }

  // The word grid. Each placed word carries a badge with its slot number.
  function wordRows(act, words, slots, disabled, mine) {
    return words.map(function (w, i) {
      var at = slots.indexOf(i);
      return '<li><button class="row' + (at >= 0 ? ' sel' : '') + (i === mine ? ' mine' : '') + '" data-act="' + act + '" data-i="' + i + '"' + (disabled ? ' disabled' : '') + '><span class="ltr">' + L(i) + '</span><span class="w">' + esc(w) + '</span>' + (at >= 0 ? '<span class="badge">' + (at + 1) + '</span>' : '') + '</button></li>';
    }).join('');
  }

  function slotBtn(act, s, w, active, mine, disabled) {
    return '<button class="slot' + (active ? ' active' : '') + (w !== null ? ' filled' : '') + (mine ? ' mine' : '') + '" data-act="' + act + '" data-s="' + s + '"' + (disabled ? ' disabled' : '') + ' aria-label="Slot ' + (s + 1) + '">' + (w !== null ? L(w) : '?') + '</button>';
  }

  /* ---------- link screen ---------- */
  function linkProblem() {
    var words = S.words;
    if (ui.chain.indexOf(null) >= 0) return 'Tap words to fill all three slots.';
    if (ui.chain.indexOf(S.me.assigned) < 0) return 'Your word, ' + words[S.me.assigned] + ', must be one of the three.';
    if (!validClue(ui.clues[0]) || !validClue(ui.clues[1])) return 'Type both link words, one word each.';
    return '';
  }

  function composerRow() {
    var h = '<div class="chainrow">';
    for (var s = 0; s < 3; s++) {
      var w = ui.chain[s];
      h += slotBtn('slot', s, w, ui.active === s, w !== null && w === S.me.assigned, false);
      if (s < 2) {
        h += '<input id="clue' + s + '" class="input clueinput" maxlength="30" placeholder="link word" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="' + (s === 0 ? 'next' : 'done') + '" value="' + esc(ui.clues[s]) + '">';
      }
    }
    return h + '</div>';
  }

  function screenLink() {
    var me = S.me;
    var words = S.words;
    var yours = '<section class="card yours compact"><div class="lab">Your word, which must be in your chain</div><div class="big"><span class="ltr">' + L(me.assigned) + '</span><span>' + esc(words[me.assigned]) + '</span></div></section>';
    var body;
    var dock;
    if (me.chain === null) {
      body = '<ul class="fitgrid" ' + gridDims(words.length) + '>' + wordRows('wordpick', words, ui.chain, false, me.assigned) + '</ul>';
      var problem = linkProblem();
      dock = '<div class="dock"><div class="line">' + esc(problem || chainSummary(words, ui.chain)) + '</div>' + composerRow() +
        '<button class="btn primary big" data-act="submit"' + (problem ? ' disabled' : '') + '>Lock in my chain</button></div>';
    } else {
      var waiting = S.players.filter(function (p) { return !p.done; });
      body = '<section class="card"><div class="lab">Locked in</div>' + chainFull(words, me.chain, me.clues) + '</section>' +
        '<ul class="plist tight">' + S.players.map(function (p) {
          return '<li><span class="nm">' + esc(p.name) + '</span>' + (p.done ? '<span class="tick">✓</span>' : '<span class="muted small">linking…</span>') + '</li>';
        }).join('') + '</ul>';
      dock = '<div class="dock"><div class="line">' + (waiting.length ? 'Waiting for ' + waiting.length + ' more' : 'Everyone is in') + '</div><button class="btn" data-act="change">Change my chain</button></div>';
    }
    return { hdr: header(), main: '<main class="screen fitscreen">' + yours + body + '</main>', dock: dock };
  }

  /* ---------- think screen ---------- */
  function screenThink() {
    var me = S.me;
    var words = S.words;
    if (!ui.target || !S.targets.some(function (t) { return t.id === ui.target; })) {
      var first = S.targets.filter(function (t) { return gFilled(t.id) === 0; })[0] || S.targets[0];
      ui.target = first.id;
    }
    var cur = S.targets.filter(function (t) { return t.id === ui.target; })[0];
    var gs = gstate(cur.id);
    var star = starOf(cur.id);
    var total = 0;
    S.targets.forEach(function (t) { total += gFilled(t.id); });
    var tabs = S.targets.map(function (t) {
      var n = gFilled(t.id);
      return '<button class="tab' + (t.id === ui.target ? ' on' : '') + (n === 3 ? ' done' : '') + '" data-act="target" data-t="' + t.id + '"><span>' + esc(t.name) + '</span><small>' +
        (n ? n + '/3' : '—') + (starOf(t.id) && n ? ' ★' : '') + '</small></button>';
    }).join('');
    var row = '<div class="chainrow view">' +
      slotBtn('gslot', 0, gs.slots[0], gs.active === 0, false, me.locked) +
      '<span class="cluetext">' + esc(cur.clues[0]) + '</span>' +
      slotBtn('gslot', 1, gs.slots[1], gs.active === 1, false, me.locked) +
      '<span class="cluetext">' + esc(cur.clues[1]) + '</span>' +
      slotBtn('gslot', 2, gs.slots[2], gs.active === 2, false, me.locked) + '</div>';
    var body = '<div class="tabs" style="--n:' + S.targets.length + '">' + tabs + '</div>' + row +
      '<div class="tfoot"><span class="echo">' + esc(chainSummary(words, gs.slots)) + '</span>' +
      '<button class="mini" data-act="gclear"' + (me.locked ? ' disabled' : '') + '>Clear</button>' +
      '<button class="starbtn' + (star ? ' on' : '') + '" data-act="star"' + (me.locked ? ' disabled' : '') + '>★ ' + (star ? 'Starred' : 'Star') + '</button></div>' +
      '<ul class="fitgrid" ' + gridDims(words.length) + '>' + wordRows('gword', words, gs.slots, me.locked, -1) + '</ul>';
    var sc = S.scoring;
    var dock;
    var open = S.targets.length * 3 - total;
    ui.open = open;
    if (ui.armed !== null && ui.armed !== undefined && ui.armed !== open) ui.armed = null;
    if (me.locked) {
      var waiting = S.players.filter(function (p) { return !p.done; }).map(function (p) { return p.name; });
      dock = '<div class="dock"><div class="line">' + '<b>You are locked in.</b> ' + (waiting.length ? 'Waiting for ' + esc(waiting.join(', ')) + '…' : 'Everyone is locked in.') + '</div><button class="btn primary" data-act="unlock">Want to guess more? Tap here to unlock</button></div>';
    } else {
      dock = '<div class="dock"><div class="line">' + total + '/' + (S.targets.length * 3) + ' filled · 2 right +' + sc.two + ' · 3 right +' + sc.full + ' · ★ ×' + sc.starMultiplier + '/−' + sc.starPenalty + '</div>' +
        '<button class="btn primary big" data-act="lock">' + (ui.armed === open ? open + ' blank' + (open === 1 ? '' : 's') + ' still empty. Tap again to lock' : 'Lock in guesses') + '</button></div>';
    }
    return { hdr: header(), main: '<main class="screen fitscreen">' + body + '</main>', dock: dock };
  }

  /* ---------- vote screen ---------- */
  function screenVote() {
    var words = S.words;
    var pending = S.players.filter(function (p) { return !p.done; }).map(function (p) { return p.name; });
    var groups = S.vote.groups.map(function (g) {
      var clues = g.members.map(function (m) {
        return '<div><div class="lab">' + esc(m.name) + '</div><div class="muted small">' + esc(chainSummary(words, m.chain)) + '</div><div class="cluepair">' + esc(m.clues[0]) + '<span class="muted"> · </span>' + esc(m.clues[1]) + '</div></div>';
      }).join('');
      var action;
      if (g.canVote) {
        action = '<div class="vbtns"><button class="btn' + (g.myVote === true ? ' on' : '') + '" data-act="vote" data-g="' + g.id + '" data-s="1">Same</button>' +
          '<button class="btn' + (g.myVote === false ? ' on' : '') + '" data-act="vote" data-g="' + g.id + '" data-s="0">Different</button></div>';
      } else {
        action = '<p class="muted small">You’re in this pair, so the others decide.</p>';
      }
      return '<section class="card vgroup"><div><div class="lab">' + (g.members.some(function (m) { return m.chain.join() !== g.members[0].chain.join(); }) ? 'Same words, one chain is the reverse of the other' : 'Same words in the same order') + '</div></div>' +
        '<div class="vclues">' + clues + '</div>' + action +
        '<p class="muted small">' + g.voted.length + ' of ' + g.voters.length + ' votes in</p></section>';
    }).join('');
    return '<main class="screen"><div><div class="lab">Round ' + S.round + ' of ' + S.rounds + '</div><h2>Were these link words the same?</h2>' +
      '<p class="muted small" style="margin-top:6px">These players built the same chain, in the same order or exactly reversed. If their link words are also the same (swapped places counts when the chain is reversed), nobody scores that chain. A plural or a typo counts as the same word. A tie counts as different.</p></div>' +
      groups +
      (pending.length ? '<p class="muted center small">Waiting for ' + esc(pending.join(', ')) + '</p>' : '') +
      (isHost() ? '<button class="btn" data-act="skipVotes">Continue without waiting</button>' : '') +
      '</main>';
  }

  /* ---------- results ---------- */
  function chip(guesserId, c) {
    if (!c) return '';
    var cls = c.status;
    var guess = c.status === 'none' ? 'no guess' : c.slots.map(function (w) { return w === null ? '–' : L(w); }).join('·') + (c.star ? ' ★' : '');
    var tail = '';
    if (c.note === 'void') { cls = 'void'; tail = '<small>void</small>'; }
    else if (c.note === 'once') tail = '<small>counted once</small>';
    else if (c.status !== 'none') tail = '<b>' + sign(c.pts) + '</b>';
    return '<span class="chip ' + cls + '">' + esc(nm(guesserId)) + ' <small>' + guess + '</small> ' + tail + '</span>';
  }

  function screenResults() {
    var R = S.results;
    var words = S.words;
    var last = S.round >= S.rounds;
    var btn = isHost()
      ? '<button class="btn primary big" data-act="next">' + (last ? 'See final result' : 'Next round') + '</button>'
      : '<p class="muted center">Waiting for the host…</p>';
    if (R.failedLink) {
      var missing = R.linkStatus.filter(function (x) { return !x.submitted; }).map(function (x) { return nm(x.id); });
      return '<main class="screen"><div><div class="lab">Round ' + S.round + ' of ' + S.rounds + '</div><h2>Time ran out while linking</h2></div>' +
        '<section class="card"><p>There was no Think phase this round, so the team scores <b>0</b>.</p>' +
        (missing.length ? '<p class="muted small" style="margin-top:6px">Still linking: ' + esc(missing.join(', ')) + '</p>' : '') +
        '<p class="muted small" style="margin-top:6px">The clock covers linking and thinking together. Linking quickly leaves more time to think.</p></section>' +
        scoreCard() + btn + '</main>';
    }
    var cards = R.targets.map(function (t) {
      var chips = S.players.filter(function (p) { return p.id !== t.id; }).map(function (p) {
        return chip(p.id, R.cells[t.id] && R.cells[t.id][p.id]);
      }).join('');
      var note = '';
      if (t.group !== null) {
        var g = R.groups.filter(function (x) { return x.id === t.group; })[0];
        var others = g.members.filter(function (m) { return m !== t.id; }).map(nm).join(', ');
        note = '<p class="note">Same chain as ' + esc(others) + '. Link words judged ' + (g.same ? 'the same' : 'different') + ' (' + g.yes + '–' + g.no + '). ' +
          (g.same ? 'Nobody scores this chain.' : 'Each guesser scores this chain once.') + '</p>';
      }
      return '<section class="card" style="display:grid;gap:10px"><div class="lab">' + esc(t.name) + '’s chain</div>' +
        chainFull(words, t.chain, t.clues) + note + '<div class="chips">' + chips + '</div></section>';
    }).join('');
    return '<main class="screen"><div><div class="lab">Round ' + S.round + ' of ' + S.rounds + (R.reason === 'time' ? ' · time ran out' : '') + '</div><h2>Round results</h2></div>' +
      scoreCard() + cards + btn + '</main>';
  }

  function scoreCard() {
    var R = S.results;
    var sc = S.score;
    var rows = S.players.map(function (p) {
      var pts = R.points[p.id] || 0;
      return '<div class="stat"><span>' + esc(p.name) + '</span><span class="mono">' + sign(pts) + ' <span class="muted">· ' + sc.byPlayer[p.id].total + ' total</span></span></div>';
    }).join('');
    return '<section class="card"><div class="lab">Team points this round</div><div class="big-score">' + sign(R.teamPoints) + '</div>' +
      '<div style="margin-top:10px">' + rows + '</div></section>';
  }

  function screenOver() {
    var sc = S.score;
    var rounds = [];
    for (var r = 0; r < S.rounds; r++) {
      var t = 0;
      S.players.forEach(function (p) { t += sc.byPlayer[p.id].rounds[r] || 0; });
      rounds.push('<div class="stat"><span>Round ' + (r + 1) + '</span><span class="mono">' + sign(t) + '</span></div>');
    }
    var players = S.players.map(function (p) {
      return '<div class="stat"><span>' + esc(p.name) + '</span><span class="mono">' + sc.byPlayer[p.id].total + '</span></div>';
    }).join('');
    return '<main class="screen"><div><div class="lab">Game over</div><h2>Team result</h2></div>' +
      '<section class="card" style="display:grid;gap:8px"><div class="rating">' + esc(sc.rating) + '</div>' +
      '<div class="big-score">' + sc.pct + '%</div>' +
      '<p class="muted">Your team scored <b>' + sc.team + '</b> of a possible <b>' + num(sc.perfect) + '</b>.</p></section>' +
      '<section class="card"><div class="lab">By round</div>' + rounds.join('') + '</section>' +
      '<section class="card"><div class="lab">By player</div>' + players + '</section>' +
      (isHost() ? '<button class="btn primary big" data-act="again">Play again</button>' : '<p class="muted center">Waiting for the host…</p>') +
      '<button class="link" data-act="leave">Leave game</button></main>';
  }

  /* ---------- render ---------- */
  var parts = {};
  var shown = {};
  ['banner', 'hdr', 'view', 'dockwrap'].forEach(function (id) {
    var el = document.createElement('div');
    el.id = id;
    $app.appendChild(el);
    parts[id] = el;
    shown[id] = null;
  });
  // Update one region only when its markup changed, so unchanged buttons and the clock are never rebuilt.
  function setPart(id, html) {
    if (shown[id] === html) return false;
    shown[id] = html;
    parts[id].innerHTML = html;
    return true;
  }

  function render() {
    var ae = document.activeElement;
    var keep = ae && ae.id && $app.contains(ae) ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
    var sy = window.scrollY;
    var vm = document.querySelector('#view main');
    var mt = vm ? vm.scrollTop : 0;
    var out;
    if (!S) out = rejoining ? screenRejoin() : screenHome();
    else if (S.phase === 'lobby') out = screenLobby();
    else if (S.phase === 'link') out = screenLink();
    else if (S.phase === 'think') out = screenThink();
    else if (S.phase === 'vote') out = screenVote();
    else if (S.phase === 'results') out = screenResults();
    else out = screenOver();
    if (typeof out === 'string') out = { hdr: '', main: out, dock: '' };
    var timed = !!(S && (S.phase === 'link' || S.phase === 'think'));
    $app.dataset.phase = timed ? S.phase : '';
    $app.classList.toggle('fit', timed);
    document.body.classList.toggle('fit', timed);
    $app.classList.toggle('is-paused', !!(timed && S.timer.paused));
    var changed = false;
    changed = setPart('banner', conn ? '' : '<div class="conn">Reconnecting\u2026</div>') || changed;
    changed = setPart('hdr', out.hdr) || changed;
    changed = setPart('view', out.main) || changed;
    changed = setPart('dockwrap', out.dock) || changed;
    if (changed) {
      if (keep) {
        var el = document.getElementById(keep.id);
        if (el && el !== document.activeElement) {
          el.focus();
          try { el.setSelectionRange(keep.s, keep.e); } catch (_) {}
        }
      }
      var nm_ = document.querySelector('#view main');
      if (nm_ && mt) nm_.scrollTop = mt;
      if (!timed) window.scrollTo(0, sy);
    }
    tick();
  }

  function tick() {
    if (!S || !S.timer) return;
    var rem = S.timer.paused ? S.timer.remainingMs : Math.max(0, localEnd - Date.now());
    var els = document.querySelectorAll('.js-time');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = fmt(rem);
      els[i].classList.toggle('low', rem <= 10000);
    }
    var bars = document.querySelectorAll('.js-bar');
    for (var j = 0; j < bars.length; j++) {
      bars[j].style.transform = 'scaleX(' + Math.max(0, Math.min(1, rem / S.timer.total)) + ')';
    }
  }
  setInterval(tick, 200);

  /* ---------- actions ---------- */
  function submitChain() {
    if (linkProblem()) return;
    send({ t: 'link', chain: ui.chain, clues: [ui.clues[0].trim(), ui.clues[1].trim()] });
  }

  function refreshLinkDock() {
    var problem = linkProblem();
    var line = document.querySelector('#dockwrap .line');
    var btn = document.querySelector('[data-act="submit"]');
    if (line) line.textContent = problem || chainSummary(S.words, ui.chain);
    if (btn) btn.disabled = !!problem;
  }

  function act(a, d) {
    switch (a) {
      case 'create':
        ui.name = ui.name.trim();
        if (!ui.name) return toast('Enter your name first.');
        lsSet('triplified.name', ui.name);
        return send({ t: 'create', name: ui.name });
      case 'join':
        ui.name = ui.name.trim();
        if (!ui.name) return toast('Enter your name first.');
        if (ui.code.length !== 4) return toast('Enter the 4-letter game code.');
        lsSet('triplified.name', ui.name);
        return send({ t: 'join', code: ui.code, name: ui.name });
      case 'leave':
        send({ t: 'leave' });
        lsDel('triplified.session');
        S = null;
        ui.round = -1;
        return render();
      case 'kick': return send({ t: 'kick', id: d.id });
      case 'wordset': return send({ t: 'setWordset', wordset: d.v });
      case 'start': return send({ t: 'start' });
      case 'pause': return send({ t: 'pause' });
      case 'resume': return send({ t: 'resume' });
      case 'slot': ui.active = Number(d.s); return render();
      case 'wordpick': {
        var r = placeWord(ui.chain, ui.active, Number(d.i));
        ui.chain = r.slots;
        ui.active = r.active;
        return render();
      }
      case 'submit': return submitChain();
      case 'change':
        ui.chain = S.me.chain.slice();
        ui.clues = S.me.clues.slice();
        ui.active = 0;
        return send({ t: 'withdraw' });
      case 'target': ui.target = d.t; return render();
      case 'gslot': {
        var g1 = gstate(ui.target);
        ui.gs[ui.target] = { slots: g1.slots, active: Number(d.s) };
        return render();
      }
      case 'gword': {
        var g2 = gstate(ui.target);
        var r2 = placeWord(g2.slots, g2.active, Number(d.i));
        ui.gs[ui.target] = r2;
        sendGuess(ui.target);
        return render();
      }
      case 'gclear':
        ui.gs[ui.target] = { slots: blank(), active: 0 };
        sendGuess(ui.target);
        return render();
      case 'star':
        ui.star[ui.target] = !starOf(ui.target);
        if (gFilled(ui.target) > 0) sendGuess(ui.target);
        return render();
      case 'lock':
        if (ui.open > 0 && ui.armed !== ui.open) {
          ui.armed = ui.open; render();
          setTimeout(function () { ui.armed = null; render(); }, 5000);
          return;
        }
        ui.armed = null; return send({ t: 'lock' });
      case 'unlock': return send({ t: 'unlock' });
      case 'vote': return send({ t: 'vote', group: Number(d.g), same: d.s === '1' });
      case 'skipVotes': return send({ t: 'skipVotes' });
      case 'next': return send({ t: 'next' });
      case 'again': return send({ t: 'again' });
    }
  }

  $app.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    unlockAudio();
    act(b.dataset.act, b.dataset);
  });
  $app.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'name') ui.name = t.value;
    else if (t.id === 'code') {
      ui.code = t.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (t.value !== ui.code) t.value = ui.code;
    } else if (t.id === 'clue0' || t.id === 'clue1') {
      var clean = t.value.replace(/\s+/g, '');
      if (clean !== t.value) t.value = clean;
      ui.clues[t.id === 'clue0' ? 0 : 1] = clean;
      refreshLinkDock();
    }
  });
  $app.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'clue0') {
      e.preventDefault();
      var n = document.getElementById('clue1');
      if (n) n.focus();
    } else if (e.target.id === 'clue1') {
      e.preventDefault();
      submitChain();
    } else if (e.target.id === 'name' || e.target.id === 'code') {
      e.preventDefault();
      act(ui.code.length === 4 ? 'join' : 'create', {});
    }
  });

  render();
  connect();
})();
