// Real browser workspace check. Only the SSO redirect/exchange is mocked; the backend and
// owner daemon are disposable processes launched by cli/scripts/share-harness-e2e.ts.
const { chromium } = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { origin, backendUrl, token, root, password } = fixture;
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(backendUrl).hostname, '127.0.0.1');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = await context.newPage();
  const errors = [], calls = [];
  let cdp = await context.newCDPSession(page);
  async function editorReady(label, selector = `textarea[aria-label="${label}"]`) {
    // Accessibility creates the DOM textbox before Flutter attaches its text-input listener.
    // Wait for the real editor, as opposed to typing into that unbound DOM placeholder.
    const deadline = Date.now() + 5000;
    while (true) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `(() => { const selector = ${JSON.stringify(selector)}; function find(root) { const found = root.querySelector(selector); if (found) return found; for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { const nested = find(el.shadowRoot); if (nested) return nested; } } return null; } return find(document); })()`,
      });
      if (result.objectId) {
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
        await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
        if (listeners.some(listener => listener.type === 'input')) return;
      }
      if (Date.now() > deadline) throw new Error(`${label} never attached its browser input listener`);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
  }
  page.on('pageerror', error => errors.push(error.message));
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  async function semantics() {
    await page.locator('flutter-view').waitFor({ state: 'attached', timeout: 45000 });
    const placeholder = page.locator('flt-semantics-placeholder');
    if (await placeholder.count()) await placeholder.evaluate(el => el.click());
  }
  async function capture(name) {
    fs.writeFileSync(path.join(root, `workspace-${name}.txt`), await page.locator('body').ariaSnapshot());
    fs.writeFileSync(path.join(root, `workspace-${name}.html`), await page.content());
    await page.screenshot({ path: path.join(root, `workspace-${name}.png`) });
    fs.writeFileSync(path.join(root, `workspace-${name}-inputs.json`), JSON.stringify(await page.evaluate(() => ({
      active: document.activeElement?.outerHTML, inputs: [...document.querySelectorAll('input,textarea')].map(el => ({label: el.getAttribute('aria-label'), value: el.value, active: el === document.activeElement})),
      trace: window.workspaceInputTrace,
    })), null, 2));
  }
  try {
    await context.addInitScript(() => {
      window.workspaceInputTrace = [];
      for (const type of ['focusin', 'focusout', 'input', 'keydown', 'keyup']) document.addEventListener(type, e => {
        const label = e.target?.getAttribute?.('aria-label');
        if (label === 'Viewer input' || label === 'Terminal input') window.workspaceInputTrace.push({type, label, key: e.key, value: e.target.value});
      }, true);
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (![origin, backendUrl].includes(url.origin)) return route.abort();
      calls.push(url.pathname);
      if (url.pathname === '/api/auth/authorize-native') return route.fulfill({ headers: cors,
        contentType: 'application/json', body: JSON.stringify({ success: true, data: {
          authorizeUrl: `${origin}/fixture-authorize?state=workspace-fixture&redirect_uri=${encodeURIComponent(origin + '/callback')}`,
          tx: 'workspace-transaction',
        } }) });
      if (url.pathname === '/fixture-authorize') return route.fulfill({ status: 302,
        headers: { location: origin + '/callback?code=workspace-code&state=workspace-fixture' }, body: '' });
      if (url.pathname === '/api/auth/exchange') {
        assert.deepEqual(route.request().postDataJSON(), { code: 'workspace-code', state: 'workspace-fixture', tx: 'workspace-transaction' });
        return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
          token, refreshToken: 'fixture-refresh', expiresIn: 3600, autonomousEnv: 'prod',
        } }) });
      }
      return route.continue();
    });
    await page.goto(origin); await semantics();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/callback?**'); await semantics();
    // The initial link-required machine may open the picker during discovery.
    await page.getByRole('button', { name: 'Connect', exact: true }).waitFor({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.getByText('Harness like a boss.', { exact: true }).waitFor({ timeout: 30000 });
    await capture('welcome');
    await page.keyboard.press('Alt+m');
    await page.getByRole('button', { name: 'Connect', exact: true }).waitFor({ timeout: 30000 });
    await capture('machines');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await capture('link');
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForFunction(machineId => {
      const peers = JSON.parse(localStorage.getItem('harness.web.v1.viewer_e2ee_machine_peers') || '[]');
      return peers.some(peer => peer.machineId === machineId);
    }, fixture.machineId, { timeout: 60000 });
    await page.locator('input[type="password"]').waitFor({ state: 'detached', timeout: 30000 });
    await page.getByText(/Connected/).first().waitFor({ timeout: 30000 });
    await capture('linked');
    await page.keyboard.press('Escape');
    if (await page.getByRole('textbox', { name: 'Search results Search machines', exact: true }).count()) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Work from your phone', exact: true }).click();
    await page.getByRole('img', { name: 'QR code to add your phone', exact: true }).waitFor({ timeout: 15000 });
    await page.getByText('owner test machine', { exact: true }).waitFor();
    await page.getByRole('dialog').getByText('Scan with Harness on your iPhone', { exact: true }).first().waitFor();
    await capture('phone');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Alt+I Deploy a local model', exact: true }).click();
    await page.getByRole('textbox').first().fill(':api');
    await page.getByRole('button', { name: /^\[ Add \] Connect an API/ }).click();
    await page.getByRole('button', { name: 'fal.ai', exact: true }).click();
    await page.locator('input[type="password"]').click();
    await editorReady('API key', 'input[type="password"]');
    await page.locator('input[type="password"]').fill('browser-fixture-api-key');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const apiFile = path.join(root, 'owner/data/api-connections/connections.json');
    const apiDeadline = Date.now() + 10000;
    while (!fs.existsSync(apiFile) || !fs.readFileSync(apiFile, 'utf8').includes('browser-fixture-api-key')) {
      if (Date.now() > apiDeadline) throw new Error('The selected daemon did not save the fixture API key');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(!JSON.stringify(await page.evaluate(() => ({...localStorage}))).includes('browser-fixture-api-key'));
    await capture('api-saved');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Shift+p');
    await page.getByRole('textbox').first().fill('>orchestrator');
    await page.getByRole('button', { name: /Create with the orchestrator/ }).click();
    await page.getByRole('group', { name: /Orchestrator What would you like to make/ }).waitFor();
    assert.match(await page.locator('body').ariaSnapshot(), /Runs on owner test machine/);
    await capture('orchestrator');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.keyboard.press('Alt+p');
    await page.getByRole('textbox').first().fill('Sharing demo');
    await page.getByRole('button', { name: /^Sharing demo/ }).click();
    await page.getByRole('button', { name: 'Connecting', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
    // Prove the viewer is interactive on the remote machine, rather than a local placeholder.
    const viewer = page.getByRole('textbox', { name: 'Viewer input', exact: true });
    await viewer.waitFor({ timeout: 45000 });
    await viewer.click({ position: { x: 70, y: 125 } });
    async function viewerReceived(marker) {
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(path.join(root, 'viewer-events.log')) ||
             !fs.readFileSync(path.join(root, 'viewer-events.log'), 'utf8').includes(marker)) {
        if (Date.now() > deadline) throw new Error(`The remote viewer did not receive ${marker}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await viewerReceived('click=1');
    await viewer.click({ position: { x: 70, y: 205 } });
    await editorReady('Viewer input');
    await page.keyboard.type('browser-viewer');
    await viewerReceived('text=browser-viewer');
    await capture('viewer');
    // The fixture's specialized harness opens a viewer beside its terminal on the right.
    await page.getByRole('textbox', { name: 'Terminal input', exact: true }).click();
    await editorReady('Terminal input');
    await page.keyboard.type('browser-workspace-input');
    await page.keyboard.press('Enter');
    // The raw-mode fixture gets one chunk per keyboard event, just like a real TUI. Check
    // its received bytes, not an assumption that all letters arrive in one output frame.
    const inputDeadline = Date.now() + 15000;
    while (!fs.readFileSync(path.join(root, 'fixture-input.bin'), 'utf8').includes('browser-workspace-input\r')) {
      if (Date.now() > inputDeadline) throw new Error('The terminal did not receive the typed command');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await capture('agent');
    const peers = await page.evaluate(() => localStorage.getItem('harness.web.v1.viewer_e2ee_machine_peers'));
    assert.ok(JSON.parse(peers).some(peer => peer.machineId === fixture.machineId));
    await page.reload(); await semantics();
    await page.getByRole('link', { name: 'Download app', exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('harness.web.v1.viewer_e2ee_machine_peers')), peers);
    assert.equal(calls.filter(call => call === '/api/auth/exchange').length, 1);
    await capture('reloaded');
    const terminalBounds = await page.getByRole('textbox', { name: 'Terminal input', exact: true }).boundingBox();
    assert.ok(terminalBounds);
    await page.close();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    page.on('pageerror', error => errors.push(error.message));
    // Test ordinary pointer/keyboard input too. This tab never enables accessibility semantics.
    let terminalReady = false;
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try { if (JSON.parse(payload).type === 'terminal_ready') terminalReady = true; } catch {}
    }));
    await page.goto(origin);
    const readyDeadline = Date.now() + 30000;
    while (!terminalReady) {
      if (Date.now() > readyDeadline) throw new Error('The ordinary browser tab did not attach its terminal');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await page.mouse.click(terminalBounds.x + 24, terminalBounds.y + 48);
    await editorReady('ordinary terminal', 'flt-text-editing-host textarea, flt-text-editing-host input');
    await page.keyboard.type('browser-default-input');
    await page.keyboard.press('Enter');
    const normalDeadline = Date.now() + 10000;
    while (!fs.readFileSync(path.join(root, 'fixture-input.bin'), 'utf8').includes('browser-default-input\r')) {
      if (Date.now() > normalDeadline) throw new Error('Ordinary browser input did not reach the terminal');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await page.screenshot({ path: path.join(root, 'workspace-ordinary-input.png') });
    assert.deepEqual(errors, []);
    console.log('PASS browser workspace: sign-in, machine linking, phone QR, API persistence, agent picker, ordinary/accessibility terminal input, interactive viewer, and reload');
  } catch (error) {
    await capture('failure');
    fs.writeFileSync(path.join(root, 'workspace-failure-details.txt'), `${error.stack}\n${JSON.stringify({ errors, calls })}`);
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
