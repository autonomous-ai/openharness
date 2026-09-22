// Native acceptance: setup.sh's actual upstream/war must exist. No mocked CircuitJS API.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME=/path/to/chrome EVIDENCE=/tmp/... node test/scope-lab-browser.mjs
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.env.EVIDENCE || mkdtempSync(join(tmpdir(), 'scope-lab-evidence-'))
)
mkdirSync(evidence, { recursive: true })
const workspace = mkdtempSync(join(evidence, 'workspace-'))
const fixture = readFileSync(
  join(pkg, 'test/fixtures/rc-scope-lab.txt'),
  'utf8'
)
writeFileSync(join(workspace, 'circuit.txt'), fixture)
const port = await new Promise((ok) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => ok(p))
  })
})
const base = `http://127.0.0.1:${port}`
let server,
  browser,
  context,
  page,
  log = '',
  errors = []
const checks = [],
  metrics = {}
async function start() {
  server = spawn(process.execPath, [join(pkg, 'viewer.mjs')], {
    env: {
      ...process.env,
      HARNESS_WORKSPACE: workspace,
      HARNESS_VIEWER_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let ready = false
  server.stdout.on('data', (d) => {
    log += d
    if (String(d).includes('listening on')) ready = true
  })
  server.stderr.on('data', (d) => {
    log += d
  })
  for (let i = 0; i < 100 && !ready; i++)
    await new Promise((r) => setTimeout(r, 50))
  assert.ok(ready, log)
}
async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise((r) => server.once('exit', r))
  server.kill()
  await exited
}
async function check(name, work) {
  await work()
  checks.push(name)
  console.log('PASS ' + name)
}
async function finished() {
  await page.waitForFunction(
    () =>
      !document.querySelector('#slCapture').disabled &&
      /Captured|Partial capture/.test(
        document.querySelector('#slStatus').textContent
      ),
    null,
    { timeout: 35000 }
  )
}
async function keep(title, note = '') {
  await page.locator('#slTitle').fill(title)
  await page.locator('#slNote').fill(note)
  await page.locator('#slKeep').click()
  await page.waitForFunction(
    () => !document.querySelector('#slDownload').hidden
  )
  const id = await page.locator('#slTake').inputValue()
  const response = await fetch(base + '/__lab/api/' + id)
  assert.equal(response.status, 200)
  return (await response.json()).capture
}
function rms(rows, col) {
  let sum = 0
  for (let i = 1; i < rows.length; i++)
    sum +=
      ((rows[i][0] - rows[i - 1][0]) *
        (rows[i][col] ** 2 + rows[i - 1][col] ** 2)) /
      2
  return Math.sqrt(sum / (rows.at(-1)[0] - rows[0][0]))
}
let a, b, timer
try {
  await start()
  browser = await chromium.launch({
    executablePath: process.env.CHROME,
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
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  await page.goto(base)
  await page.waitForFunction(
    () =>
      document.querySelector('#sim').contentWindow.CircuitJS1?.getElements()
        .length === 8
  )
  await page.evaluate(() =>
    document.querySelector('#sim').contentWindow.CircuitJS1.setSimRunning(false)
  )
  await page.locator('#scope-lab').click()
  await page.waitForFunction(() =>
    document.querySelector('#slProbes').textContent.includes('V(OUT)')
  )
  await check(
    'native RC capture matches analytic gain and Ohm’s law without changing the visible circuit',
    async () => {
      const before = await page.evaluate(() => {
        const s = document.querySelector('#sim').contentWindow.CircuitJS1
        return { time: s.getTime(), circuit: s.exportCircuit() }
      })
      await page.locator('#slProbe').selectOption('i:1:ResistorElm')
      await page.locator('#slAdd').click()
      await page.locator('#slCapture').click()
      await finished()
      a = await keep(
        '100 Hz · 1 kΩ',
        'First trace. Compare the same input with twice the resistance.'
      )
      const after = await page.evaluate(() => {
        const s = document.querySelector('#sim').contentWindow.CircuitJS1
        return { time: s.getTime(), circuit: s.exportCircuit() }
      })
      assert.deepEqual(after, before)
      assert.equal(a.sourceCircuit, before.circuit)
      assert.equal(
        readFileSync(join(workspace, 'circuit.txt'), 'utf8'),
        fixture
      )
      assert.equal(a.status, 'complete')
      assert.ok(a.samples.length > 1900)
      assert.ok(a.solverSteps >= 100000)
      const tail = a.samples.filter((r) => r[0] >= 0.3)
      const gain = rms(tail, 2) / rms(tail, 1),
        expected = 1 / Math.sqrt(1 + (2 * Math.PI * 100 * 1000 * 1e-6) ** 2)
      assert.ok(
        Math.abs(gain - expected) < 0.004,
        `gain ${gain}, expected ${expected}`
      )
      const ohmError = Math.max(
        ...a.samples.map((r) => Math.abs((r[1] - r[2]) / 1000 - r[3]))
      )
      assert.ok(ohmError < 1e-9, `Ohm error ${ohmError}`)
      metrics.rc1 = {
        gain,
        expected,
        ohmError,
        solverSteps: a.solverSteps,
        samples: a.samples.length,
        wallMs: a.wallMs
      }
    }
  )
  await check(
    'source edits produce a different native response, with comparison and measured cursors',
    async () => {
      await page.locator('#slClose').click()
      writeFileSync(
        join(workspace, 'circuit.txt'),
        fixture.replace('0 1000\n', '0 2000\n')
      )
      await page.waitForFunction(() =>
        document
          .querySelector('#sim')
          .contentWindow.CircuitJS1.exportCircuit()
          .includes('r="2000"')
      )
      await page.locator('#scope-lab').click()
      await page.locator('#slCapture').click()
      await finished()
      b = await keep(
        '100 Hz · 2 kΩ',
        'The input stays the same. The output is smaller and lags further behind.'
      )
      const tail = b.samples.filter((r) => r[0] >= 0.3),
        gain = rms(tail, 2) / rms(tail, 1),
        expected = 1 / Math.sqrt(1 + (2 * Math.PI * 100 * 2000 * 1e-6) ** 2)
      assert.ok(
        Math.abs(gain - expected) < 0.004,
        `gain ${gain}, expected ${expected}`
      )
      assert.ok(gain < metrics.rc1.gain - 0.2)
      await page.locator('#slReference').selectOption(a.id)
      await page.locator('#slPlot').click({ position: { x: 205, y: 230 } })
      await page.locator('#slPlot').click({ position: { x: 382, y: 240 } })
      await page.waitForFunction(() =>
        /Δt.*nearest stored samples/.test(
          document.querySelector('#slDelta').textContent
        )
      )
      assert.equal(await page.locator('#slValues tbody tr').count(), 3)
      await page.locator('#slZoom').click()
      await page.waitForFunction(() => !document.querySelector('#slAll').hidden)
      const measured = await page.locator('#slDelta').innerText()
      await page.locator('#slPlot').focus()
      await page.keyboard.press('ArrowRight')
      await page.waitForFunction(
        (before) => document.querySelector('#slDelta').textContent !== before,
        measured
      )
      metrics.rc2 = { gain, expected, wallMs: b.wallMs }
      await page.screenshot({ path: join(evidence, 'scope-lab.png') })
    }
  )
  await check(
    'downloaded packet has exact native circuits, CSV values, valid ZIP and matching checksums',
    async () => {
      const download = page.waitForEvent('download')
      await page.locator('#slDownload').click()
      const path = join(evidence, 'capture.zip')
      await (await download).saveAs(path)
      execFileSync(
        'python3',
        [
          '-c',
          `import csv,hashlib,io,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n checks=json.loads(z.read('checksums.json'))\n for name,sha in checks.items(): assert hashlib.sha256(z.read(name)).hexdigest()==sha,name\n data=json.loads(z.read('capture.json'))\n rows=list(csv.reader(io.StringIO(z.read('measurements.csv').decode())))\n assert [[float(v) for v in row] for row in rows[1:]]==data['samples']\n assert z.read('circuit.xml').decode()==data['sourceCircuit']\n assert z.read('capture-circuit.xml').decode()==data['runCircuit']\n print(len(rows)-1,'exact native rows; all ZIP CRCs and SHA-256 checksums pass')`,
          path
        ],
        { stdio: 'inherit' }
      )
    }
  )
  await check(
    'stopping a capture preserves an explicitly partial trace and exact in-pane edits',
    async () => {
      await page.locator('#slClose').click()
      await page.evaluate(() => {
        const s = document.querySelector('#sim').contentWindow.CircuitJS1
        s.importCircuit(
          s.exportCircuit().replace('r="2000"', 'r="3300"'),
          false
        )
        s.setSimRunning(false)
      })
      await page.locator('#scope-lab').click()
      await page.locator('#slDuration').selectOption('5')
      await page.locator('#slCapture').click()
      await page.waitForFunction(() =>
        /[1-9][0-9,]* samples/.test(
          document.querySelector('#slProgress').textContent
        )
      )
      writeFileSync(
        join(workspace, 'circuit.txt'),
        fixture.replace('0 1000\n', '0 4700\n')
      )
      await page.waitForFunction(() =>
        document
          .querySelector('#sim')
          .contentWindow.CircuitJS1.exportCircuit()
          .includes('r="4700"')
      )
      await page.locator('#slCancel').click()
      await finished()
      const partial = await keep(
        'Stopped · 3.3 kΩ',
        'An in-pane edit, stopped early.'
      )
      assert.equal(partial.status, 'partial')
      assert.match(partial.reason, /Stopped by you/)
      assert.ok(partial.samples.at(-1)[0] < 5)
      assert.ok(partial.sourceCircuit.includes('r="3300"'))
      assert.ok(
        readFileSync(join(workspace, 'circuit.txt'), 'utf8').includes(
          '0 4700\n'
        )
      )
    }
  )
  await check(
    'the native 555 topology works without labeled nodes, and lost keep acknowledgement recovers once',
    async () => {
      await page.locator('#slClose').click()
      writeFileSync(
        join(workspace, 'circuit.txt'),
        readFileSync(join(pkg, 'template/circuit.txt'))
      )
      await page.waitForFunction(() =>
        document
          .querySelector('#sim')
          .contentWindow.CircuitJS1.getElements()
          .some((e) => e.getType() === 'TimerElm')
      )
      await page.locator('#scope-lab').click()
      await page.locator('#slDuration').selectOption('0.5')
      await page.locator('#slCapture').click()
      await finished()
      let intercepted = 0
      await page.route('**/__lab/api', async (route) => {
        if (route.request().method() === 'POST') {
          intercepted++
          await route.fetch()
          await route.abort('failed')
        } else await route.continue()
      })
      timer = await keep(
        '555 · live oscillation',
        'The output switches while the timing capacitor charges and discharges.'
      )
      await page.unroute('**/__lab/api')
      assert.equal(intercepted, 1)
      assert.equal(timer.status, 'complete')
      assert.ok(timer.probes.some((p) => p.type === 'OutputElm'))
      const col = timer.probes.findIndex((p) => p.type === 'OutputElm') + 1,
        values = timer.samples.map((r) => r[col])
      assert.ok(Math.min(...values) < 0.1)
      assert.ok(Math.max(...values) > 9)
      await page.locator('#slReference').selectOption('')
      await page.screenshot({ path: join(evidence, 'scope-lab-timer.png') })
      metrics.timer = {
        probes: timer.probes.map((p) => p.label),
        min: Math.min(...values),
        max: Math.max(...values),
        samples: timer.samples.length
      }
    }
  )
  await check(
    'server restart refreshes the save token while unsaved capture data stays intact',
    async () => {
      await page.locator('#slCapture').click()
      await finished()
      await stop()
      await start()
      const restored = await keep(
        'After restart',
        'The capture was made before the server restarted.'
      )
      assert.equal(restored.status, 'complete')
    }
  )
  await check(
    'discarding an unsaved capture releases it without writing an archive',
    async () => {
      const before = (await (await fetch(base + '/__lab/api')).json()).captures
        .length
      await page.locator('#slDuration').selectOption('0.1')
      await page.locator('#slCapture').click()
      await finished()
      const discarded = await page.locator('#slTake').inputValue()
      await page.locator('#slDiscard').click()
      assert.notEqual(await page.locator('#slTake').inputValue(), discarded)
      assert.equal(
        (await (await fetch(base + '/__lab/api')).json()).captures.length,
        before
      )
      assert.equal((await fetch(base + '/__lab/api/' + discarded)).status, 404)
    }
  )
  await check(
    'saved captures reopen after source deletion and remain usable at phone width',
    async () => {
      rmSync(join(workspace, 'circuit.txt'))
      await page.reload()
      await page.locator('#scope-lab').click()
      await page.waitForFunction(
        (id) =>
          [...document.querySelector('#slTake').options].some(
            (o) => o.value === id
          ),
        a.id
      )
      await page.locator('#slTake').selectOption(b.id)
      await page.locator('#slReference').selectOption(a.id)
      await page.waitForFunction(() =>
        document.querySelector('#slStatus').textContent.includes('2 kΩ')
      )
      assert.match(
        await page.locator('#slNote').inputValue(),
        /input stays the same/
      )
      assert.equal(await page.locator('#slTitle').isDisabled(), true)
      await page.setViewportSize({ width: 390, height: 844 })
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector('.sl-modal').scrollWidth <= 390 &&
            document.documentElement.scrollWidth <= 390
        ),
        true
      )
      await page.screenshot({
        path: join(evidence, 'scope-lab-mobile.png'),
        fullPage: true
      })
      await page.locator('#slPlot').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: join(evidence, 'scope-lab-mobile-traces.png')
      })
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.sl-modal').isVisible(), false)
      assert.deepEqual(errors, [])
    }
  )
} finally {
  writeFileSync(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        workspace,
        checks,
        metrics,
        errors,
        ids: { a: a?.id, b: b?.id, timer: timer?.id }
      },
      null,
      2
    )
  )
  writeFileSync(join(evidence, 'server.log'), log)
  await context?.close()
  await browser?.close()
  await stop()
}
