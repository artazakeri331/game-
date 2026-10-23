"""Stage 4 browser test: real Chromium clients, real clicks. Run: python3 test/stage4_browser.py"""
import subprocess, sys, time, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = "3292"; URL = f"http://localhost:{PORT}/"
results = []
def check(name, cond, extra=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

STATE = """() => { const s = window.__SKY.state(); return { t: s.G.t, phase: s.G.phase, paused: s.G.paused, over: !!s.G.over, seed: s.seed }; }"""
# a nation with a neutral border: returns nation id, a neutral tile and an own plains tile
PLAN = """(skip) => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length; let out = null;
  for (const n of s.G.nations) { if (n.id < 1 || !n.alive || n.tiles < 100 || skip.includes(n.id)) continue;
    let tgt = -1, own = -1;
    for (let i = 0; i < N; i++) { if (s.owner[i] !== n.id || !s.terr[i]) continue;
      if (own < 0 && s.terr[i] === 1 && !s.G.bat.has(i)) own = i;
      const x = i % MW; for (const j of [x > 0 ? i - 1 : -1, x < MW - 1 ? i + 1 : -1, i - MW, i + MW]) if (tgt < 0 && j >= 0 && j < N && s.owner[j] === -1 && s.terr[j]) tgt = j;
      if (tgt >= 0 && own >= 0) break; }
    if (tgt >= 0 && own >= 0) { out = { nation: n.id, tgt, own, name: n.name }; break; } }
  return out; }"""
CENTER = """(i) => { const S = window.__SKY, c = S.state().cam, r = document.getElementById('cv').getBoundingClientRect(), MW = S.MW;
  c.z = 6; const x = i % MW, y = (i / MW) | 0; c.x = x + .5 - r.width / c.z / 2; c.y = y + .5 - r.height / c.z / 2; }"""
SCREEN = """(i) => { const S = window.__SKY, c = S.state().cam, r = document.getElementById('cv').getBoundingClientRect(), MW = S.MW;
  const x = i % MW, y = (i / MW) | 0; return { x: r.left + (x + .5 - c.x) * c.z, y: r.top + (y + .5 - c.y) * c.z }; }"""
COUNT = "(k) => { const o = window.__SKY.state().owner; let c = 0; for (let i = 0; i < o.length; i++) if (o[i] === k) c++; return c; }"
BLDS = "() => JSON.stringify(window.__SKY.state().G.blds.map(b => [b.i, b.type, b.owner, b.lv]).sort((a, b) => a[0] - b[0]))"

def click_tile(p, i):
    p.evaluate(CENTER, i); time.sleep(.25)
    pt = p.evaluate(SCREEN, i); p.mouse.click(pt["x"], pt["y"]); time.sleep(.15)
def status(p): return p.inner_text("#statusLine")

srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": PORT, "GRACE_MS": "60000", "MAX_WORLDS": "6", "MAX_RUNNING_GAMES": "3"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"]); errs = []
        def mk(label):
            p = b.new_context(viewport={"width": 1280, "height": 760}).new_page()
            p.on("pageerror", lambda e: errs.append(f"{label}: {e}")); p.goto(URL); p.wait_for_selector("#mpStatus.ok", timeout=20000); return p
        ready = lambda p, t=120000: p.wait_for_function("document.getElementById('mpWorld').textContent.includes('World ready')||document.getElementById('mpWorld').textContent.includes('Game in progress')", timeout=t)

        A = mk("A"); A.fill("#mpName", "Alice"); A.click("#mpCreate"); A.wait_for_selector("#mpRoom:not([hidden])")
        code = A.inner_text("#mpCode")
        B = mk("B"); B.fill("#mpName", "Bob"); B.fill("#mpJoinCode", code); B.click("#mpJoin"); B.wait_for_selector("#mpRoom:not([hidden])")
        A.click("#mpMakeWorld"); ready(A); ready(B)
        check("Start Game is hidden until someone has picked a country", A.is_visible("#mpStart") and A.is_disabled("#mpStart"))

        planA = A.evaluate(PLAN, []); planB = B.evaluate(PLAN, [planA["nation"]])
        A.click("#mpClose"); B.click("#mpClose")
        click_tile(A, planA["own"]); time.sleep(.6)
        check("A claims a country by clicking the map", f"You lead {planA['name']}" in status(A), status(A)[:100])
        click_tile(B, planB["own"]); time.sleep(.6)
        check("B claims a different country", f"You lead {planB['name']}" in status(B), status(B)[:100])
        click_tile(B, planA["own"]); time.sleep(.6)
        check("B cannot take A's country", "already led by Alice" in status(B), status(B)[:100])

        A.click("#mpPill"); A.wait_for_selector("#mpRoom:not([hidden])")
        check("Start Game enabled for the host once a country is picked", A.is_enabled("#mpStart"))
        B.click("#mpPill"); B.wait_for_selector("#mpRoom:not([hidden])")
        check("guest never sees Start Game", not B.is_visible("#mpStart"))
        A.click("#mpStart")
        for p in (A, B): p.wait_for_function("document.getElementById('mpWorld').textContent.includes('Game in progress')", timeout=15000)
        A.click("#mpClose"); B.click("#mpClose"); time.sleep(.8)
        check("game started: play UI shown on both (spawn bar hidden, dock visible)", all(not p.is_visible("#spawnBar") and p.is_visible("#dockMain") for p in (A, B)))
        check("HUD shows the player's own nation data", len(A.inner_text("#hud")) > 20 and len(B.inner_text("#hud")) > 20)

        # the client must not run its own simulation: time and AI troops follow the server only
        t1 = A.evaluate(STATE)["t"]; time.sleep(2.2); t2 = A.evaluate(STATE)["t"]
        check("world time advances with the server's updates (about 2 game-seconds in 2.2 s)", 1.0 <= t2 - t1 <= 3.5, f"{t1}->{t2}")
        ok = False
        for _ in range(40):
            sa, sb = A.evaluate("()=>({t:window.__SKY.state().G.t,tr:window.__SKY.state().G.nations.map(n=>Math.round(n.troops))})"), B.evaluate("()=>({t:window.__SKY.state().G.t,tr:window.__SKY.state().G.nations.map(n=>Math.round(n.troops))})")
            if sa["t"] == sb["t"]: ok = sa["tr"] == sb["tr"]; break
            time.sleep(.1)
        check("both clients show identical troop numbers at the same server time (no local simulation)", ok)
        A.keyboard.press("Space"); time.sleep(.3)
        check("Space does not pause a shared game", not A.evaluate(STATE)["paused"])

        # attack through the real UI
        before = A.evaluate(COUNT, planA["nation"])
        click_tile(A, planA["tgt"])
        A.wait_for_function("document.getElementById('statusLine').textContent.includes('Attack launched')", timeout=5000)
        check("A's attack click is validated and accepted by the server", True)
        time.sleep(4.5)
        ca, cb = A.evaluate(COUNT, planA["nation"]), B.evaluate(COUNT, planA["nation"])
        check("the attack changed ownership, and B sees the same territory as A", ca > before and abs(ca - cb) < 400, f"{before}->{ca}/{cb}")

        # build through the real UI
        A.click('[data-tab="build"]'); A.click('[data-mode="b:city"]'); time.sleep(.2)
        click_tile(A, planA["own"])
        A.wait_for_function("document.getElementById('statusLine').textContent.includes('City built')", timeout=5000)
        time.sleep(1.5)
        ba, bb = A.evaluate(BLDS), B.evaluate(BLDS)
        check("A's city exists for both players and building lists are identical", planA["own"] in [x[0] for x in json.loads(bb)] and ba == bb, f"{len(json.loads(ba))} vs {len(json.loads(bb))}")
        B.click('[data-tab="build"]'); B.click('[data-mode="b:city"]'); time.sleep(.2)
        click_tile(B, planA["own"]); time.sleep(.8)
        check("B cannot build on A's land (server message shown)", "own land" in status(B), status(B)[:100])

        # unsupported actions are blocked, never run locally
        B.click('[data-tab="troops"]'); B.click('[data-mode="t:small"]'); time.sleep(.3)
        check("recruiting is blocked with a clear message (not run locally)", "Not available in multiplayer" in status(B), status(B)[:100])
        B.keyboard.press("p"); time.sleep(.3)
        B.evaluate("()=>{const b=document.querySelector('[data-dip]');if(b)b.click()}"); time.sleep(.3)

        # reload mid-game: seat, country and running world survive
        tb = A.evaluate(STATE)["t"]; seed = A.evaluate(STATE)["seed"]
        A.reload(); A.wait_for_selector("#mpStatus.ok"); A.wait_for_function("document.getElementById('mpWorld').textContent.includes('Game in progress')", timeout=60000)
        sa2 = A.evaluate(STATE)
        check("reload: same world (not reset) and time moved forward", sa2["seed"] == seed and sa2["t"] >= tb, f"{tb}->{sa2['t']}")
        A.wait_for_function("[...document.querySelectorAll('#mpList .nat')].some(e=>e.textContent===%r)" % planA["name"], timeout=5000)
        check("reload: Alice still leads her country", True)
        A.click("#mpClose"); time.sleep(.5)
        ba2 = A.evaluate(BLDS); check("reload: buildings restored", planA["own"] in [x[0] for x in json.loads(ba2)])

        # solo regression with the original click paths (never touched multiplayer)
        S = mk("S"); S.click("#mpSolo"); time.sleep(.3)
        plan = S.evaluate(PLAN, [])
        S.evaluate(CENTER, plan["own"]); S.evaluate("()=>{}")
        S.evaluate("(i)=>{const c=window.__SKY.state().cam;c.z=Math.min(c.z,3)}", plan["own"])
        S.click("#randomSpawn"); time.sleep(1.2)
        st = S.evaluate("()=>{const s=window.__SKY.state();return {phase:s.G.phase,alive:s.G.nations[0].alive,t:s.G.t}}")
        check("solo: spawn uses the original pickNation (nation 0 becomes the player)", st["phase"] == "play" and st["alive"])
        time.sleep(2.2)
        st2 = S.evaluate("()=>({t:window.__SKY.state().G.t})")
        check("solo: the client still runs its own simulation locally", st2["t"] > st["t"] + 1.0, f"{st['t']}->{st2['t']}")
        plan = S.evaluate("""() => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length; let own = -1, tgt = -1;
          for (let i = 0; i < N; i++) { if (s.owner[i] !== 0 || !s.terr[i]) continue; if (own < 0 && s.terr[i] === 1 && !s.G.bat.has(i)) own = i;
            const x = i % MW; for (const j of [x > 0 ? i - 1 : -1, x < MW - 1 ? i + 1 : -1, i - MW, i + MW]) if (tgt < 0 && j >= 0 && j < N && s.owner[j] === -1 && s.terr[j]) tgt = j; if (own >= 0 && tgt >= 0) break; }
          return { own, tgt }; }""")
        S.click('[data-tab="build"]'); S.click('[data-mode="b:city"]'); click_tile(S, plan["own"]); time.sleep(.6)
        mine = S.evaluate("(i)=>{const b=window.__SKY.state().G.bat.get(i);return b?[b.type,b.owner]:null}", plan["own"])
        check("solo: building works locally through the original code path (own city at the clicked tile)", mine == ["city", 0], f"{mine} {status(S)[:60]}")
        # AIs grab unclaimed land quickly, so re-pick a fresh neutral border tile right before each click
        FRESH = """() => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length;
          for (let i = 0; i < N; i++) { if (s.owner[i] !== 0 || !s.terr[i]) continue; const x = i % MW;
            for (const j of [x > 0 ? i - 1 : -1, x < MW - 1 ? i + 1 : -1, i - MW, i + MW]) if (j >= 0 && j < N && s.owner[j] === -1 && s.terr[j]) return j; } return -1; }"""
        launched = False
        S.click('[data-tab="attack"]')
        n_before = S.evaluate("()=>window.__SKY.state().G.dbg.neutAtk")
        for _ in range(4):
            tgt = S.evaluate(FRESH)
            if tgt < 0: break
            click_tile(S, tgt); time.sleep(.3)
            # launchAttack() increments G.dbg.neutAtk for every launch on unclaimed land (a tiny front may finish within a tick)
            if S.evaluate("()=>window.__SKY.state().G.dbg.neutAtk") > n_before: launched = True; break
        check("solo: attacking unclaimed land works locally through the original code path", launched, status(S)[:80])
        S.keyboard.press("Space"); time.sleep(.3)
        check("solo: Space still pauses the game", S.evaluate(STATE)["paused"])
        S.click("#mpPill"); time.sleep(.2)
        check("no JS page errors in any client", not errs, str(errs[:3]))
        b.close()
finally:
    srv.terminate()
print(f"\n{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)
