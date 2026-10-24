/**
 * Runs a privileged team script once as root, behind the system's own administrator prompt (password or Touch ID),
 * as the guest helper's install does (lib/guestHelperInstall.ts), or with sudo in the terminal the command runs in. The
 * script and the files it installs are staged in a folder private to this account (mkdtemp is 0700), so nobody can swap
 * one in between, and removed after.
 *
 * Why sudo at all: macOS 26 deletes an account only for an app the person allowed to administer the computer, and it
 * cannot ask that for the administrator prompt's process (authtrampoline), so it refuses it. With sudo in a terminal the
 * terminal app is the one asking, and macOS asks the person once: "Terminal would like to administer your computer".
 *
 * Everything that touches the system goes through [AdminDeps]; the specs never run osascript or sudo.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import { adminAppleScript } from '../lib/guestHelperInstall.js'

export type AdminResult =
  | { ok: true; stdout: string }
  /** [status]: the script's own exit status, when it stopped with one (`do shell script` ends its error with it). */
  | { ok: false; code: 'CANCELLED' | 'FAILED'; message: string; status?: number }

export interface AdminScript {
  script: string
  /** Files the script installs from the staging folder, by name. */
  files?: Record<string, string>
}

/** How root is asked for: the administrator prompt (a dialog), or sudo in this terminal, which asks for the password there. */
export type AdminVia = 'prompt' | 'sudo'

/** Builds the script once the staging folder exists (the script names it), then runs it as root. */
export type RunAdmin = (build: (stageDir: string) => AdminScript, prompt: string, via?: AdminVia) => Promise<AdminResult>

export interface AdminDeps {
  runner?: GuestRunner
  makeStage?: () => string
  removeStage?: (dir: string) => void
}

export function adminRunner(deps: AdminDeps = {}): RunAdmin {
  const runner = deps.runner ?? runGuestCommand
  const makeStage = deps.makeStage ?? (() => mkdtempSync(join(tmpdir(), 'harness-team-')))
  const removeStage = deps.removeStage ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }))
  return async (build, prompt, via = 'prompt') => {
    const stageDir = makeStage()
    try {
      chmodSync(stageDir, 0o700)
      const { script, files = {} } = build(stageDir)
      for (const [name, content] of Object.entries(files)) writeFileSync(join(stageDir, name), content, { mode: 0o600 })
      const path = join(stageDir, 'run.sh')
      writeFileSync(path, script, { mode: 0o700 })
      if (via === 'sudo') {
        // sudo asks on the terminal itself (/dev/tty), so the script's output is still collected here. `-k`: the password
        // every time, as the dialog asks for it, never a few minutes' leftover sudo from something else.
        const ask = `${prompt.replaceAll('%', '%%')}\nPassword for %u: `
        const result = await runner('sudo', ['-k', '-p', ask, '/bin/sh', path], { timeoutMs: 15 * 60_000 })
        if (result.code === 0) return { ok: true, stdout: result.stdout }
        const lines = result.stderr.trim().split(/[\r\n]+/)
        const last = lines.pop() ?? ''
        if (!/^harness: /.test(last) && /incorrect password|password is required|terminal is required|no tty present/i.test(result.stderr)) {
          return { ok: false, code: 'CANCELLED', message: 'sudo did not get an administrator password.' }
        }
        return { ok: false, code: 'FAILED', message: last.replace(/^.*harness: /, '') || `The script stopped (exit ${result.code}).`,
          ...(result.code !== null ? { status: result.code } : {}) }
      }
      const result = await runner('osascript', ['-e', adminAppleScript(path, prompt)], { timeoutMs: 15 * 60_000 })
      // -128 is the prompt's Cancel.
      if (result.code !== 0 && /-128|User canceled/i.test(result.stderr)) {
        return { ok: false, code: 'CANCELLED', message: 'The administrator prompt was cancelled.' }
      }
      if (result.code !== 0) {
        // `do shell script` hands the script's stderr back with its lines ended by CR, not LF: split on both, or a reason
        // after an earlier line is never found, and the CR left in it makes a terminal print the line over itself.
        const last = result.stderr.trim().split(/[\r\n]+/).pop() ?? ''
        const status = /\((\d+)\)$/.exec(last)?.[1]
        const said = last.replace(/^.*harness: /, '').replace(/\s*\(\d+\)$/, '')
        return { ok: false, code: 'FAILED', message: said || `The script stopped (exit ${result.code}).`, ...(status ? { status: Number(status) } : {}) }
      }
      return { ok: true, stdout: result.stdout }
    } finally {
      removeStage(stageDir)
    }
  }
}
