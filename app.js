// =============================================================
// SURVIVOR 51 FANTASY — site
// Talks to the backend (Apps Script or dev/mock-server.js) and renders every page.
// Game rules live in engine.js; this file never decides whether a pick is legal on its own.
// =============================================================
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var PRACTICE = !!CONFIG.PRACTICE;
  var PFX = PRACTICE ? 's51p_' : 's51_';   // practice never touches your real sign-in
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(PFX + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(PFX + k); } catch (e) { /* ignore */ } }
  };
  // Build a link to the site, keeping practice mode if we're in it.
  function siteUrl(query, hash) {
    var q = [];
    if (PRACTICE) q.push('practice');
    if (query) q.push(query);
    return CONFIG.SITE_URL + (q.length ? '?' + q.join('&') : '') + (hash || '');
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  var CASTBY = {};
  CAST.forEach(function (c) { CASTBY[c.id] = c; });

  // ---------- app state ----------
  var params = new URLSearchParams(location.search);
  var S = {
    data: null,                // { league, episodes, notes }
    version: -1,
    offset: 0,                 // server clock − local clock
    me: params.has('tv') ? null : store.get('me', null), // { id, name, email, queue, winnerPick, color }; the TV is nobody
    adminKey: store.get('admin', null),
    isAdmin: false,
    route: 'home',
    tv: params.has('tv'),
    seenPicks: { main: null, merge: null },
    seenStatus: { main: null, merge: null },
    boardFilter: store.get('filter', 'all'),
    showBigBoard: false,
    revealQueue: [],
    revealing: false,
    dragging: false,
    lastPollOk: 0,
    failures: 0,
    sound: store.get('sound', true),
    watched: store.get('watched', 0),
    openRow: null,
    adminTab: store.get('adminTab', 'draft'),
    adminEp: null,
    adminDrafts: null,
    hiddenSeries: {}
  };

  if (params.get('admin')) {
    S.adminKey = params.get('admin');
    store.set('admin', S.adminKey);
    params.delete('admin');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
  }
  if (S.tv) document.body.classList.add('tv');
  var LINK_TOKEN = params.get('me');
  if (LINK_TOKEN) {
    params.delete('me');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
  }
  // Who am I, for every player-scoped call. The personal-link token wins over email.
  function ident() { return { email: S.me && S.me.email, token: S.me && S.me.token }; }

  function now() { return Date.now() + S.offset; }

  // ---------- API ----------
  function apiGet() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 10000);
    var sent = Date.now();
    return fetch(CONFIG.API_URL + '?action=state' + (PRACTICE ? '&ns=practice' : '') + '&t=' + sent, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('http_' + r.status); return r.json(); })
      .then(function (res) { if (timer) clearTimeout(timer); res._rtt = Date.now() - sent; return res; },
            function (e) { if (timer) clearTimeout(timer); throw e; });
  }
  function apiPost(body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 25000);
    return fetch(CONFIG.API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(PRACTICE ? Object.assign({ ns: 'practice' }, body) : body), signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (res.serverTime) S.offset = res.serverTime - Date.now();
        if (!res.ok) { var e = new Error(res.error || 'error'); e.code = res.error; e.extra = res.extra; throw e; }
        return res;
      }, function (err) {
        if (timer) clearTimeout(timer);
        var e = new Error('network'); e.code = err.name === 'AbortError' ? 'timeout' : 'network'; throw e;
      });
  }
  function admin(op, extra) {
    var body = Object.assign({ action: 'admin', key: S.adminKey, op: op }, extra || {});
    return apiPost(body).then(function (res) {
      if (res.league) acceptLeague(res.league);
      return res;
    });
  }

  var ERRORS = {
    not_your_turn: "It's not your turn anymore.",
    stale_pick: 'That pick already closed (the clock ran out). Refreshing the board.',
    off_board: "That castaway has already been picked twice.",
    already_yours: "They're already on your team.",
    castaway_out: "That castaway is out of the game.",
    draft_paused: 'The draft is paused. Hang tight.',
    draft_not_live: "The draft isn't live right now.",
    draft_complete: 'The draft is over.',
    server_busy: 'The server is busy. Try again in a second.',
    not_found: "We couldn't find that email. Join the league first.",
    name_taken: 'Someone already has that name. Add a last initial?',
    email_taken: 'That email is already in the league.',
    draft_started: 'The draft already started. Ask Will to add you.',
    bad_email: "That email doesn't look right.",
    missing_name: 'Add your name.',
    winner_bet_locked: 'Winner bets locked when the draft finished.',
    bad_admin_key: "That admin link isn't valid.",
    too_many_picks: "There aren't enough castaways for that many rounds.",
    network: "Couldn't reach the server. Check your connection.",
    timeout: 'The server took too long. Try again.'
  };
  function errMsg(e) { return ERRORS[e.code] || ('Something went wrong (' + (e.code || e.message) + ').'); }

  // ---------- data intake ----------
  function acceptPayload(res) {
    // serverTime was stamped roughly mid-flight, so add half the round trip.
    if (res.serverTime) S.offset = res.serverTime + (res._rtt || 0) / 2 - Date.now();
    var d = res.data;
    var prev = S.data;
    if (prev && d.league.version < S.version) return false;   // an older response arrived late
    S.data = d;
    var changed = !prev || d.league.version !== S.version;
    S.version = d.league.version;
    if (S.me) {
      var p = Engine.playerById(d.league, S.me.id);
      if (p && !p.removed) { S.me.name = p.name; S.me.color = p.color; }
    }
    detectDraftEvents(prev);
    return changed;
  }
  function acceptLeague(league) {
    if (!S.data || league.version < S.version) return;
    var prev = { league: S.data.league };
    S.data.league = league;
    S.version = league.version;
    detectDraftEvents(prev);
    render();
  }

  // New picks → reveal animation; draft start → order reveal; your turn → alert.
  function detectDraftEvents(prev) {
    var L = S.data.league;
    ['main', 'merge'].forEach(function (kind) {
      var d = kind === 'merge' ? L.merge : L.draft;
      var seen = S.seenPicks[kind];
      if (seen == null) { S.seenPicks[kind] = d.picks.length; S.seenStatus[kind] = d.status; return; }
      if (S.seenStatus[kind] === (kind === 'merge' ? 'off' : 'open') && d.status === 'live') {
        S.revealQueue.push({ type: 'order', kind: kind });
      }
      if (d.picks.length > seen) {
        var fresh = d.picks.slice(seen);
        if (fresh.length <= 3) fresh.forEach(function (p) { if (p.castawayId) S.revealQueue.push({ type: 'pick', kind: kind, pick: p }); });
        else toast(plural(fresh.length, 'new pick') + ' came in.');
      }
      S.seenPicks[kind] = d.picks.length;
      S.seenStatus[kind] = d.status;
    });
    checkMyTurn();
    runReveals();
  }

  // ---------- polling ----------
  var pollTimer = null, polling = null;
  function liveKind() {
    if (!S.data) return null;
    var L = S.data.league;
    if (L.merge.status === 'live' || L.merge.status === 'paused') return 'merge';
    if (L.draft.status === 'live' || L.draft.status === 'paused') return 'main';
    return null;
  }
  function pollDelay() {
    if (document.hidden) return liveKind() ? 8000 : 120000;
    if (liveKind()) return 2500;
    if (S.data && S.data.league.draft.status === 'open' && (S.route === 'draft' || S.route === 'home')) return 8000;
    return 60000;
  }
  function poll() {
    clearTimeout(pollTimer);
    if (polling) return polling;            // never run two poll loops at once
    polling = apiGet().then(function (res) {
      S.failures = 0;
      S.lastPollOk = Date.now();
      var changed = acceptPayload(res);
      if (changed) render(); else renderChrome();
    }).catch(function () {
      S.failures++;
      renderChrome();
    }).then(function () {
      polling = null;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, S.failures ? Math.min(15000, 2500 * S.failures) : pollDelay());
    });
    return polling;
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  // ---------- routing ----------
  var ROUTES = ['home', 'draft', 'standings', 'cast', 'rules', 'join', 'admin'];
  function route() {
    var r = (location.hash || '#home').slice(1).split('/')[0] || 'home';
    if (ROUTES.indexOf(r) === -1) r = 'home';
    if (r === 'admin' && !S.adminKey) r = 'home';
    S.route = r;
    if (S.tv) S.route = 'draft';
    $$('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + S.route); });
    $$('[data-route]').forEach(function (a) { a.classList.toggle('active', a.dataset.route === S.route); });
    render();
    window.scrollTo(0, 0);
    if (S.data && !polling) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, Date.now() - S.lastPollOk > 15000 ? 0 : pollDelay()); }
  }
  window.addEventListener('hashchange', route);

  // ---------- spoilers ----------
  // Results from an episode that aired in the last 6 days stay hidden until you say you've watched it.
  function airTime(ep) {
    var s = CONFIG.AIR_DATES[ep];
    return s ? new Date(s).getTime() : null;
  }
  function hiddenFromEp() {
    if (!S.data) return null;
    var eps = Object.keys(S.data.episodes).map(Number).sort(function (a, b) { return a - b; });
    var t = now();
    for (var i = 0; i < eps.length; i++) {
      var ep = eps[i];
      var at = airTime(ep);
      if (ep > S.watched && at && t - at > -86400000 && t - at < 6 * 86400000) return ep;
    }
    return null;
  }
  // A copy of the data with hidden episodes removed and their eliminations undone.
  function view() {
    var d = S.data;
    var h = hiddenFromEp();
    if (h == null) return { league: d.league, episodes: d.episodes, notes: d.notes, hidden: null };
    var league = Engine.clone(d.league);
    Object.keys(league.castaways).forEach(function (id) {
      var o = league.castaways[id];
      if (o.eliminatedEp != null && o.eliminatedEp >= h) delete league.castaways[id];
    });
    var episodes = {};
    Object.keys(d.episodes).forEach(function (k) { if (Number(k) < h) episodes[k] = d.episodes[k]; });
    return { league: league, episodes: episodes, notes: d.notes, hidden: h };
  }
  function markWatched(ep) {
    S.watched = Math.max(S.watched, ep);
    store.set('watched', S.watched);
    render();
  }
  function spoilerBar(v) {
    if (!v.hidden) return '';
    var latest = Math.max.apply(null, Object.keys(S.data.episodes).map(Number));
    return '<div class="spoiler-gate" style="padding:18px;margin-bottom:16px">' +
      '<div class="row" style="justify-content:center"><span class="big" style="font-size:26px">🙈</span>' +
      '<div style="text-align:left"><b>Episode ' + v.hidden + (latest > v.hidden ? '–' + latest : '') + ' results are hidden</b>' +
      '<div class="muted small">Standings, eliminations and the write-up stay spoiler-free until you say so.</div></div>' +
      '<button class="btn primary sm" data-act="watched" data-ep="' + latest + '">I\'ve watched Episode ' + latest + '</button></div></div>';
  }

  // ---------- shared bits ----------
  function st(v, id) { return Engine.castawayStatus(v.league, CAST, id); }
  function photo(id) { var c = CASTBY[id]; return c && c.photo ? c.photo : ''; }
  function ava(id, size, v) {
    var c = CASTBY[id]; if (!c) return '';
    var s = v ? st(v, id) : { tribe: c.tribe, status: c.status };
    return '<span class="ava ' + (size || '') + ' tribe-' + esc(s.tribe) + (s.status !== 'active' ? ' out' : '') + '" style="background-image:url(\'' + esc(photo(id)) + '\')" role="img" aria-label="' + esc(c.shortName) + '"></span>';
  }
  function playerName(L, id) { var p = Engine.playerById(L, id); return p ? p.name : '?'; }
  function playerColor(L, id) { var p = Engine.playerById(L, id); return p ? p.color : '#888'; }
  function isMe(id) { return S.me && S.me.id === id; }
  function amIn() { return S.me && S.data && Engine.playerById(S.data.league, S.me.id); }

  function ownersOf(L, id) {
    var out = [];
    L.draft.picks.forEach(function (p) { if (p.castawayId === id) out.push({ playerId: p.playerId, kind: 'main' }); });
    L.merge.picks.forEach(function (p) { if (p.castawayId === id) out.push({ playerId: p.playerId, kind: 'merge' }); });
    return out;
  }

  // ---------- chrome: nav, me chip, banner ----------
  function renderChrome() {
    document.body.classList.toggle('is-admin', !!S.isAdmin);
    var chip = $('#meChip');
    if (S.me && amIn()) {
      chip.innerHTML = '<button class="who" data-act="me"><span class="dot" style="background:' + esc(S.me.color) + '"></span>' + esc(S.me.name.split(' ')[0]) + '</button>';
    } else if (S.data && S.data.league.draft.status === 'open') {
      chip.innerHTML = '<a class="btn primary sm" href="#join">Join</a><button class="btn sm ghost" data-act="signin">Sign in</button>';
    } else {
      chip.innerHTML = '<button class="btn sm ghost" data-act="signin">Sign in</button>';
    }
    var lk = liveKind();
    $$('[data-route="draft"]').forEach(function (a) { a.classList.toggle('live', !!lk && S.data && S.data[lk === 'merge' ? 'league' : 'league'][lk === 'merge' ? 'merge' : 'draft'].status === 'live'); });

    var banner = $('#banner');
    var html = '', cls = '';
    if (PRACTICE && !S.tv) {
      html = '🧪 Practice mode: bots, fake episodes, nothing counts. <a class="btn sm" href="' + esc(CONFIG.SITE_URL) + '">Go to the real league</a>';
      cls = 'practice';
    }
    if (S.failures >= 3) {
      html = '⚠️ Can’t reach the server. Retrying…';
    } else if (lk) {
      var d = draftOf(lk);
      var slot = Engine.currentSlot(d);
      if (slot && isMe(slot.playerId) && d.status === 'live') {
        cls = 'yours';
        html = '🔥 You’re on the clock! <span data-clock="' + lk + '"></span>' + (S.route !== 'draft' ? ' <a class="btn sm" href="#draft">Pick now</a>' : '');
      } else if (S.route !== 'draft' && slot) {
        html = (lk === 'merge' ? 'Merge draft' : 'The draft') + ' is ' + (d.status === 'paused' ? 'paused' : 'live') + ' · ' + esc(playerName(S.data.league, slot.playerId)) + ' is up <a class="btn sm" href="#draft">Watch</a>';
      }
    }
    banner.hidden = !html;
    banner.className = 'banner ' + cls;
    banner.innerHTML = html;
    tickClocks();
  }

  function draftOf(kind) { return kind === 'merge' ? S.data.league.merge : S.data.league.draft; }

  // ---------- clocks (updated 4× a second without re-rendering) ----------
  function clockText(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : String(s);
  }
  function tickClocks() {
    if (!S.data) return;
    $$('[data-clock]').forEach(function (el) {
      var d = draftOf(el.dataset.clock);
      var ms = d.status === 'paused' ? d.pausedRemainingMs : (d.deadline ? d.deadline - now() : null);
      el.textContent = ms == null ? '' : clockText(ms);
    });
    $$('[data-ring]').forEach(function (el) {
      var d = draftOf(el.dataset.ring);
      var total = (d.clockSec || 90) * 1000;
      var ms = d.status === 'paused' ? d.pausedRemainingMs : (d.deadline ? d.deadline - now() : total);
      ms = Math.max(0, ms == null ? total : ms);
      var frac = Math.min(1, ms / total);
      var c = el.querySelector('.arc');
      if (c) c.style.strokeDashoffset = String(213.6 * (1 - frac));
      el.classList.toggle('low', d.status === 'live' && ms < 15000);
      var t = el.querySelector('.t');
      if (t) t.textContent = d.status === 'paused' ? '❚❚' : clockText(ms);
    });
    $$('[data-countdown]').forEach(function (el) {
      var ms = Number(el.dataset.countdown) - now();
      if (ms <= 0) { el.innerHTML = '<div><b>Now</b><span>🔥</span></div>'; return; }
      var d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
      var parts = d ? [[d, 'days'], [h, 'hrs'], [m, 'min']] : [[h, 'hrs'], [m, 'min'], [s, 'sec']];
      el.innerHTML = parts.map(function (p) { return '<div><b>' + p[0] + '</b><span>' + p[1] + '</span></div>'; }).join('');
    });
  }
  setInterval(tickClocks, 250);

  // ---------- your-turn alerts ----------
  var myTurnKey = null, titleTimer = null;
  function checkMyTurn() {
    var lk = liveKind();
    var key = null;
    if (lk && S.me) {
      var d = draftOf(lk), slot = Engine.currentSlot(d);
      if (slot && isMe(slot.playerId) && d.status === 'live') key = lk + ':' + slot.n;
    }
    if (key && key !== myTurnKey) {
      if (!S.tv && !$('#reveal').hidden) { $('#reveal').hidden = true; S.revealing = false; }
      if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([250, 120, 250, 120, 400]);
      if (S.sound) chime();
      if (document.hidden && window.Notification && Notification.permission === 'granted') {
        try { new Notification('🔥 You’re on the clock!', { body: 'Survivor 51 draft: make your pick.' }); } catch (e) { /* ignore */ }
      }
      clearInterval(titleTimer);
      var on = false;
      titleTimer = setInterval(function () { on = !on; document.title = on ? '🔥 YOUR PICK' : 'Survivor 51 Fantasy'; }, 900);
    }
    if (!key) { clearInterval(titleTimer); document.title = 'Survivor 51 Fantasy'; }
    myTurnKey = key;
  }
  var audioCtx = null;
  // iPhones only allow sound after a tap, and they don't vibrate from web pages.
  // Unlock audio on the first tap anywhere so the turn chime can play later.
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio */ }
  }
  document.addEventListener('touchend', unlockAudio, { passive: true });
  document.addEventListener('click', unlockAudio);
  function chime() {
    try {
      unlockAudio();
      [0, 0.18, 0.36].forEach(function (t, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'triangle'; o.frequency.value = [523, 659, 784][i];
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.5);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.55);
      });
    } catch (e) { /* no audio */ }
  }

  // ---------- reveals ----------
  var revealId = 0;
  function runReveals() {
    if (S.revealing || !S.revealQueue.length) return;
    // Don't bury someone mid-pick under an animation.
    if (!$('#sheet').hidden && !S.tv) { setTimeout(runReveals, 1500); return; }
    // Never cover the board while your own clock is running: skip straight to a one-line toast.
    if (myTurnKey && !S.tv) {
      var lastPick = S.revealQueue.filter(function (x) { return x.type === 'pick'; }).pop();
      S.revealQueue = [];
      if (lastPick) toast(playerName(S.data.league, lastPick.pick.playerId) + ' took ' + CASTBY[lastPick.pick.castawayId].shortName + '. You’re up!');
      return;
    }
    // If we've fallen far behind (fast bots, a wifi blip), skip ahead to the latest picks.
    if (S.revealQueue.length > 3) S.revealQueue = S.revealQueue.slice(-2);
    var backlog = S.revealQueue.length;   // speed up when picks arrive faster than we can show them
    var item = S.revealQueue.shift();
    S.revealing = true;
    var el = $('#reveal');
    var L = S.data.league;
    var ms;
    if (item.type === 'order') {
      var d = draftOf(item.kind);
      el.className = 'reveal order';
      el.innerHTML = '<div><div class="with">' + (item.kind === 'merge' ? 'Merge draft order' : 'The draft order is in') + '</div>' +
        '<div class="who">' + (item.kind === 'merge' ? 'Last place picks first' : 'Snake draft · ' + plural(d.rounds, 'round')) + '</div>' +
        '<div class="list' + (d.order.length > 7 ? ' two' : '') + '">' + d.order.map(function (pid, i) {
          return '<div style="animation-delay:' + (0.4 + i * 0.35) + 's"><span class="n">' + (i + 1) + '</span><span class="dot" style="background:' + esc(playerColor(L, pid)) + '"></span>' + esc(playerName(L, pid)) + (isMe(pid) ? ' <span class="chip warn">you</span>' : '') + '</div>';
        }).join('') + '</div><div class="tiny dim" style="margin-top:16px">tap to continue</div></div>';
      ms = 3000 + d.order.length * 400 + (S.tv ? 6000 : 2500);
    } else {
      var p = item.pick, c = CASTBY[p.castawayId];
      var d2 = draftOf(item.kind);
      var slot = Engine.slotInfo(d2, p.n) || { round: 1 };
      var times = Engine.timesPicked({ picks: d2.picks.slice(0, p.n + 1) }, p.castawayId);
      var ctx = item.kind === 'merge' ? 'Merge pick' : 'Round ' + slot.round + ' · ' + (times === 2 ? 'second time picked — now off the board' : 'first time picked');
      el.className = 'reveal';
      el.innerHTML = '<div><div class="with">With the ' + ordinal(p.n + 1) + ' pick' + (item.kind === 'merge' ? ' of the merge draft' : '') + '</div>' +
        '<div class="who" style="color:' + esc(playerColor(L, p.playerId)) + '">' + esc(playerName(L, p.playerId)) + '</div>' +
        '<div class="sel">selects</div>' +
        '<div class="ph tribe-' + esc(c.tribe) + '" style="background-image:url(\'' + esc(photo(c.id)) + '\')"></div>' +
        '<div class="cn">' + esc(c.shortName) + '</div>' +
        '<div class="ctx">' + esc(c.tribe) + ' · ' + esc(c.occupation) + ' · ' + esc(ctx) + '</div>' +
        (p.auto && p.auto !== 'commissioner' ? '<div class="auto chip warn">⏱ Auto-pick (' + (p.auto === 'queue' ? 'from their list' : 'league favorite') + ')</div>' : '') +
        (p.auto === 'commissioner' ? '<div class="auto chip">Entered by the commissioner</div>' : '') +
        '</div>';
      ms = backlog > 1 ? 2000 : S.tv ? 6500 : 4200;
    }
    el.hidden = false;
    var rid = ++revealId;
    var done = function () {
      if (el.hidden || rid !== revealId) return;
      el.hidden = true; S.revealing = false;
      setTimeout(runReveals, 250);
    };
    el.onclick = done;
    setTimeout(done, ms);
  }

  // ---------- toast / sheet ----------
  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 5000 : 3200);
  }
  function openSheet(html) {
    var sh = $('#sheet');
    sh.innerHTML = '<button class="x" data-act="close" aria-label="Close">✕</button>' + html;
    sh.hidden = false; $('#sheetBackdrop').hidden = false;
    var f = sh.querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 60);
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true; runReveals(); }
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  // ---------- markdown (small, safe) ----------
  function md(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n');
    var out = [], para = [], list = null;
    function inline(s) {
      s = esc(s);
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
           .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
           .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
           .replace(/(^|[\s(])([+−-]\d{1,3})(?= ?(?:pts?|points)\b)/g, function (m, pre, n) {
             return pre + '<span class="pts' + (/^[−-]/.test(n) ? ' neg' : '') + '">' + n + '</span>';
           });
      return s;
    }
    function flushPara() { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
    lines.forEach(function (ln) {
      var m;
      if (!ln.trim()) { flushPara(); flushList(); return; }
      if ((m = ln.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); var lvl = Math.min(3, m[1].length + 1); out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>'); return; }
      if (/^(-{3,}|\*{3,})$/.test(ln.trim())) { flushPara(); flushList(); out.push('<hr>'); return; }
      if ((m = ln.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); return; }
      if ((m = ln.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); return; }
      if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); return; }
      flushList(); para.push(ln.trim());
    });
    flushPara(); flushList();
    return out.join('\n');
  }

  // =============================================================
  // PAGES
  // =============================================================
  function render() {
    renderChrome();
    if (!S.data) {
      $('#page-' + S.route).innerHTML = '<div class="center muted" style="padding:80px 0"><div class="brand-flame" style="margin:0 auto 14px;width:34px;height:42px"></div>Lighting the torches…</div>';
      return;
    }
    if (S.dragging) return;
    var fn = { home: renderHome, draft: renderDraft, standings: renderStandings, cast: renderCast, rules: renderRules, join: renderJoin, admin: renderAdmin }[S.route];
    if (S.route === 'admin' || S.route === 'join') {
      // Forms: only draw once per visit so polling never wipes what someone is typing.
      var pg = $('#page-' + S.route);
      var typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && pg.contains(document.activeElement);
      // The admin Draft tab has no free-text fields worth protecting, so keep it live during the draft.
      var liveAdmin = S.route === 'admin' && S.adminTab === 'draft' && pg.dataset.version !== String(S.version) && !typing;
      if (pg.dataset.drawn === '1' && !liveAdmin) return;
      pg.dataset.drawn = '1';
      pg.dataset.version = String(S.version);
    }
    fn();
  }
  function redraw(routeName) {
    var pg = $('#page-' + routeName);
    if (pg) pg.dataset.drawn = '';
    render();
  }
  window.addEventListener('hashchange', function () { $('#page-admin').dataset.drawn = ''; $('#page-join').dataset.drawn = ''; });

  // ---------- HOME ----------
  function renderHome() {
    var v = view();
    var L = v.league;
    var h = '';
    var phase = L.draft.status;
    var lk = liveKind();

    // Hero
    h += '<div class="hero">';
    if (phase === 'open') {
      var draftAt = L.draftAt ? new Date(L.draftAt).getTime() : null;
      h += '<div class="eyebrow">' + (PRACTICE ? '🧪 Practice league' : 'Season 51 · Fiji · The Open Era') + '</div>' +
        '<h1>' + (PRACTICE ? 'Take it for a <em>test drive</em>' : 'Draft night is <em>coming</em>') + '</h1>' +
        '<p>Twenty castaways are left after the premiere. We draft on Episode 2 night (Wed, Sep 30). Everyone picks from their own phone, so it works the same in the room or across the country.</p>' +
        (draftAt ? '<div class="countdown" data-countdown="' + draftAt + '"></div>' : '') +
        '<div class="row">' + (amIn()
          ? '<a class="btn primary lg" href="#draft">Rank your board →</a>'
          : '<a class="btn primary lg" href="#join">Join the league</a><button class="btn lg" data-act="signin">I already joined</button>') + '</div>';
    } else if (lk) {
      var d = draftOf(lk), slot = Engine.currentSlot(d);
      h += '<div class="eyebrow"><span class="chip live">LIVE</span></div>' +
        '<h1>The ' + (lk === 'merge' ? 'merge draft' : 'draft') + ' is <em>' + (d.status === 'paused' ? 'paused' : 'on') + '</em></h1>' +
        '<p>' + (slot ? esc(playerName(L, slot.playerId)) + ' is on the clock · pick ' + (slot.n + 1) + ' of ' + Engine.totalSlots(d) : '') + '</p>' +
        '<div class="row"><a class="btn primary lg" href="#draft">Enter the draft room →</a></div>';
    } else {
      var next = nextEpisode();
      var rows = Engine.standings(L, v.episodes);
      var scored = Engine.episodeNumbers(L, v.episodes);
      h += '<div class="eyebrow">Season 51 · ' + (scored.length ? 'After Episode ' + scored[scored.length - 1] : 'Tribes are set') + '</div>';
      if (rows.length && scored.length && rows[0].total > 0) {
        var leaders = rows.filter(function (r) { return r.rank === 1; });
        h += '<h1><em>' + esc(leaders.map(function (r) { return r.name.split(' ')[0]; }).join(' & ')) + '</em> ' + (leaders.length > 1 ? 'share' : 'leads') + ' the league</h1>' +
          '<p>' + rows[0].total + ' points' + (rows[1] && rows[1].rank !== 1 ? ', ' + (rows[0].total - rows[1].total) + ' ahead of ' + esc(rows[1].name) : '') + '. ' + (next ? 'Episode ' + next.ep + ' is next.' : '') + '</p>';
      } else {
        h += '<h1>The tribes <em>have been drafted</em></h1><p>Scoring starts with Episode 3. ' + (next ? 'Next up: Episode ' + next.ep + '.' : '') + '</p>';
      }
      if (next) h += '<div class="countdown" data-countdown="' + next.at + '"></div>';
      h += '<div class="row"><a class="btn primary" href="#standings">Standings</a><a class="btn" href="#draft">Draft board</a></div>';
    }
    h += '</div>';

    h += spoilerBar(v);
    if (PRACTICE) h += '<div style="margin-top:18px">' + practiceLab() + '</div>';

    // Commissioner's Notes
    h += '<div class="split" style="margin-top:18px">';
    h += '<div>' + notesBlock(v) + '</div>';
    h += '<div class="stack">';
    if (phase === 'open') h += lobbyCard(L);
    else {
      h += miniStandings(v);
      if (amIn()) h += myTeamCard(v);
    }
    h += '</div></div>';
    $('#page-home').innerHTML = h;
  }

  // ---------- Practice lab ----------
  function practiceLab() {
    var L = S.data.league;
    var d = L.draft;
    var h = '<div class="card" style="border-color:rgba(94,217,160,.35)"><div class="row" style="margin-bottom:10px"><span style="font-size:26px">🧪</span><div class="grow"><h3 style="margin:0">Practice lab</h3><div class="small muted">Try everything with bots before the real thing. Anyone can reset this.</div></div></div>';
    if (!amIn()) {
      h += '<div class="steps small"><div><div><b>Join the practice league</b> with any name and email (it’s separate from the real one).</div></div><div><div>Start a practice draft against bots. They pick in about 3 seconds; you get 45.</div></div><div><div>After the draft, simulate episodes to see standings move.</div></div></div>' +
        '<div class="row" style="margin-top:12px"><a class="btn primary" href="#join">Join practice</a><button class="btn" data-act="signin">Sign in</button></div>';
      return h + '</div>';
    }
    h += '<div class="row">';
    if (d.status === 'open' || d.status === 'complete') h += '<button class="btn primary" data-act="p_start">🔥 ' + (d.status === 'open' ? 'Start a practice draft vs bots' : 'Draft again') + '</button>';
    else h += '<a class="btn primary" href="#draft">Go to the draft room →</a>';
    if (d.status === 'complete') h += '<button class="btn" data-act="p_episode">📺 Simulate next episode</button>';
    h += '<button class="btn ghost" data-act="p_reset">Reset practice</button></div>';
    h += '<div class="row small" style="margin-top:12px"><span class="muted">Also try:</span><a href="' + esc(siteUrl('admin=practice', '#admin')) + '">Will’s admin view</a><span class="dim">·</span><a href="' + esc(siteUrl('tv')) + '" target="_blank" rel="noopener">TV view</a><span class="dim">·</span><button class="btn sm ghost" data-act="copy" data-url="' + esc(S.me.token ? personalLink(S.me.token) : '') + '">Copy my practice link (open on your phone)</button></div>';
    return h + '</div>';
  }

  function nextEpisode() {
    var t = now();
    var scored = S.data ? Object.keys(S.data.episodes).map(Number) : [];
    var after = scored.length ? Math.max.apply(null, scored) : 0;
    for (var ep = after + 1; ep <= 14; ep++) {
      var at = airTime(ep);
      if (at && at + 90 * 60000 > t) return { ep: ep, at: at };
    }
    return null;
  }

  function notesBlock(v) {
    var keys = Object.keys(v.notes || {}).map(Number).sort(function (a, b) { return b - a; });
    if (!keys.length) {
      return '<div class="card notes"><div class="notes-head"><div class="notes-badge">📜</div><div><div class="eyebrow">Commissioner’s Notes</div><h3 style="margin:2px 0 0">The first write-up drops after the draft</h3></div></div><p class="muted">Every week: who scored, who got burned, and what it means for the league.</p></div>';
    }
    var sel = S.notesEp != null && keys.indexOf(S.notesEp) !== -1 ? S.notesEp : keys[0];
    var n = v.notes[sel];
    var gated = v.hidden != null && sel >= v.hidden;
    var h = '<article class="card notes">';
    h += '<div class="notes-head"><div class="notes-badge">📜</div><div class="grow"><div class="eyebrow">Commissioner’s Notes · ' + (sel === 0 ? 'Preseason' : 'Episode ' + sel) + '</div>' +
      '<div class="tiny dim">' + esc(n.author || 'The Commissioner') + ' · ' + new Date(n.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</div></div></div>';
    if (gated) {
      h += '<div class="spoiler-gate"><div class="big">🙈</div><h3>Spoilers for Episode ' + sel + '</h3><p class="muted">This write-up covers what happened on the show.</p><button class="btn primary" data-act="watched" data-ep="' + sel + '">I’ve watched it — show me</button></div>';
    } else {
      h += '<h2 class="notes-title">' + esc(n.title) + '</h2><div class="prose" style="margin-top:14px">' + md(n.body) + '</div>';
    }
    if (keys.length > 1) {
      h += '<div class="notes-archive"><span class="tiny dim" style="align-self:center">Past weeks:</span>' + keys.map(function (k) {
        return '<button class="btn sm' + (k === sel ? ' primary' : '') + '" data-act="notes" data-ep="' + k + '">' + (k === 0 ? 'Preseason' : 'Ep ' + k) + '</button>';
      }).join('') + '</div>';
    }
    return h + '</article>';
  }

  function lobbyCard(L) {
    var ps = Engine.activePlayers(L);
    var h = '<div class="card"><div class="row" style="margin-bottom:12px"><h3 style="margin:0" class="grow">Who’s in <span class="muted">(' + ps.length + ')</span></h3>' +
      (amIn() ? '' : '<a class="btn primary sm" href="#join">Join</a>') + '</div>';
    if (!ps.length) h += '<div class="empty">Nobody yet. Be the first.</div>';
    h += '<div class="lobby" style="grid-template-columns:1fr">' + ps.map(function (p) {
      return '<div class="lobby-item"><span class="dot" style="width:28px;height:28px;background:' + esc(p.color) + '"></span><div class="grow"><div class="name">' + esc(p.name) + (isMe(p.id) ? ' <span class="chip warn">you</span>' : '') + '</div>' +
        '<div class="checks"><span class="chip ' + (p.queueSize ? 'good' : '') + '">' + (p.queueSize ? '✓ Board ranked' : 'No board yet') + '</span>' +
        '<span class="chip ' + (p.hasWinnerBet ? 'good' : '') + '">' + (p.hasWinnerBet ? '✓ Winner bet' : 'No winner bet') + '</span></div></div></div>';
    }).join('') + '</div>';
    var cap = Engine.activeCastawayIds(L, CAST).length * L.settings.maxPerCastaway;
    var rounds = L.settings.rounds;
    if (ps.length * rounds > cap) {
      h += '<p class="small muted" style="margin-top:12px">With ' + ps.length + ' players there aren’t enough castaways for ' + rounds + ' rounds, so the draft will be ' + Math.floor(cap / ps.length) + ' rounds.</p>';
    }
    return h + '</div>';
  }

  function miniStandings(v) {
    var L = v.league;
    var rows = Engine.standings(L, v.episodes);
    var scored = Engine.episodeNumbers(L, v.episodes).length > 0;
    var h = '<div class="card flush"><div class="card-head"><h3 class="grow">Standings</h3><a class="small" href="#standings">Full standings →</a></div><div class="lb">';
    h += rows.slice(0, 5).map(function (r) {
      return '<div class="lb-row' + (r.rank === 1 && scored ? ' first' : '') + '" style="--pc:' + esc(r.color) + ';cursor:default"><div class="lb-rank">' + r.rank + '</div><div><div class="lb-name">' + esc(r.name) + (isMe(r.playerId) ? '<span class="you">YOU</span>' : '') + '</div></div><div class="lb-score"><b>' + r.total + '</b></div></div>';
    }).join('');
    return h + '</div></div>';
  }

  function myTeamCard(v) {
    var L = v.league;
    var r = Engine.roster(L, S.me.id);
    var ids = r.draft.concat(r.merge.filter(function (id) { return r.draft.indexOf(id) === -1; }));
    var bet = L.winnerBets && L.winnerBets[S.me.id];
    var h = '<div class="card"><h3>Your tribe</h3>';
    if (!ids.length) h += '<div class="empty">No castaways yet.</div>';
    h += ids.map(function (id) {
      var s = st(v, id), c = CASTBY[id];
      var pts = Engine.castawayTotal(L, v.episodes, id, r.draft.indexOf(id) === -1 ? L.merge.startEp : null);
      return '<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)" data-act="castaway" data-id="' + id + '">' + ava(id, 'sm', v) +
        '<div class="grow"><b>' + esc(c.shortName) + '</b> ' + (r.draft.indexOf(id) === -1 ? '<span class="chip">merge pick</span>' : '') +
        '<div class="tiny ' + (s.status === 'active' ? 'dim' : '') + '" style="' + (s.status !== 'active' ? 'color:#FF9EA1' : '') + '">' + (s.status === 'active' ? esc(s.tribe) : 'Out · Ep ' + s.eliminatedEp) + '</div></div><b>' + pts + '</b></div>';
    }).join('');
    if (bet) h += '<div class="row small" style="margin-top:10px"><span class="muted">Winner bet:</span> ' + ava(bet, 'xs', v) + ' <b>' + esc(CASTBY[bet].shortName) + '</b> <span class="dim">(+' + L.settings.winnerBetPoints + ' if right)</span></div>';
    return h + '</div>';
  }

  // ---------- JOIN ----------
  function renderJoin() {
    var L = S.data.league;
    var h = '<div style="max-width:560px;margin:0 auto" class="stack">';
    if (amIn()) {
      h += '<div class="card center"><div style="font-size:40px">🔥</div><h2>You’re in, ' + esc(S.me.name.split(' ')[0]) + '.</h2><p class="muted">Next: rank your board so the auto-pick has your back.</p><a class="btn primary lg" href="#draft">Rank your board →</a></div>';
    } else if (L.draft.status !== 'open' && PRACTICE) {
      h += '<div class="card center stack"><h2>A practice draft is running</h2><p class="muted">Reset the practice league to join, then start your own.</p><button class="btn primary" data-act="p_reset">Reset practice</button></div>';
    } else if (L.draft.status !== 'open') {
      h += '<div class="card center"><h2>The draft already happened</h2><p class="muted">Want in anyway? Ask Will to add you. If you already joined, sign in.</p><button class="btn primary" data-act="signin">Sign in</button></div>';
    } else {
      h += '<div class="center"><div class="eyebrow">Season 51 Fantasy</div><h1 class="display" style="font-size:44px;margin:6px 0">Join the league</h1>' +
        '<p class="muted">Takes 20 seconds. Your email is how you sign in on draft night; it’s never shown to anyone.</p></div>' +
        '<div class="card stack"><label class="field"><span>Your name</span><input class="input" id="jName" autocomplete="name" autocapitalize="words" maxlength="40" placeholder="First and last"></label>' +
        '<label class="field"><span>Email</span><input class="input" id="jEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></label>' +
        '<div><span class="small muted" style="font-weight:700">Pick the Winner <span class="dim">(optional now, +' + L.settings.winnerBetPoints + ' pts if right, locks when the draft ends)</span></span>' +
        '<div class="board" id="jWinner" style="margin-top:8px;grid-template-columns:repeat(auto-fill,minmax(86px,1fr))">' + winnerChoices(null) + '</div></div>' +
        '<div class="err" id="jErr"></div><button class="btn primary lg block" data-act="join">Join Season 51</button></div>' +
        '<p class="center small muted">Already joined? <a href="#" data-act="signin">Sign in with your email</a></p>';
    }
    $('#page-join').innerHTML = h + '</div>';
  }

  function winnerChoices(selected) {
    var L = S.data.league;
    return CAST.filter(function (c) { return Engine.castawayStatus(L, CAST, c.id).status === 'active'; }).map(function (c) {
      return '<button class="bc' + (selected === c.id ? ' pickable' : '') + '" data-act="winnerpick" data-id="' + c.id + '" style="' + (selected === c.id ? 'box-shadow:0 0 0 2px var(--flame)' : '') + '">' +
        '<div class="ph tribe-' + c.tribe + '" style="background-image:url(\'' + esc(c.photo) + '\')"></div><div class="bar tribe-' + c.tribe + '"></div>' +
        '<div class="body" style="padding:5px 6px 6px"><div class="nm" style="font-size:12px">' + esc(c.shortName) + '</div></div>' +
        (selected === c.id ? '<span class="qrank">🏆</span>' : '') + '</button>';
    }).join('');
  }

  // ---------- DRAFT ----------
  function renderDraft() {
    var v = view();
    var L = S.data.league;
    var kind = (L.merge.status !== 'off') ? 'merge' : 'main';
    if (S.draftTab === 'main') kind = 'main';
    var d = draftOf(kind);
    var el = $('#page-draft');
    if (d.status === 'open') { el.innerHTML = (PRACTICE ? practiceLab() : '') + draftPrep(v); return; }
    el.innerHTML = draftRoom(v, kind) + (PRACTICE && d.status === 'complete' ? '<div style="margin-top:18px">' + practiceLab() + '</div>' : '');
  }

  // Pre-draft: rank your board + winner bet
  function draftPrep(v) {
    var L = v.league;
    var h = '<div class="section-title" style="margin-top:0"><h2>Draft prep</h2><span class="muted">' + (L.draftAt ? 'Draft starts ' + new Date(L.draftAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'Wed, Sep 30 · Episode 2 night') + '</span></div>';
    h += '<div class="card" style="margin-bottom:16px"><div class="steps">' +
      '<div><div><b>' + L.settings.rounds + ' rounds, snake order.</b> <span class="muted">Order is random and revealed when the draft starts. Each castaway can be picked by two players, then they’re off the board.</span></div></div>' +
      '<div><div><b>' + L.settings.clockSec + ' seconds per pick, from your own phone.</b> <span class="muted">When it’s your turn your phone buzzes and the board lights up.</span></div></div>' +
      '<div><div><b>Rank your board below.</b> <span class="muted">If your clock runs out (or your signal drops), you automatically get the highest-ranked castaway still available on your list.</span></div></div>' +
      '</div></div>';
    if (!amIn()) {
      return h + '<div class="card center stack"><h3>Join to rank your board</h3><div class="row" style="justify-content:center"><a class="btn primary" href="#join">Join the league</a><button class="btn" data-act="signin">Sign in</button></div></div>' + castBoard(v, 'main', { prep: true });
    }
    var q = S.me.queue || [];
    h += '<div class="split">';
    h += '<div><div class="board-tools"><h3 class="grow" style="margin:0">Tap castaways to add them to your list</h3>' + filterSeg() + '</div>' + castBoard(v, 'main', { prep: true }) + '</div>';
    h += '<div class="stack" style="position:sticky;top:calc(var(--topbar-h) + 12px)">';
    h += '<div class="card"><div class="row" style="margin-bottom:10px"><h3 class="grow" style="margin:0">Your list <span class="muted">(' + q.length + ')</span></h3><span class="tiny dim" id="saveState"></span></div>' +
      (q.length ? '<div class="queue" id="queue">' + q.map(function (id, i) {
        var c = CASTBY[id];
        return '<div class="qi" draggable="true" data-id="' + id + '"><span class="grip" aria-hidden="true">⠿</span><span class="n">' + (i + 1) + '</span>' + ava(id, 'xs', v) + '<span class="nm">' + esc(c.shortName) + ' <span class="tribe-tag ' + c.tribe + '">' + c.tribe + '</span></span>' +
          '<span class="ctl"><button data-act="qup" data-id="' + id + '" aria-label="Move up">↑</button><button data-act="qdown" data-id="' + id + '" aria-label="Move down">↓</button><button data-act="qdel" data-id="' + id + '" aria-label="Remove">✕</button></span></div>';
      }).join('') + '</div>' : '<div class="empty">Your list is empty. Tap castaways on the board to add them in order.</div>') +
      '<p class="tiny dim" style="margin:10px 0 0">Nobody else sees your list. Rank at least 8 to be safe.</p></div>';
    h += '<div class="card"><h3>Pick the Winner <span class="muted small">+' + L.settings.winnerBetPoints + ' pts</span></h3>' +
      (S.me.winnerPick ? '<div class="row" style="margin-bottom:10px">' + ava(S.me.winnerPick, 'sm', v) + '<b class="grow">' + esc(CASTBY[S.me.winnerPick].shortName) + '</b><button class="btn sm" data-act="winnersheet">Change</button></div>'
        : '<button class="btn primary block" data-act="winnersheet" style="margin-bottom:8px">Choose your winner</button>') +
      '<p class="tiny dim" style="margin:0">Hidden until the draft ends, then locked.</p></div>';
    h += soundCard();
    h += '</div></div>';
    return h;
  }

  function soundCard() {
    return '<div class="card"><h3>Draft-night alerts</h3><div class="stack small">' +
      '<label class="row"><input type="checkbox" data-act="sound" ' + (S.sound ? 'checked' : '') + ' style="width:20px;height:20px;accent-color:var(--ember)"> <span class="grow">Play a chime when it’s my turn</span><button class="btn sm ghost" data-act="testsound">Test</button></label>' +
      (window.Notification && Notification.permission !== 'granted' ? '<button class="btn sm" data-act="notify">Allow notifications (desktop)</button>' : '') +
      '<div class="dim tiny">Keep this page open on draft night. Android phones also buzz. iPhones can’t buzz from a web page, so leave the chime on and your volume up (tap anywhere once so the phone allows sound).</div></div></div>';
  }

  function filterSeg() {
    var opts = [['all', 'All'], ['Savu', 'Savu'], ['Toka', 'Toka'], ['avail', 'Available']];
    return '<div class="seg">' + opts.map(function (o) { return '<button class="' + (S.boardFilter === o[0] ? 'on' : '') + '" data-act="filter" data-f="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>';
  }

  function castBoard(v, kind, opts) {
    opts = opts || {};
    var L = v.league;
    var d = draftOf(kind);
    var slot = Engine.currentSlot(d);
    var myTurn = slot && isMe(slot.playerId) && d.status === 'live';
    var cap = kind === 'merge' ? L.settings.mergeMaxPerCastaway : L.settings.maxPerCastaway;
    var q = (S.me && S.me.queue) || [];
    var list = CAST.slice().sort(function (a, b) {
      var oa = st(v, a.id).status !== 'active', ob = st(v, b.id).status !== 'active';
      return (oa - ob) || a.shortName.localeCompare(b.shortName);
    });
    var h = '<div class="board">';
    list.forEach(function (c) {
      var s = st(v, c.id);
      if (s.status !== 'active' && opts.prep) return;
      if (S.boardFilter === 'Savu' || S.boardFilter === 'Toka') { if (s.tribe !== S.boardFilter) return; }
      var blocker = S.me && amIn() ? Engine.pickBlocker(L, CAST, kind, S.me.id, c.id) : null;
      var taken = Engine.timesPicked(d, c.id);
      var gone = s.status !== 'active' || taken >= cap;
      if (S.boardFilter === 'avail' && (gone || blocker)) return;
      var cls = 'bc tribe-' + s.tribe;
      if (s.status !== 'active') cls += ' out';
      else if (gone) cls += ' gone';
      else if (!opts.prep && blocker === 'already_yours') cls += ' mine';
      else if (myTurn && !blocker) cls += ' pickable';
      var pickers = d.picks.filter(function (p) { return p.castawayId === c.id; });
      var slots = '';
      for (var i = 0; i < cap; i++) slots += '<i class="' + (pickers[i] ? 'taken' : '') + '" style="' + (pickers[i] ? '--c:' + esc(playerColor(L, pickers[i].playerId)) : '') + '" title="' + (pickers[i] ? esc(playerName(L, pickers[i].playerId)) : 'open') + '"></i>';
      var qi = q.indexOf(c.id);
      h += '<button class="' + cls + '" data-act="' + (opts.prep ? 'qtoggle' : 'castaway') + '" data-id="' + c.id + '" data-kind="' + kind + '">' +
        '<div class="ph" style="background-image:url(\'' + esc(c.photo) + '\')"></div><div class="bar"></div>' +
        '<div class="body"><div class="nm">' + esc(c.shortName) + '</div><div class="meta">' + esc(c.age) + ' · ' + esc(c.occupation) + '</div></div>' +
        (opts.prep || s.status !== 'active' ? '' : '<div class="slots">' + slots + '</div>') +
        (qi !== -1 && (opts.prep || !gone) ? '<span class="qrank">' + (opts.prep ? qi + 1 : '#' + (qi + 1)) + '</span>' : '') +
        '</button>';
    });
    return h + '</div>';
  }

  function draftRoom(v, kind) {
    var L = S.data.league;
    var d = draftOf(kind);
    var slot = Engine.currentSlot(d);
    var h = '';
    if (L.merge.status !== 'off') {
      h += '<div class="seg" style="margin-bottom:12px"><button class="' + (kind === 'merge' ? 'on' : '') + '" data-act="drafttab" data-tab="merge">Merge draft</button><button class="' + (kind === 'main' ? 'on' : '') + '" data-act="drafttab" data-tab="main">Main draft</button></div>';
    }
    if (d.status === 'complete') return h + draftComplete(v, kind);

    var mine = slot && isMe(slot.playerId);
    var total = Engine.totalSlots(d);
    h += '<div class="clock-card ' + (mine && d.status === 'live' ? 'yours' : '') + (d.status === 'paused' ? ' paused' : '') + '">' +
      '<div class="ring" data-ring="' + kind + '"><svg viewBox="0 0 76 76"><circle cx="38" cy="38" r="34" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="6"/>' +
      '<circle class="arc" cx="38" cy="38" r="34" fill="none" stroke="' + (mine ? 'var(--flame)' : esc(playerColor(L, slot.playerId))) + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="213.6" style="transition:stroke-dashoffset .25s linear"/></svg><div class="t"></div></div>' +
      '<div class="grow"><div class="otc-label">' + (d.status === 'paused' ? '❚❚ Paused by the commissioner' : mine ? 'You’re on the clock' : 'On the clock') + '</div>' +
      '<div class="otc-name" style="color:' + esc(playerColor(L, slot.playerId)) + '">' + esc(playerName(L, slot.playerId)) + '</div>' +
      '<div class="otc-sub">' + (kind === 'merge' ? 'Merge pick ' + (slot.n + 1) + ' of ' + total : 'Round ' + slot.round + ' · Pick ' + slot.pickInRound + ' · ' + (slot.n + 1) + ' of ' + total) + '</div></div>' +
      '<div class="act">' + (mine && d.status === 'live' ? autoPickHint(v, kind) : '') + '</div></div>';

    // On deck
    var up = Engine.upcomingSlots(d, 12);
    h += '<div class="ondeck">' + up.map(function (s, i) {
      return '<span class="od' + (i === 0 ? ' now' : '') + '"><span class="dot" style="background:' + esc(playerColor(L, s.playerId)) + '"></span>' + esc(playerName(L, s.playerId).split(' ')[0]) + (isMe(s.playerId) ? ' (you)' : '') + ' <span class="n">#' + (s.n + 1) + '</span></span>';
    }).join('') + '</div>';

    if (S.tv) {
      h += '<div class="tv-grid" style="margin-top:14px"><div>' + castBoard(v, kind) + '</div><div class="stack">' +
        '<div class="card row" style="flex-wrap:nowrap"><div id="tvQr" style="width:112px;height:112px;background:#fff;border-radius:10px;padding:6px;flex:none"></div><div><b>Pick from your phone</b><div class="small muted">Scan, sign in with your email, and your board lights up when you’re up.</div></div></div>' +
        feedCard(v, kind, 12) + '</div></div>';
      setTimeout(drawQr, 0);
      return h + '<div style="margin-top:18px">' + bigBoard(v, kind) + '</div>';
    }

    h += '<div class="split" style="margin-top:6px"><div>';
    h += '<div class="board-tools"><div class="grow">' + (mine && d.status === 'live' ? '<b style="color:var(--flame)">Tap a castaway to draft them.</b>' : !amIn() ? '<button class="btn sm" data-act="signin">Sign in to pick</button>' : '<span class="muted small">' + upNext(d) + '</span>') + '</div>' + filterSeg() +
      '<button class="btn sm" data-act="bigboard">' + (S.showBigBoard ? 'Castaways' : 'Draft board') + '</button></div>';
    h += S.showBigBoard ? bigBoard(v, kind) : castBoard(v, kind);
    h += '</div><div class="stack">';
    if (amIn()) h += myDraftCard(v, kind);
    h += feedCard(v, kind, 10);
    h += '</div></div>';
    return h;
  }

  // QR code for the room (TV mode). Library loads only on the TV.
  function drawQr() {
    var el = $('#tvQr');
    if (!el) return;
    var go = function () {
      var q = window.qrcode(0, 'M');
      q.addData(siteUrl('', '#draft')); q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
      var svg = el.querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; }
    };
    if (window.qrcode) return go();
    var sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    sc.onload = go;
    document.head.appendChild(sc);
  }

  function upNext(d) {
    if (!S.me) return '';
    var up = Engine.upcomingSlots(d, 40);
    for (var i = 0; i < up.length; i++) {
      if (isMe(up[i].playerId)) return i === 0 ? '' : 'You pick in ' + plural(i, 'turn') + ' (#' + (up[i].n + 1) + ').';
    }
    return 'You’re done picking.';
  }

  function autoPickHint(v, kind) {
    var L = v.league;
    var q = (S.me && S.me.queue) || [];
    var choice = Engine.chooseAutoPick(L, CAST, kind, S.me.id, q, []);
    if (!choice) return '';
    var c = CASTBY[choice.castawayId];
    return '<div class="small muted hide-sm" style="max-width:200px">If time runs out you get <b style="color:var(--text)">' + esc(c.shortName) + '</b>' + (choice.source === 'queue' ? ' (from your list)' : '') + '.</div>';
  }

  function myDraftCard(v, kind) {
    var L = v.league;
    var d = draftOf(kind);
    var mine = d.picks.filter(function (p) { return p.playerId === S.me.id; });
    var h = '<div class="card"><h3>Your ' + (kind === 'merge' ? 'merge pick' : 'picks') + '</h3>';
    if (!mine.length) h += '<div class="dim small">None yet.</div>';
    h += mine.map(function (p) {
      if (!p.castawayId) return '<div class="small dim">Pick #' + (p.n + 1) + ' skipped (no legal pick)</div>';
      var c = CASTBY[p.castawayId];
      return '<div class="row" style="padding:5px 0">' + ava(c.id, 'sm', v) + '<b class="grow">' + esc(c.shortName) + '</b><span class="tiny dim">#' + (p.n + 1) + (p.auto ? ' · auto' : '') + '</span></div>';
    }).join('');
    var q = (S.me.queue || []).filter(function (id) { return !Engine.pickBlocker(L, CAST, kind, S.me.id, id); });
    h += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)"><div class="row"><span class="small muted grow">Your list (still available)</span><button class="btn sm ghost" data-act="queuesheet">Edit</button></div>' +
      (q.length ? '<div class="row" style="gap:5px;margin-top:6px">' + q.slice(0, 8).map(function (id, i) { return '<span class="chip">' + (i + 1) + '. ' + esc(CASTBY[id].shortName) + '</span>'; }).join('') + '</div>'
        : '<div class="tiny dim" style="margin-top:4px">Empty. Auto-pick will use the league’s favorites.</div>') + '</div>';
    return h + '</div>';
  }

  function feedCard(v, kind, n) {
    var L = v.league;
    var d = draftOf(kind);
    var picks = d.picks.slice().reverse().slice(0, n);
    var h = '<div class="card flush"><div class="card-head"><h3 class="grow">Latest picks</h3><span class="tiny dim">' + d.picks.length + ' / ' + Engine.totalSlots(d) + '</span></div><div class="feed">';
    if (!picks.length) h += '<div class="feed-item dim">No picks yet.</div>';
    h += picks.map(function (p, i) {
      var c = p.castawayId ? CASTBY[p.castawayId] : null;
      return '<div class="feed-item' + (i === 0 && S.freshN === p.n ? ' fresh' : '') + '"><span class="n">#' + (p.n + 1) + '</span><span class="dot" style="background:' + esc(playerColor(L, p.playerId)) + '"></span>' +
        '<span class="grow"><b>' + esc(playerName(L, p.playerId)) + '</b> <span class="muted">took</span> ' + (c ? '<b>' + esc(c.shortName) + '</b>' : '<span class="dim">nothing (skipped)</span>') + '</span>' +
        (p.auto ? '<span class="chip ' + (p.auto === 'commissioner' ? '' : 'warn') + '">' + (p.auto === 'commissioner' ? 'comm.' : 'auto') + '</span>' : '') + (c ? ava(c.id, 'xs', v) : '') + '</div>';
    }).join('');
    return h + '</div></div>';
  }

  function bigBoard(v, kind) {
    var L = v.league;
    var d = draftOf(kind);
    var N = d.order.length;
    if (!N) return '';
    var h = '<div class="card flush"><div class="bigboard"><table><thead><tr><th></th>' + d.order.map(function (pid) {
      return '<th style="color:' + esc(playerColor(L, pid)) + '">' + esc(playerName(L, pid).split(' ')[0]) + (isMe(pid) ? ' ★' : '') + '</th>';
    }).join('') + '</tr></thead><tbody>';
    for (var r = 0; r < d.rounds; r++) {
      h += '<tr><th class="rl">' + (kind === 'merge' ? 'Merge' : 'R' + (r + 1)) + '</th>';
      for (var col = 0; col < N; col++) {
        var pos = d.snake && r % 2 === 1 ? N - 1 - col : col;
        var n = r * N + pos;
        var p = d.picks[n];
        var pid = d.order[col];
        var isNow = n === d.picks.length && d.status !== 'complete';
        if (p && p.castawayId) {
          var c = CASTBY[p.castawayId];
          h += '<td class="filled" style="--pc:' + esc(playerColor(L, pid)) + '"><div class="cell">' + ava(c.id, 'xs', v) + '<div><b>' + esc(c.shortName) + '</b><span class="n">#' + (n + 1) + '</span>' + (p.auto ? ' <span class="auto">' + (p.auto === 'commissioner' ? 'COMM' : 'AUTO') + '</span>' : '') + '</div></div></td>';
        } else if (p) {
          h += '<td><span class="dim tiny">skipped</span></td>';
        } else {
          h += '<td class="' + (isNow ? 'now' : '') + '"><span class="dim tiny">#' + (n + 1) + '</span></td>';
        }
      }
      h += '</tr>';
    }
    return h + '</tbody></table></div></div>';
  }

  function draftComplete(v, kind) {
    var L = v.league;
    var h = '<div class="hero" style="margin-bottom:16px"><div class="eyebrow">' + (kind === 'merge' ? 'Merge draft complete' : 'Draft complete') + '</div><h1>The tribes <em>have spoken</em></h1>' +
      '<p>' + (kind === 'merge' ? 'Merge picks score from Episode ' + L.merge.startEp + ' on.' : plural(L.draft.picks.filter(function (p) { return p.castawayId; }).length, 'pick') + ' in ' + plural(L.draft.rounds, 'round') + '. Scoring starts with Episode ' + L.settings.scoringStartEp + '.') + '</p></div>';
    h += bigBoard(v, kind);
    if (kind === 'main' && L.winnerBets) {
      h += '<div class="section-title"><h2>Winner bets</h2><span class="muted">locked · +' + L.settings.winnerBetPoints + ' if right</span></div><div class="lobby">';
      h += Engine.activePlayers(L).map(function (p) {
        var b = L.winnerBets[p.id];
        return '<div class="lobby-item">' + (b ? ava(b, 'sm', v) : '<span class="ava sm"></span>') + '<div class="grow"><div class="name" style="color:' + esc(p.color) + '">' + esc(p.name) + '</div><div class="small muted">' + (b ? esc(CASTBY[b].shortName) + (st(v, b).status !== 'active' ? ' <span style="color:#FF9EA1">(out)</span>' : '') : 'No bet') + '</div></div></div>';
      }).join('') + '</div>';
    }
    return h;
  }

  // ---------- STANDINGS ----------
  function renderStandings() {
    var v = view();
    var L = v.league;
    var el = $('#page-standings');
    if (L.draft.status !== 'complete') {
      el.innerHTML = '<div class="section-title" style="margin-top:0"><h2>Standings</h2></div><div class="card center muted" style="padding:40px">Standings start after the draft.</div>';
      return;
    }
    var rows = Engine.standings(L, v.episodes);
    var eps = Engine.episodeNumbers(L, v.episodes);
    var probs = eps.length ? winProbs(v) : {};
    var last = eps[eps.length - 1];
    var h = spoilerBar(v);
    h += '<div class="section-title" style="margin-top:0"><h2>Standings</h2><span class="muted">' + (eps.length ? 'through Episode ' + last : 'no episodes scored yet') + '</span></div>';
    h += '<div class="card flush"><div class="lb">';
    h += rows.map(function (r) {
      var roster = Engine.roster(L, r.playerId);
      var pills = roster.draft.map(function (id) { return ava(id, 'xs', v); }).join('') +
        roster.merge.filter(function (id) { return roster.draft.indexOf(id) === -1; }).map(function (id) { return '<span style="outline:1.5px dashed var(--muted);border-radius:50%;outline-offset:2px;display:inline-block">' + ava(id, 'xs', v) + '</span>'; }).join('');
      var alive = roster.draft.concat(roster.merge).filter(function (id, i, a) { return a.indexOf(id) === i && st(v, id).status === 'active'; }).length;
      var pct = probs[r.playerId];
      var move = r.move > 0 ? '<span class="move up">▲' + r.move + '</span>' : r.move < 0 ? '<span class="move down">▼' + (-r.move) + '</span>' : '';
      var open = S.openRow === r.playerId;
      return '<div class="lb-row' + (r.rank === 1 && eps.length ? ' first' : '') + (open ? ' open' : '') + '" style="--pc:' + esc(r.color) + '" data-act="lbrow" data-id="' + r.playerId + '">' +
        '<div class="lb-rank">' + r.rank + '</div>' +
        '<div class="grow"><div class="lb-name">' + esc(r.name) + (isMe(r.playerId) ? '<span class="you">YOU</span>' : '') + ' ' + move + '</div>' +
        '<div class="lb-team">' + pills + '<span class="tiny dim" style="margin-left:4px">' + alive + ' left</span></div>' +
        (pct != null ? '<div class="winbar" title="Chance to win the league"><i style="width:' + Math.max(1, Math.round(pct * 100)) + '%"></i></div>' : '') + '</div>' +
        '<div class="lb-score"><b>' + r.total + '</b><div class="sub">' + (last != null ? (r.lastEp >= 0 ? '+' : '') + r.lastEp + ' last ep' : '') + '</div>' + (pct != null ? '<div class="sub">' + Math.round(pct * 100) + '% to win</div>' : '') + '</div>' +
        '<div class="lb-detail">' + (open ? rosterTable(v, r.playerId) : '') + '</div></div>';
    }).join('');
    h += '</div></div>';
    h += '<p class="tiny dim" style="margin:8px 4px 0">Win chances simulate the rest of the season thousands of times with a random boot order. They know who’s still alive, not who’s good.</p>';

    if (eps.length >= 1) {
      h += '<div class="section-title"><h2>The race</h2><span class="muted">cumulative points</span></div><div class="card">' + raceChart(v) + '</div>';
      h += '<div class="section-title"><h2>By episode</h2></div><div class="card flush" style="overflow-x:auto">' + episodeTable(v, rows, eps) + '</div>';
    }
    el.innerHTML = h;
  }

  // Seeded so the percentages don't jitter every time the page refreshes.
  function winProbs(v) {
    var key = S.version + ':' + (v.hidden || 0);
    if (S.probCache && S.probCache.key === key) return S.probCache.val;
    var seed = 51;
    var rand = function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    var val = Engine.winProbabilities(v.league, CAST, v.episodes, { sims: 5000, rand: rand });
    S.probCache = { key: key, val: val };
    return val;
  }

  function rosterTable(v, pid) {
    var L = v.league;
    var r = Engine.roster(L, pid);
    var eps = Engine.episodeNumbers(L, v.episodes);
    var rows = r.draft.map(function (id) { return { id: id, from: null, tag: '' }; })
      .concat(r.merge.filter(function (id) { return r.draft.indexOf(id) === -1; }).map(function (id) { return { id: id, from: L.merge.startEp, tag: 'merge' }; }));
    var h = '<table class="mini-table"><thead><tr><th>Castaway</th>' + eps.map(function (e) { return '<th class="num">E' + e + '</th>'; }).join('') + '<th class="num">Total</th></tr></thead><tbody>';
    rows.forEach(function (x) {
      var c = CASTBY[x.id], s = st(v, x.id);
      h += '<tr><td><div class="row" style="gap:8px;flex-wrap:nowrap">' + ava(x.id, 'xs', v) + '<span class="nowrap">' + esc(c.shortName) + (x.tag ? ' <span class="chip">merge</span>' : '') + (s.status !== 'active' ? ' <span class="dim tiny">out E' + s.eliminatedEp + '</span>' : '') + '</span></div></td>' +
        eps.map(function (e) {
          var p = x.from != null && e < x.from ? null : Engine.castawayEpisodePoints(v.episodes, x.id, e);
          return '<td class="num ' + (p ? '' : 'dim') + '">' + (p == null ? '–' : p) + '</td>';
        }).join('') + '<td class="num"><b>' + Engine.castawayTotal(L, v.episodes, x.id, x.from) + '</b></td></tr>';
    });
    var bonus = Engine.winnerBetBonus(L, v.episodes, pid);
    if (bonus) h += '<tr><td>🏆 Winner bet</td>' + eps.map(function () { return '<td></td>'; }).join('') + '<td class="num"><b>' + bonus + '</b></td></tr>';
    var bet = L.winnerBets && L.winnerBets[pid];
    h += '</tbody></table>';
    if (bet && !bonus) h += '<div class="tiny dim" style="margin-top:6px">Winner bet: ' + esc(CASTBY[bet].shortName) + (st(v, bet).status !== 'active' ? ' (out)' : '') + '</div>';
    return h;
  }

  function episodeTable(v, rows, eps) {
    var L = v.league;
    var h = '<table class="mini-table"><thead><tr><th>Player</th>' + eps.map(function (e) { return '<th class="num">Ep ' + e + '</th>'; }).join('') + '<th class="num">Total</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var per = eps.map(function (e) { return Engine.playerEpisodePoints(L, v.episodes, r.playerId, e); });
      var best = eps.map(function (e) { return Math.max.apply(null, rows.map(function (x) { return Engine.playerEpisodePoints(L, v.episodes, x.playerId, e); })); });
      h += '<tr><td class="nowrap"><span class="dot" style="background:' + esc(r.color) + ';margin-right:6px"></span>' + esc(r.name) + '</td>' +
        per.map(function (p, i) { return '<td class="num" style="' + (p === best[i] && p > 0 ? 'color:var(--gold);font-weight:800' : '') + '">' + p + '</td>'; }).join('') +
        '<td class="num"><b>' + r.total + '</b></td></tr>';
    });
    return h + '</tbody></table>';
  }

  function raceChart(v) {
    var series = Engine.raceSeries(v.league, v.episodes);
    if (!series.length || !series[0].points.length) return '';
    var W = 760, H = 320, pl = 36, pr = 96, pt = 14, pb = 28;
    var eps = series[0].points.map(function (p) { return p.ep; });
    var max = Math.max(10, Math.max.apply(null, series.map(function (s) { return s.points[s.points.length - 1].total; })));
    var min = Math.min(0, Math.min.apply(null, series.map(function (s) { return Math.min.apply(null, s.points.map(function (p) { return p.total; })); })));
    var x = function (i) { return pl + (eps.length === 1 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (eps.length - 1)); };
    var y = function (val) { return pt + (1 - (val - min) / (max - min)) * (H - pt - pb); };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cumulative points by episode">';
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var val = Math.round(min + (max - min) * t / ticks);
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(val) + '" y2="' + y(val) + '" stroke="rgba(255,228,196,.07)"/><text x="' + (pl - 8) + '" y="' + (y(val) + 4) + '" fill="#7A6C5F" font-size="11" text-anchor="end">' + val + '</text>';
    }
    eps.forEach(function (e, i) { svg += '<text x="' + x(i) + '" y="' + (H - 8) + '" fill="#7A6C5F" font-size="11" text-anchor="middle">Ep ' + e + '</text>'; });
    // Label collision: nudge end labels apart.
    var ends = series.filter(function (s) { return !S.hiddenSeries[s.playerId]; }).map(function (s) { return { s: s, y: y(s.points[s.points.length - 1].total) }; }).sort(function (a, b) { return a.y - b.y; });
    for (var i2 = 1; i2 < ends.length; i2++) if (ends[i2].y - ends[i2 - 1].y < 13) ends[i2].y = ends[i2 - 1].y + 13;
    series.forEach(function (s) {
      if (S.hiddenSeries[s.playerId]) return;
      var me = isMe(s.playerId);
      var pts = s.points.map(function (p, i) { return x(i) + ',' + y(p.total); }).join(' ');
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + esc(s.color) + '" stroke-width="' + (me ? 3.5 : 2.25) + '" stroke-linejoin="round" stroke-linecap="round" opacity="' + (me ? 1 : 0.85) + '"/>';
      s.points.forEach(function (p, i) { svg += '<circle cx="' + x(i) + '" cy="' + y(p.total) + '" r="' + (me ? 4 : 3) + '" fill="' + esc(s.color) + '"><title>' + esc(s.name) + ' · Ep ' + p.ep + ': ' + p.total + '</title></circle>'; });
    });
    ends.forEach(function (e) {
      svg += '<text x="' + (W - pr + 8) + '" y="' + (e.y + 4) + '" fill="' + esc(e.s.color) + '" font-size="12" font-weight="700">' + esc(e.s.name.split(' ')[0]) + ' ' + e.s.points[e.s.points.length - 1].total + '</text>';
    });
    svg += '</svg>';
    var legend = '<div class="legend">' + series.map(function (s) {
      return '<span class="' + (S.hiddenSeries[s.playerId] ? 'off' : '') + '" data-act="series" data-id="' + s.playerId + '"><span class="dot" style="background:' + esc(s.color) + '"></span>' + esc(s.name) + '</span>';
    }).join('') + '</div>';
    return '<div class="chart-wrap">' + svg + '</div>' + legend;
  }

  // ---------- CAST ----------
  function renderCast() {
    var v = view();
    var L = v.league;
    var list = CAST.slice().sort(function (a, b) {
      var sa = st(v, a.id), sb = st(v, b.id);
      if ((sa.status === 'active') !== (sb.status === 'active')) return sa.status === 'active' ? -1 : 1;
      if (sa.status !== 'active') return (sb.eliminatedEp || 0) - (sa.eliminatedEp || 0);
      return Engine.castawayTotal(L, v.episodes, b.id) - Engine.castawayTotal(L, v.episodes, a.id) || a.shortName.localeCompare(b.shortName);
    });
    var active = list.filter(function (c) { return st(v, c.id).status === 'active'; }).length;
    var h = spoilerBar(v) + '<div class="section-title" style="margin-top:0"><h2>The castaways</h2><span class="muted">' + active + ' of ' + CAST.length + ' still playing</span></div>';
    h += '<div class="row" style="margin-bottom:14px"><span class="chip"><span class="dot" style="background:var(--savu)"></span>Savu</span><span class="chip"><span class="dot" style="background:var(--toka)"></span>Toka</span><span class="tiny dim">Dots under each name show who drafted them.</span></div>';
    h += '<div class="cast-grid">' + list.map(function (c) {
      var s = st(v, c.id);
      var pts = Engine.castawayTotal(L, v.episodes, c.id);
      var owners = ownersOf(L, c.id);
      return '<button class="cc tribe-' + s.tribe + (s.status !== 'active' ? ' out' : '') + '" data-act="castaway" data-id="' + c.id + '">' +
        '<div class="ph" style="background-image:url(\'' + esc(c.photo) + '\')" data-out="' + (s.status !== 'active' ? 'Out · Ep ' + s.eliminatedEp : '') + '"></div>' +
        (Engine.episodeNumbers(L, v.episodes).length ? '<span class="pts">' + pts + ' pts</span>' : '') +
        '<div class="bar"></div><div class="body"><div class="nm">' + esc(c.shortName) + '</div><div class="meta">' + esc(c.age) + ' · ' + esc(c.occupation) + '</div>' +
        '<div class="owners">' + owners.map(function (o) { return '<span class="dot" title="' + esc(playerName(L, o.playerId)) + (o.kind === 'merge' ? ' (merge)' : '') + '" style="background:' + esc(playerColor(L, o.playerId)) + '"></span>'; }).join('') + '</div></div></button>';
    }).join('') + '</div>';
    $('#page-cast').innerHTML = h;
  }

  function castawaySheet(id, kind) {
    var v = view();
    var L = S.data.league;
    var c = CASTBY[id], s = st(v, id);
    kind = kind || liveKind() || 'main';
    var d = draftOf(kind);
    var slot = Engine.currentSlot(d);
    var canPick = amIn() && slot && isMe(slot.playerId) && d.status === 'live';
    var blocker = amIn() ? Engine.pickBlocker(L, CAST, kind, S.me.id, id) : null;
    var owners = ownersOf(L, id);
    var eps = Engine.episodeNumbers(L, v.episodes);
    var h = '<div class="sheet-hero">' + ava(id, 'lg', v) + '<div><div class="tribe-tag ' + esc(s.tribe) + '">' + esc(s.tribe) + (s.status !== 'active' ? ' · <span style="color:#FF9EA1">Out Ep ' + s.eliminatedEp + '</span>' : '') + '</div>' +
      '<h2 class="display" style="font-size:34px">' + esc(c.shortName) + '</h2><div class="muted small">' + esc(c.name) + '</div></div></div>';
    h += '<p style="margin:0 0 10px">' + esc(c.fact) + '</p>';
    h += '<dl class="kv"><dt>Age</dt><dd>' + esc(c.age) + '</dd><dt>Job</dt><dd>' + esc(c.occupation) + '</dd><dt>From</dt><dd>' + esc(c.hometown) + '</dd>' +
      '<dt>Drafted by</dt><dd>' + (owners.length ? owners.map(function (o) { return '<span class="nowrap"><span class="dot" style="background:' + esc(playerColor(L, o.playerId)) + '"></span> ' + esc(playerName(L, o.playerId)) + (o.kind === 'merge' ? ' (merge)' : '') + '</span>'; }).join(', ') : '<span class="dim">Nobody yet</span>') + '</dd>' +
      (eps.length ? '<dt>Points</dt><dd><b>' + Engine.castawayTotal(L, v.episodes, id) + '</b> <span class="dim small">(' + eps.map(function (e) { return 'E' + e + ' ' + Engine.castawayEpisodePoints(v.episodes, id, e); }).join(' · ') + ')</span></dd>' : '') + '</dl>';
    if (canPick) {
      h += blocker ? '<div class="chip bad" style="margin-bottom:10px">' + esc(ERRORS[blocker] || blocker) + '</div>'
        : '<button class="btn primary lg block" data-act="pick" data-id="' + id + '" data-kind="' + kind + '" data-n="' + slot.n + '">Draft ' + esc(c.shortName) + '</button>';
    } else if (amIn() && d.status !== 'complete' && s.status === 'active') {
      var inQ = (S.me.queue || []).indexOf(id) !== -1;
      h += '<button class="btn block" data-act="qtoggle" data-id="' + id + '" data-close="1">' + (inQ ? 'Remove from my list' : 'Add to my list') + '</button>';
    }
    openSheet(h);
  }

  // ---------- RULES ----------
  function renderRules() {
    var L = S.data.league;
    var set = L.settings;
    var h = '<div class="section-title" style="margin-top:0"><h2>How it works</h2></div><div class="split"><div class="stack">';
    h += '<div class="card"><h3>The draft</h3><div class="steps small">' +
      '<div><div><b>Random snake order, ' + set.rounds + ' rounds.</b> 1→N, then N→1, and so on.</div></div>' +
      '<div><div><b>Each castaway can be drafted by two players.</b> After their second pick they’re off the board. You can’t take the same castaway twice.</div></div>' +
      '<div><div><b>' + set.clockSec + '-second clock, from your own phone.</b> Run out of time and you get the top available castaway from your ranked list (or the league’s consensus favorite if your list is empty).</div></div>' +
      '<div><div><b>Pick the Winner:</b> choose who wins the season before the draft ends. Right = <b>+' + set.winnerBetPoints + '</b>.</div></div>' +
      '<div><div><b>Merge draft:</b> when about nine castaways are left, everyone adds one more castaway. Last place picks first. Merge picks score from that episode on.</div></div>' +
      '</div></div>';
    h += '<div class="card"><h3>When scoring starts</h3><p class="small" style="margin:0">Episode 2 is draft night, so it doesn’t count. <b>Scoring starts with Episode ' + set.scoringStartEp + '.</b> Aaliyah (Episode 1) can’t be drafted.</p></div>';
    h += '</div><div class="card flush"><div class="card-head"><h3>Scoring</h3><span class="muted small">same as Season 50</span></div><table class="mini-table"><tbody>' +
      Engine.SCORING.map(function (c) { return '<tr><td>' + esc(c.label) + '</td><td class="num"><b style="color:' + (c.points < 0 ? 'var(--bad)' : 'var(--good)') + '">' + (c.points > 0 ? '+' : '') + c.points + (c.type === 'number' ? ' each' : '') + '</b></td></tr>'; }).join('') +
      '<tr><td>Pick the Winner (correct)</td><td class="num"><b style="color:var(--good)">+' + set.winnerBetPoints + '</b></td></tr>' +
      '</tbody></table><p class="tiny dim" style="padding:0 14px 12px;margin:8px 0 0">“Survives tribal” goes to every castaway who attends Tribal Council and isn’t voted out.</p></div></div>';
    $('#page-rules').innerHTML = h;
  }

  // ---------- ADMIN ----------
  function renderAdmin() {
    var el = $('#page-admin');
    if (!S.isAdmin) { el.innerHTML = '<div class="card center muted">Checking admin link…</div>'; return; }
    var tabs = [['draft', 'Draft'], ['players', 'Players'], ['episodes', 'Scoring'], ['notes', 'Write-ups'], ['settings', 'Settings']];
    var h = '<div class="row" style="margin-bottom:16px"><h2 class="display grow" style="font-size:30px">Commissioner</h2><button class="btn sm" data-act="adminrefresh">↻ Refresh</button></div>';
    h += '<div class="seg" style="margin-bottom:16px;flex-wrap:wrap">' + tabs.map(function (t) { return '<button class="' + (S.adminTab === t[0] ? 'on' : '') + '" data-act="admintab" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>';
    h += '<div id="adminBody">' + ({ draft: adminDraft, players: adminPlayers, episodes: adminEpisodes, notes: adminNotes, settings: adminSettings }[S.adminTab])() + '</div>';
    el.innerHTML = h;
    if (S.adminTab === 'players' && !S.adminRoster) loadAdminRoster();
    if ((S.adminTab === 'notes' || S.adminTab === 'episodes') && !S.adminDrafts) loadAdminDrafts();
  }

  function adminDraft() {
    var L = S.data.league;
    var d = L.draft, m = L.merge;
    var ps = Engine.activePlayers(L);
    var cap = Engine.activeCastawayIds(L, CAST).length * L.settings.maxPerCastaway;
    var maxRounds = ps.length ? Math.floor(cap / ps.length) : 4;
    var h = '<div class="admin-grid">';
    // Main draft
    h += '<div class="card stack"><h3>Main draft · <span class="chip ' + (d.status === 'live' ? 'live' : '') + '">' + d.status.toUpperCase() + '</span></h3>';
    if (d.status === 'open') {
      h += '<p class="small muted" style="margin:0">' + plural(ps.length, 'player') + ' signed up. Board holds ' + cap + ' picks, so up to ' + maxRounds + ' rounds.</p>' +
        '<div class="row"><label class="field grow"><span>Rounds</span><input class="input" id="aRounds" type="number" min="1" max="' + maxRounds + '" value="' + Math.min(L.settings.rounds, maxRounds) + '"></label>' +
        '<label class="field grow"><span>Seconds per pick</span><input class="input" id="aClock" type="number" min="20" max="600" value="' + L.settings.clockSec + '"></label></div>' +
        '<p class="tiny dim" style="margin:0">Starting randomizes the order, shows everyone the order reveal, and starts pick 1’s clock (with 20 extra seconds for the reveal). New sign-ups close.</p>' +
        '<button class="btn primary lg block" data-act="a_start" ' + (ps.length < 2 ? 'disabled' : '') + '>🔥 Start the draft</button>' +
        (L.autoStart && L.draftAt ? '<div class="chip good">Starts automatically ' + esc(new Date(L.draftAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + '</div>' : '<div class="tiny dim">Tip: Settings → set a start time and tick “start automatically.”</div>');
    } else if (d.status === 'live' || d.status === 'paused') {
      var slot = Engine.currentSlot(d);
      h += '<div class="row"><div class="grow"><div class="small muted">On the clock</div><b style="font-size:20px;color:' + esc(playerColor(L, slot.playerId)) + '">' + esc(playerName(L, slot.playerId)) + '</b> <span class="muted">#' + (slot.n + 1) + '</span></div><div class="display" style="font-size:34px" data-clock="main"></div></div>' +
        '<div class="row">' + (d.status === 'live' ? '<button class="btn" data-act="a_pause">❚❚ Pause</button>' : '<button class="btn primary" data-act="a_resume">▶ Resume</button>') +
        '<button class="btn" data-act="a_undo">↶ Undo last pick</button><button class="btn" data-act="a_autopick">⏭ Auto-pick now</button></div>' +
        '<div class="row"><select class="input grow" id="aPickFor">' + CAST.filter(function (c) { return !Engine.pickBlocker(L, CAST, 'main', slot.playerId, c.id); }).map(function (c) { return '<option value="' + c.id + '">' + esc(c.shortName) + '</option>'; }).join('') + '</select>' +
        '<button class="btn" data-act="a_pickfor" data-n="' + slot.n + '" data-pid="' + slot.playerId + '">Pick for ' + esc(playerName(L, slot.playerId).split(' ')[0]) + '</button></div>' +
        '<div class="row"><label class="field grow"><span>Change clock (sec)</span><input class="input" id="aClock2" type="number" value="' + d.clockSec + '"></label><button class="btn" data-act="a_clock" style="align-self:flex-end">Set</button></div>' +
        '<p class="tiny dim" style="margin:0">Use “Pick for” when someone tells you their pick out loud. Undo reopens the previous slot.</p>';
    } else {
      h += '<p class="small muted" style="margin:0">Done: ' + d.picks.length + ' picks.</p><button class="btn sm" data-act="a_undo">↶ Undo last pick (reopens draft)</button>';
    }
    h += '<details><summary class="small dim" style="cursor:pointer">Danger zone</summary><div class="row" style="margin-top:8px"><input class="input grow" id="aReset" placeholder="Type RESET"><button class="btn danger" data-act="a_reset">Reset draft</button></div></details>';
    h += '</div>';

    // Links
    h += '<div class="card stack"><h3>Links to share</h3>' +
      linkRow('The one link to share', siteUrl()) +
      linkRow('TV mode (big screen)', siteUrl('tv')) +
      linkRow('Admin link (keep private)', siteUrl('admin=' + S.adminKey, '#admin')) + '</div>';

    // Merge
    h += '<div class="card stack"><h3>Merge draft · <span class="chip">' + m.status.toUpperCase() + '</span></h3>';
    if (d.status !== 'complete') h += '<p class="small dim" style="margin:0">Available after the main draft.</p>';
    else if (m.status === 'off' || m.status === 'complete') {
      var rows = Engine.standings(L, S.data.episodes).slice().reverse();
      h += '<p class="small muted" style="margin:0">Order: reverse standings (last place first). Each player adds one castaway; picks score from the start episode on.</p>' +
        '<div class="small">' + rows.map(function (r, i) { return (i + 1) + '. ' + esc(r.name) + ' <span class="dim">(' + r.total + ')</span>'; }).join('<br>') + '</div>' +
        '<div class="row"><label class="field grow"><span>Counts from episode</span><input class="input" id="aMergeEp" type="number" value="' + ((L.currentEp || 8) + 1) + '"></label>' +
        '<label class="field grow"><span>Clock (sec, 0 = none)</span><input class="input" id="aMergeClock" type="number" value="0"></label></div>' +
        '<button class="btn primary" data-act="a_merge">Start merge draft</button>';
    } else {
      var ms = Engine.currentSlot(m);
      h += '<div>On the clock: <b>' + esc(playerName(L, ms.playerId)) + '</b></div><div class="row">' + (m.status === 'live' ? '<button class="btn" data-act="a_pause" data-kind="merge">Pause</button>' : '<button class="btn" data-act="a_resume" data-kind="merge">Resume</button>') + '<button class="btn" data-act="a_undo" data-kind="merge">Undo</button></div>';
    }
    h += '</div></div>';
    return h;
  }

  function personalLink(token) { return siteUrl('me=' + token); }

  function linkRow(label, url) {
    return '<div><div class="small muted">' + esc(label) + '</div><div class="row" style="flex-wrap:nowrap"><input class="input" readonly value="' + esc(url) + '" style="font-size:13px"><button class="btn sm" data-act="copy" data-url="' + esc(url) + '">Copy</button></div></div>';
  }

  function loadAdminRoster() {
    admin('roster').then(function (res) { S.adminRoster = res.players; redraw('admin'); }).catch(function (e) { toast(errMsg(e), true); });
  }
  function loadAdminDrafts() {
    admin('drafts').then(function (res) { S.adminDrafts = res; redraw('admin'); }).catch(function (e) { toast(errMsg(e), true); });
  }

  function adminPlayers() {
    var L = S.data.league;
    var h = '<div class="card flush"><div class="card-head"><h3 class="grow">Players</h3><span class="small muted">' + Engine.activePlayers(L).length + ' active</span></div>';
    if (!S.adminRoster) return h + '<div class="empty" style="margin:14px">Loading…</div></div>';
    h += '<div style="padding:12px 16px;border-bottom:1px solid var(--line)" class="row"><span class="small muted grow">Each player’s personal link signs them in with one tap on any device. Text it to them.</span><button class="btn sm primary" data-act="a_copyall">Copy all links</button></div>';
    h += '<div style="overflow-x:auto"><table class="mini-table"><thead><tr><th>Name</th><th>Email</th><th>List</th><th>Winner bet</th><th>Link</th><th></th></tr></thead><tbody>';
    h += S.adminRoster.map(function (p) {
      return '<tr style="' + (p.removed ? 'opacity:.4' : '') + '"><td class="nowrap"><input type="color" value="' + esc(p.color) + '" data-act="a_color" data-id="' + p.id + '" style="width:26px;height:26px;border:0;background:none;vertical-align:middle"> ' + esc(p.name) + '</td>' +
        '<td class="small">' + esc(p.email) + '</td><td>' + p.queue.length + '</td><td>' + (p.winnerPick ? esc(CASTBY[p.winnerPick].shortName) : '<span class="dim">—</span>') + '</td>' +
        '<td>' + (p.token ? '<button class="btn sm" data-act="copy" data-url="' + esc(personalLink(p.token)) + '">Copy</button>' : '') + '</td>' +
        '<td>' + (L.draft.status === 'open' ? '<button class="btn sm ' + (p.removed ? '' : 'danger') + '" data-act="a_remove" data-id="' + p.id + '" data-v="' + (p.removed ? '0' : '1') + '">' + (p.removed ? 'Restore' : 'Remove') + '</button>' : '') + '</td></tr>';
    }).join('');
    h += '</tbody></table></div></div>';
    h += '<div class="card stack" style="margin-top:16px"><h3>Add a player</h3><div class="row"><input class="input grow" id="aNewName" placeholder="Name"><input class="input grow" id="aNewEmail" placeholder="Email" type="email"></div><button class="btn" data-act="a_add">Add</button><p class="tiny dim" style="margin:0">Works before and after the draft starts (late joiners won’t have picks unless you enter them).</p></div>';
    return h;
  }

  function episodeAtStart(ep) {
    // Castaways still in the game at the start of an episode.
    var L = S.data.league;
    return CAST.filter(function (c) {
      var s = Engine.castawayStatus(L, CAST, c.id);
      return s.status === 'active' || (s.eliminatedEp != null && s.eliminatedEp >= ep);
    });
  }

  function adminEpisodes() {
    var L = S.data.league;
    if (!S.adminDrafts) return '<div class="empty">Loading…</div>';
    var ep = S.adminEp || Math.max(L.settings.scoringStartEp, (L.currentEp || 2) + (S.data.episodes[L.currentEp] ? 1 : 0));
    S.adminEp = ep;
    var saved = S.adminDrafts.episodes[ep] || { scores: {}, eliminated: [], title: '', published: true };
    var elim = {}; (saved.eliminated || []).forEach(function (x) { elim[x.id] = x.type || 'voted'; });
    var list = episodeAtStart(ep);
    var h = '<div class="card stack"><div class="row"><h3 class="grow" style="margin:0">Episode</h3><div class="seg" style="flex-wrap:wrap">';
    for (var e = 2; e <= (L.settings.lastEpisode || 13); e++) h += '<button class="' + (e === ep ? 'on' : '') + '" data-act="a_ep" data-ep="' + e + '">' + e + (S.adminDrafts.episodes[e] ? '✓' : '') + '</button>';
    h += '</div></div>';
    if (ep < L.settings.scoringStartEp) h += '<div class="chip warn">Episode ' + ep + ' doesn’t count toward points (scoring starts Ep ' + L.settings.scoringStartEp + '). You can still record eliminations.</div>';
    h += '<div class="row"><label class="field grow"><span>Episode title</span><input class="input" id="aEpTitle" value="' + esc(saved.title || '') + '"></label>' +
      '<label class="row small" style="align-self:flex-end;padding-bottom:10px"><input type="checkbox" id="aEpPub" ' + (saved.published !== false ? 'checked' : '') + ' style="width:20px;height:20px;accent-color:var(--ember)"> Published</label></div>';
    h += '<div class="score-wrap"><table class="score-grid"><thead><tr><th>Castaway</th>' + Engine.SCORING.map(function (c) { return '<th title="' + esc(c.label) + '">' + esc(c.short) + '<br><span style="color:' + (c.points < 0 ? 'var(--bad)' : 'var(--good)') + '">' + (c.points > 0 ? '+' : '') + c.points + '</span></th>'; }).join('') + '<th>Out</th></tr></thead><tbody>';
    list.forEach(function (c) {
      var sc = (saved.scores || {})[c.id] || {};
      h += '<tr data-row="' + c.id + '"><td>' + ava(c.id, 'xs') + ' <b>' + esc(c.shortName) + '</b> <span class="tribe-tag ' + c.tribe + '">' + c.tribe[0] + '</span></td>' +
        Engine.SCORING.map(function (cat) {
          return cat.type === 'number'
            ? '<td><input type="number" min="0" max="12" data-k="' + cat.key + '" value="' + (sc[cat.key] || '') + '"></td>'
            : '<td><input type="checkbox" data-k="' + cat.key + '" ' + (sc[cat.key] ? 'checked' : '') + '></td>';
        }).join('') +
        '<td><select data-out style="background:rgba(0,0,0,.3);border:1px solid var(--line-2);border-radius:6px;padding:3px"><option value="">—</option>' +
        ['voted', 'medevac', 'quit', 'other'].map(function (t) { return '<option ' + (elim[c.id] === t ? 'selected' : '') + '>' + t + '</option>'; }).join('') + '</select></td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="row"><button class="btn" data-act="a_survivors">✓ Everyone at tribal survived except “Out”</button><span class="tiny dim grow">Pre-merge, tick the losing tribe; this helper ticks every castaway of the tribe(s) you’ve already ticked once.</span></div>';
    h += '<button class="btn primary lg" data-act="a_saveep">Save Episode ' + ep + '</button></div>';
    return h;
  }

  function adminNotes() {
    if (!S.adminDrafts) return '<div class="empty">Loading…</div>';
    var L = S.data.league;
    var keys = Object.keys(S.adminDrafts.notes).map(Number);
    var ep = S.adminNotesEp != null ? S.adminNotesEp : (keys.length ? Math.max.apply(null, keys) : 0);
    S.adminNotesEp = ep;
    var n = S.adminDrafts.notes[ep] || { title: '', body: '', author: 'The Commissioner', published: false };
    var h = '<div class="card stack"><div class="row"><h3 class="grow" style="margin:0">Write-up for</h3><div class="seg" style="flex-wrap:wrap">';
    for (var e = 0; e <= (L.settings.lastEpisode || 13); e++) h += '<button class="' + (e === ep ? 'on' : '') + '" data-act="a_notesep" data-ep="' + e + '">' + (e === 0 ? 'Pre' : e) + (S.adminDrafts.notes[e] ? (S.adminDrafts.notes[e].published ? '●' : '○') : '') + '</button>';
    h += '</div></div>' +
      '<label class="field"><span>Headline</span><input class="input" id="aNTitle" value="' + esc(n.title) + '"></label>' +
      '<label class="field"><span>Byline</span><input class="input" id="aNAuthor" value="' + esc(n.author || 'The Commissioner') + '"></label>' +
      '<div class="split" style="grid-template-columns:1fr 1fr"><label class="field"><span>Body (Markdown: ## heading, **bold**, - list, > quote)</span><textarea class="input" id="aNBody">' + esc(n.body) + '</textarea></label>' +
      '<div><span class="small muted" style="font-weight:700">Preview</span><div class="prose card" id="aNPreview" style="margin-top:6px;max-height:420px;overflow:auto;font-size:14px">' + md(n.body) + '</div></div></div>' +
      '<div class="row"><label class="row small"><input type="checkbox" id="aNPub" ' + (n.published ? 'checked' : '') + ' style="width:20px;height:20px;accent-color:var(--ember)"> Published on the homepage</label><span class="grow"></span><button class="btn primary" data-act="a_savenotes">Save write-up</button></div></div>';
    return h;
  }

  function adminSettings() {
    var L = S.data.league;
    var s = L.settings;
    function num(id, label, val) { return '<label class="field"><span>' + label + '</span><input class="input" id="' + id + '" type="number" value="' + val + '"></label>'; }
    var dt = L.draftAt ? new Date(L.draftAt) : null;
    var local = dt ? new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    return '<div class="card stack" style="max-width:560px"><h3>League settings</h3>' +
      '<label class="field"><span>Draft start time (shows a countdown on the homepage)</span><input class="input" id="sDraftAt" type="datetime-local" value="' + local + '"></label>' +
      '<label class="row small"><input type="checkbox" id="sAuto" ' + (L.autoStart ? 'checked' : '') + ' style="width:20px;height:20px;accent-color:var(--ember)"> Start the draft automatically at that time</label>' +
      (L.autoStartError ? '<div class="chip bad">Auto-start failed: ' + esc(ERRORS[L.autoStartError] || L.autoStartError) + '</div>' : '') +
      num('sRounds', 'Draft rounds', s.rounds) + num('sClock', 'Seconds per pick', s.clockSec) +
      num('sStart', 'Scoring starts at episode', s.scoringStartEp) + num('sBet', 'Winner bet points', s.winnerBetPoints) +
      num('sCur', 'Current episode', L.currentEp || 2) +
      '<button class="btn primary" data-act="a_settings">Save settings</button></div>';
  }

  // =============================================================
  // ACTIONS (one delegated click handler)
  // =============================================================
  var saveQueueTimer = null;
  function saveQueueSoon() {
    store.set('me', S.me);
    var ss = $('#saveState'); if (ss) ss.textContent = 'Saving…';
    clearTimeout(saveQueueTimer);
    saveQueueTimer = setTimeout(function () {
      apiPost(Object.assign({ action: 'prefs', queue: S.me.queue }, ident())).then(function (res) {
        S.me.queue = res.me.queue; store.set('me', S.me);
        var ss2 = $('#saveState'); if (ss2) ss2.textContent = '✓ Saved';
      }).catch(function (e) {
        var ss3 = $('#saveState'); if (ss3) ss3.textContent = '⚠️ Not saved';
        toast(errMsg(e), true);
      });
    }, 700);
  }
  function moveQ(id, delta) {
    var q = S.me.queue, i = q.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= q.length) return;
    q.splice(i, 1); q.splice(j, 0, id);
    saveQueueSoon(); render();
  }

  function signedIn(me) {
    S.me = me; store.set('me', me);
    render();
  }

  function signinSheet() {
    openSheet('<h2 class="display" style="font-size:30px">Sign in</h2><p class="muted small">Use the email you joined with.</p>' +
      '<input class="input" id="siEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"><div class="err" id="siErr"></div>' +
      '<button class="btn primary block lg" data-act="signin_go">Sign in</button>' +
      (S.data && S.data.league.draft.status === 'open' ? '<p class="small muted center">New here? <a href="#join" data-act="close">Join the league</a></p>' : ''));
  }

  function winnerSheet() {
    openSheet('<h2 class="display" style="font-size:30px">Pick the Winner</h2><p class="muted small">Who wins Survivor 51? +' + S.data.league.settings.winnerBetPoints + ' if you’re right. Hidden until the draft ends, then locked.</p>' +
      '<div class="board" style="grid-template-columns:repeat(auto-fill,minmax(86px,1fr))">' + winnerChoices(S.me.winnerPick) + '</div>');
  }

  function queueSheet() {
    var q = S.me.queue || [];
    openSheet('<h2 class="display" style="font-size:30px">Your list</h2><p class="muted small">Auto-pick takes the highest one still available.</p><div class="queue">' + q.map(function (id, i) {
      var c = CASTBY[id];
      return '<div class="qi"><span class="n">' + (i + 1) + '</span>' + ava(id, 'xs') + '<span class="nm">' + esc(c.shortName) + '</span><span class="ctl"><button data-act="qup" data-id="' + id + '" data-sheet="1">↑</button><button data-act="qdown" data-id="' + id + '" data-sheet="1">↓</button><button data-act="qdel" data-id="' + id + '" data-sheet="1">✕</button></span></div>';
    }).join('') + '</div>' + (q.length ? '' : '<div class="empty">Empty</div>') + '<p class="tiny dim">To add castaways, tap them on the board.</p>');
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.dataset.act;
    if (t.tagName === 'A' && act !== 'close' && act !== 'signin') { /* let links navigate */ }
    var id = t.dataset.id;
    var L = S.data && S.data.league;

    switch (act) {
      case 'close': closeSheet(); return;
      case 'signin': e.preventDefault(); signinSheet(); return;
      case 'signin_go': {
        var em = $('#siEmail').value.trim();
        t.disabled = true; t.textContent = 'Signing in…';
        apiPost({ action: 'login', email: em }).then(function (res) { closeSheet(); signedIn(res.me); toast('Welcome back, ' + res.me.name.split(' ')[0] + '.'); })
          .catch(function (err) { $('#siErr').textContent = errMsg(err); t.disabled = false; t.textContent = 'Sign in'; });
        return;
      }
      case 'me':
        openSheet('<div class="row"><span class="dot" style="width:40px;height:40px;background:' + esc(S.me.color) + '"></span><div><h3 style="margin:0">' + esc(S.me.name) + '</h3><div class="small muted">' + esc(S.me.email) + '</div></div></div>' +
          '<div class="stack" style="margin-top:16px">' +
          (S.me.token ? '<div class="card"><h3>Your personal link</h3><p class="small muted" style="margin:0 0 8px">Opens the site signed in as you on any phone or laptop. Don’t share it.</p><button class="btn block" data-act="copy" data-url="' + esc(personalLink(S.me.token)) + '">Copy my link</button></div>' : '') +
          soundCard() + (S.isAdmin ? '<a class="btn block" href="#admin" data-act="close">Commissioner tools</a>' : '') + '<button class="btn block" data-act="signout">Sign out</button></div>');
        return;
      case 'signout': S.me = null; store.del('me'); closeSheet(); render(); return;
      case 'join': {
        var name = $('#jName').value, email = $('#jEmail').value;
        var sel = $('#jWinner .pickable');
        t.disabled = true; t.textContent = 'Joining…';
        apiPost({ action: 'join', name: name, email: email, winnerPick: sel ? sel.dataset.id : null }).then(function (res) {
          signedIn(res.me);
          toast(res.existing ? 'You were already in. Signed you in.' : 'You’re in! 🔥');
          location.hash = '#draft';
          poll();
        }).catch(function (err) { $('#jErr').textContent = errMsg(err); t.disabled = false; t.textContent = 'Join Season 51'; });
        return;
      }
      case 'winnerpick': {
        if (S.route === 'join' && $('#sheet').hidden) {
          var was = t.classList.contains('pickable');
          $$('#jWinner .bc').forEach(function (b) { b.classList.remove('pickable'); b.style.boxShadow = ''; var q = b.querySelector('.qrank'); if (q) q.remove(); });
          if (!was) { t.classList.add('pickable'); t.style.boxShadow = '0 0 0 2px var(--flame)'; t.insertAdjacentHTML('beforeend', '<span class="qrank">🏆</span>'); }
          return;
        }
        var pickId = S.me.winnerPick === id ? null : id;
        apiPost(Object.assign({ action: 'prefs', winnerPick: pickId }, ident())).then(function (res) {
          S.me.winnerPick = res.me.winnerPick; store.set('me', S.me); closeSheet(); render();
          toast(pickId ? 'Winner bet: ' + CASTBY[pickId].shortName : 'Winner bet cleared');
        }).catch(function (err) { toast(errMsg(err), true); });
        return;
      }
      case 'winnersheet': winnerSheet(); return;
      case 'queuesheet': queueSheet(); return;
      case 'qtoggle': {
        if (!amIn()) { signinSheet(); return; }
        var q = S.me.queue = S.me.queue || [];
        var i = q.indexOf(id);
        if (i === -1) q.push(id); else q.splice(i, 1);
        saveQueueSoon();
        if (t.dataset.close) closeSheet();
        render();
        return;
      }
      case 'qup': moveQ(id, -1); if (t.dataset.sheet) queueSheet(); return;
      case 'qdown': moveQ(id, 1); if (t.dataset.sheet) queueSheet(); return;
      case 'qdel': S.me.queue.splice(S.me.queue.indexOf(id), 1); saveQueueSoon(); render(); if (t.dataset.sheet) queueSheet(); return;
      case 'filter': S.boardFilter = t.dataset.f; store.set('filter', S.boardFilter); render(); return;
      case 'bigboard': S.showBigBoard = !S.showBigBoard; render(); return;
      case 'drafttab': S.draftTab = t.dataset.tab; render(); return;
      case 'castaway': castawaySheet(id, t.dataset.kind); return;
      case 'pick': {
        t.disabled = true; t.innerHTML = 'Drafting…';
        var kind = t.dataset.kind;
        apiPost(Object.assign({ action: 'pick', castawayId: id, kind: kind, n: Number(t.dataset.n) }, ident())).then(function (res) {
          closeSheet();
          acceptLeague(res.league);
        }).catch(function (err) {
          toast(errMsg(err), true);
          closeSheet(); poll();
        });
        return;
      }
      case 'sound': S.sound = t.checked; store.set('sound', S.sound); if (S.sound) chime(); return;
      case 'testsound': chime(); if (navigator.vibrate) navigator.vibrate(200); return;
      case 'notify': if (window.Notification) Notification.requestPermission().then(function () { render(); }); return;
      case 'watched': markWatched(Number(t.dataset.ep)); return;
      case 'notes': S.notesEp = Number(t.dataset.ep); render(); return;
      case 'lbrow': S.openRow = S.openRow === id ? null : id; render(); return;
      case 'series': S.hiddenSeries[id] = !S.hiddenSeries[id]; render(); return;
      case 'p_start':
        t.disabled = true; t.textContent = 'Setting up bots…';
        apiPost({ action: 'practice', op: 'start', bots: 8, clockSec: 45, botSec: 3 }).then(function (res) {
          S.seenStatus.main = 'open';
          acceptLeague(res.league); location.hash = '#draft';
        }).catch(function (err) { toast(errMsg(err), true); t.disabled = false; });
        return;
      case 'p_episode':
        t.disabled = true;
        apiPost({ action: 'practice', op: 'episode' }).then(function (res) {
          toast('Episode ' + res.ep + ': ' + CASTBY[res.boot].shortName + ' was voted out.');
          return poll();
        }).catch(function (err) { toast(errMsg(err), true); }).then(function () { t.disabled = false; });
        return;
      case 'p_reset':
        if (!confirm('Reset the practice league? (The real league is not affected.)')) return;
        apiPost({ action: 'practice', op: 'reset' }).then(function (res) { S.seenPicks = { main: null, merge: null }; acceptLeague(res.league); toast('Practice reset'); poll(); })
          .catch(function (err) { toast(errMsg(err), true); });
        return;
      case 'copy':
        if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.url).then(function () { toast('Copied'); });
        return;
    }

    // ----- admin actions -----
    if (act.indexOf('a') === 0 && act.charAt(1) === '_' || act === 'admintab' || act === 'adminrefresh') {
      adminAction(act, t, L);
    }
  });

  function adminDone(msg) { return function () { toast(msg); redraw('admin'); }; }
  function adminFail(e) { toast(errMsg(e), true); }

  function adminAction(act, t, L) {
    var kind = t.dataset.kind || 'main';
    switch (act) {
      case 'admintab': S.adminTab = t.dataset.tab; store.set('adminTab', S.adminTab); redraw('admin'); return;
      case 'adminrefresh': S.adminRoster = null; S.adminDrafts = null; poll().then(function () { redraw('admin'); }); return;
      case 'a_start':
        if (!confirm('Start the draft now? Sign-ups close and the order is randomized.')) return;
        admin('start_draft', { rounds: Number($('#aRounds').value), clockSec: Number($('#aClock').value), revealSec: 20 }).then(adminDone('The draft is live 🔥')).catch(adminFail); return;
      case 'a_pause': admin('pause', { kind: kind }).then(adminDone('Paused')).catch(adminFail); return;
      case 'a_resume': admin('resume', { kind: kind }).then(adminDone('Resumed')).catch(adminFail); return;
      case 'a_undo':
        if (!confirm('Undo the last pick?')) return;
        admin('undo', { kind: kind }).then(function (res) {
          // An undone pick shouldn't replay its reveal later.
          S.seenPicks[kind] = draftOf(kind).picks.length;
          adminDone('Undid ' + (res.undone && res.undone.castawayId ? CASTBY[res.undone.castawayId].shortName : 'last pick') + '. That player is back on the clock.')();
        }).catch(adminFail); return;
      case 'a_autopick': admin('autopick_now', { kind: kind }).then(adminDone('Auto-picked')).catch(adminFail); return;
      case 'a_pickfor':
        admin('pick_for', { kind: 'main', castawayId: $('#aPickFor').value, n: Number(t.dataset.n), playerId: t.dataset.pid })
          .then(adminDone('Pick entered')).catch(function (e) { adminFail(e); redraw('admin'); }); return;
      case 'a_clock': admin('set_clock', { kind: 'main', clockSec: Number($('#aClock2').value) }).then(adminDone('Clock updated')).catch(adminFail); return;
      case 'a_reset':
        admin('reset_draft', { confirm: $('#aReset').value.trim() }).then(function () { S.seenPicks = { main: null, merge: null }; adminDone('Draft reset')(); }).catch(adminFail); return;
      case 'a_merge': {
        var order = Engine.standings(L, S.data.episodes).slice().reverse().map(function (r) { return r.playerId; });
        if (!confirm('Start the merge draft? Order: ' + order.map(function (p) { return playerName(L, p); }).join(', '))) return;
        admin('start_merge', { order: order, startEp: Number($('#aMergeEp').value), clockSec: Number($('#aMergeClock').value) }).then(adminDone('Merge draft started')).catch(adminFail); return;
      }
      case 'a_color': return;
      case 'a_copyall': {
        var lines = (S.adminRoster || []).filter(function (p) { return !p.removed && p.token; })
          .map(function (p) { return p.name + ': ' + personalLink(p.token); });
        var text = 'Survivor 51 draft links — tap yours and it signs you in:\n' + lines.join('\n');
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Copied ' + lines.length + ' links'); });
        return;
      }
      case 'a_remove': admin('update_player', { id: t.dataset.id, removed: t.dataset.v === '1' }).then(function () { S.adminRoster = null; adminDone('Updated')(); }).catch(adminFail); return;
      case 'a_add': admin('add_player', { name: $('#aNewName').value, email: $('#aNewEmail').value }).then(function () { S.adminRoster = null; adminDone('Added')(); }).catch(adminFail); return;
      case 'a_ep': S.adminEp = Number(t.dataset.ep); redraw('admin'); return;
      case 'a_survivors': {
        var rows = $$('.score-grid tr[data-row]');
        var tribes = {};
        rows.forEach(function (r) { if (r.querySelector('[data-k="survives"]').checked || r.querySelector('[data-out]').value) tribes[CASTBY[r.dataset.row].tribe] = true; });
        rows.forEach(function (r) {
          var out = r.querySelector('[data-out]').value;
          var inTribe = tribes[Engine.castawayStatus(L, CAST, r.dataset.row).tribe];
          if (inTribe) r.querySelector('[data-k="survives"]').checked = !out;
        });
        return;
      }
      case 'a_saveep': {
        var scores = {}, eliminated = [];
        $$('.score-grid tr[data-row]').forEach(function (r) {
          var cid = r.dataset.row, sc = {};
          $$('[data-k]', r).forEach(function (inp) {
            if (inp.type === 'checkbox' && inp.checked) sc[inp.dataset.k] = true;
            if (inp.type === 'number' && Number(inp.value)) sc[inp.dataset.k] = Number(inp.value);
          });
          if (Object.keys(sc).length) scores[cid] = sc;
          var out = r.querySelector('[data-out]').value;
          if (out) eliminated.push({ id: cid, type: out });
        });
        var ep = S.adminEp;
        admin('save_episode', { ep: ep, data: { title: $('#aEpTitle').value, scores: scores, eliminated: eliminated, published: $('#aEpPub').checked } })
          .then(function () { S.adminDrafts = null; return poll(); }).then(adminDone('Episode ' + ep + ' saved')).catch(adminFail);
        return;
      }
      case 'a_notesep': S.adminNotesEp = Number(t.dataset.ep); redraw('admin'); return;
      case 'a_savenotes':
        admin('save_notes', { ep: S.adminNotesEp, title: $('#aNTitle').value, author: $('#aNAuthor').value, body: $('#aNBody').value, published: $('#aNPub').checked })
          .then(function () { S.adminDrafts = null; return poll(); }).then(adminDone('Write-up saved')).catch(adminFail);
        return;
      case 'a_settings': {
        var at = $('#sDraftAt').value;
        admin('settings', {
          settings: { rounds: $('#sRounds').value, clockSec: $('#sClock').value, scoringStartEp: $('#sStart').value, winnerBetPoints: $('#sBet').value },
          currentEp: $('#sCur').value, draftAt: at ? new Date(at).toISOString() : null, autoStart: $('#sAuto').checked
        }).then(adminDone('Settings saved')).catch(adminFail);
        return;
      }
    }
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.act === 'a_color') {
      admin('update_player', { id: t.dataset.id, color: t.value }).then(function () { toast('Color saved'); }).catch(adminFail);
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'aNBody') $('#aNPreview').innerHTML = md(e.target.value);
  });

  // Drag to reorder your list (desktop). Phones use the ↑ ↓ buttons.
  document.addEventListener('dragstart', function (e) {
    var qi = e.target.closest && e.target.closest('.qi[draggable]');
    if (!qi) return;
    S.dragging = true; qi.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', qi.dataset.id);
  });
  document.addEventListener('dragover', function (e) {
    var over = e.target.closest && e.target.closest('.qi[draggable]');
    var dragging = $('.qi.dragging');
    if (!over || !dragging || over === dragging) return;
    e.preventDefault();
    var r = over.getBoundingClientRect();
    over.parentNode.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  document.addEventListener('dragend', function () {
    var dragging = $('.qi.dragging');
    S.dragging = false;
    if (!dragging) return;
    dragging.classList.remove('dragging');
    S.me.queue = $$('#queue .qi').map(function (el) { return el.dataset.id; });
    saveQueueSoon(); render();
  });

  // =============================================================
  // BOOT
  // =============================================================
  function boot() {
    route();
    poll();
    if (S.adminKey) {
      apiPost({ action: 'admin', key: S.adminKey, op: 'whoami' }).then(function () {
        S.isAdmin = true; redraw(S.route);
      }).catch(function (e) {
        if (e.code === 'bad_admin_key') { store.del('admin'); S.adminKey = null; toast(errMsg(e), true); }
      });
    }
    // Refresh my private prefs (queue / winner bet) from the server.
    if (LINK_TOKEN && !S.tv) {
      apiPost({ action: 'login', token: LINK_TOKEN }).then(function (res) {
        S.me = res.me; store.set('me', S.me); render();
        toast('Signed in as ' + res.me.name + ' 🔥');
      }).catch(function () { toast('That personal link didn’t work. Sign in with your email instead.', true); });
    } else if (S.me && (S.me.email || S.me.token)) {
      apiPost(Object.assign({ action: 'login' }, ident())).then(function (res) { S.me = res.me; store.set('me', S.me); render(); })
        .catch(function (e) { if (e.code === 'not_found') { S.me = null; store.del('me'); render(); } });
    }
  }
  boot();

  // For quick debugging from the console.
  window.S51 = { state: S, poll: poll, render: render };
})();
