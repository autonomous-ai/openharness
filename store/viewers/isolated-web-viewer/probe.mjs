// Optional browser verification. Uses the real opaque-origin HTTP preview.
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHtmlViewer } from './viewer.mjs';

export async function probe({ mode = 'proof', target = process.argv[2] || 'index.html', seconds = Number(process.argv[3] || 3) } = {}) {
  const artifact = resolve(target);
  const workspace = resolve(process.env.HARNESS_WORKSPACE || dirname(artifact));
  const file = relative(workspace, artifact);
  if (isAbsolute(file) || file.startsWith('..')) throw new Error('The artifact must be inside HARNESS_WORKSPACE.');
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error('Measure for 1 to 30 seconds.');
  const output = join(workspace, '.harness');
  await mkdir(output, { recursive: true });
  const report = { mode, artifact: file, at: new Date().toISOString(), passed: false, interactionVerified: false, errors: [], dependencies: [] };
  const reportPath = join(output, mode === 'perf' ? 'perf.json' : 'browser-proof.json');
  let server, browser;
  try {
    try { await readFile(artifact); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(file + ' missing — create the page before verifying it.'); throw error; }
    let chromium;
    try { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')); }
    catch { throw new Error('Playwright is missing. Install it in the web-viewer package, or set PLAYWRIGHT_MODULE to playwright/index.mjs.'); }
    let recipe;
    try { recipe = JSON.parse(await readFile(join(workspace, 'proof.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (recipe && (!Array.isArray(recipe.actions) || recipe.actions.length > 128)) throw new Error('proof.json needs an actions array (at most 128 steps).');
    const changed = (recipe?.actions || []).some(action => action.click || action.fill !== undefined || action.select !== undefined);
    const asserted = (recipe?.actions || []).some(action => action.text !== undefined || action.attribute);
    if (!changed || !asserted) throw new Error('Add proof.json with a real interaction and an assertion of its result.');
    server = await createHtmlViewer(workspace);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const resources = new Set([file]);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== base) return;
      const match = url.pathname.match(/^\/preview\/[a-f0-9]{48}\/(.+)/);
      if (match) resources.add(decodeURIComponent(match[1]));
      if (response.status() >= 400) report.errors.push('HTTP ' + response.status() + ': ' + url.pathname.replace(/\/preview\/[a-f0-9]+\//, '/'));
    });
    await page.goto(base + '/?file=' + encodeURIComponent(file), { waitUntil: 'load' });
    const frame = page.frameLocator('#preview');
    await frame.locator('body').waitFor();
    const perform = async () => {
      for (const action of recipe.actions) {
        if (typeof action.selector !== 'string') throw new Error('Every proof action needs a CSS selector.');
        const locator = frame.locator(action.selector);
        await locator.waitFor({ state: 'visible', timeout: 10000 });
        if (action.click) await locator.click();
        if (action.fill !== undefined) await locator.fill(String(action.fill));
        if (action.select !== undefined) await locator.selectOption(String(action.select));
        if (action.text !== undefined) {
          const actual = (await locator.textContent()).trim();
          if (actual !== String(action.text)) throw new Error(action.selector + ': expected "' + action.text + '", got "' + actual + '"');
        }
        if (action.attribute) {
          const actual = await locator.getAttribute(action.attribute.name);
          if (actual !== String(action.attribute.value)) throw new Error(action.selector + ': unexpected ' + action.attribute.name + '=' + actual);
        }
      }
    };
    await perform();
    report.interactionVerified = true;
    if (mode === 'perf') {
      const sampling = frame.locator('body').evaluate((_body, duration) => new Promise(resolve => {
        const frames = [], tasks = [];
        const observer = new PerformanceObserver(list => { for (const task of list.getEntries()) tasks.push(task.duration); });
        observer.observe({ type: 'longtask', buffered: false });
        const start = performance.now();
        const tick = now => {
          frames.push(now);
          if (now - start < duration * 1000) requestAnimationFrame(tick);
          else {
            observer.disconnect();
            const deltas = frames.slice(1).map((time,i) => time - frames[i]);
            const sorted = [...deltas].sort((a,b) => a-b);
            resolve({
              fps: (frames.length-1)*1000/(frames.at(-1)-frames[0]),
              frameP95Ms: sorted[Math.floor(sorted.length*.95)] || 0,
              droppedPct: 100*deltas.filter(ms=>ms>25).length/Math.max(1,deltas.length),
              samples: deltas.length, longTasks: tasks.length,
              blockedMs: tasks.reduce((sum,duration)=>sum+Math.max(0,duration-50),0)
            });
          }
        };
        requestAnimationFrame(tick);
      }), seconds);
      const until = Date.now() + seconds*1000;
      let rounds=0;
      try {
        while (Date.now() < until) {
          await perform(); rounds++;
          await page.mouse.move(150+rounds*47%1050, 300+rounds*31%500);
          await page.waitForTimeout(50);
        }
      } finally { Object.assign(report, await sampling); }
      report.interactionRounds = rounds;
      report.renderers = await frame.locator('canvas').evaluateAll(canvases => canvases.map(canvas => {
        const gl=canvas.getContext('webgl2');
        if(!gl)return {type:'canvas2d',width:canvas.width,height:canvas.height};
        const extension=gl.getExtension('WEBGL_debug_renderer_info');
        return {type:'webgl2',width:canvas.width,height:canvas.height,renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):'unknown'};
      }));
      if (report.fps < 55 || report.droppedPct >= 2) throw new Error('Frame budget missed during interaction: ' + report.fps.toFixed(1) + ' fps, ' + report.droppedPct.toFixed(1) + '% slow frames.');
    }
    await page.screenshot({ path: join(output, 'last.png'), fullPage: true });
    for (const path of resources) {
      const absolute = resolve(workspace,path), inside = relative(workspace,absolute);
      if (isAbsolute(inside) || inside.startsWith('..')) continue;
      report.dependencies.push({ path: inside, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
    }
    if (report.errors.length) throw new Error('The browser reported errors: ' + report.errors.join('; '));
    report.passed = true;
    console.log(mode === 'perf' ? 'ok   ' + report.fps.toFixed(1) + ' fps during ' + report.interactionRounds + ' interaction rounds' : 'ok   page and interaction assertions passed');
    console.log('evidence: ' + reportPath);
  } catch (error) {
    report.errors.push(error.message);
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await writeFile(reportPath, JSON.stringify(report,null,2)+'\n');
    if (mode === 'proof') {
      const verdict = {
        spec: 1, ready: report.passed,
        summary: report.passed ? 'Browser and interaction assertions verified' : 'Browser verification failed',
        findings: report.errors.map(message => ({ severity: 'error', kind: 'browser', message })),
        artifact: file, updatedAt: new Date().toISOString()
      };
      await writeFile(join(output,'verdict.json'),JSON.stringify(verdict,null,2)+'\n');
    }
  }
  return report;
}
