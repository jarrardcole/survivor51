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
// Picks sent in the last seconds still count: network lag means phones show a little more time than the server has.
var GRACE_MS = 3000;
// Bots (practice only) don't have network lag, so they get no grace.
function graceFor(league, kind) {
  var d = kind === 'merge' ? league.merge : league.draft;
  var slot = Engine.currentSlot(d);
  return slot && d.botIds && d.botIds.indexOf(slot.playerId) !== -1 ? 0 : GRACE_MS;
}

// ---------- Namespaces ----------
// '' is the real league. 'practice:' is a sandbox anyone can reset, with bots, sharing this deployment.
var NS = '';
function setNs(v) { NS = v === 'practice' ? 'practice:' : ''; }
var DB = {
  loadAll: function () {
    var raw = Platform.storeLoadAll(), out = {};
    Object.keys(raw).forEach(function (k) {
      if (NS) { if (k.indexOf(NS) === 0) out[k.slice(NS.length)] = raw[k]; }
      else if (k.indexOf('practice:') !== 0) out[k] = raw[k];
    });
    return out;
  },
  set: function (k, v) { Platform.storeSet(NS + k, v); },
  cacheGet: function () { return Platform.cacheGet(NS); },
  cachePut: function (b, m) { Platform.cachePut(b, m, NS); },
  cacheClear: function () { Platform.cacheClear(NS); }
};

