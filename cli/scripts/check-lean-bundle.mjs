/**
 * Before a release is uploaded (scripts/upload-cli.sh): the lean bundle cli.js carries for harnessd's
 * master and its services (src/harnessd/leanBundle.ts) must start a master and load every service.
 *
 * A master started on cli.js runs only a lean bundle that answers its probe, and a service that cannot
 * start from it is started from cli.js, so a broken one costs memory, not the daemon. This keeps a broken
 * one from shipping at all: it writes the files out, asks the master's probe (`harnessd.mjs
 * __harnessd-probe`), and imports the module each process starts on, each in a Node of its own, in a
 * throwaway home and data folder.
 *
 *   node scripts/check-lean-bundle.mjs dist/cli.js
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readLeanBlock } from './lib/leanBlock.mjs'

const cli = resolve(process.argv[2] ?? 'dist/cli.js')
const files = readLeanBlock(readFileSync(cli))
const fail = (why) => { console.error(`error: ${cli}: ${why}`); process.exit(1) }
if (!files) fail('carries no lean bundle, or one that does not match its checksum')
if (!files['harnessd.mjs']) fail('its lean bundle has no harnessd.mjs')
const root = mkdtempSync(join(tmpdir(), 'lean-check-'))
try {
  const dir = join(root, 'lean')
  mkdirSync(dir)
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code)
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id') }
  const run = (args) => execFileSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  let answer
  try { answer = run([join(dir, 'harnessd.mjs'), '__harnessd-probe']) } catch (error) { fail(`its master does not answer its probe: ${String(error.stderr || error.message).trim()}`) }
  if (!answer.includes('harnessd-probe ok')) fail(`its master answered its probe with: ${answer.trim()}`)
  // Each process's own module: the master's, and every service's (serviceProcess.ts loads the one it is named).
  const modules = Object.keys(files).filter((name) => /^(masterProcess|serviceProcess|\w+Process)-[A-Z0-9]+\.mjs$/.test(name))
  if (!modules.some((name) => name.startsWith('masterProcess-')) || !modules.some((name) => name.startsWith('serviceProcess-'))) {
    fail(`its lean bundle is missing the master's or the services' module (${modules.join(', ') || 'none'})`)
  }
  for (const name of modules) {
    try { run(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(dir, name)).href)})`]) } catch (error) {
      fail(`${name} does not load: ${String(error.stderr || error.message).trim()}`)
    }
  }
  console.log(`>> lean bundle: the master answers its probe, and ${modules.length} modules load`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
