/** Locate the installed terminal host without loading its client, launcher or process state. */
import { accessSync, constants, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'

export const PTY_HOST_BINARY = process.platform === 'win32' ? 'harness-pty.exe' : 'harness-pty'

function runnable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const VERSION_DIR = /^\d+(\.\d+)*$/

export interface PtyHostBinaryOptions {
  env?: NodeJS.ProcessEnv
  runtimeDir?: string
  /** The bundle's own directory (`dist/` in a release); the binary is looked for in its `pty/`. */
  besideDir?: string
}

/**
 * `<runtime>/pty/current-pty`: the name of the `<runtime>/pty/<version>/` directory whose host the installed CLI
 * ships, as `current-grid` pins grid (gridBinary.ts). The installer writes it (sub-project B); this reads it. Only a
 * version name is taken, so the pointer can never name a file outside `<runtime>/pty/`.
 */
export function currentPtyVersion(runtimeDir: string = env.ADAPTER_RUNTIME_DIR): string | null {
  try {
    const recorded = readFileSync(path.join(runtimeDir, 'pty', 'current-pty'), 'utf8').trim()
    return VERSION_DIR.test(recorded) ? recorded : null
  } catch {
    return null
  }
}

/**
 * The `harness-pty` to start, or null when there is none:
 * 1. `HARNESS_PTY_BIN`, as it is (a wrong override should fail loudly, not fall back);
 * 2. `<runtime>/pty/<version>/harness-pty[.exe]` for the version `current-pty` names. Binaries install per version
 *    because Windows cannot overwrite a running .exe (spec §4, host upgrade); older ones stay for the hosts still
 *    draining on them. Pinned, not the newest directory there: a newer one may be another install's, of another
 *    protocol, or one that has not finished (Task 12's review);
 * 3. in `pty/` beside the bundle, where `build-bundle.mjs` puts it with its ConPTY payload for local Windows testing
 *    (scripts/lib/ptyPayload.mjs).
 */
export function ptyHostBinary(options: PtyHostBinaryOptions = {}): string | null {
  const override = (options.env ?? process.env).HARNESS_PTY_BIN?.trim()
  if (override) return override
  const runtimeDir = options.runtimeDir ?? env.ADAPTER_RUNTIME_DIR
  const version = currentPtyVersion(runtimeDir)
  if (version) {
    const file = path.join(runtimeDir, 'pty', version, PTY_HOST_BINARY)
    if (runnable(file)) return file
  }
  const beside = path.join(options.besideDir ?? path.dirname(fileURLToPath(import.meta.url)), 'pty', PTY_HOST_BINARY)
  return runnable(beside) ? beside : null
}
