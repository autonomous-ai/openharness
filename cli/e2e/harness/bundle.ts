/**
 * `E2E_BUNDLE=1`: every daemon in the run starts from one bundle built here, as the release ships,
 * instead of from the sources through tsx (vitest's global setup; `daemon.ts` reads the path).
 *
 * Why: tsx transpiles the whole tree at every start, and a parallel run starts hundreds of daemons —
 * on a 12-core Mac four files at a time drove the load average past 100, and tests timed out that
 * pass alone. A daemon from the bundle starts on a fraction of the CPU. And the run tests the code as
 * it was when it began: from the sources, an edit made mid-run reached every daemon started after it,
 * and 21 tests failed on a half-written change.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export default function setup(): (() => void) | undefined {
  const asked = process.env.E2E_BUNDLE
  if (!asked || asked === '0') return undefined
  const out = mkdtempSync(join(tmpdir(), 'harness-e2e-bundle-'))
  execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: out }, stdio: 'pipe' })
  // Read by every daemon the run starts (`IsolatedDaemon.start`); the workers inherit it.
  process.env.E2E_BUNDLE_PATH = join(out, 'cli.js')
  return () => rmSync(out, { recursive: true, force: true })
}
