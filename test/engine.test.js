// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('../engine.js');
const { CAST } = require('../cast.js');

const ROOT = path.join(__dirname, '..');
const ids = CAST.filter(c => c.status === 'active').map(c => c.id);

function leagueWith(n) {
  const l = E.newLeague(51);
  for (let i = 0; i < n; i++) l.players.push({ id: 'p' + i, name: 'P' + i, color: '#fff' });
  return l;
}

test('snake order reverses every other round', () => {
  const l = leagueWith(3);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1', 'p2'], rounds: 2 });
  const seq = [0, 1, 2, 3, 4, 5].map(n => E.slotInfo(l.draft, n).playerId);
  assert.deepStrictEqual(seq, ['p0', 'p1', 'p2', 'p2', 'p1', 'p0']);
});

test('castaway comes off the board after two picks; no duplicates on a roster', () => {
  const l = leagueWith(3);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1', 'p2'], rounds: 2 });
  E.applyPick(l, CAST, 'main', 'p0', 'rob', { now: 1 });
  E.applyPick(l, CAST, 'main', 'p1', 'rob', { now: 2 });
  assert.throws(() => E.applyPick(l, CAST, 'main', 'p2', 'rob', { now: 3 }), /off_board/);
  E.applyPick(l, CAST, 'main', 'p2', 'kilby', { now: 3 });
  assert.throws(() => E.applyPick(l, CAST, 'main', 'p2', 'kilby', { now: 4 }), /already_yours/);
});

test('eliminated castaways and out-of-turn picks are rejected', () => {
  const l = leagueWith(2);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1'], rounds: 1 });
  assert.throws(() => E.applyPick(l, CAST, 'main', 'p0', 'aaliyah', { now: 1 }), /castaway_out/);
  assert.throws(() => E.applyPick(l, CAST, 'main', 'p1', 'rob', { now: 1 }), /not_your_turn/);
  assert.throws(() => E.applyPick(l, CAST, 'main', 'p0', 'rob', { now: 1, expectedN: 3 }), /stale_pick/);
});

test('clock expiry auto-picks from the queue, then the league consensus', () => {
  const l = leagueWith(2);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1'], rounds: 2, clockSec: 90 });
  assert.strictEqual(E.tick(l, CAST, 'main', 89999, {}), null);
  const r = E.tick(l, CAST, 'main', 90000, { p0: ['aaliyah', 'maggie', 'rob'], p1: ['devin'] });
  assert.strictEqual(r.castawayId, 'maggie');             // skips eliminated Aaliyah
  assert.strictEqual(l.draft.picks[0].auto, 'queue');
  assert.strictEqual(l.draft.deadline, 90000 + 90000);     // next player gets a full clock
  const r2 = E.tick(l, CAST, 'main', 180000, { p0: ['maggie'], p1: [] });
  assert.strictEqual(r2.castawayId, 'maggie');             // p1 has no queue → consensus
  assert.strictEqual(l.draft.picks[1].auto, 'consensus');
});

test('only one auto-pick per tick even after a long outage', () => {
  const l = leagueWith(3);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1', 'p2'], rounds: 1, clockSec: 60 });
  E.tick(l, CAST, 'main', 10 * 60000, {});
  assert.strictEqual(l.draft.picks.length, 1);
});

test('pause freezes the clock; resume restores remaining time (min 15s)', () => {
  const l = leagueWith(2);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1'], rounds: 1, clockSec: 90 });
  E.pause(l.draft, 30000);
  assert.strictEqual(E.tick(l, CAST, 'main', 999999, {}), null);
  E.resume(l.draft, 100000);
  assert.strictEqual(l.draft.deadline, 100000 + 60000);
});

test('undo reopens a completed draft in paused state', () => {
  const l = leagueWith(2);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1'], rounds: 1 });
  E.applyPick(l, CAST, 'main', 'p0', 'rob', { now: 1 });
  E.applyPick(l, CAST, 'main', 'p1', 'ori', { now: 2 });
  assert.strictEqual(l.draft.status, 'complete');
  E.undo(l.draft, 3);
  assert.strictEqual(l.draft.status, 'paused');
  assert.strictEqual(E.currentSlot(l.draft).playerId, 'p1');
});

