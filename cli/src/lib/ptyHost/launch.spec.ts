import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../terminalBackend.contract.js'
import { PtyHostClient } from './client.js'
import { currentPtyVersion, discoveredHostDead, discoverHosts, ensurePtyHost, forgetExitedHost, ptyHostBinary, reachable, reachPtyHost, readDiscovery, removeUnusedPtyVersions, startMarkerMs } from './launch.js'
import { helloProof, PTY_PROTOCOL, SUPPORTED_PTY_PROTOCOLS } from './protocol.js'

const exe = process.platform === 'win32' ? 'harness-pty.exe' : 'harness-pty'
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(() => removeTree(dir))
  return dir
}

function executable(file: string, body = ''): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

const discoveryFile = (home: string) => path.join(home, 'run', `pty-host-${PTY_PROTOCOL}.json`)
function writeDiscovery(home: string, value: unknown): void {
  mkdirSync(path.join(home, 'run'), { recursive: true })
  writeFileSync(discoveryFile(home), JSON.stringify(value))
}

describe('ptyHostBinary', () => {
  it('takes HARNESS_PTY_BIN first, as it is', () => {
    expect(ptyHostBinary({ env: { HARNESS_PTY_BIN: ' /opt/x/harness-pty ' }, runtimeDir: '/nowhere', besideDir: '/nowhere' }))
      .toBe('/opt/x/harness-pty')
  })

  it('takes the version <runtime>/pty/current-pty names, not the newest there', () => {
    const runtime = tempDir('rt-')
    executable(path.join(runtime, 'pty', '0.9.0', exe))
    executable(path.join(runtime, 'pty', '0.10.0', exe))
    // Newer, perhaps another install's of another protocol: not the pinned one.
    executable(path.join(runtime, 'pty', '0.11.0', exe))
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.10.0\n')
    const besideDir = tempDir('dist-')
    executable(path.join(besideDir, 'pty', exe))
    expect(currentPtyVersion(runtime)).toBe('0.10.0')
    expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir })).toBe(path.join(runtime, 'pty', '0.10.0', exe))
    // HARNESS_PTY_BIN still comes first.
    expect(ptyHostBinary({ env: { HARNESS_PTY_BIN: '/o/harness-pty' }, runtimeDir: runtime, besideDir })).toBe('/o/harness-pty')
  })

  it('falls back to the bundle\'s binary when current-pty is missing, not a version, or names no binary', () => {
    const runtime = tempDir('rt-')
    executable(path.join(runtime, 'pty', '0.9.0', exe))
    const besideDir = tempDir('dist-')
    const beside = executable(path.join(besideDir, 'pty', exe))
    // No pointer: the newest directory is not guessed at.
    expect(currentPtyVersion(runtime)).toBeNull()
    expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir })).toBe(beside)
    // A pointer names only a version directory: never a path out of <runtime>/pty.
    for (const pointer of ['../../bin', '/usr/bin', 'latest', '']) {
      writeFileSync(path.join(runtime, 'pty', 'current-pty'), pointer)
      expect(currentPtyVersion(runtime)).toBeNull()
      expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir })).toBe(beside)
    }
    // A version whose install did not finish.
    mkdirSync(path.join(runtime, 'pty', '0.10.0'))
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.10.0')
    expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir })).toBe(beside)
  })

  it.skipIf(process.platform === 'win32')('skips a managed binary that is not executable', () => {
    const runtime = tempDir('rt-')
    const file = executable(path.join(runtime, 'pty', '1.0.0', exe))
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '1.0.0')
    chmodSync(file, 0o644)
    expect(ptyHostBinary({ env: {}, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
  })

  it('falls back to the binary in pty/ beside the bundle (build-bundle.mjs), then to null', () => {
    const besideDir = tempDir('dist-')
    expect(ptyHostBinary({ env: {}, runtimeDir: '/nowhere', besideDir })).toBeNull()
    // Not loose beside it: the host's ConPTY payload travels in its folder.
    executable(path.join(besideDir, exe))
    expect(ptyHostBinary({ env: {}, runtimeDir: '/nowhere', besideDir })).toBeNull()
    executable(path.join(besideDir, 'pty', exe))
    expect(ptyHostBinary({ env: { HARNESS_PTY_BIN: '  ' }, runtimeDir: '/nowhere', besideDir })).toBe(path.join(besideDir, 'pty', exe))
  })
})

