// =============================================================
// SURVIVOR 51 FANTASY — backend API (runs inside Google Apps Script)
// -------------------------------------------------------------
// Every write is an atomic "action" validated on the server, instead of Season 50's
// "whole state publish" (which is how stale tabs wiped the sheet mid-merge-draft).
// Storage and Google services sit behind `Platform` (platform.js) so the same file
// runs under the local node mock server (dev/mock-server.js) for testing.
//
// GET  ?action=state            → public league + episodes + notes (+ runs the pick clock)
// POST {action:'join'|'login'|'prefs'|'pick'|'admin', ...}
// =============================================================

var PRIVATE_KEY = 'private';
var LEAGUE_KEY = 'league';

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'state';
    if (action === 'state') return Platform.raw(publicPayload());
    if (action === 'ping') return Platform.json({ ok: true, serverTime: Date.now() });
    return Platform.json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return Platform.json({ ok: false, error: err.code || err.message });
  }
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return Platform.json({ ok: false, error: 'bad_json' }); }
  try {
    var out;
    switch (body.action) {
      case 'join':  out = Platform.withLock(function () { return actJoin(body); }); break;
      case 'login': out = actLogin(body); break;
      case 'prefs': out = Platform.withLock(function () { return actPrefs(body); }); break;
      case 'pick':  out = Platform.withLock(function () { return actPick(body); }); break;
      case 'admin': out = Platform.withLock(function () { return actAdmin(body); }); break;
      default: Engine.fail('unknown_action');
    }
    out.ok = true;
    out.serverTime = Date.now();
    return Platform.json(out);
  } catch (err) {
    return Platform.json({ ok: false, error: err.code || err.message, extra: err.extra || null, serverTime: Date.now() });
  }
}

// ---------- Storage ----------
function loadAll() {
  var all = Platform.storeLoadAll();          // { key: parsedValue }
  if (!all[LEAGUE_KEY]) all[LEAGUE_KEY] = Engine.newLeague(51);
  if (!all[PRIVATE_KEY]) all[PRIVATE_KEY] = { byId: {} };
  return all;
}

function saveLeague(all, reason) {
  var league = all[LEAGUE_KEY];
  league.version = (league.version || 0) + 1;
  league.updatedAt = Date.now();
  Platform.storeSet(LEAGUE_KEY, league);
  Platform.backup(reason, league);
  Platform.cacheClear();
}

function savePrivate(all) {
  Platform.storeSet(PRIVATE_KEY, all[PRIVATE_KEY]);
}

function queuesOf(all) {
  var q = {};
  var byId = all[PRIVATE_KEY].byId;
  Object.keys(byId).forEach(function (id) { q[id] = byId[id].queue || []; });
  return q;
}

// ---------- Public read (cached) ----------
function publicPayload() {
  var cached = Platform.cacheGet();
  if (cached) {
    var meta = cached.meta;
    var now = Date.now();
    var due = (meta.main && now >= meta.main) || (meta.merge && now >= meta.merge);
    if (!due) return withTime(cached.body);
  }
  // Cache miss or a pick clock has expired: rebuild from the sheet (under lock if we may write).
  return withTime(Platform.withLock(function () {
    // Another request may have rebuilt the cache while we waited for the lock.
    var again = Platform.cacheGet();
    if (again) {
      var m2 = again.meta, t2 = Date.now();
      if (!((m2.main && t2 >= m2.main) || (m2.merge && t2 >= m2.merge))) return again.body;
    }
    var all = loadAll();
    var league = all[LEAGUE_KEY];
    var now = Date.now();
    var changed = false;
    ['main', 'merge'].forEach(function (kind) {
      var r = Engine.tick(league, CAST, kind, now, queuesOf(all));
      if (r) { changed = true; onDraftProgress(all, kind); }
    });
    if (changed) saveLeague(all, 'autopick');
    var body = buildPublicBody(all);
    Platform.cachePut(body, {
      main: league.draft.status === 'live' ? league.draft.deadline : null,
      merge: league.merge.status === 'live' ? league.merge.deadline : null
    });
    return body;
  }));
}

function withTime(body) {
  return '{"ok":true,"serverTime":' + Date.now() + ',"data":' + body + '}';
}

