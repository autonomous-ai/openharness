// Cross-cutting interaction checks over the fixture build.
//
//   node tool/web_ux/checks.mjs <build-dir> <out-dir>
//
// 1. Tap targets: on the phone widths, every control the accessibility tree
//    exposes whose box is under 44 px in either direction.
// 2. Scrolling: a mouse wheel (vertical and shift/horizontal) and a touch
//    swipe over each scrolling area; the area "scrolls" when its pixels change.
// 3. Hover and focus: a control's pixels with and without the mouse over it,
//    and the page after Tab presses, to see whether a focus ring shows.
// Results go to <out-dir>/checks.json, with before/after images under
// <out-dir>/checks/. FIXTURE=super-tab measures the tap targets of every
// Super Tab flow on a build of tool/super_tab_mobile_fixture.dart instead.
import { chromium } from './playwright.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFlows } from './load-flows.mjs';
import { VIEWPORTS, contextFor, runStep, settle, urlFor } from './capture.mjs';
import { serve } from './serve.mjs';

const FIXTURE = process.env.FIXTURE ?? 'app';
const FLOWS = await loadFlows(FIXTURE);
const flow = (name) => FLOWS.find((f) => f.name === name);
const PHONES = VIEWPORTS.filter((v) => v.width < 720);
const COMPUTER = VIEWPORTS.find((v) => v.name === '1440');

// Flows whose controls are measured for tap size on phones: on the Super Tab
// fixture, all of them.
const TAP_FLOWS = FIXTURE !== 'app' ? FLOWS.map((f) => f.name) : [
  'signin', 'first-machine', 'computers', 'workspace', 'app-menu', 'tab-switcher',
  'footer-menu', 'notifications', 'open-harness', 'machines', 'all-commands',
  'appearance', 'split-pane', 'store', 'settings', 'settings-notifications',
  'settings-keyboard-shortcuts', 'new-tab', 'error-banner', 'new-device', 'link-password',
  'taken-over', 'view-only',
];

// Scrolling areas: the flow that shows one, and where it is.
const SCROLLERS = [
  // The active tab is the last, so the row starts scrolled to its end: wheel back.
  { flow: 'many-tabs', area: 'tab row', box: [60, 0, 1300, 40], wheel: [0, -300] },
  { flow: 'many-tabs', area: 'tab row (shift+wheel)', box: [60, 0, 1300, 40], wheel: [0, -300], shift: true },
  { flow: 'many-tabs', area: 'tab row (trackpad sideways)', box: [60, 0, 1300, 40], wheel: [-300, 0] },
  { flow: 'store', area: 'store page', box: [120, 60, 1300, 860], wheel: [0, 600] },
  { flow: 'open-harness', area: 'picker filter chips', box: [320, 330, 1100, 360], wheel: [0, 200] },
  { flow: 'all-commands', area: 'command list', box: [320, 380, 720, 880], wheel: [0, 400] },
  { flow: 'appearance', area: 'appearance panel', box: [1230, 120, 1440, 900], wheel: [0, 500] },
  { flow: 'settings-keyboard-shortcuts', area: 'shortcut list', box: [270, 100, 1440, 900], wheel: [0, 600] },
  { flow: 'split-pane', area: 'new harness form', box: [300, 150, 1140, 880], wheel: [0, 400] },
];

// Phone areas scrolled with a finger.
const SWIPES = [
  { flow: 'tab-switcher', area: 'tab switcher list', from: [195, 600], to: [195, 250] },
  { flow: 'machines', area: 'machines list', from: [195, 600], to: [195, 250] },
  { flow: 'app-menu', area: 'app menu', from: [120, 500], to: [120, 200] },
  { flow: 'store', area: 'store page', from: [195, 650], to: [195, 200] },
  { flow: 'settings', area: 'settings list', from: [195, 650], to: [195, 200] },
  { flow: 'settings-keyboard-shortcuts', area: 'shortcut list', from: [195, 650], to: [195, 200] },
  { flow: 'all-commands', area: 'command list', from: [195, 650], to: [195, 250] },
  { flow: 'first-machine', area: 'connect page', from: [195, 650], to: [195, 200] },
  { flow: 'signin', area: 'sign-in page', from: [195, 650], to: [195, 200] },
];

