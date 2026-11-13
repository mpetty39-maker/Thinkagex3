'use strict';
// Plays whole games with simulated phones against a real server and checks the scoring.
// Run with: npm test
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 4100 + Math.floor(Math.random() * 500);
const URL = 'ws://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Phone {
  constructor(name) {
    this.name = name;
    this.S = null;
    this.errors = [];
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'state') this.S = m.state;
        if (m.t === 'joined') { this.code = m.code; this.token = m.token; }
        if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async waitFor(pred, label, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.S && pred(this.S)) return this.S;
      await sleep(15);
    }
    throw new Error('Timed out waiting for: ' + label + ' (phase ' + (this.S && this.S.phase) + ')');
  }
}

async function lobby(n, wordset) {
  const phones = [];
  for (let i = 0; i < n; i++) {
    const p = new Phone('P' + (i + 1));
    await p.open();
    phones.push(p);
  }
  phones[0].send({ t: 'create', name: 'P1' });
  await phones[0].waitFor(s => s.phase === 'lobby', 'lobby');
  for (let i = 1; i < n; i++) {
    phones[i].send({ t: 'join', code: phones[0].code, name: 'P' + (i + 1) });
    await phones[i].waitFor(s => s.phase === 'lobby', 'join');
  }
  if (wordset) phones[0].send({ t: 'setWordset', wordset });
  return phones;
}

async function startRound(phones, first) {
  phones[0].send({ t: first ? 'start' : 'next' });
  for (const p of phones) await p.waitFor(s => s.phase === 'link' && s.me, 'link phase');
}

