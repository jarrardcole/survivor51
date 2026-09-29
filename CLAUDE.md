# Survivor: 🌈 Brooklyn (Survivor 51 Fantasy League)

Status: Active
Next: Jarrard tests practice mode; then send the one link to the group, set the draft start time (auto-start), give Will the admin link. The Machine is built and put to a league vote (sign-up + homepage).

## What it is
Season 51 of the friends' Survivor fantasy league (Season 50 lives in `fun/survivor-draft`, repo `survivor50`).
A static site on GitHub Pages (`jarrardcole/survivor51`) plus a Google Apps Script backend on a new Google Sheet.
Jarrard is remote on draft night, so the draft is fully self-serve: every player picks from their own phone.
**Will Taylor is the in-room admin.**

## Decisions (Sep 28, 2026)
- Same scoring as Season 50 (`engine.js` → `SCORING`). "Survives" = attended Tribal and wasn't voted out.
- **Episode 2 does not count.** `scoringStartEp = 3`. The draft happens on Episode 2 night (Wed Sep 30).
- Snake draft, 4 rounds by default, each castaway can be picked by 2 players. The server refuses a draft
  bigger than the board (20 active castaways × 2 = 40 picks; 10 players × 4 fits, 11 players needs 3 rounds).
- 90-second pick clock. When it expires, auto-pick takes the top available castaway from that player's
  ranked list, else the league consensus (average rank across everyone's lists).
- **Pick the Winner** bet: +10, hidden until the main draft completes, then locked and revealed.
- No weekly pick'em. No email newsletter. The weekly **Commissioner's Notes** write-up lives on the homepage.
- New people can sign up at `#join` until the draft starts; after that Will adds them from Admin → Players.
- Merge draft: 1 pick each, reverse standings, cap 2, scores from its start episode on.

## Files
| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | The site. Hash routes: `#home #draft #standings #cast #rules #join #admin`. `?tv` = big-screen draft view. |
| `engine.js` | Pure game rules (draft order, pick legality, clock/auto-pick, scoring, standings, win odds). Shared by site, backend and tests. |
| `cast.json` → `cast.js` | Castaways (`tools/build.sh` generates `cast.js`). Photos in `photos/`. |
| `apps-script/api.js`, `platform.js` | Backend. `tools/build.sh` concatenates cast + engine + api + platform into `apps-script/Code.gs` (paste that into Apps Script). |
| `config.js` | `API_URL` (Apps Script `/exec` URL), site URL, air dates. Localhost uses the mock server. |
| `dev/mock-server.js` | Runs the real backend code in node with an in-memory store. Admin key `dev`. `POST /__seed?n=9` adds fake players, `/__reset` clears. Preview config: `survivor51-mock` in the workspace `.claude/launch.json`. |
| `test/engine.test.js` | `node --test test/engine.test.js` (engine + API flows). |
| `tools/post-notes.js` | Publish a write-up: `S51_API=… S51_ADMIN=… node tools/post-notes.js notes/writeups/NN-*.md` |
| `notes/season-facts.md` | Cast/tribe/Episode 1 facts with sources. `notes/writeups/` holds the Commissioner's Notes sources. |

## Backend design (why it's different from Season 50)
- Season 50 published the **whole state** from the admin's browser, and stale tabs wiped the sheet mid-draft.
  Now every write is a small server-side **action** (`join`, `prefs`, `pick`, `admin` ops) validated by `engine.js` under `LockService`.
- The pick clock is server-authoritative. Every GET checks the deadline and applies the auto-pick (one per tick,
  so a room-wide wifi drop can't auto-draft everyone).
- Storage: `Store` sheet, one row per key (`league`, `private`, `ep:N`, `notes:N`). Each value < 50K chars.
  `private` holds emails, ranked lists and winner bets; it's never sent to viewers. Every league write also
  appends a row to `Backups`.
- GET responses are cached in CacheService (chunked) and invalidated on write.
- Admin key lives in Script Properties (`setup()` creates it). Admin link: `SITE_URL?admin=KEY#admin`.

## Live (Sep 28, 2026)
- Site: https://jarrardcole.github.io/survivor51/ (the one link). Practice sandbox: `?practice` (bots, fake episodes; practice admin key is `practice`).
- Backend: Apps Script web app, deployment "Survivor 51 v1" (now Version 4), bound to the Sheet "Survivor 51 Fantasy — backend".
  URLs, Sheet link and the real admin key are in `.env.local` (git-ignored). Never commit the admin key.
- **Host view (Will's laptop on the TV):** `?tv&admin=<KEY>`. TV board + a small Host bar (start, pause, undo, use backup plan). Clicking a castaway opens "Draft X for <whoever is up>?"; if that player picks on their phone first, the server keeps theirs (`pick_for` checks `n` + `playerId`). Before the draft the TV shows a waiting room (who's in, who's ready, QR, Machine vote).
- Personal links: `?me=<token>` signs a player in on any device. Admin → Players → "Copy all links".
- `tools/rehearse.js` runs a full draft against the live backend in the practice namespace (races, timeouts, purge). Last run:
  18 picks, 0 errors, and with 12 simultaneous pollers p50 ~1s / p90 2.6s / max 5.3s, 0 busy.
- Lesson: one Apps Script execution stalled for 6 min holding the script lock (Google-side). Reads are now lock-free
  (`tryWithLock` + fall back to cached/stored state), writes wait max 8s, backups flush after the lock, slow locks log to Executions.
- Redeploy: paste `apps-script/Code.gs` (fetch from GitHub raw by commit into Monaco via `monaco.editor.getModels()[0].setValue`),
  save, Deploy → Manage deployments → Edit → Version: **New version** (select by ref) → Deploy.

## The Machine (added Sep 28)
- Optional AI shadow team, decided by league vote (yay/nay at sign-up or on the homepage; locks at draft start; ties = no Machine; Will can force on/off in Admin → Draft).
- Plan + one-liners in `machine.json` (bundled into cast.js by build.sh). It picks once at the end of each main-draft round, never counts against the 2-pick cap, can't win; standings show it as a dashed benchmark row/line.
- Weekly write-ups can needle whoever is losing to it.

## Weekly routine (after each episode)
1. Admin → Scoring → pick the episode, tick the boxes, mark who went home, Save. (Or Claude posts `save_episode` via the API.)
2. Write the Commissioner's Notes in `notes/writeups/NN-episode.md`, publish with `tools/post-notes.js`.
3. The site hides the newest episode's results for 6 days until each viewer taps "I've watched it".

## Deploy checklist
1. `tools/build.sh` → paste `apps-script/Code.gs` into a new Apps Script bound to a new Sheet → run `setup` → Deploy as web app (Execute as me, Anyone). **Select "New version" by accessibility ref, not pixel** (Season 50 lesson).
2. Put the `/exec` URL in `config.js`, commit, push to `main`; Pages serves from the repo root.
3. Smoke test: `GET ?action=ping`, join with a test email, remove it in Admin → Players.
