// An engine's argv on the real Harness PTY host: a program in a folder with a space, and an npm shim's engine given a
// first message cmd.exe would have run. Windows only. Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/launch.real.spec.ts
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyHostBackend } from '../ptyHostBackend.js'
import { listDiscoveries } from '../ptyHost/launch.js'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { processRows } from '../processTable.js'
import { removeTree } from '../terminalBackend.contract.js'
import { windowsEngineArgv } from './launch.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = 90_000

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function withBackend(run: (backend: PtyHostBackend, scratch: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pty-launch-'))
  const scratch = mkdtempSync(join(tmpdir(), 'pty-launch-'))
  const backend = new PtyHostBackend({ home })
  try {
    const prepared = await backend.prepare({ ownedPanes: new Map() })
    if (prepared.state !== 'ready') throw new Error(`the pty host is unavailable: ${prepared.reason}`)
    await run(backend, scratch)
  } finally {
    const discovery = listDiscoveries(home).findLast((found) => found.protocol === PTY_PROTOCOL)
    backend.dispose()
    if (discovery) try { process.kill(discovery.pid) } catch { /* gone */ }
    removeTree(home)
    removeTree(scratch)
  }
}

;(enabled ? describe : describe.skip)('engine argv on the real pty host', () => {
  it('runs a program by an absolute path with a space in it, not a program named by its first word', async () => {
    await withBackend(async (backend, scratch) => {
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      mkdirSync(join(scratch, 'with space'))
      const program = join(scratch, 'with space', 'ping.exe')
      copyFileSync(join(system32, 'PING.EXE'), program)
      // Unquoted, CreateProcessW tries `<scratch>\with.exe` first (as `C:\Users\John.exe` for `C:\Users\John Doe\…`).
      copyFileSync(join(system32, 'HOSTNAME.EXE'), join(scratch, 'with.exe'))
      const created = await backend.create({ command: [program, '-n', '600', '127.0.0.1'] })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      const root = await backend.rootProcess(created.runtime)
      const rows = await until(processRows, (table) => !!table?.some((row) => row.pid === root))
      expect(rows?.find((row) => row.pid === root)?.imagePath?.toLowerCase()).toBe(program.toLowerCase())
      await backend.kill(created.runtime)
    })
  }, CASE_TIMEOUT_MS)

  it('gives an npm engine a hostile first message as one argument: nothing runs, nothing expands', async () => {
    await withBackend(async (backend, scratch) => {
      // An npm global folder with npm's own codex.cmd, whose script records the argv node gave it.
      copyFileSync(join(import.meta.dirname, 'fixtures', 'npm-codex.cmd'), join(scratch, 'codex.cmd'))
      const script = join(scratch, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      const record = join(scratch, 'argv.json')
      mkdirSync(join(script, '..'), { recursive: true })
      writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))); setTimeout(() => {}, 600000)\n`)
      const pwned = join(scratch, 'pwned.txt')
      const prompts = [`fix&echo pwned>"${pwned}"`, '%PATH%', `a "b & echo pwned>"${pwned}"`, 'line one\n\nline two', 'x | y ^ (z) !w!']
      const argv = windowsEngineArgv('codex', [join(scratch, 'codex.cmd'), ...prompts], { environment: process.env })
      expect(argv.slice(0, 2)).toEqual([expect.stringMatching(/node\.exe$/i), script])
      const created = await backend.create({ command: argv })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      await until(() => existsSync(record), (there) => there)
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(prompts)
      expect(existsSync(pwned)).toBe(false)
      await backend.kill(created.runtime)
    })
  }, CASE_TIMEOUT_MS)
})
