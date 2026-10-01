#!/usr/bin/env node
// Validate and publish one episode's scoring.
//   set -a; . ./.env.local; set +a; node tools/score-episode.js notes/episodes/ep03.json [--draft] [--dry-run]
// File format:
//   { "ep": 3, "title": "Episode title",
//     "scores": { "rob": { "survives": true, "findIdol": true }, "jury": { "juryVotes": 2 } },
//     "eliminated": [ { "id": "maggie", "type": "voted" } ],      // voted | medevac | quit | other
//     "sources": ["https://..."] }
// Keys allowed in scores: survives findIdol playIdol findAdvantage playAdvantage makesMerge
// idolPocket quit immunityWin firemaking juryVotes(number) soleSurvivor iconic
const fs = require('fs');
const E = require('../engine.js');
const { CAST } = require('../cast.js');

const [file, ...flags] = process.argv.slice(2);
const API = process.env.S51_API, KEY = process.env.S51_ADMIN;
if (!file || !API || !KEY) { console.error('usage: node tools/score-episode.js <file.json> [--draft] [--dry-run]  (needs S51_API, S51_ADMIN)'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const ids = new Set(CAST.map(c => c.id));
const keys = new Set(E.SCORING.map(c => c.key));
const problems = [];

(async () => {
  const L = (await fetch(API + '?action=state&t=' + Date.now()).then(r => r.json())).data.league;
  const inGame = id => { const s = E.castawayStatus(L, CAST, id); return s.status === 'active' || (s.eliminatedEp != null && s.eliminatedEp >= data.ep); };
  if (!Number.isInteger(data.ep) || data.ep < 1) problems.push('ep must be a positive integer');
  Object.entries(data.scores || {}).forEach(([id, sc]) => {
    if (!ids.has(id)) problems.push(`unknown castaway id "${id}"`);
    else if (!inGame(id)) problems.push(`${id} was already out before Ep ${data.ep}`);
    Object.keys(sc).forEach(k => { if (!keys.has(k)) problems.push(`${id}: unknown category "${k}"`); });
  });
  (data.eliminated || []).forEach(x => {
    if (!ids.has(x.id)) problems.push(`eliminated: unknown id "${x.id}"`);
    if ((data.scores[x.id] || {}).survives) problems.push(`${x.id} is marked both eliminated and survived`);
  });
  if (problems.length) { console.error('NOT PUBLISHED — fix these:\n - ' + problems.join('\n - ')); process.exit(2); }

  // Preview the effect on every player.
  const episodes = (await fetch(API + '?action=state&t=' + Date.now()).then(r => r.json())).data.episodes;
  episodes[data.ep] = { scores: data.scores, published: true };
  E.standings(L, episodes).forEach(r => console.log(`  ${r.rank}. ${r.name}: ${r.total} (+${r.lastEp} this ep)`));
  if (L.machine && L.machine.enabled) console.log(`  🤖 Machine: ${E.machineTotal(L, episodes)}`);
  if (flags.includes('--dry-run')) { console.log('dry run: nothing saved'); return; }

  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({
    action: 'admin', key: KEY, op: 'save_episode', ep: data.ep,
    data: { title: data.title || '', scores: data.scores, eliminated: data.eliminated || [], published: !flags.includes('--draft') }
  }) }).then(r => r.json());
  if (!res.ok) { console.error('save failed:', res.error); process.exit(1); }
  console.log(`${flags.includes('--draft') ? 'Saved as draft' : 'Published'}: Episode ${data.ep}`);
})().catch(e => { console.error(e); process.exit(1); });
