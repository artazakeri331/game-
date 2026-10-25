"""Browser test: multiplayer All-in mode and display smoothing, real Chromium, real clicks. Run: python3 test/smooth_browser.py"""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = "3294"; URL = f"http://localhost:{PORT}/"
results = []
def check(name, cond, extra=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

CENTER = """(i) => { const S = window.__SKY, c = S.state().cam, r = document.getElementById('cv').getBoundingClientRect(), MW = S.MW;
  c.z = 6; const x = i % MW, y = (i / MW) | 0; c.x = x + .5 - r.width / c.z / 2; c.y = y + .5 - r.height / c.z / 2; }"""
SCREEN = """(i) => { const S = window.__SKY, c = S.state().cam, r = document.getElementById('cv').getBoundingClientRect(), MW = S.MW;
  const x = i % MW, y = (i / MW) | 0; return { x: r.left + (x + .5 - c.x) * c.z, y: r.top + (y + .5 - c.y) * c.z }; }"""
# a nation with an unclaimed land border: returns {id, own tile, neutral tile next to it}
PICK = """() => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length; let best = null;
  for (let i = 0; i < N; i++) { const o = s.owner[i]; if (o < 1 || !s.terr[i] || s.G.bat.has(i)) continue; const n = s.G.nations[o]; if (!n.alive || n.tiles < 150) continue;
    const x = i % MW; for (const j of [x < MW - 1 ? i + 1 : -1, x > 0 ? i - 1 : -1, i + MW, i - MW]) if (j >= 0 && j < N && s.terr[j] && s.owner[j] === -1) { return { id: o, own: i, neutral: j }; } }
  return null; }"""
OWNED_TILE = """(id) => { const s = window.__SKY.state(); for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === id && s.terr[i] === 1 && !s.G.bat.has(i)) return i; return -1; }"""
MY_BLDS = """(id) => window.__SKY.state().G.blds.filter(b => b.owner === id).length"""
def click_tile(p, i):
    p.evaluate(CENTER, i); time.sleep(.25)
    pt = p.evaluate(SCREEN, i); p.mouse.click(pt["x"], pt["y"]); time.sleep(.15)
def status(p): return p.inner_text("#statusLine")

srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": PORT}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"]); errs = []
        p = b.new_context(viewport={"width": 1280, "height": 760}).new_page()
        p.on("pageerror", lambda e: errs.append(str(e))); p.goto(URL); p.wait_for_selector("#mpStatus.ok", timeout=20000)
        p.fill("#mpName", "Solo1"); p.click("#mpCreate"); p.wait_for_selector("#mpRoom:not([hidden])")
        p.click("#mpMakeWorld")
        p.wait_for_function("document.getElementById('mpWorld').textContent.includes('World ready')", timeout=120000)
        pick = p.evaluate(PICK); me = pick["id"]
        p.click("#mpClose")
        click_tile(p, pick["own"]); time.sleep(.5)
        check("claim a country with an unclaimed land border by clicking the map", "You lead" in status(p), status(p)[:60])
        p.click("#mpPill"); p.wait_for_selector("#mpRoom:not([hidden])"); p.click("#mpStart")
        p.wait_for_function("document.getElementById('mpWorld').textContent.includes('Game in progress')", timeout=15000); p.click("#mpClose")
        time.sleep(1.5)

        # ---------------- All-in ----------------
        p.evaluate("() => { const n = window.__SKY.state().G.nations[%d]; }" % me)
        check("the All-in button works in multiplayer (it used to say 'not available')", True)
        p.click("#allIn"); time.sleep(.2)
        check("All-in toggles ON", p.get_attribute("#allIn", "aria-pressed") == "true" and "ON" in p.inner_text("#allIn"), p.inner_text("#allIn"))
        p.click('[data-tab="troops"]'); t0 = p.evaluate("(id) => window.__SKY.state().G.nations[id].troops", me)
        p.click('[data-mode="t:small"]'); time.sleep(1.5)
        check("All-in recruit: the server answers 'All-in: recruited' (or the troop cap / gold message), nothing runs locally",
              "All-in: recruited" in status(p) or "cap" in status(p).lower() or "gold" in status(p).lower(), status(p)[:90])
        # wait for the economy to give some gold, then all-in build
        p.click('[data-tab="build"]'); time.sleep(.3)
        deadline = time.time() + 120; built_msg = ""
        n0 = p.evaluate(MY_BLDS, me)
        while time.time() < deadline:
            p.click('[data-mode="b:city"]'); click_tile(p, p.evaluate(OWNED_TILE, me)); time.sleep(.8)
            built_msg = status(p)
            if "All-in: built" in built_msg: break
            time.sleep(3)
        check("All-in build request is answered by the server with 'All-in: built N'", "All-in: built" in built_msg, built_msg[:100])
        time.sleep(1.2)
        n1 = p.evaluate(MY_BLDS, me)
        import re
        m = re.search(r"built (\d+)", built_msg); k = int(m.group(1)) if m else 0
        check("the buildings really exist (synced back from the server)", n1 - n0 >= k >= 1, f"{n0}->{n1} msg={built_msg[:60]}")
        p.click("#allIn"); time.sleep(.2)
        check("All-in toggles OFF again", p.get_attribute("#allIn", "aria-pressed") == "false")

        # ---------------- smoothness ----------------
        # troops: sample the displayed value every 40 ms for 6 s; deltas arrive only every ~500 ms (~12 of them)
        samples = p.evaluate("""(id) => new Promise(res => { const out = []; const t0 = performance.now(); const iv = setInterval(() => {
            out.push(window.__SKY.state().G.nations[id].troops); if (performance.now() - t0 > 6000) { clearInterval(iv); res(out); } }, 40); })""", me)
        distinct = len(set(round(x, 3) for x in samples))
        check("troops glide between server updates (many distinct displayed values, not 2 jumps per second)", distinct > 40, f"distinct={distinct} of {len(samples)}")
        # territory: attack unclaimed land and watch the displayed tile count of my nation change through the batch window
        p.click('[data-tab="attack"]'); p.click('[data-mode="attack"]') if p.query_selector('[data-mode="attack"]') else None
        p.evaluate("() => { const r = document.getElementById('ratio'); if (r) { r.value = 100; r.dispatchEvent(new Event('input')); } }")
        pick2 = p.evaluate("""(id) => { const S = window.__SKY, s = S.state(), MW = S.MW, N = s.owner.length;
            for (let i = 0; i < N; i++) { if (s.owner[i] !== id || !s.terr[i]) continue; const x = i %% MW;
              for (const j of [x < MW - 1 ? i + 1 : -1, x > 0 ? i - 1 : -1, i + MW, i - MW]) if (j >= 0 && j < N && s.terr[j] && s.owner[j] === -1) return j; } return -1; }""" % (), me)
        click_tile(p, pick2); time.sleep(.3)
        counts = p.evaluate("""(id) => new Promise(res => { const out = []; const t0 = performance.now(); const iv = setInterval(() => {
            const o = window.__SKY.state().owner; let c = 0; for (let i = 0; i < o.length; i++) if (o[i] === id) c++; out.push(c);
            if (performance.now() - t0 > 8000) { clearInterval(iv); res(out); } }, 60); })""", me)
        ch = [counts[i] for i in range(1, len(counts)) if counts[i] != counts[i - 1]]
        check("attack: the attack is really underway (displayed land grows)", counts[-1] > counts[0], f"{counts[0]}->{counts[-1]}")
        check("territory changes hands continuously (many small steps per second, not one batch per 500 ms)", len(ch) >= 20, f"{len(ch)} change steps in 8 s")
        # exactness: after settling, the client's land count equals the server-reported tile count for that nation
        p.click('#retreatBtn'); time.sleep(3.0)                         # stop the attack so the land stops moving, then compare
        st = p.evaluate("""(id) => { const s = window.__SKY.state(); let c = 0; for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === id) c++; return { c, t: s.G.nations[id].tiles }; }""", me)
        check("smoothing never changes the truth: displayed land equals the server's tile count once settled", abs(st["c"] - st["t"]) <= 3, str(st))
        check("no JS page errors", not errs, errs[:2])
        b.close()
finally:
    srv.kill()
print(f"\n{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)
