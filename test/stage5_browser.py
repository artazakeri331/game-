"""Stage 5 browser test: three real Chromium clients in one room, real clicks. Run: python3 test/stage5_browser.py"""
import subprocess, sys, time, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = "3293"; URL = f"http://localhost:{PORT}/"
results = []
def check(name, cond, extra=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

STATE = """() => { const s = window.__SKY.state(); return { t: s.G.t, phase: s.G.phase, over: !!s.G.over, seed: s.seed }; }"""
PAIR = """() => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length; let out = null;
  for (let i = 0; i < N - 1 && !out; i++) { const a = s.owner[i], b = s.owner[i + 1];
    if (a < 1 || b < 1 || a === b || !s.terr[i] || !s.terr[i + 1]) continue;
    const A = s.G.nations[a], B = s.G.nations[b]; if (!A.alive || !B.alive || A.tiles < 100 || B.tiles < 100) continue;
    out = { a, b, tgt: i + 1, an: A.name, bn: B.name }; }
  return out; }"""
OWN = """(id) => { const S = window.__SKY, s = S.state(); for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === id && s.terr[i] === 1 && !s.G.bat.has(i)) return i; return -1; }"""
THIRD = """(skip) => { const s = window.__SKY.state(); const n = s.G.nations.find(n => n.id >= 1 && n.alive && n.tiles >= 100 && !skip.includes(n.id)); return n ? { id: n.id, name: n.name } : null; }"""
ADJ = """([a, b]) => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length;
  for (let i = 0; i < N; i++) { if (s.owner[i] !== b || !s.terr[i]) continue; const x = i % MW;
    for (const j of [x > 0 ? i - 1 : -1, x < MW - 1 ? i + 1 : -1, i - MW, i + MW]) if (j >= 0 && j < N && s.owner[j] === a) return i; } return -1; }"""
FAR = """([from, id]) => { const S = window.__SKY, s = S.state(), MW = S.MW; const fx = from % MW, fy = (from / MW) | 0; let best = -1, bd = -1;
  for (let i = 0; i < s.owner.length; i += 7) { if (s.owner[i] !== id || !s.terr[i]) continue; const d = Math.hypot(i % MW - fx, ((i / MW) | 0) - fy); if (d > bd) { bd = d; best = i; } } return best; }"""
CENTER = """(i) => { const S = window.__SKY, c = S.state().cam, r = document.getElementById('cv').getBoundingClientRect(), MW = S.MW;
  c.z = 6; const x = i % MW, y = (i / MW) | 0; c.x = x + .5 - r.width / c.z / 2; c.y = y + .5 - r.height / c.z / 2; }"""
SCREEN = """(i) => { const S = window.__SKY, c = S.state().cam, r = document.getElementById('cv').getBoundingClientRect(), MW = S.MW;
  const x = i % MW, y = (i / MW) | 0; return { x: r.left + (x + .5 - c.x) * c.z, y: r.top + (y + .5 - c.y) * c.z }; }"""
REL = """([a, b, f]) => { const S = window.__SKY, r = S.state().REL; return r[f][a * S.NCOUNT + b]; }"""
NAT = """([id, f]) => window.__SKY.state().G.nations[id][f]"""

def click_tile(p, i):
    p.evaluate(CENTER, i); time.sleep(.25)
    pt = p.evaluate(SCREEN, i); p.mouse.click(pt["x"], pt["y"]); time.sleep(.15)
def status(p): return p.inner_text("#statusLine")
def wait_status(p, text, timeout=6000):
    try: p.wait_for_function("t => document.getElementById('statusLine').textContent.includes(t)", arg=text, timeout=timeout); return True
    except Exception: return False
def until(fn, timeout=8.0, step=.15):
    t = time.time()
    while time.time() - t < timeout:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(step)
    return False

WIPE = """
const { io } = require('socket.io-client');
const s = io(process.argv[1], { forceNew: true, reconnection: false });
s.on('connect', () => s.emit('join-room', { code: process.argv[2], name: 'Zed' }, r => {
  if (!r.success) { console.log('JOIN FAIL', r.message); process.exit(2); }
  s.emit('test-wipe', { nation: Number(process.argv[3]) }, () => { console.log('wiped'); setTimeout(() => process.exit(0), 200); });
}));
"""
def wipe(code, nation):
    out = subprocess.run(["node", "-e", WIPE, f"http://localhost:{PORT}", code, str(nation)], cwd=ROOT, capture_output=True, text=True, timeout=30)
    return "wiped" in out.stdout

srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": PORT, "GRACE_MS": "60000", "MAX_WORLDS": "6", "MAX_RUNNING_GAMES": "3", "SKYFRONT_TEST": "1"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
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
        C = mk("C"); C.fill("#mpName", "Cleo"); C.fill("#mpJoinCode", code); C.click("#mpJoin"); C.wait_for_selector("#mpRoom:not([hidden])")
        A.click("#mpMakeWorld"); [ready(p) for p in (A, B, C)]
        pr = A.evaluate(PAIR); na, nb = pr["a"], pr["b"]
        third = A.evaluate(THIRD, [na, nb]); nc = third["id"]
        for p in (A, B, C): p.click("#mpClose")
        click_tile(A, A.evaluate(OWN, na)); time.sleep(.5)
        click_tile(B, B.evaluate(OWN, nb)); time.sleep(.5)
        click_tile(C, C.evaluate(OWN, nc)); time.sleep(.5)
        check("three players claim three different countries by clicking the map", all(f"You lead" in status(p) for p in (A, B, C)), [status(p)[:50] for p in (A, B, C)])
        A.click("#mpPill"); A.wait_for_selector("#mpRoom:not([hidden])"); A.click("#mpStart")
        for p in (B, C): p.click("#mpPill")
        for p in (A, B, C): p.wait_for_function("document.getElementById('mpWorld').textContent.includes('Game in progress')", timeout=15000)
        for p in (A, B, C): p.click("#mpClose")
        time.sleep(1.0)
        check("everyone sees every human player's name next to their country in the standings",
              all(all(n in p.inner_text("#standings") for n in ("Alice", "Bob", "Cleo")) for p in (A, B, C)), A.inner_text("#standings")[:200])

        # ---- diplomacy through the real panel ----
        A.click("#dipBtn"); time.sleep(.5)
        row = f'#dipList .drow:has(button[data-dip="war"][data-t="{nb}"])'
        check("diplomacy panel labels the other human with the player's name", "(Bob)" in A.inner_text(row), A.inner_text(row)[:120])
        check("the game keeps running while the diplomacy panel is open (never paused locally)", A.evaluate("()=>!window.__SKY.state().G.paused"))
        if A.evaluate(REL, [na, nb, "treaty"]):                         # the game presets some real-world alliances
            A.click(f'button[data-dip="end"][data-t="{nb}"]'); time.sleep(.8)
        wbtn = f'button[data-dip="war"][data-t="{nb}"]'
        A.click(wbtn); time.sleep(.2); A.click(wbtn)                    # first click asks for confirmation
        check("A declares war on Bob; the server applies it for both nations", until(lambda: A.evaluate(REL, [na, nb, "war"]) == 1 and A.evaluate(REL, [nb, na, "war"]) == 1), A.inner_text("#dipMsg"))
        check("B's client receives the war (relationship, HUD chip)", until(lambda: B.evaluate(REL, [na, nb, "war"]) == 1) and until(lambda: "At war" in B.inner_text("#hud")))
        check("C (uninvolved) also sees the war", until(lambda: C.evaluate(REL, [na, nb, "war"]) == 1))
        LOGCOUNT = "([a, b]) => window.__SKY.state().G.log.filter(l => l.text.includes(a + ' declared war on ' + b)).length"
        check("war news is in everyone's log exactly once", all(p.evaluate(LOGCOUNT, [pr["an"], pr["bn"]]) == 1 for p in (A, B, C)), [p.evaluate(LOGCOUNT, [pr["an"], pr["bn"]]) for p in (A, B, C)])
        A.click("#dipClose")
        A.click('[data-tab="attack"]')
        click_tile(A, pr["tgt"])
        check("A can attack B's land now (Stage 4 attack, server-validated)", wait_status(A, "Attack launched"), status(A)[:80])

        # ---- economy ----
        A.click('[data-tab="economy"]'); A.fill("#tax", "40"); time.sleep(.2)
        check("tax change is applied by the server and visible to B", until(lambda: B.evaluate(NAT, [na, "tax"]) == 0.4) and A.evaluate(NAT, [na, "tax"]) == 0.4, f"A sees {A.evaluate(NAT, [na, 'tax'])}, B sees {B.evaluate(NAT, [na, 'tax'])}, status {status(A)[:60]}")

        # ---- military ----
        A.click('[data-tab="troops"]'); A.click('[data-mode="t:small"]'); time.sleep(.8)
        check("recruiting is answered by the server (not 'not available')", "Not available" not in status(A) and len(status(A)) > 3, status(A)[:80])
        A.click('[data-tab="build"]'); A.click('[data-mode="b:silo"]'); own = A.evaluate(OWN, na)
        built = False
        for _ in range(30):
            click_tile(A, own); built = wait_status(A, "Missile silo built", 800)
            if built: break
            time.sleep(1)
        check("A builds a missile silo (economy gates it on real gold)", built, status(A)[:80])
        far = A.evaluate(FAR, [own, nb])
        A.click('[data-tab="missile"]'); A.click('[data-mode="m:cruise"]')
        fired = False
        for _ in range(40):
            click_tile(A, far); fired = wait_status(A, "Cruise launched", 800)
            if fired: break
            time.sleep(1)
        check("A launches a cruise missile at Bob (server checks silo, gold, war)", fired, status(A)[:80])
        seen = {}
        for name, p in (("A", A), ("B", B), ("C", C)):
            seen[name] = until(lambda: p.evaluate("()=>window.__SKY.state().G.missiles.length") > 0, 4, .05)
        check("the missile is a synced projectile that every client sees in flight", all(seen.values()), str(seen))
        check("and it disappears again for everyone when it lands or is shot down", all(until(lambda p=p: p.evaluate("()=>window.__SKY.state().G.missiles.filter(m=>m.owner===%d).length" % na) == 0, 20) for p in (A, B, C)))
        check("the launch is in the news for B", until(lambda: "launched a Cruise" in B.evaluate("()=>window.__SKY.state().G.news.map(n=>n.text).join('|')")))
        # an ally-less third player cannot be bombed without war: C is not at war with A -> war prompt, never a silent failure
        A.click('[data-mode="m:cruise"]'); cown = A.evaluate(FAR, [own, nc])
        click_tile(A, cown); time.sleep(.8)
        check("firing at a nation you are not at war with opens the war prompt", A.is_visible("#warPrompt"), status(A)[:80])
        A.click("#wpNo")

        # ---- peace offer: B proposes, A accepts through the offer banner ----
        B.click("#dipBtn"); time.sleep(.4)
        B.click(f'button[data-dip="peace"][data-t="{na}"]'); time.sleep(.4)
        check("B's peace offer is accepted by the server as an offer (not applied yet)", "offer" in B.inner_text("#dipMsg").lower() and B.evaluate(REL, [na, nb, "war"]) == 1, B.inner_text("#dipMsg"))
        B.click("#dipClose")
        check("A sees a diplomatic offer banner naming Bob", until(lambda: A.is_visible("#offerBar") and "Bob" in A.inner_text("#offerText")), A.inner_text("#offerText"))
        A.click("#offerYes")
        check("A accepts: war ends for everyone (ceasefire)", until(lambda: all(p.evaluate(REL, [na, nb, "war"]) == 0 for p in (A, B, C))) and A.evaluate(REL, [na, nb, "truce"]) > 0)
        check("the banner disappears everywhere", until(lambda: not A.is_visible("#offerBar") and not B.is_visible("#offerBar")))
        A.click('[data-tab="attack"]'); fronts = A.evaluate(ADJ, [na, nb]); click_tile(A, fronts if fronts >= 0 else pr["tgt"]); time.sleep(.6)
        check("during the ceasefire an attack on Bob is refused (war prompt, no troops spent)", A.is_visible("#warPrompt") and "ceasefire" in A.inner_text("#wpText").lower(), A.inner_text("#wpText")[:80] + " | " + json.dumps(A.evaluate("([a,b,t])=>{const S=window.__SKY,s=S.state(),k=a*S.NCOUNT+b;return {treaty:s.REL.treaty[k],truce:s.REL.truce[k],t:s.G.t,owner:s.owner[t],b}}", [na, nb, pr["tgt"]])))
        A.click("#wpNo")

        # ---- elimination / spectating / game over ----
        t0 = B.evaluate(STATE)["t"]
        check("test hook wipes Bob's land", wipe(code, nb))
        check("Bob is eliminated: spectator banner appears for him", until(lambda: B.is_visible("#specBar"), 10), "")
        check("the game goes on for the others (not over: Alice and Cleo are alive)", not A.evaluate(STATE)["over"] and not C.evaluate(STATE)["over"])
        check("the eliminated player's order buttons are disabled", B.is_disabled('[data-mode="t:small"]') if B.is_visible('[data-mode="t:small"]') else True)
        B.click('[data-tab="attack"]'); click_tile(B, pr["tgt"]); time.sleep(.8)
        check("the eliminated player cannot act (server says the nation has fallen)", "fallen" in status(B).lower(), status(B)[:80])
        time.sleep(1.5)
        check("the spectator keeps receiving live updates", B.evaluate(STATE)["t"] > t0 + 1.5)
        check("the defeat is announced to the others", until(lambda: "has fallen" in A.inner_text("#log") or "has fallen" in C.inner_text("#log")), A.inner_text("#log")[:150])
        check("test hook wipes Cleo's land", wipe(code, nc))
        for p in (A, B, C): p.wait_for_function("document.getElementById('overlay').textContent.length>0 && !document.getElementById('overlay').hidden", timeout=15000)
        check("game over: Alice sees Victory, Bob and Cleo see Defeat", "victory" in A.inner_text("#overlay").lower() and "defeat" in B.inner_text("#overlay").lower() and "defeat" in C.inner_text("#overlay").lower(), [p.inner_text("#overlay")[:40] for p in (A, B, C)])
        check("only the host gets the 'New game' button; others wait", A.is_enabled("#againBtn") and B.is_disabled("#againBtn"))
        B.click("#viewBtn"); check("defeated players can close the end screen and keep looking at the map", not B.is_visible("#overlay"))
        A.click("#againBtn"); A.click("#mpPill") if not A.is_visible("#mpRoom") else None
        check("host starts a new game in the same room: a new world is built and loaded", until(lambda: "World ready" in A.inner_text("#mpWorld"), 90) and all(until(lambda p=p: "World ready" in p.inner_text("#mpWorld") or p.evaluate(STATE)["phase"] == "spawn", 60) for p in (B, C)))
        check("the end screen is gone and countries are free again", not A.is_visible("#overlay") and A.evaluate("()=>window.__SKY.state().G.phase")=="spawn")

        # ---- solo regression (original click paths) ----
        S = mk("S"); S.click("#mpSolo"); time.sleep(.3)
        pick = S.evaluate("""() => { const S = window.__SKY, s = S.state(); const n = s.G.nations.find(n => n.id >= 1 && n.alive && n.tiles >= 100); for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === n.id && s.terr[i]) return i; }""")
        click_tile(S, pick); time.sleep(1.2)
        st = S.evaluate("()=>{const s=window.__SKY.state();return {phase:s.G.phase,alive:s.G.nations[0].alive,t:s.G.t}}")
        check("solo: spawning works through the original path", st["phase"] == "play" and st["alive"], str(st))
        S.click("#dipBtn"); time.sleep(.4)
        check("solo: opening Diplomacy still pauses the game (original behavior)", S.evaluate("()=>window.__SKY.state().G.paused"))
        ai = S.evaluate("() => { const s = window.__SKY.state(); const n = s.G.nations.find(n => n.id >= 1 && n.alive && !s.REL.treaty[n.id] && !s.REL.war[n.id]); return n ? n.id : -1 }")
        wb = f'button[data-dip="war"][data-t="{ai}"]'
        S.click(wb); time.sleep(.2); S.click(wb); time.sleep(.4)
        check("solo: declaring war on an AI nation works locally (declareWar)", S.evaluate(REL, [0, ai, "war"]) == 1, S.inner_text("#dipMsg"))
        S.click(f'button[data-dip="peace"][data-t="{ai}"]'); time.sleep(.4)
        check("solo: proposing peace to an AI nation still gets the AI's own answer", len(S.inner_text("#dipMsg")) > 10, S.inner_text("#dipMsg"))
        S.click("#dipClose"); time.sleep(.3)
        t1 = S.evaluate(STATE)["t"]; time.sleep(2.2)
        check("solo: closing the panel resumes the local simulation", S.evaluate(STATE)["t"] > t1 + 1.0)
        S.click('[data-tab="troops"]'); S.click('[data-mode="t:small"]'); time.sleep(.3)
        lg = S.evaluate("()=>window.__SKY.state().G.log.slice(0,3).map(l=>l.text)")
        check("solo: recruiting still runs locally (original recruit() logs it, or reports the troop cap)", any(x.startswith("Recruited") for x in lg) or "Troop cap" in status(S), f"{lg} {status(S)[:60]}")
        check("no JS page errors in any client", not errs, str(errs[:3]))
        b.close()
finally:
    srv.terminate()
print(f"\n{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)
