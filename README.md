# Skyfront

Browser strategy game (`Skyfront.html`) with an optional online multiplayer mode (Node.js, Express, Socket.IO).
Solo play is unchanged: open the page and press **Play Solo**.

## Multiplayer (Stage 4)

1. Host: **Create Room**, share the code. Friends: **Join Room** (max 8 per room).
2. Host: **Create World** (server generates it, ~5-30 s). Everyone receives the same world.
3. Each player clicks a country on the map to claim it (exclusive, validated on the server).
4. Host: **Start Game**. The server then runs the real game simulation; clients only render and send actions.
5. Shared today: **attacks** (unclaimed land, or nations at war with you) and **building / upgrading**.
   Other actions show "Not available in multiplayer yet" and never run locally.

### Architecture
- `server.js` rooms, players, claims, limits, rate limiting, event routing.
- `sim-worker.js` one worker thread per started room: owns the authoritative sim, ticks at 10 Hz max, validates actions.
- `sim-host.js` loads the game's own script from `Skyfront.html` into a `vm` with a stub DOM (no duplicated game logic) and encodes snapshots.
- `world-actions.js` shape checks, then calls the game's own `launchAttack` / `tryBuild` / `upgradeBuilding` for the player's *server-side* nation.
- `world-sync.js` delta tracker: changed tiles (binary), nations, buildings (keyed by tile), relations, attacks. Sent every 500 ms with a sequence number; a client that sees a gap refetches a snapshot.
- `Skyfront.html` guarded hooks (`MPH`, `window.__SKY`); all are inert unless a room is joined.

### Configuration (environment variables)
All are optional. Defaults are the values the Stage 2-5 tests and measurements used. `PORT` is provided by the host (Render sets it).
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP + Socket.IO port; the server binds `0.0.0.0:$PORT` |
| `MAX_WORLDS` | 4 | worlds that exist at once (~50 MB each) |
| `MAX_RUNNING_GAMES` | 1 | games ticking at once (see Performance) |
| `GRACE_MS` | 60000 | how long a disconnected player's seat/country is held |
| `BROADCAST_TICKS` | 5 (= `round(500 / SIM_STEP_MS)`) | sim steps per delta (5 steps = every 500 ms) |
| `SIM_STEP_MS` | 100 | wall-clock length *and* game time of one sim step, 100-250. 100 is the original game's step. Larger saves only ~7% CPU (measured) and makes the sim coarser: **not equivalent to the original**. Leave at 100 unless you have measured a need. |
| `WORLD_IDLE_MS` | 900000 | an unstarted or finished world nobody touched for this long is discarded (frees ~50 MB). Running games are never reaped. |
| `REAPER_MS` | 60000 | how often the idle check runs |
| `STATS_LOG_MS` | 0 (off) | if set, prints a `[stats]` JSON line at this interval: memory, action counters, per-world tick time, worker busy share, delta counts/bytes |
| `SKYFRONT_TEST` | unset | **tests only.** Enables the `test-wipe` / `test-crash` socket hooks. Never set it on a hosted service. |

Hard-coded: `MAX_ROOMS` 25, 8 players per room, action rate limit burst 10 / 5 per second per player.

## Diplomacy, warfare, economy, events and victory (Stage 5)

Everything below runs on the server inside the room's worker; clients only send requests (`game-action`) and render deltas.
The acting nation always comes from the server-side claim, never from the payload.

| Request (`action.type`) | Reuses the game's own function |
|---|---|
| `diplo` war / end / gift / mend / endpact | `declareWar`, `endTreaty`, `giftTo`, settle-dispute and nuclear-deal code (`dipAct`, the original `dipDo` with the acting nation as a parameter) |
| `diplo` peace / trade / alliance / nukepact against an **AI** nation | `propose` (the AI answers by its own rules) |
| `diplo` peace / trade / alliance / nukepact against a **human** | stored as an offer in `G.offers` (60 s, max 6 per player); the other human answers with `respond`; applied with `makePeace` / `setTreaty` |
| `attack`, `naval`, `sink`, `missile`, `bomber` | `launchAttack` (+ `launchNaval` fallback like the original click), `launchNaval`, `sinkShip`, `launchMissile`, `sortie` |
| `recruit`, `drive`, `jet`, `sat`, `stock` | `recruit`, `startDrive`, `buyJet`, `buySat`, `stockBuy` |
| `tax` (0-60), `bonds` issue/repay, `retreat` | tax slider rules, `issueBonds` / `repayBonds`, `endAttack` |
| `build`, `upgrade` | `tryBuild`, `upgradeBuilding` (Stage 4) |