describe('readDiscovery', () => {
  const valid = { protocol: PTY_PROTOCOL, instance: 'p1', endpoint: '/x.sock', pid: 7, version: '0.1.0', token: 't' }

  it('reads <home>/run/pty-host-<protocol>.json', () => {
    const home = tempDir('h-')
    writeDiscovery(home, valid)
    expect(readDiscovery(home, PTY_PROTOCOL)).toEqual(valid)
  })

  it('gives null for a missing, unreadable or malformed file, or another protocol', () => {
    const home = tempDir('h-')
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    mkdirSync(path.join(home, 'run'))
    writeFileSync(discoveryFile(home), '{"protocol":')
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    writeDiscovery(home, { ...valid, pid: '7' })
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    writeDiscovery(home, null)
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
    writeDiscovery(home, { ...valid, protocol: PTY_PROTOCOL + 1 })
    expect(readDiscovery(home, PTY_PROTOCOL)).toBeNull()
  })
})

/**
 * A stand-in for `harness-pty serve --home <dir>`: a Node script that records each start in
 * `<home>/spawns`, then serves (writing its discovery file once it listens), fails, or exits
 * at once as a host that found another one serving does.
 */
function fakeBinary(mode: 'serve' | 'fail' | 'quiet' | 'deaf'): string {
  const dir = tempDir('bin-')
  return executable(path.join(dir, exe), `#!${process.execPath}
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
const home = process.argv[process.argv.indexOf('--home') + 1]
const run = path.join(home, 'run')
fs.mkdirSync(run, { recursive: true })
fs.appendFileSync(path.join(home, 'spawns'), process.pid + '\\n')
// What the host was started with, for the spawn-environment test.
fs.writeFileSync(path.join(home, 'env.json'), JSON.stringify({ TMUX: process.env.TMUX ?? null, TMUX_PANE: process.env.TMUX_PANE ?? null, KEPT: process.env.PTY_LAUNCH_KEPT ?? null }))
fs.writeFileSync(path.join(home, 'cwd'), process.cwd())
if (${JSON.stringify(mode)} === 'fail') process.exit(4)
if (${JSON.stringify(mode)} === 'quiet') process.exit(0)
const endpoint = path.join(run, 'h.sock')
fs.rmSync(endpoint, { force: true })
if (${JSON.stringify(mode)} === 'deaf') {
  // A discovery file naming an endpoint nothing listens at, from a host that then stays up.
  const file = path.join(run, 'pty-host-${PTY_PROTOCOL}.json')
  fs.writeFileSync(file, JSON.stringify({ protocol: ${PTY_PROTOCOL}, instance: 'p1', endpoint, pid: process.pid, version: 'fake', token: 'fake-token' }))
  setInterval(() => {}, 1000)
} else {
const server = net.createServer(socket => {
  socket.on('error', () => {})
  let pending = ''
  let said = false
  socket.on('data', chunk => {
    pending += chunk
    let at
    while ((at = pending.indexOf('\\n')) >= 0) {
      const value = JSON.parse(pending.slice(0, at))
      pending = pending.slice(at + 1)
      if (!said) {
        said = true
        const proof = crypto.createHash('sha256').update('fake-token').update('\\0').update(String(value.hello.nonce)).digest('hex')
        socket.write(JSON.stringify({ hello: { ok: true, instance: 'p1', version: 'fake', pid: process.pid, proof } }) + '\\n')
        continue
      }
      socket.write(JSON.stringify(value.op === 'inventory' ? { id: value.id, ok: true, panes: [] } : { id: value.id, ok: true }) + '\\n')
    }
  })
})
server.listen(endpoint, () => {
  const file = path.join(run, 'pty-host-${PTY_PROTOCOL}.json')
  fs.writeFileSync(file + '.tmp', JSON.stringify({ protocol: ${PTY_PROTOCOL}, instance: 'p1', endpoint, pid: process.pid, version: 'fake', token: 'fake-token' }))
  fs.renameSync(file + '.tmp', file)
})
}
`)
}

