/** Capture original Harness viewers with isolated demo data, never the user's fleet/models.
 * node capture-covers.mjs <all|machine-monitor|mlx-lm|ollama|vllm|home-assistant>
 *   --playwright /path/to/playwright/index.mjs --output /tmp/store-covers
 * Home Assistant is the upstream public demo; all other pages run on loopback.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const mode = args[0] || 'all';
const ids = ['machine-monitor', 'mlx-lm', 'ollama', 'vllm', 'home-assistant'];
if (mode !== 'all' && !ids.includes(mode)) throw new Error(`Choose all or ${ids.join(', ')}.`);
const output = resolve(option('--output', join(tmpdir(), 'harness-cover-captures')));
const playwright = option('--playwright', 'playwright');
const { chromium } = await import(playwright.startsWith('/') ? pathToFileURL(playwright).href : playwright);
const source = path => import(pathToFileURL(join(root, path)).href);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const id of mode === 'all' ? ids : [mode]) {
    if (id === 'home-assistant') {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
      try {
        await page.goto('https://demo.home-assistant.io/', { waitUntil: 'networkidle' });
        await page.getByText('Living room', { exact: true }).first().waitFor();
        await page.screenshot({ path: join(output, `${id}.png`) });
      } finally { await page.close(); }
    } else if (id === 'machine-monitor') {
      const { createViewer } = await source('store/agents/machine-monitor/viewer.mjs');
      const { createCollector } = await source('store/agents/machine-monitor/lib/snapshot.mjs');
      const { fakeReads, OWNER_MACHINES, STUDIO_ROSTER } = await source('store/agents/machine-monitor/test/fixtures.mjs');
      const workspace = await mkdtemp(join(tmpdir(), 'machine-cover-'));
      const rosters = Object.fromEntries(OWNER_MACHINES.map((m, i) => [m.machineId,
        Array.from({ length: 8 + i * 3 }, (_, j) => ({ ...STUDIO_ROSTER[j % 3], id: `demo-${i}-${j}`, status: j % 3 ? 'active' : 'offline' })),
      ]));
      const collect = createCollector(workspace, { read: fakeReads({ rosters,
        peers: OWNER_MACHINES.slice(1).map(m => ({ machineId: m.machineId, linked: true })),
      }) });
      const viewer = createViewer({ workspace, intervalMs: 60_000, collect });
      const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
      try {
        await page.goto(`http://127.0.0.1:${await viewer.start()}/`);
        await page.waitForSelector('.node');
        await page.waitForTimeout(1500); // Let the layout settle before recording.
        await page.screenshot({ path: join(output, `${id}.png`) });
      } finally { await page.close(); await viewer.close(); await rm(workspace, { recursive: true, force: true }); }
    } else {
      const { createServer } = await source('store/agents/mlx-lm/src/server.mjs');
      const { MLX_CATALOG } = await source('store/agents/mlx-lm/src/mlx.mjs');
      const { CATALOG } = await source('store/agents/ollama/src/catalog.mjs');
      const name = { 'mlx-lm': 'MLX-LM', ollama: 'Ollama', vllm: 'vLLM' }[id];
      const catalog = id === 'ollama' ? CATALOG : MLX_CATALOG;
      const controller = new EventEmitter();
      controller.profile = { id, name };
      controller.workspace = '/demo';
      controller.refresh = async () => {};
      controller.snapshot = () => ({
        runtime: { id, name, online: true, version: 'demo', models: catalog.slice(0, 3).map((m, i) => ({
          ...m, size: Math.round(m.downloadGB * 1024 ** 3), running: i === 0,
          resident: i === 0 ? { size: 1024 ** 3 } : null,
        })) },
        system: { chip: 'Apple Silicon', totalMemory: 32 * 1024 ** 3, freeMemory: 24 * 1024 ** 3 },
        jobs: [], runs: [], benchmarks: [], loadTests: [], catalog, updatedAt: new Date().toISOString(),
      });
      const server = createServer(controller, { assetRoot: join(root, 'store/agents', id, 'dist') });
      await new Promise(ok => server.listen(0, '127.0.0.1', ok));
      const page = await browser.newPage({ viewport: { width: 640, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' });
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/?view=grid`);
        await page.waitForSelector('.model-node');
        await page.locator('.map-panel').screenshot({ path: join(output, `${id}.png`) });
      } finally {
        await page.close(); server.closeEvents(); server.closeAllConnections();
        await new Promise(ok => server.close(ok));
      }
    }
    console.log(`Captured ${id}`);
  }
} finally { await browser.close(); }
