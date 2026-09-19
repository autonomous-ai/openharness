import { once } from 'node:events';
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHtmlViewer } from '../../viewers/isolated-web-viewer/viewer.mjs';

// Optional developer dependency; no machine-specific path is shipped in the package.
export async function chromium() {
  try {
    return (await import(process.env.PLAYWRIGHT_MODULE
      ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')).chromium;
  } catch (error) {
    throw new Error('Install Playwright + Chromium, or set PLAYWRIGHT_MODULE to playwright/index.mjs.', { cause: error });
  }
}

export const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function preview(browser, template, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'group-a-preview-'));
  if (template) await cp(resolve(root, template), workspace, { recursive: true });
  if (options.prepare) await options.prepare(workspace);
  const server = await createHtmlViewer(workspace);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', ...options.context });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const url = `http://127.0.0.1:${server.address().port}/?file=${encodeURIComponent(options.file || 'index.html')}`;
  return {
    workspace, server, context, page, url, errors,
    frame: () => page.frameLocator('#preview'),
    async open() { await page.goto(url); return this.frame(); },
    async screenshot(name) {
      const directory = process.env.HARNESS_QA_DIR || join(workspace, '.harness');
      await mkdir(directory, { recursive: true });
      const output = join(directory, name + '.png');
      await page.screenshot({ path: output, fullPage: true });
      return output;
    },
    async close() {
      await context.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(workspace, { recursive: true, force: true });
    }
  };
}