// Controls hovered with the mouse at 1440.
const HOVERS = [
  { flow: 'workspace', name: 'New Tab' },
  { flow: 'workspace', name: 'Open Harness' },
  { flow: 'workspace', name: 'Close Pane' },
  { flow: 'workspace', name: 'Agent: Claude Code' },
  { flow: 'workspace', name: 'Click to open Harness Monitor' },
  { flow: 'many-tabs', name: 'docs' },
  { flow: 'app-menu', name: 'Settings', exact: true },
  { flow: 'signin', name: 'Continue with Google' },
  { flow: 'first-machine', name: 'Download app' },
  { flow: 'settings', name: 'Privacy', exact: true },
];

const digest = (buffer) => createHash('sha1').update(buffer).digest('hex');
const clip = ([x0, y0, x1, y1]) => ({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });

/// A page showing flow [name], or a rejection when the flow is unknown or a
/// step cannot be clicked; the page is closed before rejecting.
async function open(context, origin, name, viewport, theme = 'dark') {
  const f = flow(name);
  if (!f) throw new Error(`no flow "${name}"`);
  const page = await context.newPage();
  try {
    await page.goto(urlFor(origin, f, theme));
    await settle(page);
    const compact = viewport.width < 720;
    for (const step of (compact ? f.compact : f.wide) ?? f.steps ?? []) {
      await runStep(page, step, Boolean(viewport.device));
      await page.waitForTimeout(700);
    }
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function tapTargets(browser, origin, blocked) {
  const out = [];
  for (const viewport of PHONES) {
    const context = await contextFor(browser, viewport, 'dark', origin, blocked);
    for (const name of TAP_FLOWS) {
      const f = flow(name);
      if (f?.only === 'wide') continue;
      const page = await open(context, origin, name, viewport).catch(() => null);
      if (!page) { out.push({ flow: name, width: viewport.name, small: null, note: 'flow did not open' }); continue; }
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll('flt-semantics[flt-tappable], flt-semantics[role="button"], flt-semantics[role="link"], flt-semantics[role="checkbox"], flt-semantics[role="switch"], flt-semantics[role="tab"], flt-semantics[role="radio"]'))
          .map((e) => {
            const r = e.getBoundingClientRect();
            const label = (e.getAttribute('aria-label') || e.textContent || '').split('\n')[0].trim().slice(0, 60);
            return { label, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
          })
          .filter((c) => c.w > 0 && c.h > 0 && (c.w < 44 || c.h < 44) && c.y < window.innerHeight && c.y + c.h > 0));
      out.push({ flow: name, width: viewport.name, small });
      await page.close();
    }
    await context.close();
  }
  return out;
}

async function wheels(browser, origin, blocked, dir) {
  const context = await contextFor(browser, COMPUTER, 'dark', origin, blocked);
  const out = [];
  for (const s of SCROLLERS) {
    const page = await open(context, origin, s.flow, COMPUTER).catch(() => null);
    if (!page) { out.push({ ...s, scrolled: null, note: 'flow did not open' }); continue; }
    const [x0, y0, x1, y1] = s.box;
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2);
    const before = await page.screenshot({ clip: clip(s.box) });
    if (s.shift) await page.keyboard.down('Shift');
    await page.mouse.wheel(...s.wheel);
    if (s.shift) await page.keyboard.up('Shift');
    await page.waitForTimeout(800);
    const after = await page.screenshot({ clip: clip(s.box) });
    const file = `${s.flow}-${s.area.replace(/\W+/g, '-')}`;
    writeFileSync(join(dir, `${file}-before.png`), before);
    writeFileSync(join(dir, `${file}-after.png`), after);
    out.push({ ...s, scrolled: digest(before) !== digest(after), images: `checks/${file}-{before,after}.png` });
    await page.close();
  }
  await context.close();
  return out;
}