/** A home whose spawned fake hosts are killed after the test. */
function home(): string {
  const dir = tempDir('h-')
  cleanup.push(() => {
    const spawns = path.join(dir, 'spawns')
    if (!existsSync(spawns)) return
    for (const pid of readFileSync(spawns, 'utf8').split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ }
    }
  })
  return dir
}
const spawnCount = (dir: string) => existsSync(path.join(dir, 'spawns'))
  ? readFileSync(path.join(dir, 'spawns'), 'utf8').split('\n').filter(Boolean).length
  : 0

async function clientOf(result: Awaited<ReturnType<typeof ensurePtyHost>>): Promise<PtyHostClient> {
  if (!('client' in result)) throw new Error(`no client: ${JSON.stringify(result)}`)
  cleanup.push(() => result.client.close())
  return result.client
}

// The fake binary is a script with a shebang, which Windows cannot run.
describe.skipIf(process.platform === 'win32')('ensurePtyHost', () => {
  it('connects to the host the discovery file names, without starting one', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    const first = await clientOf(await ensurePtyHost(dir, { binary }))
    expect(spawnCount(dir)).toBe(1)
    const second = await clientOf(await ensurePtyHost(dir, { binary: null }))
    expect(second).not.toBe(first)
    expect(await second.call({ op: 'inventory' })).toEqual({ state: 'ok', value: { panes: [] } })
    expect(spawnCount(dir)).toBe(1)
  })

  it('starts the host without the daemon\'s tmux identity: its panes are not inside the daemon\'s tmux pane', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0')
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubEnv('PTY_LAUNCH_KEPT', 'yes')
    try {
      const dir = home()
      await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
      expect(JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8'))).toEqual({ TMUX: null, TMUX_PANE: null, KEPT: 'yes' })
      expect(process.env.TMUX_PANE).toBe('%42')
    } finally { vi.unstubAllEnvs() }
  })

  it('starts the host in its home, not in the daemon\'s directory', async () => {
    const dir = home()
    await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    expect(readFileSync(path.join(dir, 'cwd'), 'utf8')).toBe(realpathSync(dir))
    expect(realpathSync(process.cwd())).not.toBe(realpathSync(dir))
  })

  it('starts the host in a home that does not exist yet, making it', async () => {
    const parent = home()
    const dir = path.join(parent, 'not', 'yet')
    const client = await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    cleanup.push(() => {
      const pid = readDiscovery(dir, PTY_PROTOCOL)?.pid
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    })
    expect(client.instance).toBe('p1')
    expect(readFileSync(path.join(dir, 'cwd'), 'utf8')).toBe(realpathSync(dir))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('starts a host when there is no discovery file, and waits for it', async () => {
    const dir = home()
    const client = await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    expect(client.instance).toBe('p1')
    expect(readDiscovery(dir, PTY_PROTOCOL)?.pid).toBe(Number(readFileSync(path.join(dir, 'spawns'), 'utf8').trim()))
  })

  it('starts a host when the endpoint in the discovery file refuses', async () => {
    const dir = home()
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint: path.join(dir, 'gone.sock'), pid: 999_999, version: 'old', token: 't' })
    const client = await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
    expect(readDiscovery(dir, PTY_PROTOCOL)?.version).toBe('fake')
  })

  it('starts one host for concurrent calls', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    const results = await Promise.all([ensurePtyHost(dir, { binary }), ensurePtyHost(dir, { binary }), ensurePtyHost(dir, { binary })])
    for (const result of results) await clientOf(result)
    expect(spawnCount(dir)).toBe(1)
  })

  it('is unavailable when there is no binary', async () => {
    expect(await ensurePtyHost(home(), { binary: null })).toEqual({
      unavailable: expect.stringContaining('harness-pty'), code: 'PTY_HOST_UNAVAILABLE',
    })
  })

  it('is unavailable when the binary cannot be started', async () => {
    const result = await ensurePtyHost(home(), { binary: path.join(tempDir('bin-'), 'missing') })
    expect(result).toEqual({ unavailable: expect.stringContaining('could not start'), code: 'PTY_HOST_UNAVAILABLE' })
  })

  it('is unavailable at once when the host exits with an error', async () => {
    const started = Date.now()
    const result = await ensurePtyHost(home(), { binary: fakeBinary('fail'), waitMs: 5_000 })
    expect(result).toEqual({ unavailable: expect.stringContaining('exited with code 4'), code: 'PTY_HOST_UNAVAILABLE' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('is unavailable when no discovery file appears in time', async () => {
    const result = await ensurePtyHost(home(), { binary: fakeBinary('quiet'), waitMs: 300 })
    expect(result).toEqual({ unavailable: expect.stringContaining('300 ms'), code: 'PTY_HOST_UNAVAILABLE' })
  })

  it('is unavailable, saying so, when the endpoint a new discovery file names refuses connections', async () => {
    const result = await ensurePtyHost(home(), { binary: fakeBinary('deaf') })
    expect(result).toEqual({
      unavailable: 'no harness-pty answers at the endpoint its discovery file names', code: 'PTY_HOST_UNAVAILABLE',
    })
  })

  it('reports a host that refuses this daemon as incompatible, without starting another', async () => {
    const dir = home()
    const endpoint = path.join(dir, 'r.sock')
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ hello: { ok: false, code: 'incompatible', reason: 'wrong token' } })}\n`)
      })
    })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: 1, version: 'v', token: 'stale' })
    expect(await ensurePtyHost(dir, { binary: fakeBinary('serve') })).toEqual({ incompatible: 'incompatible: wrong token' })
    expect(spawnCount(dir)).toBe(0)
  })

  it('never dials the endpoint a dead host\'s discovery file names: whoever has it now is not the host', async () => {
    const dir = home()
    const endpoint = path.join(dir, 'squatted.sock')
    let dialled = 0
    const squatter = net.createServer(socket => {
      dialled++
      socket.on('error', () => {})
      socket.once('data', () => socket.end(`${JSON.stringify({ hello: { ok: false, code: 'incompatible', reason: 'squatter' } })}\n`))
    })
    squatter.listen(endpoint)
    await once(squatter, 'listening')
    cleanup.push(() => new Promise(resolve => squatter.close(resolve)))
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: deadPid(), version: 'v', token: 'stale' })
    const client = await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve') }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
    expect(spawnCount(dir)).toBe(1)
    expect(dialled).toBe(0)
  })

  it('takes a pid given to another process since the file was written for a dead host, and a live one\'s refusal as an error', async () => {
    const dir = home()
    const endpoint = path.join(dir, 'refusing.sock')
    let dialled = 0
    const server = net.createServer(socket => {
      dialled++
      socket.on('error', () => {})
      socket.once('data', () => socket.end(`${JSON.stringify({ hello: { ok: false, code: 'incompatible', reason: 'wrong token' } })}\n`))
    })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: process.pid, version: 'v', token: 'stale' })
    // The host that wrote the file started before it; this one after: not it.
    // (The host started in its place is listed too, as having started before its own file.)
    const started = () => existsSync(path.join(dir, 'spawns'))
      ? readFileSync(path.join(dir, 'spawns'), 'utf8').split('\n').filter(Boolean).map(Number) : []
    const later = { alive: () => true, rows: async () => [
      { pid: process.pid, executable: 'x', startMarker: filetime(Date.now() + 60_000) },
      ...started().map(pid => ({ pid, executable: 'harness-pty', startMarker: filetime(Date.now() - 60_000) })),
    ] }
    expect(await clientOf(await ensurePtyHost(dir, { binary: fakeBinary('serve'), liveness: later }))).toBeTruthy()
    expect(dialled).toBe(0)
    // The process that wrote it, still running and refusing: an error, and no other host is started.
    const other = home()
    writeDiscovery(other, { protocol: PTY_PROTOCOL, instance: 'p1', endpoint, pid: process.pid, version: 'v', token: 'stale' })
    const earlier = { alive: () => true, rows: async () => [{ pid: process.pid, executable: 'x', startMarker: filetime(Date.now() - 60_000) }] }
    expect(await ensurePtyHost(other, { binary: fakeBinary('serve'), liveness: earlier })).toEqual({ incompatible: 'incompatible: wrong token' })
    expect(dialled).toBe(1)
    expect(spawnCount(other)).toBe(0)
  })

  it('tries again once when the discovery file changed during a refused hello', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    await clientOf(await ensurePtyHost(dir, { binary }))
    const live = readDiscovery(dir, PTY_PROTOCOL)!
    // A host that just restarted: the file still names the old token while the new host answers.
    const endpoint = path.join(dir, 'r.sock')
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        writeDiscovery(dir, live)
        socket.end(`${JSON.stringify({ hello: { ok: false, code: 'incompatible', reason: 'wrong token' } })}\n`)
      })
    })
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    writeDiscovery(dir, { ...live, endpoint, token: 'old', pid: 1 })
    const client = await clientOf(await ensurePtyHost(dir, { binary: null }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
  })
})

/** An endpoint for a test server: a named pipe on Windows, a socket file in [dir] elsewhere. */
const endpointIn = (dir: string, name: string) => process.platform === 'win32'
  ? `\\\\.\\pipe\\pty-launch-${path.basename(dir)}-${name}`
  : path.join(dir, `${name}.sock`)

/** A host stand-in in this process that proves [token] and answers every request `ok`; the protocols said hello in. */
async function answeringHost(endpoint: string, token: string): Promise<number[]> {
  const protocols: number[] = []
  const server = net.createServer(socket => {
    socket.on('error', () => {})
    let pending = ''
    let said = false
    socket.on('data', chunk => {
      pending += chunk
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const value = JSON.parse(pending.slice(0, at))
        pending = pending.slice(at + 1)
        if (said) { socket.write(`${JSON.stringify({ id: value.id, ok: true })}\n`); continue }
        said = true
        protocols.push(value.hello.protocol)
        socket.write(`${JSON.stringify({ hello: { ok: true, instance: `p${value.hello.protocol}`, version: 'v', pid: process.pid, proof: helloProof(token, value.hello.nonce) } })}\n`)
      }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  cleanup.push(() => new Promise(resolve => server.close(resolve)))
  return protocols
}

const writeDiscoveryOf = (home: string, protocol: number, value: Record<string, unknown>) => {
  mkdirSync(path.join(home, 'run'), { recursive: true })
  writeFileSync(path.join(home, 'run', `pty-host-${protocol}.json`), JSON.stringify({ protocol, instance: `p${protocol}`, version: '0.1.0', token: 't', ...value }))
}
/** A pid no process has: a child that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid!
}

/** A Windows start marker for [ms] since the epoch. */
const filetime = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`

describe('discoveredHostDead', () => {
  it('reads both kinds of start marker', () => {
    expect(startMarkerMs(filetime(1_791_893_045_123))).toBe(1_791_893_045_123)
    expect(startMarkerMs('Thu Oct 15 10:00:00 2026')).toBe(new Date(2026, 9, 15, 10, 0, 0).getTime())
    expect(startMarkerMs('soon')).toBeNull()
  })

  it('is proven only by a pid that runs nothing, a table without it, or a process that started after the file', async () => {
    const dir = tempDir('h-')
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: '/x', pid: 42 })
    const discovery = { protocol: PTY_PROTOCOL, pid: 42 }
    const row = (startMarker: string) => ({ pid: 42, executable: 'harness-pty.exe', startMarker })
    expect(await discoveredHostDead(dir, discovery, { alive: () => false })).toBe(true)
    // The pid alone, alive: no proof.
    expect(await discoveredHostDead(dir, discovery, { alive: () => true })).toBe(false)
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => [] })).toBe(true)
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(true)
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => [row(filetime(Date.now() - 60_000))] })).toBe(false)
    // Within a second-resolution stamp's slack of the file: the host that wrote it.
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => [row(filetime(Date.now() + 1_000))] })).toBe(false)
    // A table that cannot be read, a marker that cannot be read, a file that is not there: no proof.
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => null })).toBe(false)
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => { throw new Error('ps') } })).toBe(false)
    expect(await discoveredHostDead(dir, discovery, { alive: () => true, rows: async () => [row('soon')] })).toBe(false)
    expect(await discoveredHostDead(tempDir('h-'), discovery, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(false)
  })
})

