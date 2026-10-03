// Exercise generated applications with the OS's sandboxed Chromium, not a downloaded browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [work, report] = process.argv.slice(2);
mkdirSync(report, { recursive: true });
const results = [];
const servers = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(name, command, args, env = {}) {
  const log = openSync(join(report, `${name}-server.log`), 'a');
  const child = spawn(command, args, { cwd: join(work, name), env: { ...process.env, ...env },
    detached: true, stdio: ['ignore', log, log] });
  servers.add(child);
  return child;
}
async function stop(child) {
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 50 && child.exitCode === null; i++) await delay(100);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
  servers.delete(child);
}
async function available(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(500);
  }
  throw new Error(`Server did not become ready: ${url}`);
}
async function row(name, check) {
  const started = Date.now();
  try { await check(); results.push({ name, status: 'passed', seconds: (Date.now() - started) / 1000 }); }
  catch (error) { results.push({ name, status: 'failed', error: String(error), seconds: (Date.now() - started) / 1000 }); }
  console.log(JSON.stringify(results.at(-1)));
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', chromiumSandbox: true, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
try {
  await row('website keyboard filtering and help', async () => {
    const child = start('website', 'python3', ['-m', 'http.server', '18881', '--bind', '127.0.0.1']);
    const page = await context.newPage();
    try {
      await available('http://127.0.0.1:18881');
      await page.goto('http://127.0.0.1:18881');
      assert.ok(await page.locator('article.talk:visible').count() >= 6, 'Six talks must be visible initially');
      await page.screenshot({ path: join(report, 'website.png'), fullPage: true });
      await page.locator('#search').focus();
      await page.keyboard.type('no-such-conference-talk-987');
      await page.waitForFunction(() => ![...document.querySelectorAll('article.talk')].some(t => !t.hidden));
      await page.locator('#search').fill('');
      await page.locator('#day-filter').focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const day = await page.locator('#day-filter').inputValue();
      assert.notEqual(day, 'all');
      assert.ok(await page.locator('article.talk:visible').count() > 0);
      assert.ok(await page.locator('article.talk:visible').evaluateAll((talks, selected) => talks.every(t => t.dataset.day === selected), day));
      await page.locator('#help-button').focus();
      await page.keyboard.press('Enter');
      await page.locator('dialog').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.locator('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'help-button', 'Help restores keyboard focus');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow on a phone');
      await page.screenshot({ path: join(report, 'website-mobile.png'), fullPage: true });
    } finally { await page.close(); await stop(child); }
  });
  await row('game movement pause restart and state restoration', async () => {
    const child = start('game', 'python3', ['-m', 'http.server', '18883', '--bind', '127.0.0.1']);
    const page = await context.newPage();
    try {
      await available('http://127.0.0.1:18883');
      await page.goto('http://127.0.0.1:18883');
      await page.waitForFunction(() => window.harnessGame?.stats);
      for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        assert.ok(await page.evaluate(() => {
          const board = document.querySelector('canvas').getBoundingClientRect();
          const legend = document.querySelector('.legend').getBoundingClientRect();
          return board.width > 200 && board.height > 200 && board.top >= 0 &&
            board.bottom <= innerHeight && legend.bottom <= innerHeight &&
            document.documentElement.scrollHeight <= innerHeight + 1;
        }), 'The whole game and keyboard legend fit the laptop viewport');
      }
      await page.keyboard.press('Enter');
      await page.screenshot({ path: join(report, 'game.png') });
      let moved = false;
      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
        const before = await page.evaluate(() => window.harnessGame.stats().player);
        await page.keyboard.down(key); await delay(150); await page.keyboard.up(key);
        const after = await page.evaluate(() => window.harnessGame.stats().player);
        if (JSON.stringify(before) !== JSON.stringify(after)) { moved = true; break; }
      }
      assert.ok(moved, 'Arrow keys move the player');
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => window.harnessGame.stats().paused), true);
      const frozen = await page.evaluate(() => window.harnessGame.captureState());
      await delay(300);
      assert.deepEqual(await page.evaluate(() => window.harnessGame.captureState()), frozen, 'Pause freezes simulation');
      await page.keyboard.press('r');
      assert.equal(await page.evaluate(() => window.harnessGame.stats().score), 0);
      await page.evaluate(state => { window.harnessGame.setPaused(true); window.harnessGame.restoreState(state); }, frozen);
      assert.deepEqual(await page.evaluate(() => window.harnessGame.captureState()), frozen);
    } finally { await page.close(); await stop(child); }
  });
  await row('fullstack browser CRUD validation and persistence', async () => {
    const url = 'http://127.0.0.1:18882';
    const env = { PORT: '18882', DB_PATH: join(report, 'acceptance.sqlite') };
    let child = start('fullstack', 'npm', ['start'], env);
    const page = await context.newPage();
    const request = (path, method = 'GET', data) => fetch(url + path, { method,
      ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
    try {
      await available(url);
      assert.equal((await request('/api/issues', 'POST', { title: '' })).status, 400);
      assert.equal((await request('/api/issues/9999999', 'PATCH', { status: 'done' })).status, 404);
      await page.goto(url);
      await page.locator('#issue-title').focus(); await page.keyboard.type('Built on Programmer OS');
      await page.locator('#issue-body').fill('Created through the real keyboard-accessible frontend.');
      await page.locator('#create-issue').focus(); await page.keyboard.press('Enter');
      await page.getByText('Built on Programmer OS', { exact: true }).waitFor();
      const list = await (await request('/api/issues')).json();
      const item = list.find(issue => issue.title === 'Built on Programmer OS');
      assert.ok(item?.id); assert.equal(item.status, 'open');
      assert.equal((await request(`/api/issues/${item.id}`, 'PATCH', { status: 'invalid' })).status, 400);
      assert.ok((await request(`/api/issues/${item.id}`, 'PATCH', { status: 'done' })).ok);
      await page.reload();
      await page.screenshot({ path: join(report, 'fullstack.png'), fullPage: true });
      await stop(child); child = start('fullstack', 'npm', ['start'], env); await available(url);
      const restored = await (await request('/api/issues')).json();
      assert.equal(restored.find(issue => issue.id === item.id)?.status, 'done', 'SQLite data survives a server restart');
      assert.ok((await request(`/api/issues/${item.id}`, 'DELETE')).ok);
      assert.ok(!(await (await request('/api/issues')).json()).some(issue => issue.id === item.id));
    } finally { await page.close(); await stop(child); }
  });
} finally {
  await browser.close();
  for (const child of servers) await stop(child);
  writeFileSync(join(report, 'browser-receipt.json'), JSON.stringify({ chromium: browser.version(), results }, null, 2) + '\n');
}
if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
