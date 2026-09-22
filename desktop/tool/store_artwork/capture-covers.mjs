/** Capture original Harness viewers with isolated demo data, never the user's fleet/models.
 * node capture-covers.mjs <all|machine-monitor|harness-monitor|mlx-lm|ollama|vllm|home-assistant>
 *   --playwright /path/to/playwright/index.mjs --output /tmp/store-covers
 * COVER_DUMP_TEXT=1 prints Harness Monitor's visible text, to check it holds nothing personal.
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
const ids = ['machine-monitor', 'harness-monitor', 'mlx-lm', 'ollama', 'vllm', 'home-assistant'];
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
    } else if (id === 'harness-monitor') {
      const { createViewer } = await source('store/agents/harness-monitor/viewer.mjs');
      const { row, HOUR, DAY } = await source('store/agents/harness-monitor/test/fixtures.mjs');
      // An invented fleet: three machines, eight projects, harnesses from minutes to days idle.
      const machines = [
        { machineId: 'studio', name: 'studio', current: true, online: true },
        { machineId: 'build-box', name: 'build-box', current: false, online: true },
        { machineId: 'laptop', name: 'laptop', current: false, online: true },
      ];
      const fleet = [
        ['payments', 'Retry webhooks with backoff', 'studio', 0.1, { working: true }],
        ['payments', 'Refund flow edge cases', 'build-box', 3, {}],
        ['payments', 'Audit the ledger migration', 'studio', 30, { state: 'paused' }],
        ['widgets', 'Fix the reconciler', 'studio', 0.3, { needsInput: true }],
        ['widgets', 'Snapshot tests for the grid', 'laptop', 7, {}],
        ['widgets', 'Drop the legacy renderer', 'build-box', 80, { state: 'paused' }],
        ['docs-site', 'Rewrite the quickstart', 'laptop', 1.5, { working: true }],
        ['docs-site', 'Broken links sweep', 'studio', 26, {}],
        ['docs-site', 'Search index rebuild', 'build-box', 190, { state: 'paused' }],
        ['ml-pipeline', 'Eval harness for the ranker', 'build-box', 0.05, { working: true }],
        ['ml-pipeline', 'Tokenizer regression', 'studio', 5, { needsInput: true }],
        ['ml-pipeline', 'Backfill features', 'build-box', 52, {}],
        ['mobile-app', 'Onboarding copy pass', 'laptop', 2, {}],
        ['mobile-app', 'Crash on resume', 'studio', 11, { working: true }],
        ['mobile-app', 'Dark mode contrast', 'laptop', 120, {}],
        ['mobile-app', 'Release notes 1.4', 'laptop', 240, { state: 'paused' }],
        ['infra', 'Rotate the staging certs', 'build-box', 0.7, { working: true }],
        ['infra', 'Terraform drift report', 'studio', 40, {}],
        ['api-gateway', 'Rate limits per key', 'studio', 4, { needsInput: true }],
        ['api-gateway', 'OpenAPI diff in CI', 'build-box', 96, { state: 'paused' }],
        ['design-system', 'Token rename', 'laptop', 0.2, { working: true }],
        ['design-system', 'Icon audit', 'laptop', 18, {}],
      ];
      const now = Date.now();
      const rows = fleet.map(([project, title, machineId, idleHours, extra], i) => {
        const paused = extra.state === 'paused';
        return row({
          id: `demo-${i}`, sessionId: `demo-session-${i}`, name: project, title, project,
          engine: i % 3 ? 'claude' : 'codex', model: i % 3 ? 'opus-5' : 'gpt-5',
          cwd: `/home/you/code/${project}`, home: `~/code/${project}`, branch: i % 4 ? 'main' : `fix/${i}`,
          idleMs: idleHours * HOUR, lastActivity: now - idleHours * HOUR, createdAt: now - (idleHours / 24 + 2) * DAY,
          stateSince: now - idleHours * HOUR, rssBytes: paused ? 0 : (180 + (i * 97) % 700) * 1024 * 1024,
          machine: machineId, machineId, local: machineId === 'studio', pane: `%${i + 1}`,
          ...extra,
        });
      });
      const workspace = await mkdtemp(join(tmpdir(), 'harness-cover-'));
      // The viewer reads its policy and pause log from the home directory; point it at an
      // empty one so nothing of this computer's own state can reach the picture.
      const env = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        HARNESS_MONITOR_STATE: process.env.HARNESS_MONITOR_STATE };
      process.env.HOME = workspace;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.HARNESS_MONITOR_STATE;
      const viewer = createViewer({
        workspace, intervalMs: 60_000, remoteIntervalMs: 60_000,
        collect: async () => ({ rows, machines, problems: [], observedAt: Date.now() }),
        scan: async () => '$ ',
      });
      const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1, colorScheme: 'dark' });
      try {
        await page.goto(`http://127.0.0.1:${await viewer.start()}/`);
        await page.waitForSelector('#lane-list > *');
        await page.waitForTimeout(1500); // Let the layout settle before recording.
        await page.screenshot({ path: join(output, `${id}.png`) });
        if (process.env.COVER_DUMP_TEXT) console.log(await page.innerText('body'));
      } finally {
        await page.close(); await viewer.close(); await rm(workspace, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
      }
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
