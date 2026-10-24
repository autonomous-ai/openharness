/**
 * Runs a privileged team script once as root, behind the system's own administrator prompt (password or Touch ID),
 * as the guest helper's install does (lib/guestHelperInstall.ts). The script and the files it installs are staged
 * in a folder private to this account (mkdtemp is 0700), so nobody can swap one in between, and removed after.
 *
 * Everything that touches the system goes through [AdminDeps]; the specs never run osascript.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import { adminAppleScript } from '../lib/guestHelperInstall.js'

export type AdminResult =
  | { ok: true; stdout: string }
  | { ok: false; code: 'CANCELLED' | 'FAILED'; message: string }

export interface AdminScript {
  script: string
  /** Files the script installs from the staging folder, by name. */
  files?: Record<string, string>
}

/** Builds the script once the staging folder exists (the script names it), then runs it as root. */
export type RunAdmin = (build: (stageDir: string) => AdminScript, prompt: string) => Promise<AdminResult>

export interface AdminDeps {
  runner?: GuestRunner
  makeStage?: () => string
  removeStage?: (dir: string) => void
}

export function adminRunner(deps: AdminDeps = {}): RunAdmin {
  const runner = deps.runner ?? runGuestCommand
  const makeStage = deps.makeStage ?? (() => mkdtempSync(join(tmpdir(), 'harness-team-')))
  const removeStage = deps.removeStage ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }))
  return async (build, prompt) => {
    const stageDir = makeStage()
    try {
      chmodSync(stageDir, 0o700)
      const { script, files = {} } = build(stageDir)
      for (const [name, content] of Object.entries(files)) writeFileSync(join(stageDir, name), content, { mode: 0o600 })
      const path = join(stageDir, 'run.sh')
      writeFileSync(path, script, { mode: 0o700 })
      const result = await runner('osascript', ['-e', adminAppleScript(path, prompt)], { timeoutMs: 15 * 60_000 })
      // -128 is the prompt's Cancel.
      if (result.code !== 0 && /-128|User canceled/i.test(result.stderr)) {
        return { ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' }
      }
      if (result.code !== 0) {
        // `do shell script` hands the script's stderr back with its lines ended by CR, not LF: split on both, or a reason
        // after an earlier line is never found, and the CR left in it makes a terminal print the line over itself.
        const said = result.stderr.trim().split(/[\r\n]+/).pop()?.replace(/^.*harness: /, '').replace(/\s*\(\d+\)$/, '') ?? ''
        return { ok: false, code: 'FAILED', message: said || `The script stopped (exit ${result.code}).` }
      }
      return { ok: true, stdout: result.stdout }
    } finally {
      removeStage(stageDir)
    }
  }
}
