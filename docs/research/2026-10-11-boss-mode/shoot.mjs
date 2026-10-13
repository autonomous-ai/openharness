#!/usr/bin/env node
/**
 * Opens every prototype on the invented desk in headless Chromium, drives it by keys, fails on any console
 * error or any request that leaves this computer, and writes the screenshots in this folder. Never ?real:
 * committed screenshots show the invented desk only.
 *
 *   PLAYWRIGHT=/path/to/playwright/index.mjs node docs/research/2026-10-11-boss-mode/shoot.mjs [only] [--out dir]
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const out = outAt >= 0 ? args[outAt + 1] : here
const only = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))[0] ?? null
const playwright = process.env.PLAYWRIGHT ?? 'playwright'
const { chromium } = await import(playwright.startsWith('/') ? pathToFileURL(playwright).href : playwright)

const server = spawn(process.execPath, [join(here, 'serve.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] })
const base = await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => { const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(chunk)); if (m) resolve(m[0]) })
  server.on('exit', (code) => reject(new Error(`serve.mjs exited ${code}`)))
})

// [page, shot name, viewport, query, steps]: a step is a key, ['wait', ms], or ['eval', js]
const SHOTS = [
  ['approach', 'approach', [1300, 1100], 'still', [['wait', 9000]]],
  ['approach', 'approach-final', [1300, 1100], 'still', [['wait', 4500], 'f', 'f', ['wait', 4500]]],
  ['approach', 'approach-narrow', [760, 980], 'still', [['wait', 5000]]],
  ['pass', 'pass', [1300, 1100], 'still', [['wait', 2500]]],
  ['pass', 'pass-ticket', [1300, 1100], 'still', [['wait', 1500], 'k', 'Enter', ['wait', 900]]],
  ['pass', 'pass-narrow', [760, 980], 'still', [['wait', 2000]]],
  ['switchboard', 'switchboard', [1300, 1100], 'still', [['wait', 3500]]],
  ['switchboard', 'switchboard-listen', [1300, 1100], 'still', [['wait', 2500], 'Enter', ['wait', 1200]]],
  ['switchboard', 'switchboard-narrow', [760, 980], 'still', [['wait', 3000]]],
  ['score', 'score', [1300, 1100], 'still', [['wait', 2500]]],
  ['score', 'score-part', [1300, 1100], 'still', [['wait', 1500], 'n', 'Enter', ['wait', 900]]],
  ['score', 'score-narrow', [760, 980], 'still', [['wait', 2000]]],
  ['index', 'index', [1300, 1000], '', [['wait', 800]]],
]

const browser = await chromium.launch()
const failures = []
for (const [page, name, [width, height], query, steps] of SHOTS) {
  if (only && page !== only) continue
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const tab = await context.newPage()
  const errors = []
  tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  tab.on('pageerror', (e) => errors.push(String(e)))
  tab.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) errors.push(`left this computer: ${r.url()}`) })
  await tab.goto(`${base}${page === 'index' ? '' : `${page}.html`}${query ? `?${query}` : ''}`)
  for (const step of steps) {
    if (Array.isArray(step) && step[0] === 'wait') await tab.waitForTimeout(step[1])
    else if (Array.isArray(step) && step[0] === 'eval') await tab.evaluate(step[1])
    else await tab.keyboard.press(step)
  }
  const file = join(out, `${name}.jpg`)
  await tab.screenshot({ path: file, type: 'jpeg', quality: 86 })
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${name} → ${file}${errors.length ? `\n     ${errors.join('\n     ')}` : ''}`)
  if (errors.length) failures.push(name)
  await context.close()
}
await browser.close()
server.kill()
process.exit(failures.length ? 1 : 0)
