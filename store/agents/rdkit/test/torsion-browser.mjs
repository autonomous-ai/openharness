// Native RDKit and real 3Dmol in Chrome. No mocked molecule calculation or renderer.
// RDKIT_PYTHON=/path/to/python PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/torsion-browser.mjs
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.RDKIT_PYTHON || join(pkg, '.venv/bin/python')
const evidence = resolve(
  process.env.EVIDENCE ||
    '/private/tmp/openharness-harness-improvements-evidence/rdkit-lab'
)
const workspace = join(evidence, 'workspace-' + Date.now())
mkdirSync(join(workspace, 'molecules'), { recursive: true })
const source = readFileSync(join(pkg, 'test/fixtures/flexible-molecules.py'))
writeFileSync(join(workspace, 'molecules/flexible-molecules.py'), source)
const env = {
  ...process.env,
  RDKIT_PYTHON: python,
  PYTHONPATH: join(pkg, 'toolchain'),
  PYTHONDONTWRITEBYTECODE: '1'
}
execFileSync(python, [join(workspace, 'molecules/flexible-molecules.py')], {
  cwd: workspace,
  env
})
const original = readFileSync(join(workspace, 'out/butane.sdf'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const port = await new Promise((resolve, reject) => {
  const probe = createServer()
    .listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
    .on('error', reject)
})
const url = `http://127.0.0.1:${port}/`
const checks = [],
  errors = []
let server,
  browser,
  page,
  logs = ''
async function startServer() {
  logs = ''
  server = spawn(process.execPath, [join(pkg, 'viewer.mjs')], {
    env: {
      ...env,
      HARNESS_WORKSPACE: workspace,
      HARNESS_VIEWER_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.stdout.on('data', (data) => {
    logs += data
  })
  server.stderr.on('data', (data) => {
    logs += data
  })
  for (let i = 0; i < 150 && !logs.includes('listening on'); i++)
    await new Promise((resolve) => setTimeout(resolve, 30))
  assert.match(logs, /listening on/)
}
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const exit = new Promise((resolve) => server.once('exit', resolve))
  server.kill()
  await exit
}
async function ready() {
  await page.waitForFunction(
    () => window.__pane?.state.mol && !window.__pane.torsion.inspect().working
  )
}
async function scan() {
  await page.locator('#bondScanBtn').click()
  await page.locator('#scanStart').click()
  await page.waitForFunction(
    () =>
      !window.__pane.torsion.inspect().working &&
      document.querySelector('#scanBond').options.length > 0
  )
  await page.locator('#scanRun').click()
  await page.waitForFunction(
    () =>
      !!window.__pane.torsion.inspect().study &&
      !window.__pane.torsion.inspect().working
  )
}
async function pose(index) {
  await page.locator('#scanScrub').fill(String(index))
  await page.waitForFunction(
    (index) => window.__pane.torsion.inspect().selected === index,
    index
  )
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
    colorScheme: 'light'
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url + '?file=out/butane.sdf')
  await ready()
  await scan()
  const initial = await page.evaluate(
    () => window.__pane.torsion.inspect().study
  )
  assert.equal(initial.frames.length, 25)
  assert.deepEqual(initial.atoms, [0, 1, 2, 3])
  assert.equal(
    initial.method,
    'Rigid MMFF94 scan; other internal coordinates fixed; no solvent'
  )
  await pose(12)
  const atZero = await page.evaluate(() => ({
    text: document.querySelector('#scanPose').textContent,
    atoms: window.__pane.viewer
      .getModel(0)
      .selectedAtoms({})
      .map((a) => [a.x, a.y, a.z])
  }))
  assert.match(atZero.text, /0°/)
  let maxCoordError = 0
  for (let a = 0; a < atZero.atoms.length; a++)
    for (let k = 0; k < 3; k++)
      maxCoordError = Math.max(
        maxCoordError,
        Math.abs(atZero.atoms[a][k] - initial.frames[12].coords[a][k])
      )
  assert.ok(
    maxCoordError < 0.000051,
    `Displayed MOL coordinate rounding: ${maxCoordError}`
  )
  const plot = await page.locator('#scanPlot').boundingBox()
  await page
    .locator('#scanPlot')
    .click({ position: { x: 43 + (plot.width - 55) * 0.25, y: 80 } })
  assert.equal(
    await page.evaluate(() => window.__pane.torsion.inspect().selected),
    6
  )
  await page.locator('#scanBest').click()
  assert.equal(
    await page.evaluate(() => window.__pane.torsion.inspect().selected),
    initial.bestIndex
  )
  await page.locator('#scanGhost').uncheck()
  assert.equal(
    await page.evaluate(
      () =>
        window.__pane.viewer.getInternalState().models.filter(Boolean).length
    ),
    1
  )
  await page.locator('#scanGhost').check()
  assert.equal(
    await page.evaluate(
      () =>
        window.__pane.viewer.getInternalState().models.filter(Boolean).length
    ),
    2
  )
  await page.locator('#scanPlay').click()
  await page.waitForTimeout(800)
  await page.locator('#scanPlay').click()
  assert.notEqual(
    await page.evaluate(() => window.__pane.torsion.inspect().selected),
    initial.bestIndex
  )
  await pose(8)
  await page.locator('#scanTitle').fill('Butane · a folded starting point')
  await page
    .locator('#scanNote')
    .fill(
      'Compare this −60° pose with the lowest sampled point; keep the same input geometry.'
    )
  await page.locator('#scanKeep').click()
  await page.waitForFunction(
    () =>
      !!window.__pane.torsion.inspect().savedId &&
      !window.__pane.torsion.inspect().working
  )
  const id = await page.evaluate(() => window.__pane.torsion.inspect().savedId)
  const keptPath = join(workspace, 'out/torsions', id)
  const saved = JSON.parse(readFileSync(join(keptPath, 'study.json')))
  assert.equal(saved.selectedIndex, 8)
  assert.equal(saved.frames[8].angle, -60)
  assert.equal(saved.fingerprint, initial.fingerprint)
  assert.equal(
    sha(original),
    sha(readFileSync(join(workspace, 'out/butane.sdf')))
  )
  assert.equal(
    readFileSync(join(keptPath, 'source.mol'), 'utf8'),
    initial.source.molblock
  )
  const extract = join(evidence, 'independent-' + id)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#scanKept a').click()
  ])
  const downloaded = join(evidence, id + '.zip')
  await download.saveAs(downloaded)
  assert.equal(
    sha(readFileSync(downloaded)),
    sha(readFileSync(join(keptPath, 'study.zip')))
  )
  execFileSync(python, ['-m', 'zipfile', '-e', downloaded, extract], { env })
  const reproduced = JSON.parse(
    execFileSync(python, [join(extract, 'reproduce.py')], {
      cwd: '/',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    }).toString()
  )
  assert.equal(reproduced.max_energy_difference_kcal_mol, 0)
  checks.push({
    name: 'Native scan, playback, ghost, full source preservation and independent ZIP reproduction',
    frames: 25,
    maxCoordError,
    reproduced,
    id
  })
  await page.locator('#panel-scan').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.screenshot({ path: join(evidence, 'desktop.png') })

  // Source writes while a study is open cannot replace it; returning loads the changed molecule.
  const replacement = readFileSync(join(workspace, 'out/phenethyl-acetate.sdf'))
  writeFileSync(join(workspace, 'out/butane.sdf'), replacement)
  await page.locator('#scanPending').waitFor({ state: 'visible' })
  assert.equal(
    await page.evaluate(
      () => window.__pane.torsion.inspect().study.fingerprint
    ),
    initial.fingerprint
  )
  await page.locator('#scanClose').click()
  await page.waitForFunction(
    () =>
      window.__pane.state.mol?.record?.smiles.includes('c1ccccc1') &&
      !window.__pane.state.mol?.torsionPreview
  )
  assert.equal(
    await page.evaluate(() =>
      window.__pane.state.mol.blocks[0].includes('phenethyl-acetate')
    ),
    true
  )
  await page.locator('.scan-open').first().click()
  await page.waitForFunction(
    () =>
      !!window.__pane.torsion.inspect().study &&
      !window.__pane.torsion.inspect().working
  )
  assert.equal(
    await page.evaluate(
      () => window.__pane.torsion.inspect().study.fingerprint
    ),
    initial.fingerprint
  )
  assert.match(await page.locator('#scanAngle').textContent(), /-60°/)
  checks.push({
    name: 'Deferred agent output, explicit return to revised molecule, and preserved study reopen'
  })

  // A failed request leaves the calculation available; the restarted server's token refreshes.
  await page.route('**/api/torsion/keep', async (route) => {
    await route.abort()
  })
  await page.locator('#scanKeep').click()
  await page.waitForFunction(
    () =>
      !window.__pane.torsion.inspect().working &&
      document.querySelector('#scanStatus').classList.contains('error')
  )
  assert.equal(
    await page.evaluate(
      () => window.__pane.torsion.inspect().study.fingerprint
    ),
    initial.fingerprint
  )
  await page.unroute('**/api/torsion/keep')
  await stopServer()
  await startServer()
  await page.locator('#scanTitle').fill('Butane · after reconnect')
  await page.locator('#scanKeep').click()
  await page.waitForFunction(
    (previous) =>
      window.__pane.torsion.inspect().savedId !== previous &&
      !window.__pane.torsion.inspect().working,
    id
  )
  checks.push({
    name: 'Failed save preserves study; retry refreshes restarted server token without page reload'
  })

  await page.reload()
  await ready()
  await page.locator('#bondScanBtn').click()
  await page
    .locator('.scan-open')
    .filter({ hasText: 'a folded starting point' })
    .click()
  await page.waitForFunction(
    () =>
      !!window.__pane.torsion.inspect().study &&
      !window.__pane.torsion.inspect().working
  )
  assert.equal(
    await page.evaluate(
      () => window.__pane.torsion.inspect().study.fingerprint
    ),
    initial.fingerprint
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#panel-scan').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.screenshot({ path: join(evidence, 'mobile.png') })
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  )
  await pose(18)
  assert.match(await page.locator('#scanAngle').textContent(), /90°/)
  checks.push({
    name: 'Saved study survives viewer restart; mobile scrub and layout',
    viewport: [390, 844]
  })

  await page.setViewportSize({ width: 1280, height: 960 })
  await page.locator('#scanClose').click()
  await page.evaluate(() =>
    window.__pane.selectMolecule('phenethyl-acetate', { user: true })
  )
  await ready()
  await scan()
  const ester = await page.evaluate(() => window.__pane.torsion.inspect().study)
  assert.notEqual(ester.source.smiles, initial.source.smiles)
  assert.ok(ester.elements.length > initial.elements.length)
  const bond = await page.locator('#scanBond option').allTextContents()
  assert.ok(bond.length >= 4)
  await page.locator('#scanBond').selectOption({ index: 2 })
  await page.locator('#scanStep').selectOption('10')
  await page.locator('#scanRun').click()
  await page.waitForFunction(
    () =>
      window.__pane.torsion.inspect().study?.frames.length === 37 &&
      !window.__pane.torsion.inspect().working
  )
  await pose(18)
  await page.locator('#panel-scan').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.screenshot({ path: join(evidence, 'ester.png') })
  checks.push({
    name: 'Separately authored aromatic ester, arbitrary candidate bond and 37-pose scan',
    candidates: bond
  })

  async function measure(atoms) {
    await page.locator('.scan-intro').click()
    await page.keyboard.press('Delete')
    await page.keyboard.press('t')
    for (const atom of atoms) {
      const point = await page.evaluate(
        (atom) => window.__pane.atom2D(atom),
        atom
      )
      await page.mouse.click(point.x, point.y)
    }
    assert.deepEqual(
      await page.evaluate(() => window.__pane.state.measures.at(-1)?.atoms),
      atoms
    )
    await page.locator('#scanMeasured').click()
  }
  await measure([2, 1, 3, 4])
  await page.locator('#scanRun').click()
  await page.waitForFunction(
    () =>
      window.__pane.torsion.inspect().study?.atoms[0] === 2 &&
      !window.__pane.torsion.inspect().working
  )
  const measuredStudy = await page.evaluate(
    () => window.__pane.torsion.inspect().study.fingerprint
  )
  await measure([6, 7, 8, 9])
  await page.locator('#scanRun').click()
  await page.waitForFunction(
    () =>
      !window.__pane.torsion.inspect().working &&
      document.querySelector('#scanStatus').classList.contains('error')
  )
  assert.match(
    await page.locator('#scanStatus').textContent(),
    /non-ring single bond/
  )
  assert.equal(
    await page.evaluate(
      () => window.__pane.torsion.inspect().study.fingerprint
    ),
    measuredStudy
  )
  checks.push({
    name: 'Four real 2D atom clicks select a custom dihedral; invalid ring scan leaves previous calculation available'
  })

  // Kept studies stand on their own after the agent's original outputs have been removed.
  for (const name of readdirSync(join(workspace, 'out')))
    if (name !== 'torsions')
      rmSync(join(workspace, 'out', name), { recursive: true, force: true })
  await page.reload()
  await page.waitForFunction(() => !!window.__pane)
  await page.locator('#bondScanBtn').click()
  await page
    .locator('.scan-open')
    .filter({ hasText: 'a folded starting point' })
    .click()
  await page.waitForFunction(
    () =>
      !!window.__pane.torsion.inspect().study &&
      !window.__pane.torsion.inspect().working
  )
  assert.equal(
    await page.evaluate(
      () => window.__pane.torsion.inspect().study.fingerprint
    ),
    initial.fingerprint
  )
  await page.locator('#scanClose').click()
  assert.equal(await page.locator('#name').textContent(), 'RDKit')
  await page.locator('#empty').waitFor({ state: 'visible' })
  checks.push({
    name: 'Library excludes saved poses from live output and reopens with no original molecule files'
  })
  assert.deepEqual(errors, [])
  writeFileSync(
    join(evidence, 'results.json'),
    JSON.stringify({ workspace, checks, errors }, null, 2) + '\n'
  )
  console.log(JSON.stringify({ workspace, checks, errors }, null, 2))
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, 'failure.png') })
    .catch(() => {})
  console.error({
    logs,
    errors,
    scan: await page
      ?.locator('#scanStatus')
      .textContent()
      .catch(() => null)
  })
  throw error
} finally {
  await browser?.close()
  await stopServer()
}
