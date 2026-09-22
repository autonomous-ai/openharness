// Native Typst PDFs, real pdf.js text layers and Chrome pointer interactions.
// TYPST=/path/to/typst PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/review-browser.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const typst = process.env.TYPST || 'typst'
const evidence = resolve(
  process.env.EVIDENCE ||
    '/private/tmp/openharness-harness-improvements-evidence/doc-review'
)
const workspace = join(evidence, 'workspace-' + Date.now())
mkdirSync(join(workspace, 'out'), { recursive: true })
const source = readFileSync(join(pkg, 'test/fixtures/field-notes.typ'))
writeFileSync(join(workspace, 'field-notes.typ'), source)
const livePdf = join(workspace, 'out/field-notes.pdf')
execFileSync(typst, ['compile', join(workspace, 'field-notes.typ'), livePdf])
const original = readFileSync(livePdf)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const port = await new Promise((resolve, reject) => {
  const probe = createServer()
    .listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
    .on('error', reject)
})
const url = `http://127.0.0.1:${port}`
const errors = [],
  checks = []
let server,
  browser,
  page,
  log = ''
async function startServer() {
  log = ''
  server = spawn(process.execPath, [join(pkg, 'viewer.mjs')], {
    env: {
      ...process.env,
      HARNESS_WORKSPACE: workspace,
      HARNESS_VIEWER_PORT: String(port),
      DOC_VIEWER_OPEN: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stdout.on('data', (b) => {
    log += b
  })
  server.stderr.on('data', (b) => {
    log += b
  })
  for (let i = 0; i < 150 && !log.includes('listening'); i++)
    await new Promise((r) => setTimeout(r, 30))
  assert.match(log, /listening/)
}
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const stopped = new Promise((r) => server.once('exit', r))
  server.kill()
  await stopped
}
async function ready(pages) {
  await page.waitForFunction(
    (n) => window.docViewer?.pages === n && !window.docViewer.review.busy,
    pages
  )
  await page.locator('.viewerContainer.live .textLayer span').first().waitFor()
}
async function go(number) {
  await page.locator('#page-input').fill(String(number))
  await page.locator('#page-input').press('Enter')
  await page.waitForFunction((n) => window.docViewer.page === n, number)
}
async function quote(text, note, kind = 'change') {
  const span = page
    .locator('.viewerContainer.live .textLayer span[style]')
    .filter({ hasText: text })
    .first()
  await span.scrollIntoViewIfNeeded()
  const box = await span.boundingBox()
  await page.mouse.move(box.x + 0.5, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 0.5, box.y + box.height / 2, {
    steps: 24
  })
  await page.mouse.up()
  const selected = await page.evaluate(() => window.getSelection().toString())
  if (!selected)
    throw new Error(
      'Pointer text selection was empty: ' +
        JSON.stringify({
          box,
          layer: await span.evaluate((el) => ({
            html: el.outerHTML,
            rect: el.getBoundingClientRect().toJSON(),
            at: document
              .elementsFromPoint(
                el.getBoundingClientRect().x + 1,
                el.getBoundingClientRect().y + 2
              )
              .map((n) => n.className)
          }))
        })
    )
  await page.locator('#review-selection').click()
  await page.locator('#review-text').fill(note)
  await page.locator('#review-kind').selectOption(kind)
  await page.locator('#review-add').click()
}
async function save() {
  await page.locator('#review-save').click()
  await page.waitForFunction(
    () => !window.docViewer.review.busy && !window.docViewer.review.dirty
  )
  return page.evaluate(() => window.docViewer.review.keptId)
}
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + '.png') })
}

