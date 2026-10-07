/**
 * Hold one real transcript stat while a registered startup attach is pending. This models a slow
 * filesystem, not a fabricated terminal result: the test exits the real engine in its private tmux
 * pane, releases the read, and lets the daemon's ordinary process probe and retirement run.
 * Scoped to the binding's read so transcript search/discovery cannot consume the barrier instead.
 * Loaded only by the E2E daemon through NODE_OPTIONS; no production test hook or changed clock.
 */
import fs from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const gate = process.env.E2E_STARTUP_ATTACH_GATE
if (gate && process.argv.includes('__run')) {
  const stat = fs.stat
  let held = false
  fs.stat = async function (path, ...args) {
    if (!held && existsSync(`${gate}.armed`) && new Error().stack?.includes('handleRegistered')) {
      const folder = readFileSync(`${gate}.armed`, 'utf8')
      if (String(path).startsWith(folder)) {
        held = true
        writeFileSync(`${gate}.pending`, String(path))
        const deadline = performance.now() + 30_000
        while (!existsSync(`${gate}.release`)) {
          if (performance.now() > deadline) throw new Error('startup attach barrier was not released')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        writeFileSync(`${gate}.released`, '')
      }
    }
    return stat.call(this, path, ...args)
  }
  syncBuiltinESMExports()
}
