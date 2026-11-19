/**
 * A trust file that cannot be read, as a person meets it (docs/plans/2026-11-19-atomic-state-writes-design.md):
 * `harness status` names it with its full path and the fix, a command that would replace it fails and says which
 * file, and its bytes never change. The CLI runs from source with the daemon's environment, as a terminal on that
 * machine would.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLI_ROOT, IsolatedDaemon } from './harness/daemon.js'

// What a reader saw mid-write.
const TORN = '[{"identityPub":"'

function harness(d: IsolatedDaemon, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: CLI_ROOT, env: d.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => done({ code: code ?? -1, out, err }))
  })
}

function tear(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, text, { mode: 0o600 })
}

const line = (file: string): string => `  ! ${file} cannot be read (not valid JSON) · move it aside to start over`

describe('a trust file that cannot be read', () => {
  let d: IsolatedDaemon | null = null
  afterEach(async () => { await d?.close(); d = null })

  it('status names a paired set it cannot read, and unpair does not replace it', async () => {
    d = await IsolatedDaemon.create()
    const paired = join(d.dataDir, 'e2e', 'paired.json')
    // Before the start: a daemon that loaded a good file holds the set in memory, and its next write heals the file.
    tear(paired, TORN)
    await d.start()

    const status = await harness(d, ['status'])
    expect(status.code, status.err).toBe(0)
    expect(status.out).toContain(line(paired))
    const unpair = await harness(d, ['unpair', '--all'])
    expect(unpair.code, unpair.out).toBe(1)
    expect(readFileSync(paired, 'utf8')).toBe(TORN)
  })

  it('a trust command with the daemon stopped says which file it cannot read', async () => {
    d = await IsolatedDaemon.create()
    const password = join(d.dataDir, 'e2e', 'remotePassword.json')
    tear(password, '{"v":1,"stretched":"')

    const clear = await harness(d, ['remote-password', 'clear'])
    expect(clear.code).toBe(1)
    expect(clear.err).toContain('✗ remotePassword.json cannot be read (not valid JSON)')
    expect(clear.err).toContain('  harness status shows where it is')
    expect(clear.err).not.toContain('Failed to start adapter')
    expect(clear.err).not.toMatch(/\n\s+at /)
    expect(readFileSync(password, 'utf8')).toBe('{"v":1,"stretched":"')
  })

  it('a torn device log does not break status', async () => {
    d = await IsolatedDaemon.create()
    const devlog = join(d.dataDir, 'e2e', 'devlog.json')
    tear(devlog, '{"recent":[')

    const status = await harness(d, ['status'])
    expect(status.code, status.err).toBe(0)
    expect(status.out).toContain('○ stopped')
    expect(status.out).toContain(line(devlog))
    expect(readFileSync(devlog, 'utf8')).toBe('{"recent":[')
  })
})