Sync: relations (`war`, `treaty`, `truce`, `pact`, `riv`), offers, projectiles (missiles, bombers, fleets, keyed by a stable `_id`),
and events (news and log lines, with strictly increasing ids; a snapshot carries the id it is aligned to, so nothing repeats after a
reconnect) travel in the existing 500 ms deltas. Victory: land share, last nation standing, alliance bloc (per human nation) and
"last surviving player"; a player who loses all land is eliminated and keeps watching as a spectator. After a game ends the host can
press **New game** to build a fresh world in the same room.

Not supported (documented, never faked): "All-in" mode and bulk recruit/build, manual pause and game speed, the single-player
president decisions / AI offers pop-ups, ally-call prompts to human allies, opinion values of AI nations are not synced (bars are
approximate), and rooms are lost on a server restart.

## Deployment (Stage 6)

### Pre-deployment audit (what was verified locally)
- Server binds `0.0.0.0:$PORT`; `GET /healthz` returns `ok`; `/` serves `Skyfront.html`; Socket.IO is same-origin (works behind Render's proxy; WebSocket with long-polling fallback).
- No required environment variables. Dependencies: `express`, `socket.io` (runtime). `socket.io-client` is a dev dependency used only by tests. `engines.node >= 18`.
- Test hooks exist only when `SKYFRONT_TEST=1`; a test checks they are absent otherwise.
- Worker threads: one per world; terminated on room deletion, world reset, idle reaping and shutdown. `SIGTERM`/`SIGINT` stop the workers and exit 0 (tested).
- A crashed worker resets only that room (clear message, claims cleared) and the host can build a new world (tested). Other rooms keep running.
- Logs contain room codes, counts and error messages only: no tokens, names or payloads. Rate-limit hits are logged at most every 10 s per player.

### Staging service on Render (manual steps; this repository cannot create it for you)
Use a **separate** service so the live one is never touched. Do **not** edit the existing service's repo, branch, commands or variables.
1. Render dashboard > **New +** > **Web Service** > connect `artazakeri331/game-` (same GitHub connection).
2. Name `skyfront-staging` (any name different from the live service).
3. **Branch:** `stage6-deployment-optimization` (contains everything from Stages 2-6). Language/Runtime: **Node**.
4. **Build command:** `npm install`  **Start command:** `npm start`
5. **Instance type: Free.** (No paid resources are needed.) Health check path: `/healthz`.
6. Environment variables: none required. Optional: `NODE_VERSION=22`, `STATS_LOG_MS=30000` (to read measurements in the Render logs). **Do not set `SKYFRONT_TEST`.**
7. Create the service; wait for "Your service is live". Then check: `https://<staging>.onrender.com/healthz` shows `ok`; the game loads; two browsers can create/join a room, create a world, claim countries and start a game.
8. Keep Auto-Deploy on for the staging service only if you want it to follow the branch. When done testing, suspend or delete the staging service.

Free-tier facts to expect (Render's published behaviour, not measured here): the instance sleeps after ~15 min without traffic (first request then takes about a minute and **all rooms are lost**), 512 MB RAM, and a small CPU share (about 0.1 vCPU). Players on a free instance should also expect the shared-world generation (CPU heavy) to take longer than the 5-30 s seen locally.

## Performance (measured locally; **not measured on Render**)
Machine: 2 vCPU container, Node v22.22. Load: `node test/soak.js` (clients issue real actions at ~13/s across the room: builds, recruiting, tax, wars, peace offers, ground attacks, missiles, bombers). CPU = server process incl. all worker threads, from `/proc`.

| Run | CPU-s per wall-s | RSS max | Delta size avg / max | Deltas per client | Real-time ratio |
|---|---|---|---|---|---|
| 1 room, 4 clients, 900 s | 0.154 (p95 of 5 s samples 0.21) | 159 MB | 5.8 KB / 23.7 KB | 2.02 / s | 1.00 |
| 1 room, 4 clients, "battle" mode, 300 s (7,456 projectile updates received) | 0.152 | 149 MB | 7.2 KB / 37.5 KB | 2.07 / s | 1.01 |
| 2 rooms x 3 clients, 120 s (needs `MAX_RUNNING_GAMES=2`) | 0.206 | 208 MB | 6.4 KB / 16.9 KB | 2 / s | 1.11 (includes start-up time) |
| 1 room, 4 clients, 120 s, `SIM_STEP_MS` 100 / 200 / 250 | 0.108 / 0.101 / 0.101 | 154 / 154 / 148 MB | 6.5 / 7.1 / 6.9 KB | 2.2 / 1.8 / 2.2 | 1.02 |
| server with no room | 0.005 | 61 MB | | | |
| world built, game not started, 1 player | 0.004 | 105 MB | | | |
| game running, all players disconnected (paused, inside grace) | 0.009 | 105 MB | | | |

Worker numbers in the 900 s run: mean step 16 ms, worst step 55 ms (budget 100 ms), worker busy 16%. CPU per game second rises as the game grows (0.11 in the first minutes, ~0.15 after 10+ minutes).

What this means:
- Locally one game uses ~0.15 of a core and ~150 MB; a delta stream is ~12 KB/s per client. A 0.1 vCPU free instance is **below** that need, so there the game would likely run slower than real time (rough estimate: ~0.6-0.7x, assuming the CPU limit applies linearly; unverified). The sim degrades by slowing (it never runs more than 3 catch-up steps), not by crashing.
- `SIM_STEP_MS=200/250` is **not** a fix: it saved only ~7% CPU. A paid instance (or a future game-speed setting) is the realistic remedy; neither has been done.
- `MAX_RUNNING_GAMES` stays 1 and `MAX_WORLDS` 4 (4 worlds ~ 4 x 47 MB fits 512 MB; a second *running* game adds ~0.05-0.1 core).
- Finished or abandoned worlds: freed when the room empties (seats expire after `GRACE_MS`) or after `WORLD_IDLE_MS`.

## Persistence (current behaviour and options)
**Today (Option A, implemented by default):** rooms, claims, worlds and games exist only in server memory. A restart, crash of the whole process, redeploy or free-tier sleep deletes every room; clients see "Your seat has expired or the room no longer exists" and must create a new room. A crash of a single world's worker resets only that room.

**Option A - keep ephemeral.** No cost, no new failure modes, simplest. Consequence: games longer than the instance's uptime are lost; on the free tier that means any 15-minute pause in traffic.
**Option B - persistent saves.** Periodically serialize each started world (the existing snapshot format already contains terrain, owners, `G`, relations and offers) plus room metadata (code, seats with tokens, claims) to storage, with a format version and a checksum; on boot validate and reload workers from saves, and let players rejoin with their tokens. Costs/risks: needs storage that survives restarts (Render's free tier has none: a persistent disk or an external database is a paid or third-party service); tokens would be persisted (must be stored carefully); a snapshot does not contain the RNG state or `last`/`acc` timing so a resumed game is not bit-identical; loading code paths must tolerate old/corrupt saves; roughly 1-2 days of work plus tests.
**Recommendation:** stay on Option A for now and tell players that games do not survive restarts. Choose Option B only if you move to a paid instance with a disk and long-running games matter. Nothing in B has been implemented; no database or storage service was added.

## Known issues and recovery
- Free-tier sleep or redeploy erases rooms: create a new room; nothing to repair on the server.
- A world can fail to build or its worker can crash: the room shows an error, claims are cleared, the host presses **Create World** again.
- A browser that loses the connection reconnects automatically within `GRACE_MS` and keeps its country; after that the country returns to the AI.
- A client that misses updates re-downloads one snapshot (automatic); repeated resyncs usually mean the server CPU is saturated.
- Not supported in multiplayer (see Stage 5 list): All-in mode, manual pause/speed, single-player president pop-ups, ally-call prompts, AI opinion values.
- `README.txt` is the original starter note and is outdated; this file is current.

### Tests
```
npm install
npm test                                   # all Node suites incl. Stage 6 resilience + a 25 s soak, serial (~6 min)
python3 test/stage2_lobby.py http://localhost:3111/   # start: PORT=3111 GRACE_MS=3000 node server.js
python3 test/stage3_browser.py             # starts its own server
python3 test/stage4_browser.py             # starts its own server
python3 test/stage5_browser.py             # starts its own server (sets SKYFRONT_TEST=1, a test-only hook)
```
Browser tests need Playwright with Chromium (`pip install playwright`).
Long or custom soak (local only, never point it at a hosted service):
```
node test/soak.js                                   # 60 s, 3 clients
SOAK_SECONDS=900 SOAK_CLIENTS=4 node test/soak.js   # the 15-minute run reported above
SOAK_BATTLE=1 SOAK_SECONDS=300 node test/soak.js    # build up, then fire missiles/bombers
SOAK_ROOMS=2 SOAK_ENV="MAX_RUNNING_GAMES=2" node test/soak.js
```