describe('discoverHosts', () => {
  it('reads every supported protocol\'s discovery file, oldest first, and nothing else', () => {
    const dir = tempDir('h-')
    expect(discoverHosts(dir)).toEqual([])
    for (const protocol of [...SUPPORTED_PTY_PROTOCOLS, PTY_PROTOCOL + 1]) writeDiscoveryOf(dir, protocol, { endpoint: `/e${protocol}`, pid: protocol })
    expect(discoverHosts(dir).map(host => host.protocol)).toEqual([...SUPPORTED_PTY_PROTOCOLS])
    expect(SUPPORTED_PTY_PROTOCOLS).toEqual([PTY_PROTOCOL - 1, PTY_PROTOCOL].filter(p => p >= 1))
  })
})

describe('reachPtyHost', () => {
  it('connects to the host of the protocol asked, in its own protocol, and never starts one', async () => {
    const dir = tempDir('h-')
    const protocol = SUPPORTED_PTY_PROTOCOLS[0]
    const endpoint = endpointIn(dir, 'old')
    const protocols = await answeringHost(endpoint, 't')
    writeDiscoveryOf(dir, protocol, { endpoint, pid: process.pid })
    const result = await reachPtyHost(dir, protocol)
    const client = await clientOf(result as Awaited<ReturnType<typeof ensurePtyHost>>)
    expect(client.protocol).toBe(protocol)
    expect(protocols).toEqual([protocol])
  })

  it('never dials a dead host\'s endpoint, even when something answers there', async () => {
    const dir = tempDir('h-')
    const protocol = SUPPORTED_PTY_PROTOCOLS[0]
    const endpoint = endpointIn(dir, 'squatted')
    const protocols = await answeringHost(endpoint, 't')
    const dead = deadPid()
    writeDiscoveryOf(dir, protocol, { endpoint, pid: dead })
    expect(await reachPtyHost(dir, protocol)).toEqual({ unavailable: expect.stringContaining(`pid ${dead}`), code: 'PTY_HOST_UNAVAILABLE', pid: dead, missing: false })
    expect(protocols).toEqual([])
  })

  it('says what the file named when nothing answers, and never that the host has gone', async () => {
    const dir = tempDir('h-')
    expect(await reachPtyHost(dir, 1)).toEqual({ unavailable: 'there is no pty-host-1.json', code: 'PTY_HOST_UNAVAILABLE', pid: null, missing: true })
    mkdirSync(path.join(dir, 'run'), { recursive: true })
    writeFileSync(path.join(dir, 'run', 'pty-host-1.json'), '{"protocol":')
    expect(await reachPtyHost(dir, 1)).toEqual({ unavailable: 'pty-host-1.json cannot be read', code: 'PTY_HOST_UNAVAILABLE', pid: null, missing: false })
    const dead = deadPid()
    writeDiscoveryOf(dir, 1, { endpoint: endpointIn(dir, 'none'), pid: dead })
    expect(await reachPtyHost(dir, 1)).toEqual({ unavailable: expect.stringContaining(`pid ${dead}`), code: 'PTY_HOST_UNAVAILABLE', pid: dead, missing: false })
  })
})

