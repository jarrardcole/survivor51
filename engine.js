// =============================================================
// SURVIVOR 51 FANTASY — shared game engine
// -------------------------------------------------------------
// Pure functions only: no DOM, no Google APIs, no clocks read directly.
// The same file runs in three places:
//   1. the website (index.html loads it as a <script>)
//   2. the Google Apps Script backend (tools/build-gs.sh prepends it to Code.gs)
//   3. node tests and the local mock server
// So the draft rules and the scoring can never drift between client and server.
// =============================================================

var Engine = (function () {
  'use strict';

  // ---------- Scoring (identical to Season 50) ----------
  var SCORING = [
    { key: 'survives',      label: 'Survives Tribal',            short: 'Survived',   points: 3,   type: 'check' },
    { key: 'findIdol',      label: 'Finds / possesses idol',     short: 'Idol found', points: 3,   type: 'check' },
    { key: 'playIdol',      label: 'Plays idol successfully',    short: 'Idol play',  points: 8,   type: 'check' },
    { key: 'findAdvantage', label: 'Finds / wins advantage',     short: 'Adv found',  points: 3,   type: 'check' },
    { key: 'playAdvantage', label: 'Plays advantage to effect',  short: 'Adv play',   points: 4,   type: 'check' },
    { key: 'makesMerge',    label: 'Makes the merge',            short: 'Merge',      points: 4,   type: 'check' },
    { key: 'idolPocket',    label: 'Goes home with idol',        short: 'Idol pocket',points: -5,  type: 'check' },
    { key: 'quit',          label: 'Quits (non-medical)',        short: 'Quit',       points: -15, type: 'check' },
    { key: 'immunityWin',   label: 'Individual immunity win',    short: 'Immunity',   points: 5,   type: 'check' },
    { key: 'firemaking',    label: 'Wins fire-making',           short: 'Fire',       points: 5,   type: 'check' },
    { key: 'juryVotes',     label: 'Jury votes (runner-up)',     short: 'Jury votes', points: 3,   type: 'number' },
    { key: 'soleSurvivor',  label: 'Sole Survivor',              short: 'Winner',     points: 20,  type: 'check' },
    { key: 'iconic',        label: 'Most Iconic (league vote)',  short: 'Iconic',     points: 7,   type: 'check' }
  ];

  var DEFAULT_SETTINGS = {
    rounds: 4,              // Season 50 ran 4 rounds with 9 players
    maxPerCastaway: 2,      // a castaway comes off the board after 2 picks
    clockSec: 90,           // pick clock
    scoringStartEp: 3,      // Episode 2 does not count (draft happens during/around it)
    mergeMaxPerCastaway: 2,
    winnerBetPoints: 10,    // Pick the Winner bet, locks when the draft completes
    lastEpisode: 13
  };

  var PLAYER_COLORS = [
    '#FF7A2F', '#2EC4B6', '#F2C14E', '#E0569B', '#7B8CFF', '#8BD346',
    '#FF5A5F', '#3FA9F5', '#C38BFF', '#F29E4C', '#5ED9A0', '#E8E8E8'
  ];

  // ---------- Errors ----------
  function fail(code, extra) {
    var e = new Error(code);
    e.code = code;
    if (extra) e.extra = extra;
    throw e;
  }

  // ---------- League skeleton ----------
  function newLeague(season) {
    return {
      season: season || 51,
      version: 0,
      settings: clone(DEFAULT_SETTINGS),
      players: [],
      castaways: {},     // overrides: { slug: { status, eliminatedEp, elimType, tribe } }
      draft: newDraft('main'),
      merge: newDraft('merge'),
      winnerBets: null,  // revealed copy, filled when the draft completes
      currentEp: 2,
      updatedAt: 0
    };
  }

  function newDraft(kind) {
    return {
      kind: kind,
      status: kind === 'main' ? 'open' : 'off', // open | live | paused | complete | off
      order: [],
      rounds: kind === 'main' ? DEFAULT_SETTINGS.rounds : 1,
      snake: kind === 'main',
      clockSec: DEFAULT_SETTINGS.clockSec,
      picks: [],
      deadline: null,
      pausedRemainingMs: null,
      startedAt: null,
      completedAt: null,
      startEp: null        // merge only: first episode the merge pick scores
    };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- Cast helpers ----------
  // cast = static array from cast.js: [{ id, name, shortName, tribe, status, eliminatedEp }]
  function castawayStatus(league, cast, id) {
    var base = null;
    for (var i = 0; i < cast.length; i++) if (cast[i].id === id) { base = cast[i]; break; }
    if (!base) return null;
    var o = (league.castaways && league.castaways[id]) || {};
    return {
      id: id,
      status: o.status || base.status || 'active',
      eliminatedEp: o.eliminatedEp != null ? o.eliminatedEp : (base.eliminatedEp != null ? base.eliminatedEp : null),
      elimType: o.elimType || base.elimType || null,
      tribe: o.tribe || base.tribe
    };
  }

  function activeCastawayIds(league, cast) {
    return cast.filter(function (c) { return castawayStatus(league, cast, c.id).status === 'active'; })
               .map(function (c) { return c.id; });
  }

  function activePlayers(league) {
    return league.players.filter(function (p) { return !p.removed; });
  }

  function playerById(league, id) {
    for (var i = 0; i < league.players.length; i++) if (league.players[i].id === id) return league.players[i];
    return null;
  }

  // ---------- Draft order ----------
  function totalSlots(draft) { return draft.order.length * draft.rounds; }

  function slotInfo(draft, n) {
    var N = draft.order.length;
    if (!N || n >= totalSlots(draft)) return null;
    var round = Math.floor(n / N);
    var pos = n % N;
    var reversed = draft.snake && round % 2 === 1;
    return { n: n, round: round + 1, pickInRound: pos + 1, playerId: draft.order[reversed ? N - 1 - pos : pos] };
  }

  function currentSlot(draft) {
    if (draft.status !== 'live' && draft.status !== 'paused') return null;
    return slotInfo(draft, draft.picks.length);
  }

  // Upcoming slots (including current), for the "on deck" ticker.
  function upcomingSlots(draft, count) {
    var out = [];
    for (var n = draft.picks.length; n < totalSlots(draft) && out.length < count; n++) out.push(slotInfo(draft, n));
    return out;
  }

  // Practice bots get a short clock so a practice draft moves fast.
  function slotDeadline(draft, now, extraSec) {
    if (!draft.clockSec) return null;
    var slot = currentSlot(draft);
    var bot = slot && draft.botIds && draft.botIds.indexOf(slot.playerId) !== -1;
    return now + ((bot ? (draft.botSec || 3) : draft.clockSec) + (extraSec || 0)) * 1000;
  }

  function shuffle(arr, rand) {
    var a = arr.slice();
    rand = rand || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------- Rosters ----------
  function picksBy(draft, playerId) {
    return draft.picks.filter(function (p) { return p.playerId === playerId && p.castawayId; })
                      .map(function (p) { return p.castawayId; });
  }

  function timesPicked(draft, castawayId) {
    var n = 0;
    draft.picks.forEach(function (p) { if (p.castawayId === castawayId) n++; });
    return n;
  }

  function roster(league, playerId) {
    return {
      draft: picksBy(league.draft, playerId),
      merge: picksBy(league.merge, playerId)
    };
  }

  // Why a castaway can't be picked right now (null = legal).
  // If every castaway is blocked by the two-pick cap (can happen on the very last picks
  // of a completely full board), the cap is lifted for that one pick instead of skipping.
  function pickBlocker(league, cast, kind, playerId, castawayId) {
    var b = strictBlocker(league, cast, kind, playerId, castawayId);
    if (b !== 'off_board') return b;
    for (var i = 0; i < cast.length; i++) {
      if (!strictBlocker(league, cast, kind, playerId, cast[i].id)) return 'off_board';
    }
    return null;
  }

  function strictBlocker(league, cast, kind, playerId, castawayId) {
    var draft = kind === 'merge' ? league.merge : league.draft;
    var st = castawayStatus(league, cast, castawayId);
    if (!st) return 'unknown_castaway';
    if (st.status !== 'active') return 'castaway_out';
    var cap = kind === 'merge' ? league.settings.mergeMaxPerCastaway : league.settings.maxPerCastaway;
    if (timesPicked(draft, castawayId) >= cap) return 'off_board';
    if (picksBy(league.draft, playerId).indexOf(castawayId) !== -1) return 'already_yours';
    if (kind === 'merge' && picksBy(league.merge, playerId).indexOf(castawayId) !== -1) return 'already_yours';
    return null;
  }

  function legalPicks(league, cast, kind, playerId) {
    return cast.map(function (c) { return c.id; })
               .filter(function (id) { return !pickBlocker(league, cast, kind, playerId, id); });
  }

  // League-wide "consensus" ranking from everyone's queues (average rank; unranked = last).
  // Used as the fallback when a player's own queue is empty or exhausted.
  function consensusRanking(cast, queues) {
    var ids = cast.map(function (c) { return c.id; });
    var score = {};
    ids.forEach(function (id) { score[id] = 0; });
    var qs = Object.keys(queues || {}).map(function (k) { return queues[k] || []; })
                   .filter(function (q) { return q.length; });
    ids.forEach(function (id) {
      qs.forEach(function (q) {
        var r = q.indexOf(id);
        score[id] += r === -1 ? ids.length : r;
      });
    });
    return ids.slice().sort(function (a, b) {
      return (score[a] - score[b]) || (ids.indexOf(a) - ids.indexOf(b));
    });
  }

  function chooseAutoPick(league, cast, kind, playerId, queue, consensus) {
    var legal = legalPicks(league, cast, kind, playerId);
    if (!legal.length) return null;
    var lists = [queue || [], consensus || []];
    for (var l = 0; l < lists.length; l++) {
      for (var i = 0; i < lists[l].length; i++) {
        if (legal.indexOf(lists[l][i]) !== -1) return { castawayId: lists[l][i], source: l === 0 ? 'queue' : 'consensus' };
      }
    }
    return { castawayId: legal[0], source: 'first' };
  }

  // ---------- Draft lifecycle ----------
  function startDraft(league, cast, opts) {
    var d = league.draft;
    if (d.status !== 'open') fail('draft_already_started');
    var players = activePlayers(league);
    if (players.length < 2) fail('need_two_players');
    var rounds = opts.rounds || league.settings.rounds;
    var capacity = activeCastawayIds(league, cast).length * league.settings.maxPerCastaway;
    if (players.length * rounds > capacity) fail('too_many_picks', { capacity: capacity, needed: players.length * rounds });
    var order = opts.order || shuffle(players.map(function (p) { return p.id; }), opts.rand);
    d.order = order;
    d.rounds = rounds;
    d.clockSec = opts.clockSec || league.settings.clockSec;
    d.status = 'live';
    d.startedAt = opts.now;
    d.picks = [];
    d.botIds = opts.botIds || [];
    d.botSec = opts.botSec || 3;
    // First pick gets a little extra time for the order reveal.
    d.deadline = slotDeadline(d, opts.now, opts.revealSec || 0);
    d.pausedRemainingMs = null;
    league.settings.rounds = rounds;
    return d;
  }

  function startMerge(league, cast, opts) {
    var m = league.merge;
    if (m.status !== 'off' && m.status !== 'complete') fail('merge_already_started');
    if (league.draft.status !== 'complete') fail('main_draft_not_complete');
    if (!opts.order || !opts.order.length) fail('missing_order');
    m.order = opts.order;
    m.rounds = 1;
    m.snake = false;
    m.clockSec = opts.clockSec || 0;           // 0 = no clock (merge draft runs async over a few days)
    m.status = 'live';
    m.picks = [];
    m.startedAt = opts.now;
    m.startEp = opts.startEp;
    m.deadline = m.clockSec ? opts.now + m.clockSec * 1000 : null;
    m.pausedRemainingMs = null;
    return m;
  }

  // Apply a pick. `expectedN` guards against double-submits and stale screens.
  function applyPick(league, cast, kind, playerId, castawayId, opts) {
    var draft = kind === 'merge' ? league.merge : league.draft;
    if (draft.status === 'paused' && !opts.admin) fail('draft_paused');
    if (draft.status !== 'live' && draft.status !== 'paused') fail('draft_not_live');
    var slot = currentSlot(draft);
    if (!slot) fail('draft_complete');
    if (opts.expectedN != null && opts.expectedN !== slot.n) fail('stale_pick', { current: slot.n });
    if (slot.playerId !== playerId) fail('not_your_turn', { current: slot.playerId });
    var blocker = pickBlocker(league, cast, kind, playerId, castawayId);
    if (blocker) fail(blocker);
    draft.picks.push({ n: slot.n, playerId: playerId, castawayId: castawayId, auto: opts.auto || null, at: opts.now });
    afterPick(league, draft, opts.now);
    return slot;
  }

  function skipSlot(league, draft, now, reason) {
    var slot = currentSlot(draft);
    draft.picks.push({ n: slot.n, playerId: slot.playerId, castawayId: null, auto: reason || 'skipped', at: now });
    afterPick(league, draft, now);
  }

  function afterPick(league, draft, now) {
    if (draft.picks.length >= totalSlots(draft)) {
      draft.status = 'complete';
      draft.deadline = null;
      draft.completedAt = now;
      return;
    }
    if (draft.status === 'paused') {
      draft.pausedRemainingMs = draft.clockSec * 1000;
    } else {
      draft.deadline = slotDeadline(draft, now);
    }
  }

  // Called on every server read. If the clock has run out, auto-pick for whoever is up.
  // Only one auto-pick per tick, and the next player always gets a full clock from `now`,
  // so a room-wide wifi drop can't cascade into everyone being auto-drafted.
  function tick(league, cast, kind, now, queues) {
    var draft = kind === 'merge' ? league.merge : league.draft;
    if (draft.status !== 'live' || !draft.deadline || now < draft.deadline) return null;
    var slot = currentSlot(draft);
    if (!slot) return null;
    var choice = chooseAutoPick(league, cast, kind, slot.playerId, (queues || {})[slot.playerId], consensusRanking(cast, queues));
    if (!choice) { skipSlot(league, draft, now, 'no_legal_pick'); return { slot: slot, castawayId: null }; }
    applyPick(league, cast, kind, slot.playerId, choice.castawayId, { now: now, auto: choice.source });
    return { slot: slot, castawayId: choice.castawayId, source: choice.source };
  }

  function pause(draft, now) {
    if (draft.status !== 'live') fail('not_live');
    draft.status = 'paused';
    draft.pausedRemainingMs = draft.deadline ? Math.max(0, draft.deadline - now) : null;
    draft.deadline = null;
  }

  function resume(draft, now) {
    if (draft.status !== 'paused') fail('not_paused');
    draft.status = 'live';
    var ms = draft.pausedRemainingMs;
    if (draft.clockSec) draft.deadline = now + Math.max(ms == null ? draft.clockSec * 1000 : ms, 15000);
    draft.pausedRemainingMs = null;
  }

  function undo(draft, now) {
    if (!draft.picks.length) fail('nothing_to_undo');
    var last = draft.picks.pop();
    if (draft.status === 'complete') { draft.status = 'paused'; draft.completedAt = null; }
    if (draft.status === 'paused') { draft.pausedRemainingMs = draft.clockSec * 1000; draft.deadline = null; }
    else draft.deadline = slotDeadline(draft, now);
    return last;
  }

  // ---------- Scoring ----------
  // episodes: { "3": { scores: { slug: { survives: true, ... } }, ... }, ... }
  function castawayEpisodePoints(episodes, id, ep) {
    var e = episodes && episodes[ep];
    var s = e && e.scores && e.scores[id];
    if (!s) return 0;
    var t = 0;
    SCORING.forEach(function (cat) {
      if (cat.type === 'check' && s[cat.key]) t += cat.points;
      if (cat.type === 'number' && s[cat.key]) t += Number(s[cat.key]) * cat.points;
    });
    return t;
  }

  function episodeNumbers(league, episodes) {
    var start = league.settings.scoringStartEp;
    return Object.keys(episodes || {}).map(Number)
      .filter(function (n) { return n >= start && episodes[n] && episodes[n].published !== false; })
      .sort(function (a, b) { return a - b; });
  }

  function castawayTotal(league, episodes, id, fromEp) {
    var t = 0;
    episodeNumbers(league, episodes).forEach(function (ep) {
      if (fromEp == null || ep >= fromEp) t += castawayEpisodePoints(episodes, id, ep);
    });
    return t;
  }

  function soleSurvivorId(episodes) {
    var found = null;
    Object.keys(episodes || {}).forEach(function (ep) {
      var sc = episodes[ep].scores || {};
      Object.keys(sc).forEach(function (id) { if (sc[id].soleSurvivor) found = id; });
    });
    return found;
  }

  // Points a player earns in one episode (draft picks + merge pick from merge.startEp onward).
  function playerEpisodePoints(league, episodes, playerId, ep) {
    if (ep < league.settings.scoringStartEp) return 0;
    var r = roster(league, playerId);
    var t = 0;
    r.draft.forEach(function (id) { t += castawayEpisodePoints(episodes, id, ep); });
    if (league.merge.startEp != null && ep >= league.merge.startEp) {
      r.merge.forEach(function (id) {
        if (r.draft.indexOf(id) === -1) t += castawayEpisodePoints(episodes, id, ep);
      });
    }
    return t;
  }

  function winnerBetBonus(league, episodes, playerId) {
    var bets = league.winnerBets || {};
    var winner = soleSurvivorId(episodes);
    return winner && bets[playerId] === winner ? league.settings.winnerBetPoints : 0;
  }

  function playerTotal(league, episodes, playerId) {
    var t = 0;
    episodeNumbers(league, episodes).forEach(function (ep) { t += playerEpisodePoints(league, episodes, playerId, ep); });
    return t + winnerBetBonus(league, episodes, playerId);
  }

  // Standings with shared ranks for ties, plus last-episode delta and rank movement.
  function standings(league, episodes) {
    var eps = episodeNumbers(league, episodes);
    var last = eps[eps.length - 1];
    var rows = activePlayers(league).map(function (p) {
      var total = playerTotal(league, episodes, p.id);
      var lastPts = last != null ? playerEpisodePoints(league, episodes, p.id, last) : 0;
      return { playerId: p.id, name: p.name, color: p.color, total: total, lastEp: lastPts, prevTotal: total - lastPts };
    });
    rankRows(rows, 'total', 'rank');
    rankRows(rows, 'prevTotal', 'prevRank');
    rows.forEach(function (r) { r.move = eps.length > 1 ? r.prevRank - r.rank : 0; });
    return rows.sort(function (a, b) { return (b.total - a.total) || a.name.localeCompare(b.name); });
  }

  function rankRows(rows, key, out) {
    var sorted = rows.slice().sort(function (a, b) { return b[key] - a[key]; });
    sorted.forEach(function (r, i) {
      r[out] = i > 0 && sorted[i - 1][key] === r[key] ? sorted[i - 1][out] : i + 1;
    });
  }

  // Cumulative totals per episode, for the season race chart.
  function raceSeries(league, episodes) {
    var eps = episodeNumbers(league, episodes);
    return activePlayers(league).map(function (p) {
      var run = 0;
      return { playerId: p.id, name: p.name, color: p.color, points: eps.map(function (ep) {
        run += playerEpisodePoints(league, episodes, p.id, ep);
        return { ep: ep, total: run };
      }) };
    });
  }

  // ---------- Win probability (Monte Carlo) ----------
  // Simulates the rest of the season: random boot order among active castaways, with
  // survival, merge, immunity, fire, jury and winner points assigned the way the rules do.
  // Deliberately simple and unbiased — it doesn't know who's "good", only who's still alive.
  function winProbabilities(league, cast, episodes, opts) {
    opts = opts || {};
    var sims = opts.sims || 3000;
    var rand = opts.rand || Math.random;
    var players = activePlayers(league);
    if (!players.length) return {};
    var active = activeCastawayIds(league, cast);
    var base = {};
    players.forEach(function (p) { base[p.id] = playerTotal(league, episodes, p.id); });
    if (active.length <= 1) {
      var out1 = {}; var best = Math.max.apply(null, players.map(function (p) { return base[p.id]; }));
      var leaders = players.filter(function (p) { return base[p.id] === best; });
      players.forEach(function (p) { out1[p.id] = leaders.indexOf(p) !== -1 ? 1 / leaders.length : 0; });
      return out1;
    }
    var mergeAt = opts.mergeAt || 12;           // castaways left at the merge (typical new-era season)
    var merged = active.length <= mergeAt;
    var ownersDraft = {}; var ownersMerge = {};
    players.forEach(function (p) {
      var r = roster(league, p.id);
      r.draft.forEach(function (id) { (ownersDraft[id] = ownersDraft[id] || []).push(p.id); });
      r.merge.forEach(function (id) { if (r.draft.indexOf(id) === -1) (ownersMerge[id] = ownersMerge[id] || []).push(p.id); });
    });
    var bets = league.winnerBets || {};
    var wins = {}; players.forEach(function (p) { wins[p.id] = 0; });

    var tribeOf = {};
    active.forEach(function (id) { tribeOf[id] = castawayStatus(league, cast, id).tribe; });

    for (var s = 0; s < sims; s++) {
      var pts = {}; active.forEach(function (id) { pts[id] = 0; });
      var alive = shuffle(active, rand);        // boot order: alive[0] goes next
      var isMerged = merged;
      while (alive.length > 3) {
        if (!isMerged && alive.length <= mergeAt) { alive.forEach(function (id) { pts[id] += 4; }); isMerged = true; }
        if (isMerged) pts[alive[1 + Math.floor(rand() * (alive.length - 1))]] += 5;   // immunity (never the boot)
        var boot = alive.shift();
        // Only castaways who attend tribal earn "survives": pre-merge that's the boot's tribe.
        alive.forEach(function (id) { if (isMerged || tribeOf[id] === tribeOf[boot]) pts[id] += 3; });
        if (alive.length === 3 && isMerged) pts[alive[Math.floor(rand() * 3)]] += 5;  // fire-making at final 4
      }
      // Final three: random winner, runners-up split a few jury votes.
      var winner = alive[Math.floor(rand() * alive.length)];
      pts[winner] += 20;
      alive.forEach(function (id) { if (id !== winner) pts[id] += 3 * Math.floor(rand() * 3); });
      var best2 = -Infinity; var leaders2 = [];
      players.forEach(function (p) {
        var t = base[p.id];
        var r = roster(league, p.id);
        r.draft.forEach(function (id) { if (pts[id]) t += pts[id]; });
        r.merge.forEach(function (id) { if (r.draft.indexOf(id) === -1 && pts[id]) t += pts[id]; });
        if (bets[p.id] === winner) t += league.settings.winnerBetPoints;
        if (t > best2) { best2 = t; leaders2 = [p.id]; } else if (t === best2) leaders2.push(p.id);
      });
      leaders2.forEach(function (id) { wins[id] += 1 / leaders2.length; });
    }
    var out = {};
    players.forEach(function (p) { out[p.id] = wins[p.id] / sims; });
    return out;
  }

  // ---------- Public view ----------
  // Strips secrets. Winner bets stay hidden until the draft completes.
  function publicLeague(league) {
    var l = clone(league);
    if (league.draft.status !== 'complete') l.winnerBets = null;
    return l;
  }

  return {
    SCORING: SCORING,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    PLAYER_COLORS: PLAYER_COLORS,
    fail: fail,
    clone: clone,
    newLeague: newLeague,
    newDraft: newDraft,
    castawayStatus: castawayStatus,
    activeCastawayIds: activeCastawayIds,
    activePlayers: activePlayers,
    playerById: playerById,
    totalSlots: totalSlots,
    slotInfo: slotInfo,
    currentSlot: currentSlot,
    upcomingSlots: upcomingSlots,
    shuffle: shuffle,
    picksBy: picksBy,
    timesPicked: timesPicked,
    roster: roster,
    pickBlocker: pickBlocker,
    legalPicks: legalPicks,
    consensusRanking: consensusRanking,
    chooseAutoPick: chooseAutoPick,
    startDraft: startDraft,
    startMerge: startMerge,
    applyPick: applyPick,
    tick: tick,
    pause: pause,
    resume: resume,
    undo: undo,
    castawayEpisodePoints: castawayEpisodePoints,
    episodeNumbers: episodeNumbers,
    castawayTotal: castawayTotal,
    soleSurvivorId: soleSurvivorId,
    playerEpisodePoints: playerEpisodePoints,
    winnerBetBonus: winnerBetBonus,
    playerTotal: playerTotal,
    standings: standings,
    raceSeries: raceSeries,
    winProbabilities: winProbabilities,
    publicLeague: publicLeague
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
