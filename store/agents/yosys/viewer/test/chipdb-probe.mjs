// Run by viewer.test.mjs in a child process, because chipdbDir() looks once per process: stands in
// for the machine — `command -v icepack` answers $PROBE_ICEPACK, or fails when it is empty, in which
// case no chipdb exists anywhere either — then prints what chip.mjs found.
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const childProcess = require('node:child_process')
const icepack = process.env.PROBE_ICEPACK
let lookupPath = null
childProcess.execFileSync = (file, args, options) => {
  lookupPath = options.env.PATH
  if (!icepack) throw new Error('command -v icepack: exit 1')
  return `${icepack}\n`
}
if (!icepack) {
  const exists = fs.existsSync
  fs.existsSync = (path) => !String(path).endsWith('chipdb-5k.txt') && exists(path)
}
if (process.env.PROBE_NO_PATH) delete process.env.PATH
syncBuiltinESMExports()

const { chipdbDir, packagePins } = await import('../lib/chip.mjs')
const dir = chipdbDir()
const again = chipdbDir()
const pins = JSON.parse(process.env.PROBE_PINS).map(([arch, pkg]) => packagePins(arch, pkg))
process.stdout.write(JSON.stringify({ dir, cached: again === dir, lookupPath, pins, pinsCached: packagePins('up5k', 'sg48') === pins[0] }))