function buildPublicBody(all) {
  var episodes = {};
  var notes = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('ep:') === 0 && all[k] && all[k].published !== false) episodes[k.slice(3)] = all[k];
    if (k.indexOf('notes:') === 0 && all[k] && all[k].published) notes[k.slice(6)] = all[k];
  });
  var league = Engine.publicLeague(all[LEAGUE_KEY]);
  // Show who has a winner bet / draft queue in (not what it is) so the lobby can nudge people.
  var byId = all[PRIVATE_KEY].byId;
  league.players.forEach(function (p) {
    var pr = byId[p.id] || {};
    p.hasWinnerBet = !!pr.winnerPick;
    p.queueSize = (pr.queue || []).length;
  });
  return JSON.stringify({ league: league, episodes: episodes, notes: notes });
}

// When the main draft completes, the winner bets lock and become public.
function onDraftProgress(all, kind) {
  var league = all[LEAGUE_KEY];
  if (kind === 'main' && league.draft.status === 'complete' && !league.winnerBets) {
    var bets = {};
    var byId = all[PRIVATE_KEY].byId;
    Engine.activePlayers(league).forEach(function (p) {
      if (byId[p.id] && byId[p.id].winnerPick) bets[p.id] = byId[p.id].winnerPick;
    });
    league.winnerBets = bets;
  }
}

