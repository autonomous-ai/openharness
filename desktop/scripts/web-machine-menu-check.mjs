#!/usr/bin/env node
// Right-clicks and clicks a machine row in a real browser, on a release build. No CI job runs Flutter in a browser, so
// a change to the row's menu runs this by hand. It uses Node's own WebSocket and installs nothing.
//
//   flutter build web --release --no-wasm-dry-run --no-web-resources-cdn \
//     -t test/web/release/machine_row_app.dart --output=OUT
//   CHROME_EXECUTABLE=/path/to/chrome-headless-shell node scripts/web-machine-menu-check.mjs OUT
//
// Exits 1 if any check fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const dir = process.argv[2];
const exe = process.env.CHROME_EXECUTABLE;
if (!dir || !exe) {
  console.error('usage: CHROME_EXECUTABLE=... node web-machine-menu-check.mjs BUILD_DIR');
  process.exit(2);
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname);
  try {
    const body = readFileSync(join(dir, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path) || '.html'] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const profile = mkdtempSync(join(tmpdir(), 'web-machine-menu-'));
const chrome = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1400,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failed = 0;
try {
  const port = await new Promise((done, fail) => {
    let text = '';
    chrome.stderr.on('data', (chunk) => {
      text += chunk;
      const found = text.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (found) done(found[1]);
    });
    setTimeout(() => fail(new Error('the browser did not start')), 30000);
  });
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done));
  let id = 0;
  const waiting = new Map();
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const send = (method, params = {}) =>
    new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const read = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;

  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  const rect = async (key) => {
    const all = (await read('document.body.dataset.rects')) ?? '';
    const row = all.split(';').find((r) => r.startsWith(`${key}=`));
    if (!row) return null;
    const [x, y, w, h] = row.split('=')[1].split(',').map(Number);
    return { x: x + w / 2, y: y + h / 2, w, bottom: y + h };
  };
  for (let i = 0; i < 120 && !(await rect('super-machine-studio')); i++) await sleep(500);
  await read(`window.__menus = []; window.addEventListener('contextmenu', (e) => window.__menus.push(e.defaultPrevented))`);

  const mouse = (type, { x, y }, button = 'none', buttons = 0) =>
    send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: button === 'none' ? 0 : 1 });
  const move = async (at) => { await mouse('mouseMoved', at); await sleep(300); };
  const click = async (at, button) => {
    const buttons = button === 'right' ? 2 : 1;
    await mouse('mousePressed', at, button, buttons);
    await mouse('mouseReleased', at, button, 0);
    await sleep(500);
  };
  const escape = async () => {
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await sleep(500);
  };
  const browserMenu = async () => (await read('window.__menus.at(-1)')) === false;
  const swarmMenu = async () => (await read('document.title')) === 'menu-open';
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  };

  const row = await rect('super-machine-studio');
  const terminal = await rect('super-machine-check-terminal');
  await move(row);
  await click(row, 'right');
  check('right-click on a machine row opens the Swarm menu, not the browser menu', (await swarmMenu()) && !(await browserMenu()));
  const before = await read('window.__menus.length');
  await click({ x: row.x, y: row.y + 200 }, 'right');
  const fired = (await read('window.__menus.length')) > before;
  check('a second right-click with that menu open does not bring up the browser menu', fired && !(await browserMenu()));
  if (await swarmMenu()) await escape();

  await move(row);
  await click(row, 'left');
  await sleep(300);
  const entry = await rect('super-machine-entry-studio');
  const below = { x: entry.x, y: entry.bottom - 6 };
  await move(below);
  await click(below, 'right');
  check("right-click on an expanded machine's readings opens the Swarm menu, not the browser menu", (await swarmMenu()) && !(await browserMenu()));
  if (await swarmMenu()) await escape();
  await move(row);
  await click(row, 'left');
  await sleep(300);

  await move(terminal);
  await click(terminal, 'right');
  check("a terminal's right-click still gives the browser's Copy and Paste", await browserMenu());

  await move(row);
  const more = await rect('super-machine-more-studio');
  check('pointing at the row shows the ⋯', !!more && more.w > 0);
  if (more) {
    await move(more);
    await click(more, 'left');
    check('a left click on the ⋯ opens the Swarm menu', await swarmMenu());
    if (await swarmMenu()) await escape();
  }
  await move(terminal);
  await click(terminal, 'right');
  check("after the menu closes the terminal's right-click is the browser's again", await browserMenu());
} finally {
  chrome.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
