/**
 * Windows' process table, read from the Harness PTY host: its `processes` op while the daemon is connected to it,
 * else `harness-pty ps --json` (pty/src/ps.rs). Windows has no `ps`; `processTable.ts` takes these rows through
 * `setProcessTableSource`, which `PtyHostBackend.prepare` sets on Windows.
 *
 * A row the host could not identify (a process it may not open, or a pid reused during the scan) comes with an
 * empty `startMarker` and is dropped: nothing may be matched, validated or signalled on a pid alone. As `ps`'s
 * read, a failed read is `null`, never `[]`: "we could not look" is not "nothing is running".
 */
import { execFile } from 'node:child_process'
import type { PtyHostClient } from '../ptyHost/client.js'
import { ptyHostBinary } from '../ptyHost/launch.js'
import { patientExec, type ExecDone, type PatientExecOptions } from '../patientExec.js'
import type { ProcessRow } from '../processTable.js'

/** As long as `ps` is given (processTable.ts). */
export const WINDOWS_PS_TIMEOUT_MS = 3_000

/** `execFile` as `patientExec` calls it back. */
export type WindowsPsRun = (file: string, args: readonly string[], options: PatientExecOptions, done: ExecDone) => void

export interface WindowsProcessRowsOptions {
  /** The host binary for the fallback read; `ptyHostBinary()` by default. */
  binary?: () => string | null
  run?: WindowsPsRun
}

const defaultRun: WindowsPsRun = patientExec(execFile)

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** One host row as a `ProcessRow`, or null for one that names no process this daemon may act on. */
export function windowsProcessRow(value: unknown): ProcessRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const { pid, parentPid, executable, startMarker, args, nativeArgv, imagePath } = row
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isSafeInteger(parentPid) || (parentPid as number) < 0) return null
  if (typeof executable !== 'string' || typeof args !== 'string') return null
  if (typeof startMarker !== 'string' || !startMarker) return null
  return {
    pid: pid as number,
    parentPid: parentPid as number,
    executable,
    startMarker,
    args,
    ...(isStringArray(nativeArgv) ? { nativeArgv } : {}),
    ...(typeof imagePath === 'string' && imagePath ? { imagePath } : {}),
  }
}

/** The host's `{ rows }` as process rows; null when it is not that shape or names nobody at all. */
export function windowsProcessTable(value: unknown): ProcessRow[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { rows?: unknown }).rows)) return null
  const rows: ProcessRow[] = []
  for (const raw of (value as { rows: unknown[] }).rows) {
    const row = windowsProcessRow(raw)
    if (row) rows.push(row)
  }
  // The scan lists the host itself at the least: an empty table is a read that failed.
  return rows.length ? rows : null
}

function readWithBinary(options: WindowsProcessRowsOptions): Promise<ProcessRow[] | null> {
  let binary: string | null
  try {
    binary = (options.binary ?? (() => ptyHostBinary()))()
  } catch {
    binary = null
  }
  if (!binary) return Promise.resolve(null)
  const run = options.run ?? defaultRun
  return new Promise((resolve) => {
    try {
      run(binary, ['ps', '--json'], { timeout: WINDOWS_PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) { resolve(null); return }
        try { resolve(windowsProcessTable(JSON.parse(stdout))) } catch { resolve(null) }
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * The process table on Windows: the connected host's `processes` op, else `harness-pty ps --json` (3 s). Rows
 * without a start marker are dropped; any failure is `null`.
 */
export async function windowsProcessRows(
  client: Pick<PtyHostClient, 'call'> | null,
  options: WindowsProcessRowsOptions = {},
): Promise<ProcessRow[] | null> {
  if (!client) return readWithBinary(options)
  try {
    const result = await client.call({ op: 'processes' })
    return result.state === 'ok' ? windowsProcessTable(result.value) : null
  } catch {
    return null
  }
}
