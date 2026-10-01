#!/usr/bin/env node
// Prints what a weekly scorer needs: which episodes are scored, who is still in the game
// (by tribe), every fantasy roster, the Machine, and current standings.
//   set -a; . ./.env.local; set +a; node tools/league-status.js
const E = require('../engine.js');
const { CAST } = require('../cast.js');
const API = process.env.S51_API;
if (!API) { console.error('need S51_API (source .env.local)'); process.exit(1); }

(async () => {
  const res = await fetch(API + '?action=state&t=' + Date.now()).then(r => r.json());
  if (!res.ok) throw new Error(res.error);
  const { league: L, episodes, notes } = res.data;
  const name = id => (L.players.find(p => p.id === id) || {}).name;
  const scored = Object.keys(episodes).map(Number).sort((a, b) => a - b);
  console.log('Draft:', L.draft.status, '| merge draft:', L.merge.status, '| scoring starts Ep', L.settings.scoringStartEp);
  console.log('Episodes scored:', scored.join(', ') || 'none', '| write-ups published:', Object.keys(notes).sort((a, b) => a - b).join(', ') || 'none');
  console.log('Next episode to score:', (scored.length ? Math.max(...scored) : L.settings.scoringStartEp - 1) + 1);
  console.log('\nStill in the game (by current tribe):');
  const tribes = {};
  CAST.forEach(c => { const s = E.castawayStatus(L, CAST, c.id); if (s.status === 'active') (tribes[s.tribe] = tribes[s.tribe] || []).push(c.id); });
  Object.keys(tribes).forEach(t => console.log(`  ${t}: ${tribes[t].join(', ')}`));
  console.log('Out:', CAST.map(c => E.castawayStatus(L, CAST, c.id)).filter(s => s.status !== 'active').map(s => `${s.id} (Ep ${s.eliminatedEp})`).join(', '));
  console.log('\nValid castaway ids:', CAST.map(c => c.id).join(', '));
  console.log('\nRosters:');
  E.activePlayers(L).forEach(p => {
    const r = E.roster(L, p.id);
    console.log(`  ${p.name}: ${r.draft.join(', ')}${r.merge.length ? ' + merge: ' + r.merge.join(', ') : ''} | winner bet: ${(L.winnerBets || {})[p.id] || '-'}`);
  });
  if (L.machine && L.machine.enabled) console.log(`  🤖 The Machine: ${L.machine.picks.map(p => p.castawayId).join(', ')} | total ${E.machineTotal(L, episodes)}`);
  console.log('\nStandings:');
  E.standings(L, episodes).forEach(r => console.log(`  ${r.rank}. ${r.name} ${r.total} (last ep ${r.lastEp >= 0 ? '+' : ''}${r.lastEp}, move ${r.move})`));
})().catch(e => { console.error(e); process.exit(1); });
