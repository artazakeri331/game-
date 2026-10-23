"""Stage 2 lobby regression (browser). Usage: python3 test/stage2_lobby.py http://localhost:PORT/  (server started with GRACE_MS=3000)"""
import sys, time
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
results = []
def check(name, cond, extra=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

def names(p):
    return p.eval_on_selector_all("#mpList li .nm", "els=>els.map(e=>e.textContent)")
def tags(p):
    return p.eval_on_selector_all("#mpList li", "els=>els.map(e=>[...e.querySelectorAll('.tag')].map(t=>t.textContent).join('+'))")

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"]) \
        if False else pw.chromium.launch(args=["--no-sandbox"])
    errs = []
    def mk(label):
        ctx = b.new_context(permissions=["clipboard-read", "clipboard-write"])
        p = ctx.new_page()
        p.on("pageerror", lambda e: errs.append(f"{label}: {e}"))
        p.goto(URL)
        p.wait_for_selector("#mpStatus.ok", timeout=15000)
        return ctx, p

    ctxA, A = mk("A"); ctxB, B = mk("B"); ctxC, C = mk("C")
    check("lobby overlay visible on load, status Connected", A.is_visible("#mpOv") and A.inner_text("#mpStatus") == "Connected")

    # errors
    B.fill("#mpJoinCode", "ab"); B.click("#mpJoin")
    B.wait_for_function("document.getElementById('mpMsg').textContent.length>0")
    check("invalid code error", "valid 5-character" in B.inner_text("#mpMsg"), B.inner_text("#mpMsg"))
    B.fill("#mpJoinCode", "ZZZZZ"); B.click("#mpJoin")
    B.wait_for_function("document.getElementById('mpMsg').textContent.includes('not found')")
    check("room-not-found error", "Room not found" in B.inner_text("#mpMsg"))

    # create + join
    A.fill("#mpName", "Alice"); A.click("#mpCreate")
    A.wait_for_selector("#mpRoom:not([hidden])")
    code = A.inner_text("#mpCode")
    check("room code is 5 chars", len(code) == 5 and code.isalnum(), code)
    B.fill("#mpName", "Bob"); B.fill("#mpJoinCode", code.lower()); B.click("#mpJoin")
    B.wait_for_selector("#mpRoom:not([hidden])")
    A.wait_for_function("document.querySelectorAll('#mpList li').length==2")
    check("A sees both players", names(A) == ["Alice", "Bob"], str(names(A)))
    check("B sees both players", names(B) == ["Alice", "Bob"], str(names(B)))
    check("host/you tags", tags(A) == ["HOST+YOU", ""] and tags(B) == ["HOST", "YOU"], f"{tags(A)} {tags(B)}")
    check("counter shows 2/8", "2/8" in A.inner_text("#mpCount"))

    # duplicate name
    D_ctx, D = mk("D"); D.fill("#mpName", "Bob"); D.fill("#mpJoinCode", code); D.click("#mpJoin")
    D.wait_for_selector("#mpRoom:not([hidden])")
    check("duplicate name made unique", names(D)[-1] == "Bob 2", str(names(D)))
    D.click("#mpLeave"); A.wait_for_function("document.querySelectorAll('#mpList li').length==2")

    # isolation
    C.fill("#mpName", "Carol"); C.click("#mpCreate"); C.wait_for_selector("#mpRoom:not([hidden])")
    codeC = C.inner_text("#mpCode")
    check("second room has different code & isolated list", codeC != code and names(C) == ["Carol"] and names(A) == ["Alice", "Bob"], f"{codeC} {names(C)} {names(A)}")

    # leave
    B.click("#mpLeave")
    A.wait_for_function("document.querySelectorAll('#mpList li').length==1")
    check("leave updates other client", names(A) == ["Alice"])
    check("leaver returns to home view", B.is_visible("#mpHome"))

    # rejoin after reload (sessionStorage token)
    B.fill("#mpJoinCode", code); B.click("#mpJoin"); B.wait_for_selector("#mpRoom:not([hidden])")
    B.reload(); B.wait_for_selector("#mpStatus.ok")
    B.wait_for_function("!document.getElementById('mpRoom').hidden", timeout=8000)
    time.sleep(.5)
    check("reload -> auto rejoin same room, same seat", B.inner_text("#mpCode") == code and names(B).count("Bob") == 1 and len(names(B)) == 2, f"{names(B)}")

    # disconnect: OFFLINE tag, then removed after grace (3s in this test)
    ctxB.set_offline(True)
    try:
        A.wait_for_function("[...document.querySelectorAll('#mpList .tag.off')].length==1", timeout=40000)
        saw_off = True
    except Exception:
        saw_off = False
    ctxB.set_offline(False)
    # set_offline doesn't always kill an open websocket; fall back to closing the page
    if not saw_off:
        B.close()
        A.wait_for_function("[...document.querySelectorAll('#mpList .tag.off')].length==1", timeout=15000)
        saw_off = True
    check("disconnect shows OFFLINE to others", saw_off)
    A.wait_for_function("document.querySelectorAll('#mpList li').length==1", timeout=15000)
    check("seat removed after grace period", names(A) == ["Alice"])

    # reconnect within grace
    ctxE, E = mk("E"); E.fill("#mpName", "Eve"); E.fill("#mpJoinCode", code); E.click("#mpJoin"); E.wait_for_selector("#mpRoom:not([hidden])")
    sess = E.evaluate("sessionStorage.getItem('skyfrontMpSession')")
    # Pre-load the replacement tab BEFORE the old one closes, so only a reload happens inside the 3 s grace window
    # (two full page loads in 3 s is racy on slower machines; the assertion itself is unchanged).
    F = ctxE.new_page(); F.on("pageerror", lambda e: errs.append(f"F: {e}")); F.goto(URL); F.wait_for_selector("#mpStatus.ok", timeout=15000)
    E.close()
    A.wait_for_function("document.querySelectorAll('#mpList .tag.off').length==1")
    F.evaluate("s=>sessionStorage.setItem('skyfrontMpSession',s)", sess); F.reload()
    F.wait_for_function("!document.getElementById('mpRoom').hidden", timeout=10000)
    time.sleep(.3)
    check("reconnect within grace keeps seat", names(A).count("Eve") == 1 and not A.query_selector("#mpList .tag.off"), str(names(A)))

    # capacity: 8 max
    res = A.evaluate("""async (code)=>{
      const out=[];
      for(let i=0;i<8;i++){
        const s=io({forceNew:true});
        await new Promise(r=>s.on('connect',r));
        out.push(await new Promise(r=>s.emit('join-room',{code,name:'Bot'+i},r)));
      }
      return out.map(r=>r.success?'ok':r.message);
    }""", code)
    check("room caps at 8 players with clear error", res[:6].count("ok") == 6 and all("full" in m for m in res[6:]), str(res))

    # Play Solo + original game intact
    G_ctx, G = mk("G"); G.click("#mpSolo")
    check("Play Solo hides lobby", not G.is_visible("#mpOv"))
    check("multiplayer pill available after closing", G.is_visible("#mpPill"))
    G.click("#randomSpawn"); time.sleep(2)
    hud = G.inner_text("#hud")
    check("solo game starts (HUD populated, canvas present)", len(hud) > 10 and G.query_selector("canvas") is not None, hud[:80])

    # file:// without server: solo must still work
    H = b.new_context().new_page(); H.on("pageerror", lambda e: errs.append(f"H: {e}"))
    H.goto(__import__("pathlib").Path(__file__).resolve().parent.parent.joinpath("Skyfront.html").as_uri()); time.sleep(1)
    check("opened without server: clear notice, Create disabled", "unavailable" in H.inner_text("#mpStatus") and H.is_disabled("#mpCreate"))
    H.click("#mpSolo"); H.click("#randomSpawn"); time.sleep(1.5)
    check("solo works without server", len(H.inner_text("#hud")) > 10)

    check("no JS page errors", not errs, str(errs[:3]))
    b.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
