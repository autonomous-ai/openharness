import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOT_RUNNING, pidIn, refused, SANDBOXED, sandboxed, START_OUTSIDE, startRefusalText, unreachableText } from './unreachable.js'

const errno = (code: string) => Object.assign(new Error(code), { code })
const failing = (code: string) => () => { throw errno(code) }
/** kill(pid, 0) as Codex's seatbelt answers it (`codex sandbox` 0.162.1, 2026-10-11): EPERM for the daemon, which is
 *  there, and ESRCH for a pid that is gone, as anywhere. */
const daemon = { here: () => {}, sandboxed: failing('EPERM'), gone: failing('ESRCH') }
const CODEX = { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' }

/** A sandbox (Codex's on macOS) kept a running Harness out of reach, and an agent was told to start it (2026-10-12). */
describe('a daemon this shell cannot reach', () => {
  it('is out of a sandbox\'s reach when the connection or the file was not permitted and the daemon is there', () => {
    expect(sandboxed({ error: errno('EPERM'), env: {}, pid: 42, signal: daemon.here })).toBe(true)
    expect(sandboxed({ error: errno('EACCES'), env: {}, pid: 42, signal: daemon.here })).toBe(true)
    expect(sandboxed({ error: errno('ECONNREFUSED'), env: {}, pid: 42, signal: daemon.here })).toBe(false)
    expect(sandboxed({ error: 'not an error', env: {}, pid: 42, signal: daemon.here })).toBe(false)
  })

  it('is in a sandbox when Codex says so, or when even asking whether its process lives is not permitted', () => {
    expect(sandboxed({ env: CODEX, pid: 42, signal: daemon.sandboxed })).toBe(true)
    expect(sandboxed({ env: { CODEX_SANDBOX: 'seatbelt' }, pid: 42, signal: daemon.here })).toBe(true)
    expect(sandboxed({ env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' }, pid: 42, signal: daemon.here })).toBe(true)
    expect(sandboxed({ env: {}, pid: 42, signal: daemon.sandboxed })).toBe(true)
    // No such process: stopped, as before.
    expect(sandboxed({ env: {}, pid: 42, signal: daemon.gone })).toBe(false)
    expect(sandboxed({ env: {}, pid: 42, signal: daemon.here })).toBe(false)
    expect(sandboxed({ env: {}, pid: null })).toBe(false)
    // Asked of this process itself, which is alive and may be signalled.
    expect(sandboxed({ env: {}, pid: process.pid })).toBe(false)
  })

  it('never says Harness runs when its process is gone: seatbelt refuses a port nobody listens on, and marks every command', () => {
    for (const pid of [42, null]) {
      const signal = daemon.gone
      expect(sandboxed({ error: errno('EPERM'), env: CODEX, pid, signal })).toBe(false)
      expect(unreachableText({ error: errno('EPERM'), env: CODEX, pid, signal })).toBe(START_OUTSIDE)
      expect(unreachableText({ env: CODEX, pid, signal })).toBe(START_OUTSIDE)
      // No sandbox Harness knows of: start it, as before.
      expect(unreachableText({ error: errno('EPERM'), env: {}, pid, signal })).toBe(NOT_RUNNING)
    }
    expect(START_OUTSIDE).toBe('Harness is not running here, and this sandbox keeps it from starting. Run `harness start` outside the sandbox (with escalated permissions).')
  })

  it('is told to run its command outside the sandbox, never to start Harness', () => {
    expect(unreachableText({ error: errno('EPERM'), env: {}, pid: 42, signal: daemon.sandboxed })).toBe(SANDBOXED)
    expect(unreachableText({ env: CODEX, pid: 42, signal: daemon.sandboxed })).toBe(SANDBOXED)
    expect(SANDBOXED).not.toMatch(/harness start/)
    expect(unreachableText({ error: errno('ECONNREFUSED'), env: {}, pid: 42, signal: daemon.gone })).toBe(NOT_RUNNING)
    expect(NOT_RUNNING).toMatch(/harness start/)
    expect(unreachableText({ env: { ...process.env, CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '' } })).toBe(NOT_RUNNING)
  })

  it('has `harness start` say why the sandbox refused it, and leaves any other failure as it was', () => {
    const mkdir = errno('EPERM')
    expect(startRefusalText({ error: mkdir, env: CODEX, pid: 42, signal: daemon.sandboxed })).toBe(SANDBOXED)
    expect(startRefusalText({ error: mkdir, env: CODEX, pid: null })).toBe(START_OUTSIDE)
    // Outside a sandbox, EPERM on the data folder is a permissions problem, shown as it is.
    expect(startRefusalText({ error: mkdir, env: {}, pid: null })).toBeNull()
    expect(startRefusalText({ error: new Error('busy'), env: CODEX, pid: 42, signal: daemon.sandboxed })).toBeNull()
  })

  it('reads the pid file of the daemon it is asked about, and knows a refusal from an absent daemon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unreachable-'))
    try {
      expect(pidIn(dir)).toBeNull()
      writeFileSync(join(dir, 'adapter.pid'), '4242\n')
      expect(pidIn(dir)).toBe(4242)
      // 0 and below name process groups: kill(0, 0) always succeeds. A file that is not a pid names no process.
      for (const text of ['0', '-1', 'nope', '12x']) {
        writeFileSync(join(dir, 'adapter.pid'), text)
        expect(pidIn(dir), text).toBeNull()
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
    for (const code of ['EPERM', 'EACCES']) expect(refused(errno(code))).toBe(true)
    for (const code of ['ECONNREFUSED', 'ENOENT']) expect(refused(errno(code))).toBe(false)
    expect(refused(undefined)).toBe(false)
  })
})
