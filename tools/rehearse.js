#!/usr/bin/env node
// Full-draft rehearsal against a real backend: fake players join, the draft runs with a short
// clock, some players pick by hand, some time out (auto-pick), and two players race for the
// same slot. Then everything is reset and the fake players are purged.
//   set -a; . ./.env.local; set +a; node tools/rehearse.js [players=9] [clockSec=15]
const API = process.env.S51_API, KEY = process.env.S51_ADMIN;
const N = Number(process.argv[2] || 9), CLOCK = Number(process.argv[3] || 15);
if (!API || !KEY) { console.error('need S51_API and S51_ADMIN'); process.exit(1); }

// Runs in the practice sandbox by default (same code and Google services, separate data). REAL=1 targets the real league.
const NS = process.env.REAL ? undefined : 'practice';
const post = b => fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ ns: NS }, b)) }).then(r => r.json());
const get = () => fetch(API + '?action=state' + (NS ? '&ns=' + NS : '') + '&t=' + Date.now()).then(r => r.json());
const admin = (op, x) => post(Object.assign({ action: 'admin', key: KEY, op }, x || {}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);

(async () => {
  if (NS) await post({ action: 'practice', op: 'reset' });
  const pre = (await get()).data.league;
  if (pre.draft.status !== 'open') { console.error('draft is not open; refusing to rehearse over a real draft'); process.exit(1); }
  const players = [];
  for (let i = 0; i < N; i++) {
    const r = await post({ action: 'join', name: 'Rehearsal ' + (i + 1), email: `rehearsal${i + 1}@example.com`, queue: i % 3 ? ['rob', 'kilby', 'ori'] : [] });
    if (!r.ok) throw new Error('join ' + r.error);
    players.push(r.me);
  }
  log('joined', players.length);
  const s = await admin('start_draft', { rounds: 2, clockSec: CLOCK });
  if (!s.ok) throw new Error('start ' + s.error);
  log('draft live, order', s.league.draft.order.length);
  const byId = Object.fromEntries(players.map(p => [p.id, p]));
  const stats = { manual: 0, auto: 0, raceRejected: 0, errors: [] };
  let lastN = -1;
  while (true) {
    const L = (await get()).data.league;
    const d = L.draft;
    if (d.status === 'complete') break;
    const n = d.picks.length;
    if (n !== lastN) {
      lastN = n;
      const N2 = d.order.length, r = Math.floor(n / N2), pos = n % N2;
      const pid = d.order[r % 2 ? N2 - 1 - pos : pos];
      const me = byId[pid];
      if (n % 4 === 3) { log(`#${n + 1} ${me.name} lets the clock run out`); continue; }
      const taken = {}; d.picks.forEach(p => { taken[p.castawayId] = (taken[p.castawayId] || 0) + 1; });
      const mine = d.picks.filter(p => p.playerId === pid).map(p => p.castawayId);
      const choice = ['sharonda', 'devin', 'jelly', 'mike', 'patt', 'eric', 'ana', 'carter', 'kristin', 'maggie', 'lewis', 'brady', 'cristian', 'alexis', 'jenna', 'thien-an', 'linnea', 'ori', 'rob', 'kilby']
        .find(id => (taken[id] || 0) < 2 && !mine.includes(id));
      if (n % 5 === 0) {
        // Race: the right player and the wrong player submit at the same moment.
        const other = players.find(p => p.id !== pid);
        const [a, b] = await Promise.all([
          post({ action: 'pick', token: me.token, castawayId: choice, n }),
          post({ action: 'pick', token: other.token, castawayId: choice, n })
        ]);
        if (!a.ok) stats.errors.push('race winner rejected: ' + a.error);
        if (!b.ok) stats.raceRejected++;
        log(`#${n + 1} race: right player ${a.ok ? 'ok' : a.error}, wrong player ${b.ok ? 'ACCEPTED?!' : b.error}`);
      } else {
        const res = await post({ action: 'pick', token: me.token, castawayId: choice, n });
        if (res.ok) stats.manual++; else stats.errors.push(`#${n + 1} ${res.error}`);
        log(`#${n + 1} ${me.name} picks ${choice}: ${res.ok ? 'ok' : res.error}`);
      }
    }
    await sleep(2500);
  }
  const L = (await get()).data.league;
  stats.auto = L.draft.picks.filter(p => p.auto).length;
  const counts = {}; L.draft.picks.forEach(p => { counts[p.castawayId] = (counts[p.castawayId] || 0) + 1; });
  const overCap = Object.entries(counts).filter(([, c]) => c > 2);
  const dupes = players.filter(p => { const m = L.draft.picks.filter(x => x.playerId === p.id).map(x => x.castawayId); return new Set(m).size !== m.length; });
  log('complete:', L.draft.picks.length, 'picks', JSON.stringify(stats), 'overCap', overCap.length, 'dupes', dupes.length);
  await admin('reset_draft', { confirm: 'RESET' });
  const purge = await admin('purge', { match: 'rehearsal' });
  log('reset + purge', purge.ok ? 'ok' : purge.error);
  process.exit(stats.errors.length || overCap.length || dupes.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