async function swipes(browser, origin, blocked, dir) {
  const viewport = VIEWPORTS.find((v) => v.name === '390');
  const context = await contextFor(browser, viewport, 'dark', origin, blocked);
  const out = [];
  for (const s of SWIPES) {
    const page = await open(context, origin, s.flow, viewport).catch(() => null);
    if (!page) { out.push({ ...s, scrolled: null, note: 'flow did not open' }); continue; }
    const before = await page.screenshot();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.synthesizeScrollGesture', {
      x: s.from[0], y: s.from[1], xDistance: s.to[0] - s.from[0], yDistance: s.to[1] - s.from[1],
      gestureSourceType: 'touch', speed: 800,
    });
    await page.waitForTimeout(800);
    const after = await page.screenshot();
    const file = `swipe-${s.flow}`;
    writeFileSync(join(dir, `${file}-before.png`), before);
    writeFileSync(join(dir, `${file}-after.png`), after);
    out.push({ ...s, scrolled: digest(before) !== digest(after), images: `checks/${file}-{before,after}.png` });
    await page.close();
  }
  await context.close();
  return out;
}

async function hovers(browser, origin, blocked, dir) {
  const context = await contextFor(browser, COMPUTER, 'dark', origin, blocked);
  const out = [];
  for (const h of HOVERS) {
    const page = await open(context, origin, h.flow, COMPUTER).catch(() => null);
    if (!page) { out.push({ ...h, changed: null, note: 'flow did not open' }); continue; }
    const target = page.getByRole('button', { name: h.name, exact: Boolean(h.exact) }).first();
    const box = await target.boundingBox().catch(() => null);
    if (!box) { out.push({ ...h, changed: null, note: 'not found' }); await page.close(); continue; }
    const area = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 };
    await page.mouse.move(5, 895);
    await page.waitForTimeout(300);
    const before = await page.screenshot({ clip: area });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(600);
    const after = await page.screenshot({ clip: area });
    const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('flutter-view')).cursor);
    const file = `hover-${h.flow}-${h.name.replace(/\W+/g, '-')}`;
    writeFileSync(join(dir, `${file}-before.png`), before);
    writeFileSync(join(dir, `${file}-after.png`), after);
    out.push({ ...h, changed: digest(before) !== digest(after), cursor, images: `checks/${file}-{before,after}.png` });
    await page.close();
  }
  await context.close();
  return out;
}

async function focus(browser, origin, blocked, dir) {
  const context = await contextFor(browser, COMPUTER, 'dark', origin, blocked);
  const out = [];
  for (const name of ['signin', 'first-machine', 'workspace', 'settings']) {
    const page = await open(context, origin, name, COMPUTER).catch(() => null);
    if (!page) { out.push({ flow: name, active: null, note: 'flow did not open' }); continue; }
    for (let i = 1; i <= 4; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
    }
    const file = `focus-${name}.png`;
    await page.screenshot({ path: join(dir, file) });
    const active = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()} ${a.getAttribute('aria-label') || a.textContent?.slice(0, 40) || ''}` : null;
    });
    out.push({ flow: name, afterTabs: 4, active, image: `checks/${file}` });
    await page.close();
  }
  await context.close();
  return out;
}

async function main() {
  const [buildDir, outDir] = process.argv.slice(2);
  const dir = join(outDir, 'checks');
  mkdirSync(dir, { recursive: true });
  const server = await serve(buildDir);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const blocked = new Set();
  const results = { tapTargets: await tapTargets(browser, server.origin, blocked) };
  if (FIXTURE === 'app') {
    results.wheel = await wheels(browser, server.origin, blocked, dir);
    results.swipe = await swipes(browser, server.origin, blocked, dir);
    results.hover = await hovers(browser, server.origin, blocked, dir);
    results.focus = await focus(browser, server.origin, blocked, dir);
  }
  results.blocked = [...blocked];
  writeFileSync(join(outDir, 'checks.json'), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
}

await main();
