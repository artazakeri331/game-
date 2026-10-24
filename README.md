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
| Variable | Default | Meaning |
|---|---|---|
| `MAX_WORLDS` | 4 | worlds that exist at once (~50 MB each) |
| `MAX_RUNNING_GAMES` | 1 | games ticking at once (~170 ms CPU per wall-second each, measured) |
| `GRACE_MS` | 60000 | how long a disconnected player's seat/country is held |
| `BROADCAST_TICKS` | 5 | sim ticks per delta (5 = every 500 ms) |

On Render's free tier (~0.1 vCPU) one running game likely cannot keep real-time speed; it slows down instead of failing.
All rooms and worlds live in memory and are lost on restart or redeploy.

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

### Tests
```
npm install
npm test                                   # all Node suites, serial (~3.5 min)
python3 test/stage2_lobby.py http://localhost:3111/   # start: PORT=3111 GRACE_MS=3000 node server.js
python3 test/stage3_browser.py             # starts its own server
python3 test/stage4_browser.py             # starts its own server
python3 test/stage5_browser.py             # starts its own server (sets SKYFRONT_TEST=1, a test-only hook)
```
Browser tests need Playwright with Chromium (`pip install playwright`).
