import { describe, expect, it, vi } from 'vitest'
import type { LaunchDeps } from './daemonLaunch.js'

async function load() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = ''
  return import('./daemonLaunch.js')
}

/** Deterministic deps: a virtual clock that advances on every sleep, a log that tests append to. */
function fakeDeps(overrides: Partial<LaunchDeps> = {}): LaunchDeps & { log: string[]; clock: { now: number } } {
  const clock = { now: 1_000_000 }
  const log: string[] = []
  return {
    log,
    clock,
    readPid: () => null,
    isAlive: () => false,
    readLogSlice: () => log.join('\n'),
    now: () => clock.now,
    // Advance the virtual clock and yield a real macrotask, so a test can change state "between" polls.
    sleep: (ms) => new Promise((r) => { clock.now += ms; setImmediate(r) }),
    port: 18473,
    ...overrides,
  }
}

describe('connectFailure', () => {
  it('classifies the log tail', async () => {
    const { connectFailure } = await load()
    expect(connectFailure('', 1)).toBeNull()
    expect(connectFailure('[backend] machine busy', 1)).toMatchObject({ busy: true, fatal: true })
    expect(connectFailure('Error: listen EADDRINUSE 127.0.0.1:18473', 18473)).toMatchObject({ fatal: true })
    expect(connectFailure('Error: listen EADDRINUSE 127.0.0.1:18473', 18473)?.detail).toContain('hook port 18473')
  })

  it.each([
    ['[backend] socket error: Error · Unexpected server response: 401', { deauth: true, fatal: true }],
    ['[backend] socket error: Error · Unexpected server response: 403', { deauth: true, fatal: true }],
    ['[backend] socket error: Error · Unexpected server response: 409', { busy: true }],
    ['[backend] socket error: Error · Unexpected server response: 404', { fatal: true, deauth: false }],
    ['[backend] socket error: Error · Unexpected server response: 502', { fatal: false }],
    // Offline is not a misconfiguration: the daemon stays up and serves the loopback until DNS is back.
    ['[backend] socket error: ENOTFOUND', { detail: 'host not found (DNS)', fatal: false }],
    ['[backend] socket error: EAI_AGAIN', { detail: 'host not found (DNS)', fatal: false }],
    ['[backend] socket error: EAI_FAIL', { detail: 'host not found (DNS)', fatal: false }],
    ['[backend] socket error: ECONNREFUSED', { detail: 'connection refused', fatal: false }],
    ['[backend] socket error: CERT_HAS_EXPIRED', { detail: 'TLS certificate error', fatal: true }],
    ['[backend] socket error: DEPTH_ZERO_SELF_SIGNED_CERT', { detail: 'TLS certificate error', fatal: true }],
    ['[backend] socket error: SELF_SIGNED_CERT_IN_CHAIN', { detail: 'TLS certificate error', fatal: true }],
    ['[backend] socket error: UNABLE_TO_VERIFY_LEAF_SIGNATURE', { detail: 'TLS certificate error', fatal: true }],
    ['[backend] socket error: ERR_TLS_CERT_ALTNAME_INVALID', { detail: 'TLS certificate error', fatal: true }],
  ])('reads %s, as the gateway writes it', async (line, expected) => {
    const { connectFailure } = await load()
    expect(connectFailure(line, 18473)).toMatchObject(expected)
  })
})

describe('waitForReady', () => {
  it('returns connected as soon as the marker lands', async () => {
    const { waitForReady } = await load()
    const deps = fakeDeps()
    const p = waitForReady(0, 10_000, deps)
    deps.log.push('[cli] dialing', '[backend] connected → wss://x')
    await expect(p).resolves.toEqual({ state: 'connected' })
  })

  it('keeps waiting through transient failures and reports the last one on timeout', async () => {
    const { waitForReady } = await load()
    const deps = fakeDeps()
    deps.log.push('[backend] socket error: ECONNREFUSED')
    await expect(waitForReady(0, 2_000, deps)).resolves.toEqual({ state: 'unreachable', detail: 'connection refused' })
  })

  it('short-circuits on fatal, deauth and busy', async () => {
    const { waitForReady } = await load()
    for (const [line, state] of [
      ['[backend] socket error: Error · Unexpected server response: 404', 'fatal'],
      ['[backend] socket error: Error · Unexpected server response: 403', 'deauth'],
      ['[backend] machine busy', 'busy'],
    ] as const) {
      const deps = fakeDeps()
      deps.log.push(line)
      expect((await waitForReady(0, 10_000, deps)).state).toBe(state)
    }
  })
})

describe('waitForBind', () => {
  it('resolves bound once the pid file names the child', async () => {
    const { waitForBind } = await load()
    let pid: number | null = null
    const deps = fakeDeps({ readPid: () => pid })
    const p = waitForBind(42, () => false, 60_000, deps)
    pid = 41 // a stale file naming someone else is not our bind
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(deps.clock.now).toBeGreaterThan(1_000_000) // polled at least once while it was 41
    pid = 42
    await expect(p).resolves.toBe('bound')
  })

  it('resolves exited when the child dies first', async () => {
    const { waitForBind } = await load()
    let gone = false
    const deps = fakeDeps()
    const p = waitForBind(42, () => gone, 60_000, deps)
    gone = true
    await expect(p).resolves.toBe('exited')
  })

  it('resolves timeout when nothing happens', async () => {
    const { waitForBind } = await load()
    await expect(waitForBind(42, () => false, 5_000, fakeDeps())).resolves.toBe('timeout')
  })
})

describe('daemonSpawnOptions', () => {
  it('starts the daemon detached, on its log, with only the allowlist of this shell', async () => {
    const { daemonSpawnOptions } = await load()
    const shell = { PATH: '/bin', HOME: '/h', ADAPTER_DATA_DIR: '/d', ANTHROPIC_API_KEY: 'kept', HARNESSD_SERVICES: 'none',
      SENTINEL_TOKEN: 's', GH_TOKEN: 'g', NODE_OPTIONS: '--require /fake/hook.cjs', CLAUDE_CODE_MESSAGING_TOKEN: 't', TERM: 'xterm' }
    expect(daemonSpawnOptions(shell, 7, 'darwin')).toEqual({
      detached: true, stdio: ['ignore', 7, 7],
      env: { PATH: '/bin', HOME: '/h', ADAPTER_DATA_DIR: '/d', ANTHROPIC_API_KEY: 'kept', HARNESSD_SERVICES: 'none' },
    })
    expect(shell.SENTINEL_TOKEN).toBe('s')
    // A build run from a checkout on Windows: the whole environment, as before (decision 5).
    expect(daemonSpawnOptions(shell, 7, 'win32').env).toEqual(shell)
  })
})