// Default chain for a player: their own word first, then the next two words on the list.
const defaultChain = p => {
  const n = p.S.words.length;
  const a = p.S.me.assigned;
  return [a, (a + 1) % n, (a + 2) % n];
};
const link = (p, chain, clues) => p.send({ t: 'link', chain, clues });
const guess = (p, target, slots, star = false) => p.send({ t: 'guess', target, slots, star });
async function allThink(ph, label) {
  for (const p of ph) await p.waitFor(s => s.phase === 'think', label);
}

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TIME_SCALE: '0.1' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise(r => srv.stdout.on('data', d => String(d).includes('listening') && r()));
  try {
    /* ---- Game 1: four players ---- */
    let ph = await lobby(4, 'bible');
    await startRound(ph, true);
    assert.strictEqual(ph[0].S.words.length, 14, '4 players see 14 words');
    assert.strictEqual(ph[0].S.timer.total, 21000, 'clock for 4 players is 3:30 scaled');
    assert.ok(ph[0].S.players.every(p => !('chain' in p) && !('assigned' in p)), 'no leak of others chains');

    // Link validation
    const a0 = ph[0].S.me.assigned;
    const n = ph[0].S.words.length;
    const other = i => (a0 + i) % n;
    ph[0].errors = [];
    link(ph[0], [other(1), other(2), other(3)], ['a', 'b']); // missing own word
    await sleep(60);
    link(ph[0], [a0, a0, other(1)], ['a', 'b']); // repeated word
    await sleep(60);
    link(ph[0], [a0, other(1), other(2)], ['two words', 'b']); // multi-word link
    await sleep(60);
    link(ph[0], [a0, other(1), other(2)], ['a', '']); // missing second link
    await sleep(60);
    assert.strictEqual(ph[0].errors.length, 4, 'four bad chains rejected: ' + ph[0].errors.join(' | '));

    // Round 1
    const chains = ph.map(defaultChain);
    ph.forEach((p, i) => link(p, chains[i], ['x' + i + 'a', 'x' + i + 'b']));
    await allThink(ph, 'think 1');
    assert.deepStrictEqual(ph[0].S.targets[0].clues.length, 2, 'two link words visible in Think');
    const id = ph.map(p => p.S.you);
    const chainOf = {};
    ph.forEach((p, i) => (chainOf[id[i]] = chains[i]));
    // P1: full + star on P2 (10), 2 right on P3 (2), 1 right starred on P4 (-2)
    guess(ph[0], id[1], chainOf[id[1]], true);
    guess(ph[0], id[2], [chainOf[id[2]][0], chainOf[id[2]][1], (chainOf[id[2]][2] + 5) % n]);
    guess(ph[0], id[3], [chainOf[id[3]][0], (chainOf[id[3]][1] + 5) % n, (chainOf[id[3]][2] + 6) % n], true);
    // P2: all three full
    [0, 2, 3].forEach(t => guess(ph[1], id[t], chainOf[id[t]]));
    // P3: 2 right on P1, reversed (1 right) on P2, nothing on P4
    guess(ph[2], id[0], [chainOf[id[0]][0], chainOf[id[0]][1], (chainOf[id[0]][2] + 4) % n]);
    guess(ph[2], id[1], chainOf[id[1]].slice().reverse());
    // P4: all three full
    [0, 1, 2].forEach(t => guess(ph[3], id[t], chainOf[id[t]]));
    await sleep(100);
    ph.forEach(p => p.send({ t: 'lock' })); // partial guesses (P3 left P4 blank) lock fine
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results 1');
    let R = ph[0].S.results;
    assert.strictEqual(R.points[id[0]], 10, 'P1: 10 + 2 - 2');
    assert.strictEqual(R.points[id[1]], 15, 'P2: 5+5+5');
    assert.strictEqual(R.points[id[2]], 2, 'P3: 2 + 0 + none');
    assert.strictEqual(R.points[id[3]], 15, 'P4: 5+5+5');
    assert.strictEqual(R.teamPoints, 42);
    assert.strictEqual(R.cells[id[1]][id[2]].k, 1, 'reversed chain gets only the middle slot');

    // Round 2: P1 and P2 build the identical chain; P3 and P4 vote "same" so nobody scores it.
    await startRound(ph, false);
    const as = ph.map(p => p.S.me.assigned);
    const shared = [as[0], as[1], as[2]];
    link(ph[0], shared, ['car', 'drive']);
    link(ph[1], shared, ['cars', 'drive']);
    link(ph[2], defaultChain(ph[2]), ['m', 'n']);
    link(ph[3], defaultChain(ph[3]), ['o', 'p']);
    await allThink(ph, 'think 2');
    const chains2 = [shared, shared, defaultChain(ph[2]), defaultChain(ph[3])];
    ph.forEach((p, i) => p.S.targets.forEach(t => guess(p, t.id, chains2[id.indexOf(t.id)])));
    await sleep(100);
    ph.forEach(p => p.send({ t: 'lock' }));
    for (const p of ph) await p.waitFor(s => s.phase === 'vote', 'vote');
    ph[0].send({ t: 'vote', group: 0, same: true }); // a member cannot vote
    await sleep(60);
    assert.strictEqual(ph[2].S.vote.groups[0].voted.length, 0, 'member vote ignored');
    ph[2].send({ t: 'vote', group: 0, same: true });
    ph[3].send({ t: 'vote', group: 0, same: true });
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results 2');
    R = ph[0].S.results;
    assert.strictEqual(R.groups[0].same, true);
    assert.strictEqual(R.points[id[0]], 10, 'P1: void + 5 + 5');
    assert.strictEqual(R.points[id[1]], 10);
    assert.strictEqual(R.points[id[2]], 5, 'P3: void pair, then P4 only');
    assert.strictEqual(R.points[id[3]], 5);
    assert.strictEqual(R.teamPoints, 30);

    // Round 3: P4 never links, so time runs out during Link: no Think phase, zero points.
    await startRound(ph, false);
    link(ph[0], defaultChain(ph[0]), ['a', 'b']);
    link(ph[1], defaultChain(ph[1]), ['a', 'b']);
    link(ph[2], defaultChain(ph[2]), ['a', 'b']);
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'link timeout', 35000);
    R = ph[0].S.results;
    assert.strictEqual(R.failedLink, true);
    assert.strictEqual(R.teamPoints, 0);

    ph[0].send({ t: 'next' });
    for (const p of ph) await p.waitFor(s => s.phase === 'over', 'over');
    const sc = ph[0].S.score;
    assert.strictEqual(sc.team, 72);
    assert.strictEqual(sc.perfect, 225); // 4 players x 3 others x 3 rounds x 5 points x 1.25
    assert.strictEqual(sc.pct, 32);
    assert.strictEqual(sc.rating, 'Not good! Better luck next time.');
    ph[0].send({ t: 'again' });
    for (const p of ph) await p.waitFor(s => s.phase === 'lobby', 'back to lobby');
    ph.forEach(p => p.ws.close());

    /* ---- Game 2: three players, identical chain but different link words ---- */
    ph = await lobby(3);
    await startRound(ph, true);
    assert.strictEqual(ph[0].S.timer.total, 18000, 'clock for 3 players is 3:00 scaled');
    const seen = new Set(ph[0].S.words);
    const b = ph.map(p => p.S.me.assigned);
    const sh = [b[0], b[1], b[2]];
    link(ph[0], sh, ['dog', 'leash']);
    link(ph[1], sh, ['cat', 'toy']);
    link(ph[2], defaultChain(ph[2]), ['golf', 'club']);
    await allThink(ph, 'think g2');
    const idb = ph.map(p => p.S.you);
    // P3 guesses both identical-chain players correctly; the starred one is worth 10 and counts once.
    guess(ph[2], idb[0], sh, true);
    guess(ph[2], idb[1], sh);
    guess(ph[0], idb[1], sh);
    guess(ph[0], idb[2], defaultChain(ph[2]));
    guess(ph[1], idb[0], sh);
    guess(ph[1], idb[2], defaultChain(ph[2]));
    await sleep(100);
    ph.forEach(p => p.send({ t: 'lock' }));
    for (const p of ph) await p.waitFor(s => s.phase === 'vote', 'vote g2');
    ph[2].send({ t: 'vote', group: 0, same: false });
    for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results g2');
    R = ph[0].S.results;
    assert.strictEqual(R.groups[0].same, false);
    assert.strictEqual(R.points[idb[2]], 10, 'P3: best of 10 and 5, counted once');
    assert.strictEqual(R.points[idb[0]], 10, 'P1: 5 for P2, 5 for P3');
    assert.strictEqual(R.points[idb[1]], 10);
    assert.ok(R.cells[idb[1]][idb[2]].note === 'once' && R.cells[idb[1]][idb[2]].pts === 0, 'non-carrier cell marked once');

    // Next round's words differ from this round's.
    await startRound(ph, false);
    assert.strictEqual(ph[0].S.words.length, 14, '3 players also see 14 words');
    ph[0].S.words.forEach(w => assert.ok(!seen.has(w), 'word repeated across rounds: ' + w));

    // Reversed chain counts as a duplicate: P1 = A-B-C, P2 = C-B-A.
    {
      const as = ph.map(p => p.S.me.assigned);
      const fwd = [as[0], as[1], as[2]];
      const rev = fwd.slice().reverse();
      link(ph[0], fwd, ['x', 'y']);
      link(ph[1], rev, ['y', 'x']);
      link(ph[2], defaultChain(ph[2]), ['golf', 'club']);
      await allThink(ph, 'think rev');
      const ids = ph.map(p => p.S.you);
      guess(ph[2], ids[0], fwd);
      guess(ph[2], ids[1], rev);
      await sleep(100);
      ph.forEach(p => p.send({ t: 'lock' }));
      for (const p of ph) await p.waitFor(s => s.phase === 'vote', 'vote rev');
      assert.strictEqual(ph[2].S.vote.groups.length, 1, 'reversed chains form one duplicate group');
      assert.strictEqual(ph[2].S.vote.groups[0].members.length, 2);
      ph[2].send({ t: 'vote', group: 0, same: true });
      for (const p of ph) await p.waitFor(s => s.phase === 'results', 'results rev');
      assert.strictEqual(ph[0].S.results.points[ids[2]], 0, 'void reversed pair scores nothing');
      await startRound(ph, false);
    }

    // Reconnect: a phone drops, rejoins with its token and gets its secret word back.
    const old = ph[1];
    const secret = old.S.me.assigned;
    old.ws.close();
    await sleep(120);
    const back = new Phone('P2b');
    await back.open();
    back.send({ t: 'rejoin', code: old.code, token: old.token });
    await back.waitFor(s => s.phase === 'link' && s.me, 'rejoin');
    assert.strictEqual(back.S.me.assigned, secret, 'rejoin restores secret word');
    back.ws.close();

    console.log('All simulated games passed.');
  } finally {
    srv.kill();
  }
  process.exit(0);
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
