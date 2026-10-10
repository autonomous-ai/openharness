/** Capture original Harness viewers with isolated demo data, never the user's fleet/models.
 * node capture-covers.mjs <all|machine-monitor|harness-monitor|memories|mlx-lm|ollama|vllm|home-assistant>
 *   --playwright /path/to/playwright/index.mjs --output /tmp/store-covers
 * COVER_DUMP_TEXT=1 prints Harness Monitor's and Memories' visible text, to check it holds nothing personal.
 * Home Assistant is the upstream public demo; all other pages run on loopback.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const mode = args[0] || 'all';
const ids = ['machine-monitor', 'harness-monitor', 'memories', 'mlx-lm', 'ollama', 'vllm', 'home-assistant'];
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
    } else if (id === 'memories') {
      const { createViewer } = await source('store/agents/memories/viewer.mjs');
      const { sessionIndex, DAY } = await source('store/agents/memories/test/fixtures.mjs');
      const { writeAbout } = await source('store/agents/memories/lib/about.mjs');
      // An invented person's home: what five agents remember and four months of messages, all made up here.
      const home = await mkdtemp(join(tmpdir(), 'memories-cover-'));
      const put = async (path, text) => { await mkdir(dirname(join(home, path)), { recursive: true }); await writeFile(join(home, path), text); };
      const notes = {
        payments: [
          ['short-answers', 'feedback', 'Wants replies under five lines', 'Keep replies short; lead with the answer.'],
          ['retries', 'project', 'Webhooks retry with backoff', 'Webhook retries back off to one hour, then page.'],
          ['ledger', 'reference', 'Where the ledger docs live', 'The ledger design is in docs/ledger.md.'],
        ],
        widgets: [
          ['tests-first', 'feedback', 'Run the tests before saying done', 'Run `make test` before calling anything done.'],
          ['renderer', 'project', 'The legacy renderer is going away', 'New work targets the grid renderer only.'],
        ],
        'docs-site': [
          ['plain-words', 'user', 'Writes docs in plain words', 'Prefers short sentences and no jargon.'],
          ['deploys', 'project', 'Docs deploy from main', 'Every merge to main publishes the site.'],
        ],
        'mobile-app': [
          ['screenshots', 'feedback', 'Reviews UI from screenshots', 'Send a screenshot with every UI change.'],
          ['release-train', 'project', 'Releases go out on Tuesdays', 'Never release on a Friday.'],
        ],
      };
      for (const [project, list] of Object.entries(notes)) {
        await mkdir(join(home, 'code', project), { recursive: true });
        const key = join(home, 'code', project).replace(/[^A-Za-z0-9]/g, '-');
        for (const [name, type, description, body] of list) {
          await put(`.claude/projects/${key}/memory/${name}.md`, `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`);
        }
      }
      await put('.codex/config.toml', '[features]\nmemories = true\n');
      await put('.codex/memories/memory_summary.md', 'Prefers small pull requests with one change each.\n');
      await put('.codex/memories/MEMORY.md', '# Handbook\n\n## Testing\nRun `make test` first.\n\n## Reviews\nOne change per pull request.\n');
      await put('.grok/config.toml', '[memory]\nenabled = true\n');
      await put('.grok/memory-v2/global/topics/style.md', '# Code style\n\nTwo-space indentation everywhere.\n');
      await put('.hermes/memories/USER.md', 'Prefers terse answers.\n§\nWorks late in the evening.\n');
      await put('.gemini/GEMINI.md', '## Gemini Added Memories\n- Prefers tabs in Go files\n- Lives in UTC+1\n');
      const asks = ['keep it short, tldr only', 'run the tests before you say done', 'one change per pull request',
        'why does the retry back off that far?', 'walk me through the ledger migration', 'ship it once CI is green',
        'make the empty state clearer', 'never release on a Friday', 'write the docs in plain words', 'add a test that fails first'];
      const engines = ['claude', 'codex', 'codex', 'claude', 'grok', 'hermes'];
      const projects = Object.keys(notes);
      const now = Date.now();
      const turns = [];
      for (let day = 0; day < 120; day++) {
        // Busy weekdays, quiet weekends, and a holiday week: a believable four months.
        const weekday = new Date(now - day * DAY).getDay();
        const count = day >= 50 && day < 57 ? 0 : weekday === 0 || weekday === 6 ? day % 3 : 2 + ((day * 7) % 9);
        for (let n = 0; n < count; n++) {
          const project = projects[(day + n) % projects.length];
          turns.push({ session: `s${day}-${n % 3}`, engine: engines[(day * 5 + n) % engines.length], cwd: join(home, 'code', project),
            title: `${project} work`, ask: asks[(day * 3 + n) % asks.length], answer: 'done', daysAgo: day + n / 24 });
        }
      }
      sessionIndex(join(home, '.harness', 'cli', 'data'), { now, turns });
      const env = { MEMORIES_HOME: join(home, '.harness', 'memory') };
      writeAbout(env.MEMORIES_HOME, ['# About you', '', '## How you work',
        '- Works across Claude Code and Codex, most days of the week. [asks:480]',
        '- Asks "why" before agreeing to a design. [asks:41]', '',
        '## What you want from agents',
        '- Short answers that lead with the result. [claude:short-answers.md, hermes:USER.md]',
        '- Tests run before anything is called done. [claude:tests-first.md, codex:MEMORY.md]',
        '- One change per pull request. [codex:memory_summary.md]', '',
        '## Taste', '- Plain words in docs; no jargon. [claude:plain-words.md]', ''].join('\n'), { gen: now, now });
      const viewer = createViewer({ workspace: home, intervalMs: 60_000, env, home });
      const page = await browser.newPage({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1, colorScheme: 'dark' });
      try {
        await page.goto(`http://127.0.0.1:${await viewer.start()}/`);
        await page.waitForSelector('#list > *');
        await page.waitForTimeout(1500); // Let the layout settle before recording.
        await page.screenshot({ path: join(output, `${id}.png`) });
        if (process.env.COVER_DUMP_TEXT) console.log(await page.innerText('body'));
      } finally { await page.close(); await viewer.close(); await rm(home, { recursive: true, force: true }); }
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
