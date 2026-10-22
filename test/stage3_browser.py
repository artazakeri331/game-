"""Stage 3 browser test: real Chromium clients, real map clicks. Run: python3 test/stage3_browser.py"""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = "3241"; URL = f"http://localhost:{PORT}/"
results = []
def check(name, cond, extra=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

FP = """() => { const s = window.__SKY.state(); let h = 2166136261;
  const mix = a => { for (let i = 0; i < a.length; i += 7) { h ^= (a[i] & 255); h = Math.imul(h, 16777619) >>> 0; } };
  mix(s.terr); mix(s.owner);
  const ns = s.G.nations.map(n => [n.id, n.name, n.troops, n.gold, n.tiles, Array.from(n.tens).slice(0, 3)]);
  return { seed: s.seed, h, nat: JSON.stringify(ns), phase: s.G.phase, n0alive: s.G.nations[0].alive, blds: s.G.blds.length }; }"""
CLICK_POINT = """(k) => { const s = window.__SKY.state(), MW = window.__SKY.MW, n = s.G.nations[k];
  let best = -1, bd = 1e18; for (let i = 0; i < s.owner.length; i++) if (s.owner[i] === k) { const d = (i % MW - n.cx) ** 2 + (((i / MW) | 0) - n.cy) ** 2; if (d < bd) { bd = d; best = i; } }
  const r = document.getElementById('cv').getBoundingClientRect(), c = s.cam;
  return { x: r.left + (best % MW + .5 - c.x) * c.z, y: r.top + (((best / MW) | 0) + .5 - c.y) * c.z, name: n.name }; }"""

srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": PORT, "GRACE_MS": "60000"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"]); errs = []
        def mk(label, url=URL):
            p = b.new_context(viewport={"width": 1280, "height": 720}).new_page()
            p.on("pageerror", lambda e: errs.append(f"{label}: {e}")); p.goto(url)
            p.wait_for_selector("#mpStatus.ok", timeout=20000); return p
        world_ready = lambda p, t=120000: p.wait_for_function("document.getElementById('mpWorld').textContent.startsWith('World ready')", timeout=t)

        A = mk("A"); A.fill("#mpName", "Alice"); A.click("#mpCreate"); A.wait_for_selector("#mpRoom:not([hidden])")
        code = A.inner_text("#mpCode")
        B = mk("B"); B.fill("#mpName", "Bob"); B.fill("#mpJoinCode", code); B.click("#mpJoin"); B.wait_for_selector("#mpRoom:not([hidden])")
        check("host sees Create World, guest does not", A.is_visible("#mpMakeWorld") and not B.is_visible("#mpMakeWorld"))
        check("guest told to wait for host", "Waiting for the host" in B.inner_text("#mpWorld"))

        A.click("#mpMakeWorld")
        B.wait_for_function("document.getElementById('mpWorld').textContent.startsWith('Generating')", timeout=10000)
        check("guest sees 'Generating' while world builds", True)
        world_ready(A); world_ready(B)
        fa, fb = A.evaluate(FP), B.evaluate(FP)
        check("A and B load the identical world (seed, map hash, all 48 nations)", fa == fb and fa["seed"] > 0, f"{fa['seed']} {fb['seed']} {fa['h']} {fb['h']}")
        check("loaded world is the server's room world", str(fa["seed"]) in A.inner_text("#mpWorld"))

        # late joiner (world already exists)
        C = mk("C"); C.fill("#mpName", "Carol"); C.fill("#mpJoinCode", code); C.click("#mpJoin"); C.wait_for_selector("#mpRoom:not([hidden])"); world_ready(C, 30000)
        fc = C.evaluate(FP)
        check("late joiner receives the same world", fc == fa)

        # other room is a different world
        X = mk("X"); X.fill("#mpName", "Xena"); X.click("#mpCreate"); X.wait_for_selector("#mpRoom:not([hidden])"); X.click("#mpMakeWorld"); world_ready(X)
        fx = X.evaluate(FP)
        check("a different room gets a different world", fx["seed"] != fa["seed"] and fx["h"] != fa["h"], f"{fx['seed']} vs {fa['seed']}")

        # real click-to-claim on the map
        A.click("#mpClose"); B.click("#mpClose")
        k = next(i for i in range(1, 48) if A.evaluate("(k)=>{const n=window.__SKY.state().G.nations[k];return n.alive&&n.tiles>=100}", i))
        pt = A.evaluate(CLICK_POINT, k)
        A.mouse.click(pt["x"], pt["y"]); time.sleep(.8)
        check("A's map click claims the country", f"You lead {pt['name']}" in A.inner_text("#statusLine"), A.inner_text("#statusLine")[:120])
        fa2 = A.evaluate(FP)
        check("claim does not alter the shared world (still spawn phase, map unchanged, nation 0 untouched)", fa2["phase"] == "spawn" and not fa2["n0alive"] and fa2["h"] == fa["h"] and fa2["nat"] == fa["nat"])
        B.click("#mpPill"); B.wait_for_selector("#mpRoom:not([hidden])")
        B.wait_for_function("[...document.querySelectorAll('#mpList .nat')].some(e=>e.textContent===%r)" % pt["name"], timeout=5000)
        check("B's player list shows Alice's country", True)
        B.click("#mpClose"); B.mouse.click(pt["x"], pt["y"]); time.sleep(.8)
        stat = B.inner_text("#statusLine")
        check("B cannot take Alice's country (clear message)", "already led by Alice" in stat, stat[:120])
        check("B's own game state untouched by the rejected claim", B.evaluate(FP)["h"] == fa["h"] and not B.evaluate(FP)["n0alive"])

        # random claim button
        C.click("#mpClose"); C.click("#randomSpawn"); time.sleep(.8)
        check("random-pick button claims a free country for C", "You lead" in C.inner_text("#statusLine"), C.inner_text("#statusLine")[:100])

        # reload keeps seat, claim and world
        A.reload(); A.wait_for_selector("#mpStatus.ok"); world_ready(A, 30000)
        A.wait_for_function("[...document.querySelectorAll('#mpList .nat')].some(e=>e.textContent===%r)" % pt["name"], timeout=5000)
        check("after reload: same room, claim kept, same world re-downloaded", A.evaluate(FP)["h"] == fa["h"] and A.inner_text("#mpCode") == code)

        # leave -> original solo game still works
        B.click("#mpPill"); B.click("#mpLeave"); time.sleep(.5)
        B.click("#mpSolo") if B.is_visible("#mpSolo") else None
        B.wait_for_function("window.__SKY.state().G.phase==='spawn'", timeout=60000)
        sb = B.evaluate(FP)
        check("after leaving, B is back on a fresh solo world", sb["h"] != fa["h"] or sb["seed"] != fa["seed"])
        B.click("#randomSpawn"); time.sleep(1.5)
        check("solo spawn runs the original game logic (phase=play, nation 0 alive, HUD filled)", B.evaluate(FP)["phase"] == "play" and B.evaluate(FP)["n0alive"] and len(B.inner_text("#hud")) > 10)

        # never-touched solo page
        S = mk("S"); S.click("#mpSolo"); S.click("#randomSpawn"); time.sleep(1.5)
        check("pure solo (never joined a room) unchanged", S.evaluate(FP)["phase"] == "play" and S.evaluate(FP)["n0alive"])
        check("no JS page errors in any client", not errs, str(errs[:3]))
        b.close()
finally:
    srv.terminate()
print(f"\n{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)
