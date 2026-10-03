// Invoked by cli/scripts/share-harness-e2e.ts against disposable accounts and services only.
const { chromium } = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { origin, backendUrl, mode, token, root } = fixture;
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(backendUrl).hostname, '127.0.0.1');
const link = new URL(fixture.url);
const address = origin + link.pathname + link.search + link.hash;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  async function semantics() {
    await page.locator('flutter-view').waitFor({ state: 'attached', timeout: 45000 });
    const placeholder = page.locator('flt-semantics-placeholder');
    if (await placeholder.count()) await placeholder.evaluate(el => el.click());
  }
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  try {
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      // Every application call below is real except the SSO redirect/code exchange. No real account
      // credentials or external analytics services may participate in this fixture.
      if (![origin, backendUrl].includes(url.origin)) return route.abort();
      if (url.pathname === '/api/auth/authorize-native') {
        return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
          authorizeUrl: `${origin}/fixture-authorize?state=share-fixture&redirect_uri=${encodeURIComponent(origin + '/callback')}`, tx: 'share-transaction',
        } }) });
      }
      if (url.pathname === '/fixture-authorize') {
        return route.fulfill({ status: 302, headers: { location: origin + '/callback?code=share-code&state=share-fixture' }, body: '' });
      }
      if (url.pathname === '/api/auth/exchange') {
        const input = route.request().postDataJSON();
        assert.equal(input.code, 'share-code'); assert.equal(input.state, 'share-fixture'); assert.equal(input.tx, 'share-transaction');
        return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
          token, refreshToken: 'fixture-refresh', expiresIn: 3600, autonomousEnv: 'prod',
        } }) });
      }
      return route.continue();
    });
    await page.goto(address); await semantics();
    if (mode !== 'public') {
      await page.getByText('This link is private. Sign in with an invited email.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/callback?**'); await semantics();
      await page.waitForURL(url => url.pathname === link.pathname && url.hash === link.hash, { timeout: 30000 });
      assert.ok(!page.url().includes('share-code'));
    }
    if (mode === 'denied') {
      await page.getByText('This link is unavailable or your email has not been invited. Ask the owner for access.', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.getByText('View only', { exact: true }).count(), 0);
    } else {
      await page.getByText('View only', { exact: true }).waitFor({ timeout: 30000 });
      await page.getByText('Live', { exact: true }).waitFor({ timeout: 30000 });
      await page.screenshot({ path: path.join(root, `share-${mode}-desktop.png`) });
      await page.getByRole('button', { name: 'Comments', exact: true }).click();
      await page.getByText('Comments (1)', { exact: true }).waitFor({ timeout: 30000 });
      fs.writeFileSync(path.join(root, `browser-${mode}-dom.html`), await page.content());
      const accessible = await page.locator('body').ariaSnapshot();
      fs.writeFileSync(path.join(root, `browser-${mode}-aria.txt`), accessible);
      assert.match(accessible, /Fixture collaboration/);
      if (mode === 'public') {
        await page.getByRole('button', { name: 'Sign in to comment', exact: true }).waitFor();
        assert.equal(await page.locator('textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled])').count(), 0);
      } else {
        const text = 'Browser collaborator — private link';
        await page.getByRole('textbox').last().fill(text);
        await page.getByRole('button', { name: 'Comment', exact: true }).click();
        await page.getByText('Comments (2)', { exact: true }).waitFor();
        assert.ok((await page.locator('body').ariaSnapshot()).includes(text));
        assert.equal(await page.getByRole('textbox').last().inputValue(), '');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(root, `share-${mode}-phone.png`) });
      const download = await page.getByRole('link', { name: 'Download app', exact: true }).boundingBox();
      assert.ok(download && download.x >= 0 && download.x + download.width <= 390);
      assert.equal(new URL(page.url()).hash, link.hash);
      await page.reload(); await semantics();
      await page.getByText('Live', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(new URL(page.url()).hash, link.hash);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS browser ${mode}: real encrypted sharing, access policy, comments, and responsive view`);
  } catch (error) {
    fs.writeFileSync(path.join(root, `browser-${mode}-failure.html`), await page.content());
    fs.writeFileSync(path.join(root, `browser-${mode}-failure.txt`), `${error.stack}\n${(await page.locator('body').innerText()).slice(0, 10000)}\n${errors.join('\n')}`);
    await page.screenshot({ path: path.join(root, `browser-${mode}-failure.png`) });
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
