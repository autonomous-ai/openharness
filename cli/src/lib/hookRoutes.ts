/**
 * Found by QA on a quiet machine: the last daemon to install hooks took every daemon's hooks.
 * Each pane's owner tag now names its daemon's data folder and bound port. The hook validates this
 * record before routing; without one it keeps its command's port/data folder. Retain records on stop:
 * an offline hook must write its owner's registry, not fall back to another daemon's.
 */
import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { harnessPaneOwner } from './harnessSessionLabel.js'

export function hookRouteFile(tag: string, dir: string = env.HARNESS_HOOK_ROUTES_DIR): string {
  return join(dir, `${tag}.json`)
}

/** Publish after the hook server binds. Failure leaves the installed command usable and never stops
 * the daemon. The actual reader is notify.mjs; keeping another unused reader here hid its real checks. */
export function publishHookRoute(dataDir: string, port: number, dir: string = env.HARNESS_HOOK_ROUTES_DIR): void {
  const target = hookRouteFile(harnessPaneOwner(dataDir), dir)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    writeFileSync(temporary, JSON.stringify({ dataDir: realpathSync(dataDir), port }) + '\n', { mode: 0o600 })
    renameSync(temporary, target)
  } catch (error) {
    console.warn(`[hooks] could not record this daemon's hook route in ${dir}: ${error instanceof Error ? error.message : error}`
      + ' · hooks installed by another daemon will not reach this one\'s agents')
  } finally {
    // QA found ENOTDIR here turned the warning above into a failed daemon start.
    try { rmSync(temporary, { force: true }) } catch { /* the optional route's directory is unavailable */ }
  }
}