describe('forgetExitedHost', () => {
  it('takes down the discovery file (and Unix socket) of a host that has exited, and only that one', () => {
    const dir = tempDir('h-')
    const file = path.join(dir, 'run', 'pty-host-1.json')
    const socket = path.join(dir, 'run', 'pty-host-1.sock')
    const dead = deadPid()
    writeDiscoveryOf(dir, 1, { endpoint: socket, pid: dead })
    writeFileSync(socket, '')
    // Another pid's file (a host that took its place), or a live one: kept.
    forgetExitedHost(dir, 1, dead + 1)
    expect(existsSync(file)).toBe(true)
    writeDiscoveryOf(dir, 1, { endpoint: socket, pid: process.pid })
    forgetExitedHost(dir, 1, process.pid)
    expect(existsSync(file)).toBe(true)
    writeDiscoveryOf(dir, 1, { endpoint: socket, pid: dead })
    forgetExitedHost(dir, 1, dead)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(socket)).toBe(process.platform === 'win32')
    // Nothing there: nothing to do.
    forgetExitedHost(dir, 1, dead)
  })
})

describe('removeUnusedPtyVersions', () => {
  it('deletes the versions older than current-pty that no running host of the home has', () => {
    const runtime = tempDir('rt-')
    const dir = tempDir('h-')
    for (const version of ['0.8.0', '0.9.0', '0.9.5', '0.10.0', '0.11.0']) executable(path.join(runtime, 'pty', version, exe))
    executable(path.join(runtime, 'pty', 'tools', exe))
    writeFileSync(path.join(runtime, 'pty', '0.7.0'), 'a file, not a directory')
    // Without the installed CLI's pointer nothing is known to be old.
    expect(removeUnusedPtyVersions(dir, runtime)).toEqual([])
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.10.0')
    // 0.9.5 runs a host still draining here; 0.9.0's host has exited.
    writeDiscoveryOf(dir, SUPPORTED_PTY_PROTOCOLS[0], { endpoint: '/x', pid: process.pid, version: '0.9.5' })
    if (SUPPORTED_PTY_PROTOCOLS.length > 1) writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: '/y', pid: deadPid(), version: '0.9.0' })
    expect(removeUnusedPtyVersions(dir, runtime).sort()).toEqual(['0.8.0', '0.9.0'])
    expect(readdirSync(path.join(runtime, 'pty')).sort()).toEqual(['0.10.0', '0.11.0', '0.7.0', '0.9.5', 'current-pty', 'tools'])
    // No runtime directory at all.
    expect(removeUnusedPtyVersions(dir, path.join(runtime, 'none'))).toEqual([])
  })
})