function doGet(e) {
  setNs(e && e.parameter && e.parameter.ns);
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
  setNs(body.ns);
  try {
    var out;
    switch (body.action) {
      case 'join':  out = Platform.withLock(function () { return actJoin(body); }); break;
      case 'login': out = actLogin(body); break;
      case 'prefs': out = Platform.withLock(function () { return actPrefs(body); }); break;
      case 'pick':  out = Platform.withLock(function () { return actPick(body); }); break;
      case 'admin': out = Platform.withLock(function () { return actAdmin(body); }); break;
      case 'practice': out = Platform.withLock(function () { return actPractice(body); }); break;
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
  var all = DB.loadAll();          // { key: parsedValue }
  if (!all[LEAGUE_KEY]) all[LEAGUE_KEY] = Engine.newLeague(51);
  if (!all[PRIVATE_KEY]) all[PRIVATE_KEY] = { byId: {} };
  return all;
}

function saveLeague(all, reason) {
  var league = all[LEAGUE_KEY];
  league.version = (league.version || 0) + 1;
  league.updatedAt = Date.now();
  DB.set(LEAGUE_KEY, league);
  DB.cacheClear();
  Platform.backup(NS + reason, league);
}

function savePrivate(all) {
  DB.set(PRIVATE_KEY, all[PRIVATE_KEY]);
}

function queuesOf(all) {
  var q = {};
  var byId = all[PRIVATE_KEY].byId;
  Object.keys(byId).forEach(function (id) { q[id] = byId[id].queue || []; });
  return q;
}

// ---------- Public read (cached) ----------
function publicPayload() {
  var cached = DB.cacheGet();
  if (cached) {
    var meta = cached.meta;
    var now = Date.now();
    var due = (meta.main && now >= meta.main) || (meta.merge && now >= meta.merge) || (meta.start && now >= meta.start);
    if (!due) return withTime(cached.body);
  }
  // Cache miss or a pick clock has expired: rebuild from the sheet (under lock if we may write).
  return withTime(Platform.withLock(function () {
    // Another request may have rebuilt the cache while we waited for the lock.
    var again = DB.cacheGet();
    if (again) {
      var m2 = again.meta, t2 = Date.now();
      if (!((m2.main && t2 >= m2.main) || (m2.merge && t2 >= m2.merge) || (m2.start && t2 >= m2.start))) return again.body;
    }
    var all = loadAll();
    var league = all[LEAGUE_KEY];
    var now = Date.now();
    var changed = false;
    // Scheduled start: the draft begins on its own at league.draftAt if autoStart is on.
    if (league.draft.status === 'open' && league.autoStart && league.draftAt && now >= Date.parse(league.draftAt)) {
      try {
        Engine.startDraft(league, CAST, { now: now, revealSec: 20, rounds: autoRounds(league) });
        changed = true;
      } catch (e) { league.autoStart = false; league.autoStartError = e.code || e.message; changed = true; }
    }
    ['main', 'merge'].forEach(function (kind) {
      var r = Engine.tick(league, CAST, kind, now - graceFor(league, kind), queuesOf(all));
      if (r) { changed = true; onDraftProgress(all, kind); }
    });
    if (changed) saveLeague(all, 'autopick');
    var body = buildPublicBody(all);
    DB.cachePut(body, {
      main: league.draft.status === 'live' && league.draft.deadline ? league.draft.deadline + graceFor(league, 'main') : null,
      merge: league.merge.status === 'live' && league.merge.deadline ? league.merge.deadline + graceFor(league, 'merge') : null,
      start: league.draft.status === 'open' && league.autoStart && league.draftAt ? Date.parse(league.draftAt) : null
    });
    return body;
  }));
}

// As many rounds as the board allows, up to the configured number.
function autoRounds(league) {
  var n = Engine.activePlayers(league).length || 1;
  var cap = Engine.activeCastawayIds(league, CAST).length * league.settings.maxPerCastaway;
  return Math.max(1, Math.min(league.settings.rounds, Math.floor(cap / n)));
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

// Players are identified by their personal link token (preferred) or their email.
function findPlayer(all, b) {
  var tok = String(b.token || '');
  if (tok) {
    var byId = all[PRIVATE_KEY].byId;
    var league = all[LEAGUE_KEY];
    for (var i = 0; i < league.players.length; i++) {
      var p = league.players[i];
      if (!p.removed && byId[p.id] && byId[p.id].token === tok) return p;
    }
    if (!b.email) return null;
  }
  return findByEmail(all, b.email);
}

function newToken() {
  return (Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8)).slice(0, 10);
}

function meView(all, p) {
  var pr = all[PRIVATE_KEY].byId[p.id] || {};
  return { id: p.id, name: p.name, color: p.color, email: pr.email, token: pr.token || null, queue: pr.queue || [], winnerPick: pr.winnerPick || null };
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
    token: newToken(),
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
  var p = findPlayer(all, b);
  if (!p) Engine.fail('not_found');
  return { me: meView(all, p) };
}

function actPrefs(b) {
  var all = loadAll();
  var p = findPlayer(all, b);
  if (!p) Engine.fail('not_found');
  var pr = all[PRIVATE_KEY].byId[p.id];
  if (b.queue !== undefined) pr.queue = cleanQueue(b.queue);
  if (b.winnerPick !== undefined) {
    if (all[LEAGUE_KEY].draft.status === 'complete' || all[LEAGUE_KEY].winnerBets) Engine.fail('winner_bet_locked');
    if (b.winnerPick !== null && !validCastaway(b.winnerPick)) Engine.fail('unknown_castaway');
    pr.winnerPick = b.winnerPick;
  }
  savePrivate(all);
  DB.cacheClear();   // lobby shows who has a bet in
  return { me: meView(all, p) };
}

function actPick(b) {
  var all = loadAll();
  var league = all[LEAGUE_KEY];
  var kind = b.kind === 'merge' ? 'merge' : 'main';
  var p = findPlayer(all, b);
  if (!p) Engine.fail('not_found');
  var now = Date.now();
  // Run the clock first: if time ran out, the auto-pick lands and this submit is stale.
  var ticked = Engine.tick(league, CAST, kind, now - graceFor(league, kind), queuesOf(all));
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
  // In the practice sandbox, the admin tools are open to anyone with key "practice".
  if (!(key && b.key === key) && !(NS && b.key === 'practice')) Engine.fail('bad_admin_key');
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
      var minted = false;
      league.players.forEach(function (p) { if (byId[p.id] && !byId[p.id].token) { byId[p.id].token = newToken(); minted = true; } });
      if (minted) savePrivate(all);
      return { players: league.players.map(function (p) {
        var pr = byId[p.id] || {};
        return { id: p.id, name: p.name, color: p.color, removed: !!p.removed, email: pr.email, token: pr.token, queue: pr.queue || [], winnerPick: pr.winnerPick || null };
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
      if (b.autoStart !== undefined) { league.autoStart = !!b.autoStart; league.autoStartError = null; }
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
    case 'undo':   out.undone = Engine.undo(draft, now);   // winner bets stay locked once revealed
      break;

    case 'pick_for': {
      var slot = Engine.currentSlot(draft);
      if (!slot) Engine.fail('draft_not_live');
      if (b.playerId && b.playerId !== slot.playerId) Engine.fail('stale_pick');
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
      if (!(Number(b.startEp) >= league.settings.scoringStartEp)) Engine.fail('bad_start_ep');
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
      DB.set('ep:' + ep, epObj);
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
      DB.set('notes:' + n, {
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

    case 'purge': {            // delete players outright (test sign-ups), only before the draft
      if (league.draft.status !== 'open') Engine.fail('draft_started');
      var match = String(b.match || '').toLowerCase();
      var byId2 = all[PRIVATE_KEY].byId;
      var keep = league.players.filter(function (p) {
        var em = (byId2[p.id] && byId2[p.id].email) || '';
        var kill = (b.removed && p.removed) || (match && em.indexOf(match) !== -1) || (b.id && p.id === b.id);
        if (kill) delete byId2[p.id];
        return !kill;
      });
      out.purged = league.players.length - keep.length;
      league.players = keep;
      savePrivate(all);
      break;
    }

    default:
      Engine.fail('unknown_op');
  }

  saveLeague(all, 'admin:' + b.op);
  out.league = Engine.publicLeague(league);
  return out;
}

// ---------- Practice sandbox ----------
var BOT_NAMES = ['Bot Boston Rob', 'Bot Parvati', 'Bot Sandra', 'Bot Tony', 'Bot Kim', 'Bot Cirie', 'Bot Ozzy', 'Bot Yul', 'Bot Sophie', 'Bot Jeremy', 'Bot Natalie'];

function actPractice(b) {
  if (!NS) Engine.fail('practice_only');
  var all = loadAll();
  var league = all[LEAGUE_KEY];
  var now = Date.now();
  var out = {};
  switch (b.op) {
    case 'start': {
      // Keep the humans, replace the bots, wipe episodes, start a fresh draft.
      var byId = all[PRIVATE_KEY].byId;
      league.players = league.players.filter(function (p) { if (p.bot) delete byId[p.id]; return !p.bot && !p.removed; });
      var humans = league.players.length;
      var nBots = Math.max(1, Math.min(Number(b.bots) || 8, 11 - humans));
      var ids = CAST.filter(function (c) { return c.status === 'active'; }).map(function (c) { return c.id; });
      for (var i = 0; i < nBots; i++) {
        var p = addPlayer(all, BOT_NAMES[i], 'bot' + i + '.' + now + '@practice.bot', { queue: Engine.shuffle(ids).slice(0, 10), winnerPick: Engine.shuffle(ids)[0] });
        p.bot = true;
      }
      league.draft = Engine.newDraft('main');
      league.merge = Engine.newDraft('merge');
      league.winnerBets = null;
      league.castaways = {};
      league.currentEp = 2;
      clearEpisodes(all);
      var botIds = league.players.filter(function (p) { return p.bot; }).map(function (p) { return p.id; });
      Engine.startDraft(league, CAST, { now: now, rounds: autoRounds(league), clockSec: Number(b.clockSec) || 45, revealSec: 8, botIds: botIds, botSec: Number(b.botSec) || 3 });
      savePrivate(all);
      break;
    }
    case 'episode': {
      if (league.draft.status !== 'complete') Engine.fail('draft_not_complete');
      var eps = Object.keys(all).filter(function (k) { return k.indexOf('ep:') === 0 && all[k] && !all[k].cleared; }).map(function (k) { return Number(k.slice(3)); });
      var ep = Math.max(league.settings.scoringStartEp - 1, Math.max.apply(null, eps.concat([0]))) + 1;
      var alive = Engine.activeCastawayIds(league, CAST);
      if (alive.length <= 3) Engine.fail('season_over');
      var merged = alive.length <= 12;
      var tribes = {};
      alive.forEach(function (id) { var t = Engine.castawayStatus(league, CAST, id).tribe; (tribes[t] = tribes[t] || []).push(id); });
      var tribeNames = Object.keys(tribes);
      var attending = merged ? alive : tribes[tribeNames[Math.floor(Math.random() * tribeNames.length)]];
      var boot = attending[Math.floor(Math.random() * attending.length)];
      var scores = {};
      attending.forEach(function (id) { if (id !== boot) scores[id] = { survives: true }; });
      if (merged) {
        var imm = attending.filter(function (id) { return id !== boot; })[Math.floor(Math.random() * (attending.length - 1))];
        scores[imm].immunityWin = true;
        if (alive.length === 12) alive.forEach(function (id) { if (id !== boot) { scores[id] = scores[id] || {}; scores[id].makesMerge = true; } });
      }
      if (Math.random() < 0.4) { var f = alive[Math.floor(Math.random() * alive.length)]; if (f !== boot) { scores[f] = scores[f] || {}; scores[f].findIdol = true; } }
      DB.set('ep:' + ep, { ep: ep, title: 'Practice episode ' + ep, scores: scores, eliminated: [{ id: boot, type: 'voted' }], published: true, savedAt: now });
      league.castaways[boot] = { status: 'eliminated', eliminatedEp: ep, elimType: 'voted', fromEpisode: true };
      league.currentEp = ep;
      out.ep = ep; out.boot = boot;
      break;
    }
    case 'reset': {
      var fresh = Engine.newLeague(51);
      fresh.players = league.players.filter(function (p) { return !p.bot && !p.removed; });
      all[LEAGUE_KEY] = league = fresh;
      clearEpisodes(all);
      break;
    }
    default: Engine.fail('unknown_op');
  }
  saveLeague(all, 'practice:' + b.op);
  out.league = Engine.publicLeague(league);
  return out;
}

function clearEpisodes(all) {
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('ep:') === 0 || k.indexOf('notes:') === 0) DB.set(k, { published: false, cleared: true });
  });
}
