import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { createHomeAdopter, readAdoptedHomes } from './homeAdoption.js'

const execute = promisify(execFile)
let bundleRoot = '', root = '', file = '', script = ''
let adopter: ReturnType<typeof createHomeAdopter>
beforeAll(() => {
  bundleRoot = realpathSync(mkdtempSync(join(tmpdir(), 'adoption-process-bundle-')))
  script = join(bundleRoot, 'writer.mjs')
  buildSync({ stdin: { resolveDir: process.cwd(), sourcefile: 'writer.ts', contents: `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { createHomeAdopter } from ${JSON.stringify(resolve('src/engines/kit/homeAdoption.ts'))}
    const [file, homes, gate, phase] = process.argv.slice(2)
    const adopter = createHomeAdopter(file)
    const fds = new Map(), original = { open: fs.openSync, close: fs.closeSync, link: fs.linkSync, flush: fs.fsyncSync }
    let published = false, confirmed = false
    fs.openSync = (...args) => { const fd = original.open(...args); fds.set(fd, String(args[0])); return fd }
    fs.closeSync = fd => { original.close(fd); fds.delete(fd) }
    fs.linkSync = (from, to) => {
      const record = String(to).endsWith('/001.json'), seal = String(to).endsWith('/001.committed')
      if (record && phase === 'before-record') process.exit(75)
      original.link(from, to)
      if (record) { published = true; if (phase === 'record') process.exit(75) }
      if (seal) { confirmed = true; if (phase === 'confirmation') process.exit(75) }
    }
    fs.fsyncSync = fd => {
      original.flush(fd)
      if (published && fds.get(fd) === file + '.adoptions' && phase === 'record-flush') process.exit(75)
      if (confirmed && fds.get(fd) === file + '.confirmations' && phase === 'confirmation-flush') process.exit(75)
    }
    syncBuiltinESMExports()
    const end = Date.now() + 8000
    while (!fs.existsSync(gate)) {
      if (Date.now() > end) throw Error('fixture gate timed out')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (;;) {
      try { const result = adopter.adopt(JSON.parse(homes)); process.stdout.write(JSON.stringify(result)); break }
      catch (error) {
        if (error?.code !== 'IDENTITY_UNAVAILABLE' || Date.now() > end) throw error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  ` }, outfile: script, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
})
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'adoption-process-')))
  mkdirSync(join(root, 'data'), { mode: 0o700 })
  file = join(root, 'data', 'engine-homes.json')
  adopter = createHomeAdopter(file)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))
const add = (...codex: string[]) => ({ claude: [], codex })
async function settle(homes: ReturnType<typeof add>): Promise<void> {
  const end = Date.now() + 5000
  for (;;) {
    try { adopter.adopt(homes); return }
    catch (error) {
      if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE' || Date.now() > end) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}
function writer(homes: ReturnType<typeof add>, phase = '') {
  return execute(process.execPath, [script, file, JSON.stringify(homes), join(root, 'start'), phase], {
    timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    env: { HOME: root, ADAPTER_DATA_DIR: join(root, 'data'), CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'), TZ: 'UTC', TMPDIR: '/tmp' },
  })
}

it.each([false, true])('serializes separate processes racing distinct or identical first homes (same=%s)', async same => {
  const first = writer(add('/first')), second = writer(add(same ? '/first' : '/second'))
  writeFileSync(join(root, 'start'), 'go')
  await Promise.all([first, second])
  expect(readAdoptedHomes(file).homes.codex.sort()).toEqual(same ? ['/first'] : ['/first', '/second'])
}, 15_000)

it.each(['before-record', 'record', 'record-flush', 'confirmation', 'confirmation-flush'])
  ('recovers a writer that exits without cleanup at %s', async phase => {
    await settle(add('/saved'))
    writeFileSync(join(root, 'start'), 'go')
    await expect(writer(add('/interrupted'), phase)).rejects.toMatchObject({ code: 75 })
    // A published intent can be completed by a fresh boot without any shell variable naming it.
    await settle(phase === 'before-record' ? add('/interrupted') : add())
    expect(readAdoptedHomes(file).homes).toEqual(add('/saved', '/interrupted'))
  }, 15_000)
