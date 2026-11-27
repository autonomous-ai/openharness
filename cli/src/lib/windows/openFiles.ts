/**
 * Which disk files a few Windows processes hold open, and the folder each works in, read with
 * `harness-pty files --json <pid>…` (pty/src/open_files.rs). Windows has no `lsof` and no `/proc`; this is what
 * `processView` asks there (docs/plans/2026-11-27-windows-codex-rescan-design.md).
 *
 * As `processTable.ts`'s read: a failed, timed-out or over-bound run is `null`, never an empty map. "We could not look"
 * is not "nothing is open", which would let an adoption through. A pid the host could not read is absent from the map:
 * unknown, never "holds nothing". Each row carries its start marker so the caller can drop a reused pid.
 */
import { execFile } from 'node:child_process'
import { ptyHostBinary } from '../ptyHost/launch.js'
import { patientExec } from '../patientExec.js'
import type { WindowsProcessRowsOptions, WindowsPsRun } from './processTable.js'
import { windowsStartTime } from './treeKill.js'

/** As long as `ps` is given (processTable.ts). */
export const WINDOWS_FILES_TIMEOUT_MS = 3_000
/** The pids one run reads; harness-pty refuses more. */
export const WINDOWS_FILES_MAX_PIDS = 32
export const WINDOWS_FILES_MAX_BUFFER = 4 * 1024 * 1024
/** The files one process may list; harness-pty leaves a process with more out. */
export const WINDOWS_FILES_MAX_PER_PID = 4096
/** The longest Windows path, in UTF-16 units (a JS string's length). */
export const WINDOWS_PATH_MAX_UNITS = 32 * 1024

export interface WindowsOpenFiles {
  startMarker: string
  /** The folder as `realpath` names it; absent when harness-pty could not read it. */
  cwd?: string
  files: string[]
}

export type WindowsFilesRead = (pids: readonly number[]) => Promise<Map<number, WindowsOpenFiles> | null>

const defaultRun: WindowsPsRun = patientExec(execFile)

const isPath = (value: unknown): value is string => typeof value === 'string' && value.length <= WINDOWS_PATH_MAX_UNITS

function windowsOpenFilesRow(value: unknown, asked: ReadonlySet<number>): [number, WindowsOpenFiles] | null {
  if (!value || typeof value !== 'object') return null
  const { pid, startMarker, cwd, files } = value as Record<string, unknown>
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !asked.has(pid as number)) return null
  if (typeof startMarker !== 'string' || windowsStartTime(startMarker) === null) return null
  if (!Array.isArray(files) || files.length > WINDOWS_FILES_MAX_PER_PID || !files.every(isPath)) return null
  if (cwd !== undefined && !isPath(cwd)) return null
  return [pid as number, { startMarker, ...(cwd !== undefined ? { cwd } : {}), files }]
}

/** harness-pty's `{ rows }` for the pids [asked], each pid's first row; null when it is not that shape. */
export function windowsOpenFilesRows(value: unknown, asked: ReadonlySet<number>): Map<number, WindowsOpenFiles> | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { rows?: unknown }).rows)) return null
  const read = new Map<number, WindowsOpenFiles>()
  for (const raw of (value as { rows: unknown[] }).rows) {
    const row = windowsOpenFilesRow(raw, asked)
    if (row && !read.has(row[0])) read.set(row[0], row[1])
  }
  return read
}

/**
 * The open disk files and folder of [pids], from `harness-pty files --json` (3 s, 4 MiB). No pids: an empty map and
 * no run. More than 32, no binary, or any failure: null. Nothing is logged here; the callers log.
 */
export function windowsOpenFiles(
  pids: readonly number[],
  options: WindowsProcessRowsOptions = {},
): Promise<Map<number, WindowsOpenFiles> | null> {
  const asked = new Set(pids)
  if (!asked.size) return Promise.resolve(new Map())
  if (asked.size > WINDOWS_FILES_MAX_PIDS) return Promise.resolve(null)
  let binary: string | null
  try {
    binary = (options.binary ?? (() => ptyHostBinary()))()
  } catch {
    binary = null
  }
  if (!binary) return Promise.resolve(null)
  const run = options.run ?? defaultRun
  const args = ['files', '--json', ...[...asked].map(String)]
  return new Promise((resolve) => {
    try {
      run(binary, args, { timeout: WINDOWS_FILES_TIMEOUT_MS, maxBuffer: WINDOWS_FILES_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
        // A killed or failed run may have printed part of its rows: what it left out would read as "nothing open".
        if (error) { resolve(null); return }
        try { resolve(windowsOpenFilesRows(JSON.parse(stdout), asked)) } catch { resolve(null) }
      })
    } catch {
      resolve(null)
    }
  })
}
