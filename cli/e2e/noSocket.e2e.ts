/**
 * A data folder too deep for the daemon's local socket: a socket path has 96 bytes at most
 * (lib/localSocket.ts), so `<data>/daemon-<port>.sock` past that leaves the daemon serving on its port
 * alone. The services that run in processes of their own reach the core only through that socket, so the
 * master runs them in the core's process instead, and every one still answers.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

describe('a data folder too deep for the local socket', () => {
  let daemon: IsolatedDaemon | undefined
  let deep = ''
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
    if (deep) rmSync(deep, { recursive: true, force: true })
  })

  it('runs the services in the core, where they answer, instead of in processes that cannot reach it', async () => {
    deep = mkdtempSync(join(tmpdir(), 'harness-deep-'))
    const dataDir = join(deep, 'a-data-folder-whose-path-is-longer-than-a-unix-socket-path-may-be', 'data')
    mkdirSync(dataDir, { recursive: true })
    expect(Buffer.byteLength(join(dataDir, 'daemon-18473.sock'))).toBeGreaterThan(96)
    const d = await IsolatedDaemon.create({ dataDir })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    // No socket to wait for: the port, and start-up done.
    await d.start({ ready: 'none' })
    await until('the daemon to finish starting', () => /\[cli\] ready/.test(d.log()) || null, 90_000, 200)
    const client = await LocalClient.connect(d, { tcp: true })
    // Search, the monitor and the project readers answer, from the core's own process.
    expect(await client.request('session_search', { query: 'anything' }, 30_000)).not.toHaveProperty('error')
    expect(await client.request('machine_resources', {}, 30_000)).not.toHaveProperty('error')
    expect(await client.request('fs_list_dir', {}, 30_000)).not.toHaveProperty('error')
    // And no service process is left crashing on every start because it cannot reach the core.
    expect(d.log()).not.toMatch(/the core has no local socket to reach/)
    client.close()
  })
})
