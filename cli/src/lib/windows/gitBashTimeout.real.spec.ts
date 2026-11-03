// A setup or doctor that outlives its timeout, run in the real Git Bash: what it started ends with it. Windows only, with
// Git for Windows installed and the host built (the table of who started whom is the host's):
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/gitBashTimeout.real.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDshCommand } from '../../dsh/shell.js'
import { processExists } from '../processLiveness.js'
import { findGitBash } from './gitBash.js'
import { windowsProcessRows } from './processTable.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN && findGitBash() !== null

describe.skipIf(!enabled)('a Git Bash run stopped at its timeout, on Windows', () => {
  it('ends what the script started, not only the shell (review of #2025)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gitbash-timeout-'))
    let child: number | undefined
    try {
      // /proc/<pid>/winpid is the Windows pid of a Git Bash process; $! alone is Git Bash's own numbering. Read a second
      // later, once the fork has exec'd sleep: before, it is the fork's, which exits on its own and would pass the test.
      const result = await runDshCommand('sleep 120 & sleep 1; echo "child $(cat /proc/$!/winpid)"; wait', { cwd: dir, timeoutMs: 10_000 })
      expect(result.timedOut).toBe(true)
      const line = result.lines.find((text) => /^child \d+$/.test(text))
      expect(line, result.lines.join('\n')).toBeDefined()
      child = Number(line!.slice('child '.length))
      const gone = await expect.poll(() => processExists(child!), { timeout: 5_000 }).toBe(false).then(() => true, () => false)
      if (!gone) {
        // Say what Windows shows of it, and of its parent, so a failure says why the stop did not reach it.
        const rows = await windowsProcessRows(null)
        const own = rows?.find((row) => row.pid === child)
        const parent = own && rows?.find((row) => row.pid === own.parentPid)
        expect.fail(`pid ${child} still runs: ${JSON.stringify(own)}; its parent: ${JSON.stringify(parent ?? null)}`)
      }
    } finally {
      if (child) { try { process.kill(child) } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
