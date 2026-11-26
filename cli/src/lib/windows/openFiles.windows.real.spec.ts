// `harness-pty files --json` (pty/src/open_files.rs) against the reader (openFiles.ts) on the real host: a row's files
// and folder are named as `realpath` and `folderKey` name them, and its start marker is the process table's, which is
// what `codexServed` and `processView` compare (docs/plans/2026-11-27-windows-codex-rescan-design.md). Windows only;
// the Windows workflow runs it with src/lib/windows against the release build. By hand, build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/openFiles.windows.real.spec.ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { folderKey } from '../sessionSearch/externals/support.js'
import { windowsOpenFiles } from './openFiles.js'
import { windowsProcessRows } from './processTable.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = 60_000

// mkdtemp under the runner's TEMP, which may be spelled with an 8.3 name (RUNNER~1): the host must name it long.
const tempFolder = () => mkdtempSync(join(tmpdir(), 'open-files-'))

;(enabled ? describe : describe.skip)('harness-pty files on the real host', () => {
  it('lists a file this process holds and its folder, as the PTY host\'s table and folderKey name them', async () => {
    const dir = tempFolder()
    const file = join(dir, 'held.jsonl')
    const fd = openSync(file, 'w')
    let open = true
    try {
      const [read, table] = await Promise.all([windowsOpenFiles([process.pid]), windowsProcessRows(null)])
      const row = read?.get(process.pid)
      expect(row?.files).toContain(realpathSync.native(file))
      expect(row?.cwd).toBe(await folderKey(process.cwd()))
      const own = table?.find((entry) => entry.pid === process.pid)
      expect(own?.startMarker).toMatch(/^w:\d+$/)
      expect(row?.startMarker).toBe(own?.startMarker)

      closeSync(fd)
      open = false
      const after = (await windowsOpenFiles([process.pid]))?.get(process.pid)
      // Read again, not left out: a missing row would pass the check below for the wrong reason.
      expect(after).toBeDefined()
      expect(after?.files).not.toContain(realpathSync.native(file))
    } finally {
      // Never closed twice: the number may be another file's by then.
      if (open) closeSync(fd)
      rmSync(dir, { recursive: true, force: true })
    }
  }, CASE_TIMEOUT_MS)

  it('names a folder as folderKey does', async () => {
    const dir = tempFolder()
    // Spelled in another case than the disk's: the PEB keeps a process's spelling, the host must not.
    const child = spawn('ping.exe', ['-n', '30', '127.0.0.1'], { cwd: dir.toUpperCase(), windowsHide: true, stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      const pid = child.pid!
      // The folder's handle is set as the process starts: wait for it, bounded.
      const cwd = await vi.waitFor(async () => {
        const read = (await windowsOpenFiles([pid]))?.get(pid)?.cwd
        expect(read).toBeDefined()
        return read
      }, { timeout: 15_000, interval: 100 })
      expect(cwd).toBe(await folderKey(dir))

      const exited = once(child, 'exit')
      child.kill()
      await exited
      const gone = await windowsOpenFiles([pid])
      // An empty map, never null: the run worked and the exited process is left out.
      expect(gone).not.toBeNull()
      expect(gone?.has(pid)).toBe(false)
    } finally {
      // A spawn that failed never exits: nothing to wait for.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, CASE_TIMEOUT_MS)
})
