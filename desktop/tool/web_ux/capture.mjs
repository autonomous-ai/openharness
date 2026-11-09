// Screenshots every flow in flows/ at the audit's widths.
//
//   node tool/web_ux/capture.mjs <build-dir> <out-dir> [flow ...]
//
// <build-dir> is `flutter build web --no-web-resources-cdn
// --dart-define=HARNESS_TEST=true -t tool/web_ux_fixture.dart` (the release
// also builds without the CDN). It is served here with an index fallback, so
// /s/… share links reach the app. Phones and the tablet are emulated with
// touch, a mobile user agent and the platform their browser reports, so
// Flutter sees iOS or Android; the computer width uses a mouse. Every request
// that leaves the served origin is blocked and listed in blocked.json, so a
// fixture can never reach a backend; only Google's font CDN, which the engine
// falls back to for missing glyphs in production too, is let through.
// Run from desktop/ with PLAYWRIGHT_DIR set (see playwright.mjs). CHROME_PATH
// uses an already-installed Chromium; WIDTHS=360,1440 captures only some widths
// (separate runs can go in parallel); FIXTURE=super-tab captures the Super Tab
// flows from a build of tool/super_tab_mobile_fixture.dart.
import { chromium, devices } from './playwright.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFlows } from './load-flows.mjs';
import { serve } from './serve.mjs';

export const VIEWPORTS = [
  { name: '360', width: 360, height: 740, device: 'Galaxy S9+', platform: 'Linux armv8l', themes: ['dark'] },
  { name: '390', width: 390, height: 844, device: 'iPhone 13', platform: 'iPhone', themes: ['dark', 'light'] },
  { name: '768', width: 768, height: 1024, device: 'iPad Mini', platform: 'iPad', themes: ['dark'] },
  { name: '1440', width: 1440, height: 900, device: null, platform: null, themes: ['dark', 'light'] },
];

const COMPACT_BELOW = 720;

export async function contextFor(browser, viewport, theme, origin, blocked) {
  const base = viewport.device ? { ...devices[viewport.device] } : {};
  const context = await browser.newContext({
    ...base,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  if (viewport.platform) {
    await context.addInitScript((platform) => {
      Object.defineProperty(navigator, 'platform', { get: () => platform });
    }, viewport.platform);
  }
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('https://fonts.gstatic.com/')) {
      return route.continue();
    }
    blocked.add(url);
    return route.abort();
  });
  return context;
}

export function urlFor(origin, flow, theme) {
  const [path, hash] = (flow.path ?? '/').split('#');
  const url = new URL(path, origin);
  url.searchParams.set('scenario', flow.scenario);
  url.searchParams.set('theme', theme);
  return hash ? `${url}#${hash}` : `${url}`;
}

/// Flutter is up once its view is in the page, the first frames are done and
/// the network is quiet: glyphs the bundled fonts lack (●, ✓) arrive from the
/// font CDN later, and a capture taken before them drops those characters.
export async function settle(page) {
  await page.waitForSelector('flutter-view', { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

/// A flow's `api` answers the app's backend reads in the browser, so a state
/// that needs a server reply (a private or offline shared link) is drawn by
/// the real page: { '/api/shared-agents/': { status, body } }. Everything else
/// stays blocked by [contextFor].
export async function answerApi(page, flow) {
  for (const [path, { status = 200, body = {} }] of Object.entries(flow.api ?? {})) {
    await page.route(`**${path}**`, (route) => {
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, x-autonomous-env',
        'access-control-allow-methods': 'GET, OPTIONS',
      };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }
}

export async function runStep(page, [kind, target], touch) {
  const press = touch ? 'tap' : 'click';
  const button = (exact) => page.getByRole('button', { name: target, exact }).first();
  switch (kind) {
    case 'click': return button(false)[press]({ timeout: 5000 });
    case 'exact': return button(true)[press]({ timeout: 5000 });
    case 'text': return page.getByText(target).first()[press]({ timeout: 5000 });
    case 'rclick':
      return page.getByRole('button', { name: target }).first().click({ button: 'right', timeout: 5000 });
    case 'key': return page.keyboard.press(target);
    default: throw new Error(`unknown step ${kind}`);
  }
}

function stepsFor(flow, viewport) {
  const compact = viewport.width < COMPACT_BELOW;
  if (flow.only === 'wide' && compact) return null;
  if (flow.only === 'compact' && !compact) return null;
  return (compact ? flow.compact : flow.wide) ?? flow.steps ?? [];
}

async function shoot(context, origin, flow, viewport, theme, outDir) {
  const steps = stepsFor(flow, viewport);
  if (!steps) return null;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  const shot = `screens/${flow.name}/${viewport.name}-${theme}.png`;
  let failed = null;
  try {
    await answerApi(page, flow);
    await page.goto(urlFor(origin, flow, theme));
    await settle(page);
    for (const step of steps) {
      await runStep(page, step, Boolean(viewport.device));
      await page.waitForTimeout(700);
    }
  } catch (e) {
    failed = String(e).split('\n')[0];
  }
  mkdirSync(join(outDir, 'screens', flow.name), { recursive: true });
  await page.screenshot({ path: join(outDir, shot) });
  await page.close();
  return { flow: flow.name, width: viewport.name, theme, shot, failed, errors };
}

async function main() {
  const [buildDir, outDir, ...only] = process.argv.slice(2);
  const fixture = process.env.FIXTURE ?? 'app';
  const all = await loadFlows(fixture);
  const flows = only.length ? all.filter((f) => only.includes(f.name)) : all;
  const server = await serve(buildDir);
  const origin = server.origin;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const blocked = new Set();
  const results = [];
  const widths = process.env.WIDTHS?.split(',');
  for (const viewport of VIEWPORTS.filter((v) => !widths || widths.includes(v.name))) {
    for (const theme of viewport.themes) {
      const context = await contextFor(browser, viewport, theme, origin, blocked);
      for (const flow of flows) {
        const result = await shoot(context, origin, flow, viewport, theme, outDir);
        if (result) results.push(result);
        if (result?.failed) console.error(`${flow.name} ${viewport.name}-${theme}: ${result.failed}`);
      }
      await context.close();
    }
  }
  const tag = `${fixture === 'app' ? '' : `-${fixture}`}${widths ? `-${widths.join('-')}` : ''}`;
  writeFileSync(join(outDir, `captures${tag}.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, `blocked${tag}.json`), JSON.stringify([...blocked], null, 2));
  await browser.close();
  server.close();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