test('draft refuses more picks than the board can hold', () => {
  const l = leagueWith(11);
  assert.throws(() => E.startDraft(l, CAST, { now: 0, rounds: 4 }), /too_many_picks/);
  const l2 = leagueWith(10);
  E.startDraft(l2, CAST, { now: 0, rounds: 4 });   // exactly 40 of 40 slots
  assert.strictEqual(E.totalSlots(l2.draft), 40);
});

test('a slot with no legal pick is skipped, not stuck', () => {
  const l = leagueWith(10);
  E.startDraft(l, CAST, { now: 0, rounds: 4, clockSec: 1 });
  let t = 0;
  for (let i = 0; i < 40 && l.draft.status === 'live'; i++) { t += 1000; E.tick(l, CAST, 'main', t, {}); }
  assert.strictEqual(l.draft.status, 'complete');
  assert.strictEqual(l.draft.picks.length, 40);
});

test('scoring: episode 2 does not count, merge pick scores from its start episode, winner bet pays', () => {
  const l = leagueWith(2);
  E.startDraft(l, CAST, { now: 0, order: ['p0', 'p1'], rounds: 1 });
  E.applyPick(l, CAST, 'main', 'p0', 'rob', { now: 1 });
  E.applyPick(l, CAST, 'main', 'p1', 'ori', { now: 2 });
  l.merge.startEp = 8;
  l.merge.picks = [{ playerId: 'p1', castawayId: 'rob' }];
  l.winnerBets = { p0: 'rob' };
  const episodes = {
    2: { scores: { rob: { survives: true, findIdol: true } } },
    3: { scores: { rob: { survives: true } } },
    8: { scores: { rob: { survives: true, immunityWin: true } } },
    13: { scores: { rob: { soleSurvivor: true, juryVotes: 0 }, ori: { juryVotes: 2 } } }
  };
  assert.strictEqual(E.playerTotal(l, episodes, 'p0'), 3 + 8 + 20 + 10);
  assert.strictEqual(E.playerTotal(l, episodes, 'p1'), 8 + 20 + 6);
  const st = E.standings(l, episodes);
  assert.strictEqual(st[0].playerId, 'p0');
});

test('win probabilities sum to 1', () => {
  const l = leagueWith(4);
  E.startDraft(l, CAST, { now: 0, rounds: 3 });
  for (let t = 1; l.draft.status === 'live'; t++) { l.draft.deadline = t; E.tick(l, CAST, "main", t, {}); }
  const p = E.winProbabilities(l, CAST, {}, { sims: 500 });
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'sum=' + sum);
});

