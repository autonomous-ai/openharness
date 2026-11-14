/**
 * A data folder too deep for the daemon's local socket, under a home too deep as well: a socket path has 96 bytes at most
 * (lib/localSocket.ts), so `<data>/daemon-<port>.sock` past that goes under `~/.harness/s/`, and a home too long for that
 * too leaves the daemon serving on its port alone. The services that run in processes of their own reach the core only through that socket, so the
 * master runs them in the core's process instead, and every one still answers.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { localSocketName, socketPathIn } from '../src/lib/localSocket.js'

describe('a data folder too deep for the local socket', () => {
  let daemon: IsolatedDaemon | undefined
  let deep = ''
  const tmp = process.env.TMPDIR
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
    if (tmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = tmp
    if (deep) rmSync(deep, { recursive: true, force: true })
  })

  it('runs the services in the core, where they answer, instead of in processes that cannot reach it', async () => {
    deep = mkdtempSync(join(tmpdir(), 'harness-deep-'))
    const dataDir = join(deep, 'a-data-folder-whose-path-is-longer-than-a-unix-socket-path-may-be', 'data')
    mkdirSync(dataDir, { recursive: true })
    expect(Buffer.byteLength(join(dataDir, 'daemon-18473.sock'))).toBeGreaterThan(96)
    const d = await IsolatedDaemon.create({ dataDir })
    daemon = d
    // A short home would hold the socket instead (a CI runner's /tmp): one as deep as the data folder, inside the test's root.
    d.env.HOME = join(d.root, 'home', 'a-home-folder-whose-path-is-longer-than-a-unix-socket-path-may-be')
    mkdirSync(d.env.HOME, { recursive: true })
    expect(socketPathIn(dataDir, localSocketName(d.port), d.env.HOME)).toBeNull()
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

  it('refuses at once, saying so, the harness\'s own data folder under a TMPDIR too long, and leaves no root', async () => {
    deep = mkdtempSync(join(tmpdir(), 'harness-deep-'))
    // A daemon made outside the suite's setup: the run's TMPDIR fits, this one does not.
    const long = join(deep, 'a-temporary-folder-whose-path-is-longer-than-a-unix-socket-path-may-be')
    mkdirSync(long)
    process.env.TMPDIR = long
    const refused = await IsolatedDaemon.create({ port: 54321 }).then((made) => { daemon = made; return null }, (error: Error) => error.message)
    const said = /^TMPDIR is too long for the daemon's Unix socket: (\S+\/htmux-\w{6}\/data\/daemon-54321\.sock) would be (\d+) bytes; a socket path has room for 96\. Run with a shorter TMPDIR, for example TMPDIR=\/tmp npm run test:e2e\.$/.exec(refused ?? '')
    expect(said, refused ?? 'the daemon was created').not.toBeNull()
    expect(said![1].startsWith(`${realpathSync(long)}/`)).toBe(true)
    expect(Number(said![2])).toBe(Buffer.byteLength(said![1]))
    expect(readdirSync(long)).toEqual([])
  })
})
