// Native Chrome + the real Jev Sheets viewer/client in explicit OFFLINE mode.
// No credentials or external model requests. These original fictional rows test the workflow.
import assert from 'node:assert/strict'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
process.env.JEV_OFFLINE = '1'
const { startSheetsViewer } = await import('../viewer/viewer.mjs')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.env.EVIDENCE ||
    '/private/tmp/openharness-harness-improvements-evidence/question-lab'
)
const workspace = join(evidence, `workspace-${Date.now()}`)
mkdirSync(workspace, { recursive: true })
writeFileSync(
  join(workspace, 'sheet.json'),
  readFileSync(join(pkg, 'template/sheet.json'))
)
let viewer, browser, context, page
const errors = [],
  checks = []
const check = (name) => {
  checks.push(name)
  console.log('PASS', name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function state() {
  return (await fetch(viewer.url + '/state')).json()
}
async function ctl(cmd, body = {}) {
  return (
    await fetch(viewer.url + '/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cmd,
        token: (await state()).questionLabToken,
        ...body
      })
    })
  ).json()
}
async function ready() {
  await page.locator('#sheetTitle').filter({ hasNotText: 'loading' }).waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('.hc.jev').length > 0
  )
}
async function compared() {
  await page.waitForFunction(() =>
    /COMPLETE/.test(document.querySelector('#qlNumbers').textContent)
  )
  await page.locator('#qlKeep').waitFor({ state: 'visible' })
}
async function newTrial(header = 'Urgent?') {
  await page.locator('#qlNew').click()
  await page.locator('#qlColumn').selectOption('needs_attention')
  await page.locator('#qlHeader').fill(header)
  await page.locator('#qlPreview').click()
  await page.locator('#qlStart').click()
  await compared()
}
try {
  viewer = await startSheetsViewer({ workspace, paceMs: 0 })
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox']
  })
  context = await browser.newContext({
    viewport: { width: 1440, height: 1040 },
    ...(process.env.RECORD_VIDEO
      ? {
          recordVideo: {
            dir: join(evidence, 'video'),
            size: { width: 1440, height: 1040 }
          }
        }
      : {})
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto(viewer.url)
  await ready()
  await page
    .locator('#fileInput')
    .setInputFiles(join(pkg, 'test/fixtures/fieldlight-feedback.csv'))
  await page.waitForFunction(
    () =>
      document.querySelector('#doorTitle').textContent ===
      'fieldlight-feedback.csv'
  )
  await page.locator('#addInput').fill('Needs attention?')
  await page.locator('#addInput').press('Enter')
  await page.waitForFunction(
    () => document.querySelectorAll('.c-jev').length > 0
  )
  await ctl('drain')
  await page.locator('.c-jev').first().click()
  await page.locator('#questionLabBtn').click()
  await page.locator('#qlHeader').fill('Urgent?')
  await page.locator('#qlPreview').click()
  await page.locator('.ql-row').first().waitFor()
  assert.equal(await page.locator('.ql-row').count(), 10)
  assert.equal(await page.locator('#qlPin').isChecked(), true)
  assert.match(
    await page.locator('#qlDetail').innerText(),
    /Production is down/
  )
  await page.screenshot({ path: join(evidence, 'preview.png') })
  const rawBefore = readFileSync(join(workspace, 'sheet.json'))
  await page.locator('#qlStart').click()
  await compared()
  assert.match(await page.locator('#qlMode').innerText(), /OFFLINE STAND-IN/)
  assert.ok(Number(await page.locator('#qlNumbers b').innerText()) > 0)
  assert.equal(await page.locator('.ql-probability').count(), 4)
  check(
    'own CSV import, selected-row pin, native paired comparison and explicit offline mode'
  )
  await page.getByRole('button', { name: 'New wording', exact: true }).click()
  await page
    .locator('#qlRowNote')
    .fill(
      'The production outage needs action today. Keep this row as a challenge case.'
    )
  await page.locator('#qlChanged').check()
  assert.ok((await page.locator('.ql-row').count()) > 0)
  await page.screenshot({ path: join(evidence, 'compare.png') })
  let lostKeep = false
  await page.route('**/control', async (route) => {
    const input = route.request().postDataJSON()
    if (input.cmd === 'labKeep' && !lostKeep) {
      lostKeep = true
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  await page.locator('#qlKeep').click()
  await page.locator('#qlMessage.error').waitFor()
  await page.locator('#qlKeep').click()
  await page.locator('#qlDownload').waitFor()
  await page.unroute('**/control')
  const list = await ctl('labList'),
    keptId = list.kept[0].id
  const kept = (await ctl('labGet', { id: keptId })).trial
  assert.equal(kept.rows[0].review.vote, 'candidate')
  assert.match(kept.rows[0].review.note, /production outage/)
  assert.equal(list.kept.length, 1)
  const downloadEvent = page.waitForEvent('download')
  await page.locator('#qlDownload').click()
  const downloaded = await downloadEvent
  const zip = join(evidence, 'downloaded-trial.zip')
  await downloaded.saveAs(zip)
  const verified = execFileSync(
    'python3',
    [
      '-c',
      'import sys,zipfile,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; c=json.loads(z.read("checksums.json")); assert all(hashlib.sha256(z.read(n)).hexdigest()==h for n,h in c.items()); print(json.dumps({"files":z.namelist(),"rows":len(json.loads(z.read("trial.json"))["rows"])}))',
      zip
    ],
    { encoding: 'utf8' }
  )
  assert.equal(JSON.parse(verified).rows, 10)
  assert.deepEqual(readFileSync(join(workspace, 'sheet.json')), rawBefore)
  check(
    'human preference and note, lost keep response retry, native download and independent ZIP/checksum verification'
  )
  await page.locator('#qlApply').click()
  await page.waitForFunction(() =>
    document
      .querySelector('#qlMessage')
      .textContent.includes('Added a separate column')
  )
  await ctl('drain')
  assert.equal((await state()).columns.length, 2)
  await page.locator('#qlApply').click()
  assert.equal((await state()).columns.length, 2)
  await page.screenshot({ path: join(evidence, 'kept.png') })
  check(
    'try on whole sheet reuses ten candidate answers, preserves original and is idempotent'
  )
  // Change a row while a preview is held; the trial still asks the frozen text and cannot apply.
  await page.locator('#qlNew').click()
  await page.locator('#qlColumn').selectOption('needs_attention')
  await page.locator('#qlHeader').fill('Needs a refund?')
  await page.locator('#qlPreview').click()
  const firstText = await page.locator('#qlDetail .ql-full-text').innerText()
  const firstId = (await state()).rows[0].id
  await ctl('editRow', {
    id: firstId,
    text: 'This row was edited after the preview.'
  })
  await page.locator('#qlStart').click()
  await compared()
  assert.equal(
    await page.locator('#qlDetail .ql-full-text').innerText(),
    firstText
  )
  await page.locator('#qlKeep').click()
  await page.locator('#qlDownload').waitFor()
  assert.equal(await page.locator('#qlApply').isDisabled(), true)
  assert.match(await page.locator('#qlInterpret').innerText(), /changed/)
  check(
    'a changed sheet does not mutate frozen rows and blocks stale whole-sheet application'
  )
  // A lost start response recovers the original run, without another set of calls.
  let lostStart = false
  await page.route('**/control', async (route) => {
    if (route.request().postDataJSON().cmd === 'labStart' && !lostStart) {
      lostStart = true
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  await newTrial('Mentions price or cost?')
  await page.unroute('**/control')
  assert.equal((await ctl('labList')).open.length, 1)
  await page.locator('#qlKeep').click()
  await page.locator('#qlDownload').waitFor()
  check(
    'lost start response recovers the same native trial without extra calls'
  )
  // Preserve a held tab across a server restart; token refresh and shelf reads are real requests.
  const port = Number(new URL(viewer.url).port),
    url = viewer.url
  await viewer.close()
  rmSync(join(workspace, 'fieldlight-feedback.csv'))
  viewer = await startSheetsViewer({ workspace, port, paceMs: 0 })
  await page.locator('#qlHistory').click()
  await page
    .locator('#qlHistoryList .ql-history-card')
    .filter({ hasText: 'Urgent?' })
    .click()
  await page.locator('#qlDownload').waitFor()
  assert.match(
    await page.locator('#qlDetail').innerText(),
    /Production is down/
  )
  assert.equal(await page.locator('#qlApply').isDisabled(), true)
  check(
    'server restart refreshes the write token and reopens exact kept rows after source deletion'
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.ql-row').first().click()
  await page.locator('#qlDetail').scrollIntoViewIfNeeded()
  assert.equal(
    await page.evaluate(
      () => document.querySelector('.ql-dialog').scrollWidth <= 391
    ),
    true
  )
  await page.screenshot({ path: join(evidence, 'mobile.png') })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.ql-dialog').evaluate((e) => e.open), false)
  await page.setViewportSize({ width: 1440, height: 1040 })
  await page.locator('#questionLabBtn').click()
  assert.equal(await page.locator('.ql-dialog').evaluate((e) => e.open), true)
  check('390px layout, keyboard Escape and reopening retain the kept review')
  assert.deepEqual(errors, [])
  writeFileSync(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        checks,
        errors,
        workspace,
        keptId,
        zip: JSON.parse(verified),
        mode: 'native Chrome, actual Jev client with JEV_OFFLINE=1; no live model validation'
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({ checks: checks.length, errors, workspace, keptId })
  )
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(evidence, 'failure.png') })
      .catch(() => {})
  writeFileSync(
    join(evidence, 'failure.json'),
    JSON.stringify({ error: error.stack, errors, checks }, null, 2)
  )
  throw error
} finally {
  await context?.close()
  await browser?.close()
  await viewer?.close()
}
