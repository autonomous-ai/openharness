/**
 * `bin\harness-launch.exe` (B1, pty/src/bin/harness-launch.rs): how every background start on Windows begins — the
 * scheduled task, `harness start` from a terminal, a master handing over to its replacement (spec section 1,
 * "Launchers"). It starts `node.exe <cli\current>\cli.js <args>` windowless and outside any job object, then exits:
 * a master Node started itself (`detached`) stayed in the terminal's job, and closing that terminal or the SSH session
 * ended it. Given `--root`, so a CLI on another ADAPTER_CLI_DIR starts its own build, never the profile's. Where the
 * launcher is: ./installLayout.ts `harnessLaunchPath(root)`, the root being the folder `cli\` is in.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { signedExitCode } from '../../harnessd/supervisor.js'

/** It resolves two pointers and starts a process: a launcher that has not returned by then is stuck. */
export const LAUNCH_TIMEOUT_MS = 30_000

export type LaunchOutcome = { ok: true } | { ok: false; detail: string }
export type LaunchRun = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; windowsHide: true; stdio: 'ignore' }) => ChildProcess

/** Start the CLI with [args] through [launcher]; resolves once the launcher has said whether it started it. */
export function launchDetached(
  launcher: string, root: string, args: readonly string[], env: NodeJS.ProcessEnv,
  run: LaunchRun = (file, argv, options) => spawn(file, [...argv], options), timeoutMs = LAUNCH_TIMEOUT_MS,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    let child: ChildProcess
    const timer = setTimeout(() => {
      settle({ ok: false, detail: `${launcher} did not return within ${timeoutMs} ms` })
      try { child.kill() } catch { /* gone */ }
    }, timeoutMs)
    try {
      child = run(launcher, ['--root', root, '--', ...args], { env, windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      settle({ ok: false, detail: `${launcher} could not be run: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    child.once('error', (error) => settle({ ok: false, detail: `${launcher} could not be run: ${error.message}` }))
    child.once('exit', (code) => settle(code === 0 ? { ok: true } : { ok: false, detail: `${launcher} exited ${signedExitCode(code)} — see ${join(root, 'cli', 'data', 'logs', 'launch.log')}` }))
  })
}