// ---------- API through the same vm harness the mock server uses ----------
function api() {
  let store = {}; let cache = {}; let now = 1_000_000;
  const ctx = {
    console, Math, JSON,
    Date: class extends Date { static now() { return now; } },
    Platform: {
      storeLoadAll: () => JSON.parse(JSON.stringify(store)),
      storeSet: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
      backup: () => {}, cachePut: (b, m, ns) => { cache[ns || ''] = { body: b, meta: m }; }, cacheGet: ns => cache[ns || ''] || null,
      cacheClear: ns => { delete cache[ns || '']; }, withLock: (l, fn) => fn(), tryWithLock: (m, l, fn) => fn(), adminKey: () => 'k',
      json: o => o, raw: s => JSON.parse(s)
    }
  };
  vm.createContext(ctx);
  for (const f of ['cast.js', 'engine.js', 'apps-script/api.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
  return {
    post: body => ctx.doPost({ postData: { contents: JSON.stringify(body) } }),
    get: () => ctx.doGet({ parameter: {} }),
    getNs: ns => ctx.doGet({ parameter: { ns } }),
    advance: ms => { now += ms; },
    store: () => store
  };
}

test('API: join, dedupe, prefs, draft, stale pick, winner bets hidden until complete', () => {
  const a = api();
  const j1 = a.post({ action: 'join', name: 'Will', email: 'Will@Example.com', winnerPick: 'rob' });
  assert.ok(j1.ok);
  assert.strictEqual(a.post({ action: 'join', name: 'Will again', email: 'will@example.com' }).existing, true);
  assert.strictEqual(a.post({ action: 'join', name: 'will', email: 'other@example.com' }).error, 'name_taken');
  a.post({ action: 'join', name: 'Jarrard', email: 'j@example.com' });
  a.post({ action: 'prefs', email: 'j@example.com', queue: ['kilby', 'bogus', 'kilby', 'ori'], winnerPick: 'mike' });
  assert.deepStrictEqual(a.post({ action: 'login', email: 'j@example.com' }).me.queue, ['kilby', 'ori']);
  assert.strictEqual(a.post({ action: 'admin', key: 'nope', op: 'whoami' }).error, 'bad_admin_key');

  const s = a.post({ action: 'admin', key: 'k', op: 'start_draft', rounds: 1, clockSec: 90, order: [j1.me.id, a.post({ action: 'login', email: 'j@example.com' }).me.id] });
  assert.ok(s.ok, s.error);
  let pub = a.get().data;
  assert.strictEqual(pub.league.winnerBets, null);
  assert.strictEqual(pub.league.players[0].hasWinnerBet, true);

  assert.strictEqual(a.post({ action: 'pick', email: 'j@example.com', castawayId: 'rob', n: 0 }).error, 'not_your_turn');
  assert.ok(a.post({ action: 'pick', email: 'will@example.com', castawayId: 'rob', n: 0 }).ok);
  assert.strictEqual(a.post({ action: 'pick', email: 'will@example.com', castawayId: 'ori', n: 0 }).error, 'stale_pick');

  // Jarrard's clock runs out: the GET poll auto-picks his first queued castaway.
  a.advance(94000);
  pub = a.get().data;
  assert.strictEqual(pub.league.draft.picks[1].castawayId, 'kilby');
  assert.strictEqual(pub.league.draft.status, 'complete');
  assert.deepStrictEqual(pub.league.winnerBets, { [j1.me.id]: 'rob', [pub.league.players[1].id]: 'mike' });
  assert.strictEqual(a.post({ action: 'prefs', email: 'j@example.com', winnerPick: 'rob' }).error, 'winner_bet_locked');
  assert.strictEqual(a.post({ action: 'join', name: 'Late', email: 'late@example.com' }).error, 'draft_started');
});

test('API: episode save sets eliminations and re-saving the episode replaces them', () => {
  const a = api();
  a.post({ action: 'admin', key: 'k', op: 'save_episode', ep: 3, data: { scores: { rob: { survives: true } }, eliminated: [{ id: 'maggie' }] } });
  let pub = a.get().data;
  assert.strictEqual(pub.league.castaways.maggie.status, 'eliminated');
  a.post({ action: 'admin', key: 'k', op: 'save_episode', ep: 3, data: { scores: {}, eliminated: [{ id: 'mike' }] } });
  pub = a.get().data;
  assert.strictEqual(pub.league.castaways.maggie, undefined);
  assert.strictEqual(pub.league.castaways.mike.eliminatedEp, 3);
  assert.ok(pub.episodes['3']);
});

test('API: scheduled auto-start kicks off the draft on the first poll after draftAt', () => {
  const a = api();
  a.post({ action: 'join', name: 'A', email: 'a@x.com' });
  a.post({ action: 'join', name: 'B', email: 'b@x.com' });
  a.post({ action: 'admin', key: 'k', op: 'settings', draftAt: new Date(1_000_000 + 60000).toISOString(), autoStart: true });
  assert.strictEqual(a.get().data.league.draft.status, 'open');
  a.advance(61000);
  const L = a.get().data.league;
  assert.strictEqual(L.draft.status, 'live');
  assert.strictEqual(L.draft.rounds, 4);
});

test('a completely full board lifts the cap for a last pick instead of skipping', () => {
  const l = leagueWith(10);
  E.startDraft(l, CAST, { now: 0, rounds: 4, order: l.players.map(p => p.id) });
  // Fill 39 picks so the last player's only open castaway is one they already own.
  const ids = CAST.filter(c => c.status === 'active').map(c => c.id);
  l.draft.picks = [];
  for (let n = 0; n < 39; n++) {
    const s = E.slotInfo(l.draft, n);
    l.draft.picks.push({ n, playerId: s.playerId, castawayId: ids[Math.floor(n / 2) % 20] });
  }
  const last = E.currentSlot(l.draft);
  const legal = E.legalPicks(l, CAST, 'main', last.playerId);
  assert.ok(legal.length > 0, 'someone is always pickable');
});

test('API: personal link token signs in and picks', () => {
  const a = api();
  const j = a.post({ action: 'join', name: 'Tok', email: 't@x.com' });
  assert.ok(j.me.token && j.me.token.length >= 8);
  assert.strictEqual(a.post({ action: 'login', token: j.me.token }).me.id, j.me.id);
  assert.strictEqual(a.post({ action: 'login', token: 'nope' }).error, 'not_found');
});

test('API: picks inside the 3-second grace still count', () => {
  const a = api();
  const x = a.post({ action: 'join', name: 'X', email: 'x@x.com' }).me;
  const y = a.post({ action: 'join', name: 'Y', email: 'y@x.com' }).me;
  a.post({ action: 'admin', key: 'k', op: 'start_draft', rounds: 1, clockSec: 60, order: [x.id, y.id] });
  a.advance(61500);   // 1.5s past the deadline
  assert.ok(a.post({ action: 'pick', token: x.token, castawayId: 'rob', n: 0 }).ok);
});

test('API: practice sandbox is isolated, bots draft fast, episodes simulate', () => {
  const a = api();
  const P = b => a.post(Object.assign({ ns: 'practice' }, b));
  const G = () => JSON.parse(JSON.stringify(a.get()));   // real league view
  a.post({ action: 'join', name: 'Real', email: 'real@x.com' });
  const me = P({ action: 'join', name: 'Tester', email: 't@x.com' }).me;
  assert.strictEqual(P({ action: 'practice', op: 'start', bots: 5, clockSec: 45, botSec: 3 }).ok, true);
  // Real league untouched.
  assert.strictEqual(G().data.league.players.length, 1);
  assert.strictEqual(G().data.league.draft.status, 'open');
  // Run the practice draft: the human picks on their turn, bots auto-pick every few seconds.
  const pubP = () => { const ctx = a; return ctx.getNs('practice').data.league; };
  for (let i = 0; i < 200; i++) {
    const L = pubP();
    if (L.draft.status === 'complete') break;
    const slot = L.draft.order.length && (function () { const d = L.draft, n = d.picks.length, N = d.order.length, r = Math.floor(n / N), pos = n % N; return { n, pid: d.order[r % 2 ? N - 1 - pos : pos] }; })();
    if (slot.pid === me.id) {
      const legal = ['rob', 'ori', 'kilby', 'mike', 'devin', 'jelly', 'ana', 'eric'].find(id => P({ action: 'pick', token: me.token, castawayId: id, n: slot.n }).ok);
      assert.ok(legal);
    } else a.advance(3500 + 3000);
  }
  assert.strictEqual(pubP().draft.status, 'complete');
  const e = P({ action: 'practice', op: 'episode' });
  assert.ok(e.ok, e.error);
  assert.strictEqual(e.ep, 3);
  assert.strictEqual(pubP().castaways[e.boot].status, 'eliminated');
  assert.strictEqual(a.post({ action: 'practice', op: 'episode' }).error, 'practice_only');
  // Practice admin key works only in practice.
  assert.ok(P({ action: 'admin', key: 'practice', op: 'whoami' }).ok);
  assert.strictEqual(a.post({ action: 'admin', key: 'practice', op: 'whoami' }).error, 'bad_admin_key');
});

test('API: purge deletes test sign-ups before the draft', () => {
  const a = api();
  a.post({ action: 'join', name: 'Keep', email: 'keep@x.com' });
  a.post({ action: 'join', name: 'R1', email: 'rehearsal1@example.com' });
  const r = a.post({ action: 'admin', key: 'k', op: 'purge', match: 'rehearsal' });
  assert.strictEqual(r.purged, 1);
  assert.strictEqual(a.get().data.league.players.length, 1);
});
