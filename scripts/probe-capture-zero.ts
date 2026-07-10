/**
 * READ-ONLY runtime probe — SINGLE login attempt (avoid re-tripping the target rate limiter).
 * Form-logs in once, waits dynamically until authenticated, then prints items 1-11 on the REAL
 * authenticated app and replicates captureSemanticSnapshot's two extractors inline to show exactly
 * how many elements it would capture. Throwaway diagnostic; does NOT modify production code.
 *
 *   PROBE_USER=<user> PROBE_PASS=<password> npx tsx scripts/probe-capture-zero.ts
 */
import { launchChromiumWithRetry } from '../server/shared/browser';

// All deployment-specific config comes from the environment — nothing hardcoded.
const TARGET_URL = process.env.TARGET_URL || '';
const USER = process.env.PROBE_USER || '';
const PASS = process.env.PROBE_PASS || '';
if (!TARGET_URL || !USER || !PASS) {
  console.error('Set TARGET_URL, PROBE_USER, PROBE_PASS in the environment before running.');
  process.exit(1);
}
const line = () => console.log('─'.repeat(72));

async function main() {
  console.log(`TARGET_URL = ${TARGET_URL}  user=${USER}`);
  const browser = await launchChromiumWithRetry({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  page.setDefaultTimeout(10000);
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    // --- single form login ---
    await page.locator('input[type="email"], input[name="email" i], input[name="username" i], input[id*="user" i]').first().fill(USER, { timeout: 8000 }).catch((e: any) => console.log('fill user err:', e?.message));
    await page.locator('input[type="password"]').first().fill(PASS, { timeout: 8000 }).catch((e: any) => console.log('fill pass err:', e?.message));
    await page.getByRole('button', { name: /log ?in|sign ?in|submit|continue/i }).first().click({ timeout: 8000 }).catch(async () => { await page.locator('input[type="password"]').first().press('Enter').catch(() => {}); });

    const t0 = Date.now();
    const loggedIn = await page.waitForFunction(() => !document.querySelector('input[type="password"]'), { timeout: 45000 }).then(() => true).catch(() => false);
    console.log(`[login] password field gone: ${loggedIn} after ${Date.now() - t0}ms`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const contentAppeared = await page.waitForFunction(() => document.querySelectorAll('button,a,input,select,textarea,[role]').length > 3, { timeout: 25000 }).then(() => true).catch(() => false);
    console.log(`[login] >3 controls present: ${contentAppeared} after ${Date.now() - t0}ms total`);
    await page.waitForTimeout(2000);
    line();

    const meta: any = await page.evaluate(`(() => ({ href: location.href, readyState: document.readyState, title: document.title, wall: !!document.querySelector('input[type="password"]') }))()`);
    console.log('[8] href      =', meta.href);
    console.log('[8] readyState=', meta.readyState, ' title=', JSON.stringify(meta.title), ' stillOnLoginWall=', meta.wall);
    line();

    const m: any = await page.evaluate(`(() => ({
      all: document.querySelectorAll('*').length,
      bodyHtmlLen: ((document.body && document.body.innerHTML) || '').length,
      bodyText: ((document.body && document.body.innerText) || '').length,
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input').length,
      roles: document.querySelectorAll('[role]').length,
      anchors: document.querySelectorAll('a').length,
      selects: document.querySelectorAll('select').length,
      idBearing: document.querySelectorAll('[data-testid],[data-field],[aria-label],[placeholder]').length,
    }))()`);
    console.log('[1] querySelectorAll("*").length =', m.all);
    console.log('[2] body.innerHTML.length        =', m.bodyHtmlLen, ' bodyText=', m.bodyText);
    console.log('    button/input/select/[role]/a =', m.buttons, m.inputs, m.selects, m.roles, m.anchors);
    console.log('    identity-bearing els         =', m.idBearing);
    line();

    const frames = page.frames();
    console.log('[3] frames().length =', frames.length);
    for (const [i, f] of frames.entries()) {
      const c: any = await f.evaluate(`document.querySelectorAll('*').length`).catch((e: any) => `ERR:${e?.message}`);
      console.log(`    [4] frame#${i} name=${JSON.stringify(f.name())} url=${f.url()} *=${c}`);
    }
    const shadow: any = await page.evaluate(`(() => { let open=0,custom=0,closed=0; for (const el of document.querySelectorAll('*')){ if(el.tagName.includes('-'))custom++; if(el.shadowRoot)open++; else if(el.tagName.includes('-'))closed++; } return {open,custom,closed}; })()`);
    console.log('[5] iframe-hosted:', frames.length > 1, ' [6] openShadow:', shadow.open, ' [7] closedShadowCandidate:', shadow.closed, ` (custom els: ${shadow.custom})`);
    line();

    const react: any = await page.evaluate(`(() => { const roots=['#root','#app','[data-reactroot]','main'].map(s=>{const el=document.querySelector(s);return el?{sel:s,childCount:el.childElementCount,htmlLen:(el.innerHTML||'').length}:null;}).filter(Boolean); let fiber=false; for(const el of document.querySelectorAll('body *')){for(const k in el){if(k.startsWith('__reactContainer$')||k.startsWith('__reactFiber$')){fiber=true;break;}}if(fiber)break;} return {roots,fiber}; })()`);
    console.log('[10] React roots:', JSON.stringify(react.roots), ' fiberAttached:', react.fiber);
    line();

    const html = await page.evaluate(`((document.body && document.body.innerHTML) || '').slice(0, 2000)`);
    console.log('[9] body.innerHTML (first 2000 chars):');
    console.log(html);
    line();

    // Replicate captureSemanticSnapshot's TWO extractors inline (one login, no extra nav):
    const ariaOutline = await page.locator('body').ariaSnapshot({ mode: 'ai' }).catch((e: any) => `ARIA_ERR:${e?.message}`);
    const interactiveRoles = ['button','link','textbox','searchbox','combobox','checkbox','radio','switch','slider','spinbutton','tab','menuitem','menuitemcheckbox','menuitemradio','option','listbox','columnheader','gridcell','row'];
    const sweepCount = await page.evaluate(`(() => {
      const IT = new Set(["button","a","input","select","textarea","summary","option"]);
      const IR = new Set(${JSON.stringify(interactiveRoles)});
      const SKIP = new Set(["meta","link","script","style","title","base","noscript","template","html","head","body","svg","path"]);
      let kept = 0;
      const visit = (root) => { for (const e of root.querySelectorAll("*")) { if (e.shadowRoot) visit(e.shadowRoot); const tag=e.tagName.toLowerCase(); if(SKIP.has(tag))continue; const role=e.getAttribute("role"); const ti=e.getAttribute("tabindex"); const pp=e.parentElement&&getComputedStyle(e.parentElement).cursor==="pointer"; const interactive=IT.has(tag)||(role&&IR.has(role))||e.hasAttribute("onclick")||e.hasAttribute("aria-haspopup")||e.isContentEditable||(ti!==null&&Number(ti)>=0)||(getComputedStyle(e).cursor==="pointer"&&!pp&&!e.closest("a, button")); const identity=e.getAttribute("data-testid")||e.getAttribute("data-field")||e.getAttribute("aria-label")||e.getAttribute("placeholder")||(tag==="th"&&e.textContent); if(!interactive&&!identity)continue; const ca=e.closest("button, a, [role='button'], [role='link'], [role='menuitem']"); if(ca&&ca!==e&&!identity)continue; kept++; } };
      visit(document); return kept;
    })()`).catch((e: any) => `SWEEP_ERR:${e?.message}`);
    console.log('[capture] aria outline produced:', typeof ariaOutline === 'string' && !ariaOutline.startsWith('ARIA_ERR') ? `yes (${(ariaOutline as string).length} chars)` : ariaOutline);
    console.log('[capture] sweepDom would keep:', sweepCount, 'elements');
    console.log('[capture] aria outline (first 800):', String(ariaOutline).slice(0, 800));
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error('PROBE ERROR:', e?.message || e); process.exit(1); });
