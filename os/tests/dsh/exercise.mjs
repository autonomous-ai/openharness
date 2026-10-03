// Real managed agents, materialized DSHs and shared viewers inside the guest.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [root, report] = process.argv.slice(2);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
async function until(label, test, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
const status = await (await fetch('http://127.0.0.1:18473/api/status')).json();
assert.ok(status.machineId);
const agents = new Map(), pending = new Map(), frames = [];
const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws');
let connected = false;
ws.addEventListener('message', event => {
  const frame = JSON.parse(event.data);
  const { type, payload } = frame;
  if (type === 'connected') connected = true;
  if (type === 'agent_synced' && payload?.agent) agents.set(payload.agent.id, payload.agent);
  if (type?.endsWith('_result') && payload?.requestId && pending.has(payload.requestId)) {
    pending.get(payload.requestId)(payload); pending.delete(payload.requestId);
  }
  if (type === 'agent_synced' || type?.endsWith('_result')) frames.push(frame);
});
function request(type, payload, timeout = 180_000) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timed out`)); }, timeout);
    pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ type, payload: { ...payload, requestId } }));
  });
}
await until('WebSocket open', () => ws.readyState === WebSocket.OPEN, 15_000);
ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: status.machineId, localProtocolVersion: 1 } }));
await until('local machine handshake', () => connected, 15_000);
const list = await request('dsh_list', {});
for (const name of ['hello', 'logs', 'game']) assert.ok(list.dsh?.some(d => d.id === `os-lab/${name}` && d.installed));

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', chromiumSandbox: true, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const results = [];
try {
  for (const name of ['hello', 'logs', 'game']) {
    let agent;
    const cwd = join(root, 'projects', name), started = Date.now();
    mkdirSync(cwd, { recursive: true });
    const page = await context.newPage();
    try {
      const created = await request('agent_create', { engine: 'opencode', cwd, dsh: `os-lab/${name}`,
        creationId: randomUUID(), bypassPermission: true,
        prompt: 'Read TASK.txt and perform the complete task now. Run the tests, fix failures, and report the result. No questions or subagents.' });
      assert.equal(created.state, 'created', JSON.stringify(created));
      agent = created.agent;
      agents.set(agent.id, agent);
      assert.equal(agent.dsh, `os-lab/${name}`);
      await until('materialized instructions and task', () => existsSync(join(cwd, 'AGENTS.md')) && existsSync(join(cwd, 'TASK.txt')));
      execFileSync('hn', ['open-harness', '-s', agent.id], { timeout: 30_000 });
      if (name === 'hello') {
        await until('agent writes Ada greeting', () => /Hello,\s*Ada!/.test(read(join(cwd, 'index.html'))), 12 * 60_000);
        const viewer = await until('web viewer URL', () => agents.get(agent.id)?.viewerUrl);
        await page.goto(viewer);
        const heading = page.frameLocator('iframe').locator('h1');
        await heading.waitFor();
        assert.match(await heading.innerText(), /Hello,\s*Ada!/);
        // A real edit must reload the shared viewer without restarting its agent.
        writeFileSync(join(cwd, 'index.html'), read(join(cwd, 'index.html')).replace('Hello, Ada!', 'Hello, Grace!'));
        await until('live viewer reload', async () => /Hello,\s*Grace!/.test(await heading.innerText().catch(() => '')));
      } else if (name === 'logs') {
        await until('agent generates CSV tool and result', () => existsSync(join(cwd, 'count.py')) && existsSync(join(cwd, 'result.json')), 12 * 60_000);
        const output = execFileSync('python3', ['count.py', 'sample.csv'], { cwd, timeout: 30_000 }).toString();
        assert.deepEqual(JSON.parse(output), { bug: 2, feature: 1 });
        const input = execFileSync('python3', ['count.py', '-'], { cwd, input: 'kind,title\nchore,Probe\n', timeout: 30_000 }).toString();
        assert.deepEqual(JSON.parse(input), { chore: 1 });
        assert.ok(!agents.get(agent.id)?.viewerUrl, 'Terminal DSH must not create a viewer');
        writeFileSync(join(report, 'logs-output.json'), output);
        execFileSync('python3', ['-m', 'unittest', 'discover', '-v'], { cwd, timeout: 30_000 });
      } else {
        await until('agent implements game change and tests', () => existsSync(join(cwd, 'state.mjs')) && existsSync(join(cwd, 'test.mjs')) && existsSync(join(cwd, 'agent-result.txt')), 12 * 60_000);
        writeFileSync(join(report, 'game-unit-tests.txt'), execFileSync('node', ['--test', 'test.mjs'], { cwd, timeout: 30_000 }));
        const viewer = await until('game viewer URL', () => agents.get(agent.id)?.viewerUrl);
        await page.goto(viewer);
        await until('game truly rendered', async () => {
          const state = await (await fetch(new URL('/api/state', viewer))).json();
          return state.status === 'ready';
        });
        assert.equal(JSON.parse(read(join(cwd, '.harness/verdict.json'))).ready, true);
        await page.locator('#play').focus(); await page.keyboard.press('Enter');
        const frame = await until('playable frame', () => page.frames().find(f => f !== page.mainFrame() && !f.isDetached()));
        await frame.locator('canvas').focus();
        await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
        assert.equal(await frame.evaluate(() => window.harnessGame.stats().score), 1);
        await page.keyboard.press('r');
        assert.equal(await frame.evaluate(() => window.harnessGame.stats().score), 0);
        assert.deepEqual(await frame.evaluate(() => window.harnessGame.stats().player), { x: 1, y: 1 });
        await page.locator('#pause').focus(); await page.keyboard.press('Enter');
        // The toolbar sends a postMessage to the game. Input delivery and the
        // iframe's receipt are separate browser tasks.
        await until('pause reaches game frame', () => frame.evaluate(() => window.harnessGame.stats().paused), 10_000);
        await page.locator('#details').focus(); await page.keyboard.press('Enter');
        await page.locator('#export').focus(); await page.keyboard.press('Enter');
        await until('standalone game export', () => existsSync(join(cwd, 'out')) && readdirSync(join(cwd, 'out')).some(name => name.startsWith('game-') && existsSync(join(cwd, 'out', name, 'index.html'))));
      }
      if (name !== 'logs') await page.screenshot({ path: join(report, `${name}-viewer.png`), fullPage: true });
      results.push({ name, status: 'passed', agentId: agent.id, seconds: (Date.now() - started) / 1000 });
    } catch (error) {
      results.push({ name, status: 'failed', error: error.stack || String(error), seconds: (Date.now() - started) / 1000 });
      await page.screenshot({ path: join(report, `${name}-failure.png`) }).catch(() => {});
    } finally {
      if (agent?.tmuxPane) {
        try { writeFileSync(join(report, `${name}-terminal.txt`), execFileSync('tmux', ['capture-pane', '-p', '-S', '-200', '-t', agent.tmuxPane], { timeout: 10_000 })); } catch {}
      }
      if (agent) await request('agent_delete', { agentId: agent.id }, 30_000).catch(error => console.error(String(error)));
      await page.close();
      writeFileSync(join(report, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally {
  writeFileSync(join(report, 'frames.json'), JSON.stringify(frames, null, 2));
  await browser.close();
  ws.close();
}
if (results.some(row => row.status !== 'passed')) process.exitCode = 1;