try {
  await startServer()
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    colorScheme: 'light',
    acceptDownloads: true,
    ...(process.env.RECORD_VIDEO
      ? {
          recordVideo: {
            dir: join(evidence, 'video'),
            size: { width: 1280, height: 960 }
          }
        }
      : {})
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(
    url + '/?file=out/field-notes.pdf' + (process.env.LEGACY ? '&legacy=1' : '')
  )
  await ready(3)
  await page.locator('#btn-review').click()
  await page.locator('#review-start').click()
  await page.waitForFunction(
    () => window.docViewer.review.draft && !window.docViewer.review.busy
  )
  await page
    .locator('#review-title')
    .fill('Portable light · prototype decisions')
  await quote(
    'A full workday should fit in one charge.',
    'Specify reading brightness before checking this target.'
  )
  assert.equal(
    await page.evaluate(() => window.docViewer.review.draft.notes[0].quote),
    'A full workday should fit in one charge.'
  )
  await quote(
    'Every surface uses a glossy finish.',
    'Use a matte finish on the surfaces touched most often.'
  )
  await go(1)
  await page.locator('#review-area').click()
  const box = await page
    .locator('.live .page[data-page-number="1"]')
    .boundingBox()
  await page.mouse.move(box.x + box.width * 0.29, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.74, box.y + box.height * 0.47, {
    steps: 24
  })
  await page.mouse.up()
  await page
    .locator('#review-text')
    .fill('Keep the quiet proportions while testing two base widths.')
  await page.locator('#review-kind').selectOption('keep')
  await page.locator('#review-add').click()
  await go(2)
  await page.locator('#review-page').click()
  await page.locator('#review-kind').selectOption('question')
  await page
    .locator('#review-text')
    .fill('Can the battery be changed with a single common screwdriver?')
  await page.locator('#review-add').click()
  await go(1)
  const draft = await page.evaluate(() => window.docViewer.review.draft)
  assert.equal(draft.notes.length, 4)
  assert.equal(draft.source.sha256, sha(original))
  assert.equal(draft.notes[2].rects.length, 1)
  assert.equal(draft.notes[3].page, 2)
  assert.equal(await page.locator('.live .review-pin').count(), 4)
  const beforeKeep = readFileSync(livePdf)
  const kept = await save()
  assert.deepEqual(readFileSync(livePdf), beforeKeep)
  assert.deepEqual(
    readFileSync(
      join(workspace, '.harness/doc-reviews', kept, 'reference.pdf')
    ),
    original
  )
  const downloading = page.waitForEvent('download')
  await page.locator('#review-download').click()
  const downloaded = await downloading
  const zipPath = join(evidence, 'kept-review.zip')
  await downloaded.saveAs(zipPath)
  const zipCheck = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,sys,zipfile,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"sha": hashlib.sha256(z.read("reference.pdf")).hexdigest(), "notes": len(json.loads(z.read("review.json"))["notes"]), "bad": z.testzip()}))',
        zipPath
      ],
      { encoding: 'utf8' }
    )
  )
  assert.deepEqual(zipCheck, { sha: sha(original), notes: 4, bad: null })
  await page.locator('#review-panel').evaluate((el) => {
    el.scrollTop = 0
  })
  await capture('review-desktop')
  await page.locator('#review-area').click()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.review-pick-layer').count(), 0)
  await page.locator('#btn-review').click()
  await page.locator('.live .review-pin').first().click()
  await page.locator('#review-panel').waitFor({ state: 'visible' })
  assert.equal(
    await page
      .locator('#review-notes .review-note.selected .review-jump')
      .textContent(),
    '1. Change · page 1'
  )
  checks.push(
    'Native text selection, rectangle and page notes; exact PDF packet; browser ZIP download independently verified'
  )

  const heldHash = await page.evaluate(() => window.docViewer.hash)
  execFileSync(typst, [
    'compile',
    '--input',
    'revision=latest',
    join(workspace, 'field-notes.typ'),
    livePdf
  ])
  await page.locator('#review-pending').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.docViewer.hash), heldHash)
  assert.equal(await page.evaluate(() => window.docViewer.pages), 3)
  await page.locator('#review-latest').click()
  await ready(4)
  await page.locator('#review-notes .review-jump').nth(0).click()
  await page.waitForFunction(() =>
    document.querySelector('#review-status').textContent.includes('on page 2')
  )
  assert.equal(await page.evaluate(() => window.docViewer.page), 2)
  await capture('review-latest')
  await page.locator('#review-notes .review-jump').nth(1).click()
  await page.waitForFunction(() =>
    document
      .querySelector('#review-status')
      .textContent.includes('quote is absent')
  )
  await page.locator('#review-notes .review-jump').nth(2).click()
  assert.match(
    await page.locator('#review-status').textContent(),
    /anchored to the reviewed draft/
  )
  await page.locator('#review-original').click()
  await ready(3)
  assert.equal(await page.evaluate(() => window.docViewer.hash), heldHash)
  await page.locator('#btn-more').click()
  const downloadingPdf = page.waitForEvent('download')
  await page
    .getByRole('menuitem', { name: 'Download PDF', exact: true })
    .click()
  await (await downloadingPdf).saveAs(join(evidence, 'displayed-draft.pdf'))
  assert.equal(
    sha(readFileSync(join(evidence, 'displayed-draft.pdf'))),
    sha(original),
    'Download PDF must use the held bytes, not the newer workspace file'
  )
  checks.push(
    'Live updates defer; quoted text follows page 1 to page 2; changed wording is absent; region never guesses; Download PDF preserves the displayed draft'
  )

  // A repeated quote must be reported as ambiguous, even when one occurrence is on the old page.
  const duplicateSource = Buffer.from(
    source
      .toString()
      .replace(
        '= What changed',
        '= What changed\nA full workday should fit in one charge.'
      )
  )
  writeFileSync(join(workspace, 'field-notes.typ'), duplicateSource)
  execFileSync(typst, [
    'compile',
    '--input',
    'revision=latest',
    join(workspace, 'field-notes.typ'),
    livePdf
  ])
  await page.locator('#review-latest').click()
  await ready(4)
  await page.locator('#review-notes .review-jump').nth(0).click()
  await page.waitForFunction(() =>
    document.querySelector('#review-status').textContent.includes('ambiguous')
  )
  await page.locator('#review-original').click()
  await ready(3)
  checks.push('Repeated quoted wording is reported as ambiguous')

  // Save fails after the server has published the packet, emulating a lost acknowledgement.
  await page
    .locator('#review-title')
    .fill('Portable light · after the discussion')
  let lost = true
  await page.route('**/api/reviews', async (route) => {
    if (route.request().method() !== 'POST' || !lost) return route.continue()
    lost = false
    await route.fetch()
    await route.abort('failed')
  })
  await page.locator('#review-save').click()
  await page.waitForFunction(
    () =>
      !window.docViewer.review.busy &&
      document
        .querySelector('#review-status')
        .textContent.includes('still in this tab')
  )
  assert.equal(
    await page.evaluate(() => window.docViewer.review.draft.notes.length),
    4
  )
  const packetsBefore = readdirSync(
    join(workspace, '.harness/doc-reviews')
  ).filter((name) => !name.startsWith('.')).length
  const retryId = await save()
  assert.equal(
    readdirSync(join(workspace, '.harness/doc-reviews')).filter(
      (name) => !name.startsWith('.')
    ).length,
    packetsBefore
  )
  await page.unroute('**/api/reviews')
  await stopServer()
  await startServer()
  await page
    .locator('#review-title')
    .fill('Portable light · resumed after restart')
  const restartedId = await save()
  assert.notEqual(restartedId, retryId)
  checks.push(
    'Lost save acknowledgement is retryable without duplicate packets; server restart refreshes the write token without losing notes'
  )

  await page.locator('#review-close').click()
  await ready(4)
  await page.locator('#btn-review').click()
  rmSync(livePdf)
  await page.reload()
  await page.locator('#btn-review').waitFor({ state: 'visible' })
  await page.locator('#btn-review').click()
  await page
    .locator('#review-library .review-jump')
    .filter({ hasText: 'resumed after restart' })
    .click()
  await ready(3)
  assert.equal(await page.locator('.live .review-pin').count(), 4)
  assert.equal((await (await fetch(url + '/api/state')).json()).pdf, null)
  checks.push(
    'Kept review reopens after reload and removal of the original PDF; the archive never replaces the live source'
  )

  // The same saved anchors track native page scaling on a narrow screen.
  await page.setViewportSize({ width: 390, height: 844 })
  await go(1)
  await page.locator('#review-notes .review-jump').first().click()
  await capture('review-mobile')
  const mobile = await page.evaluate(() => {
    const stage = document.querySelector('#stage').getBoundingClientRect(),
      panel = document.querySelector('#review-panel').getBoundingClientRect()
    const page = document.querySelector('.live .page[data-page-number="1"]'),
      mark = page.querySelector('.review-highlight'),
      p = page.getBoundingClientRect(),
      m = mark.getBoundingClientRect()
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      stage: { height: stage.height, bottom: stage.bottom },
      panel: { top: panel.top, width: panel.width },
      toolbar: {
        navRight: document.querySelector('.tb-center').getBoundingClientRect()
          .right,
        reviewLeft: document
          .querySelector('#btn-review')
          .getBoundingClientRect().left,
        reviewHeight: document
          .querySelector('#btn-review')
          .getBoundingClientRect().height
      },
      anchor: [
        (m.left - p.left) / p.width,
        (m.top - p.top) / p.height,
        m.width / p.width,
        m.height / p.height
      ]
    }
  })
  assert.equal(mobile.overflow, false)
  assert.ok(mobile.stage.height > 150)
  assert.ok(mobile.panel.top >= mobile.stage.bottom - 1)
  assert.equal(mobile.panel.width, 390)
  assert.ok(mobile.toolbar.reviewLeft >= mobile.toolbar.navRight)
  assert.ok(mobile.toolbar.reviewHeight < 35)
  const expected = draft.notes[0].rects[0]
  mobile.anchor.forEach((value, i) =>
    assert.ok(
      Math.abs(value - expected[i]) < 0.005,
      'scaled highlight must follow the same PDF location'
    )
  )
  checks.push(
    '390 px layout keeps PDF and review visible; highlights remain on the same normalized page rectangle'
  )

  await page.setViewportSize({ width: 1280, height: 960 })
  await page.locator('#review-title').fill('Temporary unsaved title')
  await page.locator('#review-close').click()
  await page.locator('#btn-review').click()
  assert.equal(await page.evaluate(() => window.docViewer.review.dirty), true)
  await page.locator('#review-original').click()
  await ready(3)
  await page.locator('#review-discard').click()
  assert.equal(
    await page.evaluate(() => window.docViewer.review.draft.notes.length),
    4
  )
  await page.locator('#review-discard').click()
  await page.waitForFunction(
    () => !window.docViewer.review.draft && !window.docViewer.review.holding
  )
  await page.waitForFunction(() => window.docViewer.pages === 0)
  assert.ok((await (await fetch(url + '/api/reviews')).json()).length >= 3)
  checks.push(
    'Back to live retains unsaved notes; clearing them takes a second explicit click and preserves kept packets'
  )

  // A compile can already be in flight when the reviewer decides to hold the visible draft.
  writeFileSync(livePdf, original)
  await ready(3)
  let release, intercepted
  const gate = new Promise((r) => {
    release = r
  })
  const fetched = new Promise((r) => {
    intercepted = r
  })
  await page.route('**/ws/out/field-notes.pdf?*', async (route) => {
    intercepted()
    await gate
    await route.continue()
  })
  execFileSync(typst, [
    'compile',
    '--input',
    'revision=latest',
    join(workspace, 'field-notes.typ'),
    livePdf
  ])
  await fetched
  await page.locator('#review-start').focus()
  await page.locator('#review-start').press('Space')
  await page.waitForFunction(
    () => window.docViewer.review.draft && !window.docViewer.review.busy
  )
  const pendingResponse = page.waitForResponse((response) =>
    response.url().includes('/ws/out/field-notes.pdf?')
  )
  release()
  await (await pendingResponse).finished()
  await page.unroute('**/ws/out/field-notes.pdf?*')
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  )
  assert.equal(await page.evaluate(() => window.docViewer.pages), 3)
  assert.equal(
    await page.evaluate(() => window.docViewer.review.draft.source.sha256),
    sha(original)
  )
  checks.push(
    'A pending live PDF fetch cannot replace the draft held with keyboard activation'
  )

  // Native compiler failure is displayed on return to live, while the held draft stays intact.
  writeFileSync(
    join(workspace, 'field-notes.typ'),
    '#unknown-review-fixture-function()'
  )
  const failedCompile = spawnSync(
    'python3',
    [
      resolve(pkg, '../../agents/typst/toolchain/verdict.py'),
      'field-notes.typ'
    ],
    {
      cwd: workspace,
      env: { ...process.env, TYPST: typst, HARNESS_WORKSPACE: workspace },
      encoding: 'utf8'
    }
  )
  assert.notEqual(failedCompile.status, 0)
  await page.waitForFunction(() => window.docViewer.state.build === 'failed')
  assert.equal(await page.locator('#error-card').isVisible(), false)
  assert.equal(await page.evaluate(() => window.docViewer.pages), 3)
  await page.locator('#review-close').click()
  await ready(4)
  await page.locator('#error-card').waitFor({ state: 'visible' })
  assert.match(
    await page.locator('#error-card').innerText(),
    /unknown variable/
  )
  writeFileSync(join(workspace, 'field-notes.typ'), source)
  execFileSync(
    'python3',
    [
      resolve(pkg, '../../agents/typst/toolchain/verdict.py'),
      'field-notes.typ'
    ],
    {
      cwd: workspace,
      env: { ...process.env, TYPST: typst, HARNESS_WORKSPACE: workspace }
    }
  )
  await ready(3)
  await page.waitForFunction(() => window.docViewer.state.build === 'idle')
  checks.push(
    'A real failed Typst compile leaves review intact; returning shows the last good PDF with diagnostics; a fresh compile recovers'
  )
  assert.deepEqual(errors, [])
  writeFileSync(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        workspace,
        checks,
        errors,
        kept,
        restartedId,
        pdfSha256: sha(original),
        mobile
      },
      null,
      2
    ) + '\n'
  )
  console.log(JSON.stringify({ workspace, checks, errors }, null, 2))
  await context.close()
} catch (error) {
  if (page) {
    await capture('failure').catch(() => {})
    writeFileSync(
      join(evidence, 'failure.txt'),
      String(error.stack) +
        '\n' +
        (await page
          .locator('body')
          .innerText()
          .catch(() => '')) +
        '\n' +
        JSON.stringify(errors) +
        '\n' +
        log
    )
  }
  throw error
} finally {
  await browser?.close()
  await stopServer()
}