// ---------- Players ----------
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function normName(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function findByEmail(all, email) {
  email = normEmail(email);
  if (!email) return null;
  var byId = all[PRIVATE_KEY].byId;
  var league = all[LEAGUE_KEY];
  for (var i = 0; i < league.players.length; i++) {
    var p = league.players[i];
    if (!p.removed && byId[p.id] && byId[p.id].email === email) return p;
  }
  return null;
}

function meView(all, p) {
  var pr = all[PRIVATE_KEY].byId[p.id] || {};
  return { id: p.id, name: p.name, color: p.color, email: pr.email, queue: pr.queue || [], winnerPick: pr.winnerPick || null };
}

function validCastaway(id) {
  for (var i = 0; i < CAST.length; i++) if (CAST[i].id === id) return true;
  return false;
}

function cleanQueue(q) {
  if (!Array.isArray(q)) return [];
  var seen = {};
  return q.filter(function (id) {
    if (!validCastaway(id) || seen[id]) return false;
    seen[id] = true; return true;
  }).slice(0, 40);
}

function addPlayer(all, name, email, extra) {
  var league = all[LEAGUE_KEY];
  name = normName(name).slice(0, 40);
  email = normEmail(email);
  if (!name) Engine.fail('missing_name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) Engine.fail('bad_email');
  if (findByEmail(all, email)) Engine.fail('email_taken');
  var taken = league.players.some(function (p) { return !p.removed && p.name.toLowerCase() === name.toLowerCase(); });
  if (taken) Engine.fail('name_taken');
  var used = {};
  Engine.activePlayers(league).forEach(function (p) { used[p.color] = true; });
  var color = Engine.PLAYER_COLORS.filter(function (c) { return !used[c]; })[0] || Engine.PLAYER_COLORS[league.players.length % Engine.PLAYER_COLORS.length];
  var id = 'p' + Math.random().toString(36).slice(2, 8);
  var p = { id: id, name: name, color: color, joinedAt: Date.now() };
  league.players.push(p);
  all[PRIVATE_KEY].byId[id] = {
    email: email,
    queue: cleanQueue(extra && extra.queue),
    winnerPick: extra && validCastaway(extra.winnerPick) ? extra.winnerPick : null
  };
  return p;
}

function actJoin(b) {
  var all = loadAll();
  var existing = findByEmail(all, b.email);
  if (existing) return { me: meView(all, existing), existing: true };
  if (all[LEAGUE_KEY].draft.status !== 'open') Engine.fail('draft_started');
  var p = addPlayer(all, b.name, b.email, b);
  savePrivate(all);
  saveLeague(all, 'join:' + p.name);
  return { me: meView(all, p) };
}

function actLogin(b) {
  var all = loadAll();
  var p = findByEmail(all, b.email);
  if (!p) Engine.fail('not_found');
  return { me: meView(all, p) };
}

function actPrefs(b) {
  var all = loadAll();
  var p = findByEmail(all, b.email);
  if (!p) Engine.fail('not_found');
  var pr = all[PRIVATE_KEY].byId[p.id];
  if (b.queue !== undefined) pr.queue = cleanQueue(b.queue);
  if (b.winnerPick !== undefined) {
    if (all[LEAGUE_KEY].draft.status === 'complete') Engine.fail('winner_bet_locked');
    if (b.winnerPick !== null && !validCastaway(b.winnerPick)) Engine.fail('unknown_castaway');
    pr.winnerPick = b.winnerPick;
  }
  savePrivate(all);
  Platform.cacheClear();   // lobby shows who has a bet in
  return { me: meView(all, p) };
}

function actPick(b) {
  var all = loadAll();
  var league = all[LEAGUE_KEY];
  var kind = b.kind === 'merge' ? 'merge' : 'main';
  var p = findByEmail(all, b.email);
  if (!p) Engine.fail('not_found');
  var now = Date.now();
  // Run the clock first: if time ran out, the auto-pick lands and this submit is stale.
  var ticked = Engine.tick(league, CAST, kind, now, queuesOf(all));
  if (ticked) { onDraftProgress(all, kind); saveLeague(all, 'autopick'); }
  var slot = Engine.applyPick(league, CAST, kind, p.id, b.castawayId, { now: now, expectedN: b.n });
  onDraftProgress(all, kind);
  // Drop the picked castaway from everyone's queue position? No — queues are preferences;
  // auto-pick already skips anything illegal.
  saveLeague(all, 'pick:' + p.name + ':' + b.castawayId);
  return { slot: slot, league: Engine.publicLeague(league) };
}

// ---------- Admin ----------
function actAdmin(b) {
  var key = Platform.adminKey();
  if (!key || b.key !== key) Engine.fail('bad_admin_key');
  var all = loadAll();
  var league = all[LEAGUE_KEY];
  var now = Date.now();
  var kind = b.kind === 'merge' ? 'merge' : 'main';
  var draft = kind === 'merge' ? league.merge : league.draft;
  var out = {};

  switch (b.op) {
    case 'whoami':
      return { admin: true };

    case 'roster': {           // private player info for the admin console
      var byId = all[PRIVATE_KEY].byId;
      return { players: league.players.map(function (p) {
        var pr = byId[p.id] || {};
        return { id: p.id, name: p.name, color: p.color, removed: !!p.removed, email: pr.email, queue: pr.queue || [], winnerPick: pr.winnerPick || null };
      }) };
    }

    case 'settings': {
      var allowed = ['rounds', 'maxPerCastaway', 'clockSec', 'scoringStartEp', 'mergeMaxPerCastaway', 'winnerBetPoints', 'lastEpisode'];
      allowed.forEach(function (k) {
        if (b.settings && b.settings[k] !== undefined) league.settings[k] = Number(b.settings[k]);
      });
      if (b.currentEp) league.currentEp = Number(b.currentEp);
      if (b.nextAir !== undefined) league.nextAir = b.nextAir;
      if (b.draftAt !== undefined) league.draftAt = b.draftAt;
      break;
    }

    case 'add_player': {
      var np = addPlayer(all, b.name, b.email, b);
      savePrivate(all);
      out.player = np;
      break;
    }

    case 'update_player': {
      var p = Engine.playerById(league, b.id);
      if (!p) Engine.fail('not_found');
      if (b.name) p.name = normName(b.name).slice(0, 40);
      if (b.color) p.color = b.color;
      if (b.removed !== undefined) {
        if (league.draft.status !== 'open' && b.removed) Engine.fail('draft_started');
        p.removed = !!b.removed;
      }
      if (b.email) { all[PRIVATE_KEY].byId[p.id].email = normEmail(b.email); savePrivate(all); }
      if (b.winnerPick !== undefined) { all[PRIVATE_KEY].byId[p.id].winnerPick = b.winnerPick; savePrivate(all); }
      break;
    }

    case 'start_draft':
      Engine.startDraft(league, CAST, { now: now, rounds: Number(b.rounds) || null, clockSec: Number(b.clockSec) || null, revealSec: Number(b.revealSec) || 0, order: b.order || null });
      break;

    case 'pause':  Engine.pause(draft, now); break;
    case 'resume': Engine.resume(draft, now); break;
    case 'undo':   out.undone = Engine.undo(draft, now);
      if (kind === 'main') league.winnerBets = null;
      break;

    case 'pick_for': {
      var slot = Engine.currentSlot(draft);
      if (!slot) Engine.fail('draft_not_live');
      Engine.applyPick(league, CAST, kind, slot.playerId, b.castawayId, { now: now, admin: true, auto: 'commissioner', expectedN: b.n });
      onDraftProgress(all, kind);
      break;
    }

    case 'autopick_now': {
      if (draft.status !== 'live') Engine.fail('draft_not_live');
      draft.deadline = now;
      Engine.tick(league, CAST, kind, now, queuesOf(all));
      onDraftProgress(all, kind);
      break;
    }

    case 'set_clock':
      draft.clockSec = Number(b.clockSec) || 0;
      if (draft.status === 'live') draft.deadline = draft.clockSec ? now + draft.clockSec * 1000 : null;
      break;

    case 'reset_draft':
      if (b.confirm !== 'RESET') Engine.fail('confirm_required');
      league.draft = Engine.newDraft('main');
      league.draft.rounds = league.settings.rounds;
      league.draft.clockSec = league.settings.clockSec;
      league.merge = Engine.newDraft('merge');
      league.winnerBets = null;
      break;

    case 'start_merge':
      Engine.startMerge(league, CAST, { now: now, order: b.order, startEp: Number(b.startEp), clockSec: Number(b.clockSec) || 0 });
      break;

    case 'save_episode': {
      var ep = Number(b.ep);
      if (!ep) Engine.fail('missing_ep');
      var data = b.data || {};
      var epObj = {
        ep: ep,
        title: String(data.title || '').slice(0, 120),
        airDate: data.airDate || null,
        scores: data.scores || {},
        eliminated: (data.eliminated || []).filter(function (x) { return validCastaway(x.id); }),
        published: data.published !== false,
        savedAt: now
      };
      Platform.storeSet('ep:' + ep, epObj);
      // Castaway status follows the episode: clear this episode's old eliminations, apply new ones.
      Object.keys(league.castaways).forEach(function (id) {
        if (league.castaways[id].eliminatedEp === ep && league.castaways[id].fromEpisode) delete league.castaways[id];
      });
      epObj.eliminated.forEach(function (x) {
        league.castaways[x.id] = { status: 'eliminated', eliminatedEp: ep, elimType: x.type || 'voted', fromEpisode: true };
      });
      if (ep > (league.currentEp || 0)) league.currentEp = ep;
      break;
    }

    case 'set_castaway': {
      if (!validCastaway(b.id)) Engine.fail('unknown_castaway');
      var o = league.castaways[b.id] || {};
      if (b.status) o.status = b.status;
      if (b.eliminatedEp !== undefined) o.eliminatedEp = b.eliminatedEp;
      if (b.elimType !== undefined) o.elimType = b.elimType;
      if (b.tribe) o.tribe = b.tribe;
      delete o.fromEpisode;
      league.castaways[b.id] = o;
      break;
    }

    case 'save_notes': {
      var n = Number(b.ep);
      if (!n && n !== 0) Engine.fail('missing_ep');
      Platform.storeSet('notes:' + n, {
        ep: n,
        title: String(b.title || '').slice(0, 160),
        body: String(b.body || '').slice(0, 45000),
        author: String(b.author || 'The Commissioner').slice(0, 60),
        published: b.published !== false,
        publishedAt: now
      });
      break;
    }

    case 'drafts': {           // everything incl. unpublished episodes and notes, admin only
      var notes = {}, eps = {};
      Object.keys(all).forEach(function (k) {
        if (k.indexOf('notes:') === 0) notes[k.slice(6)] = all[k];
        if (k.indexOf('ep:') === 0) eps[k.slice(3)] = all[k];
      });
      return { notes: notes, episodes: eps };
    }

    case 'backup':
      return { dump: loadAll() };

    default:
      Engine.fail('unknown_op');
  }

  saveLeague(all, 'admin:' + b.op);
  out.league = Engine.publicLeague(league);
  return out;
}