describe('reachable', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('gives up on a connection that is never accepted, after its timeout', async () => {
    const socket = new net.Socket()
    const destroy = vi.spyOn(socket, 'destroy')
    vi.spyOn(net, 'connect').mockReturnValue(socket)
    const started = Date.now()
    expect(await reachable('/nowhere', 50)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(destroy).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('is true for an endpoint that accepts, and false for one that refuses', async () => {
    const dir = tempDir('r-')
    const endpoint = path.join(dir, 'a.sock')
    const server = net.createServer(socket => socket.on('error', () => {}))
    server.listen(endpoint)
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => server.close(resolve)))
    expect(await reachable(endpoint)).toBe(true)
    expect(await reachable(path.join(dir, 'none.sock'))).toBe(false)
  })
})

// Runs the real host: `cd pty && cargo +stable build`, then
// HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/ptyHost/launch.spec.ts
describe.skipIf(!process.env.HARNESS_PTY_BIN)('ensurePtyHost with the real harness-pty', () => {
  it('starts the host in a temporary home, lists no panes, and reports a pane\'s exit after its create', async () => {
    const dir = tempDir('h-')
    cleanup.push(() => {
      const pid = readDiscovery(dir, PTY_PROTOCOL)?.pid
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    })
    const client = await clientOf(await ensurePtyHost(dir))
    expect(client.instance).toBe(`p${PTY_PROTOCOL}`)
    expect(await client.call({ op: 'inventory' })).toEqual({ state: 'ok', value: { panes: [] } })

    // A command that exits at once: its exit notice may overtake the create reply.
    const exits: Array<string> = []
    const known = new Set<string>()
    client.onEvent(e => { if (e.event === 'exit') exits.push(`${known.has(e.pane) ? 'known' : 'unknown'} ${e.pane} ${e.status}`) })
    const command = process.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'exit 3'] : ['/bin/sh', '-c', 'exit 3']
    const created = await client.call({ op: 'create', command, cols: 80, rows: 24, owner: 'test', hold: false })
    if (created.state !== 'ok') throw new Error(JSON.stringify(created))
    known.add(created.value.pane)
    await expect.poll(() => exits, { timeout: 5_000 }).toEqual([`known ${created.value.pane} 3`])

    const stream = await client.openStream()
    expect(stream).not.toBeNull()
    stream!.destroy()
  })
})
