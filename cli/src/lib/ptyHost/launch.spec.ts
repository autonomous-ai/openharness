import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../terminalBackend.contract.js'
import { PtyHostClient } from './client.js'
import { binaryVersion, currentPtyVersion, discoveredHostDead, ensurePtyHost, forgetExitedHost, listDiscoveries, ptyHostBinary, reachable, reachPtyHost, readInstanceDiscovery, removeUnusedPtyVersions, startMarkerMs, targetHost } from './launch.js'
import { discoveryFileName } from './instance.js'
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

/** The instance a host from before versioned instances has: `p<protocol>`, in `pty-host-<protocol>.json`. */
const LEGACY = `p${PTY_PROTOCOL}`
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

describe('readInstanceDiscovery', () => {
  const valid = { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint: '/x.sock', pid: 7, version: '0.1.0', token: 't' }

  it('reads a legacy p<n> from <home>/run/pty-host-<n>.json, and a versioned one from pty-host-<instance>.json', () => {
    const home = tempDir('h-')
    writeDiscovery(home, valid)
    expect(readInstanceDiscovery(home, LEGACY)).toEqual(valid)
    const versioned = { ...valid, instance: `p${PTY_PROTOCOL}-0.4.21`, version: '0.4.21' }
    writeFileSync(path.join(home, 'run', `pty-host-p${PTY_PROTOCOL}-0.4.21.json`), JSON.stringify(versioned))
    expect(readInstanceDiscovery(home, versioned.instance)).toEqual(versioned)
    // Each instance its own file.
    expect(readInstanceDiscovery(home, LEGACY)).toEqual(valid)
  })

  it('gives null for a missing, unreadable or malformed file, another protocol or another instance', () => {
    const home = tempDir('h-')
    expect(readInstanceDiscovery(home, LEGACY)).toBeNull()
    mkdirSync(path.join(home, 'run'))
    writeFileSync(discoveryFile(home), '{"protocol":')
    expect(readInstanceDiscovery(home, LEGACY)).toBeNull()
    writeDiscovery(home, { ...valid, pid: '7' })
    expect(readInstanceDiscovery(home, LEGACY)).toBeNull()
    writeDiscovery(home, null)
    expect(readInstanceDiscovery(home, LEGACY)).toBeNull()
    writeDiscovery(home, { ...valid, protocol: PTY_PROTOCOL + 1 })
    expect(readInstanceDiscovery(home, LEGACY)).toBeNull()
    writeDiscovery(home, { ...valid, instance: `p${PTY_PROTOCOL}-0.4.21` })
    expect(readInstanceDiscovery(home, LEGACY)).toBeNull()
    // Not an instance: never a path.
    expect(readInstanceDiscovery(home, '../run/pty-host-2')).toBeNull()
  })
})

describe('listDiscoveries', () => {
  it('listDiscoveries finds legacy and versioned hosts, oldest first', () => {
    const dir = tempDir('h-')
    expect(listDiscoveries(dir)).toEqual([])
    expect(listDiscoveries(path.join(dir, 'none'))).toEqual([])
    writeDiscoveryOf(dir, 2, { endpoint: '/b', pid: 2, version: '0.4.21' }, 'p2-0.4.21')
    writeDiscoveryOf(dir, 3, { endpoint: '/e', pid: 5, version: '0.1.0' }, 'p3-0.1.0')
    writeDiscoveryOf(dir, 2, { endpoint: '/a', pid: 1, version: '0.4.20' }, 'p2-0.4.20')
    writeDiscoveryOf(dir, 2, { endpoint: '/l', pid: 9, version: '0.4.19' })
    writeDiscoveryOf(dir, 2, { endpoint: '/d', pid: 3, version: '0.4.21-dev.win1' }, 'p2-0.4.21-dev.win1')
    writeDiscoveryOf(dir, 1, { endpoint: '/o', pid: 4, version: '0.3.0' })
    // Not discovery files: the wrong shape, an instance another file is named for, a protocol its instance is not of.
    writeFileSync(path.join(dir, 'run', 'pty-host-junk.json'), JSON.stringify({ protocol: 2, instance: 'junk', endpoint: '/j', pid: 6, version: 'x', token: 't' }))
    writeFileSync(path.join(dir, 'run', 'pty-host-p2-9.json'), JSON.stringify({ protocol: 2, instance: 'p2-0.4.20', endpoint: '/j', pid: 6, version: 'x', token: 't' }))
    writeFileSync(path.join(dir, 'run', 'pty-host-p2-8.json'), JSON.stringify({ protocol: 1, instance: 'p2-8', endpoint: '/j', pid: 6, version: 'x', token: 't' }))
    writeFileSync(path.join(dir, 'run', 'pty-host-p2-7.json'), '{"protocol":')
    writeFileSync(path.join(dir, 'run', 'pty-host-p2-0.4.20.lock'), '')
    expect(listDiscoveries(dir).map(host => host.instance)).toEqual(['p1', 'p2', 'p2-0.4.20', 'p2-0.4.21-dev.win1', 'p2-0.4.21', 'p3-0.1.0'])
    expect(listDiscoveries(dir)[2]).toEqual({ protocol: 2, instance: 'p2-0.4.20', endpoint: '/a', pid: 1, version: '0.4.20', token: 't' })
  })
})

/**
 * A stand-in for `harness-pty serve --home <dir>`: a Node script that records each start in
 * `<home>/spawns`, then serves (writing its discovery file once it listens), fails, or exits
 * at once as a host that found another one serving does.
 */
function fakeBinary(mode: 'serve' | 'fail' | 'quiet' | 'deaf', options: { instance?: string; versionLine?: string; file?: string } = {}): string {
  const instance = options.instance ?? LEGACY
  const name = discoveryFileName(instance)!
  return executable(options.file ?? path.join(tempDir('bin-'), exe), `#!${process.execPath}
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
if (process.argv[2] === 'version') {
  if (process.env.FAKE_PTY_RUNS) fs.appendFileSync(process.env.FAKE_PTY_RUNS, 'version\\n')
  process.stdout.write(${JSON.stringify(`${options.versionLine ?? ''}\n`)})
  process.exit(0)
}
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
  const file = path.join(run, ${JSON.stringify(name)})
  fs.writeFileSync(file, JSON.stringify({ protocol: ${PTY_PROTOCOL}, instance: ${JSON.stringify(instance)}, endpoint, pid: process.pid, version: 'fake', token: 'fake-token' }))
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
        socket.write(JSON.stringify({ hello: { ok: true, instance: ${JSON.stringify(instance)}, version: 'fake', pid: process.pid, proof } }) + '\\n')
        continue
      }
      socket.write(JSON.stringify(value.op === 'inventory' ? { id: value.id, ok: true, panes: [] } : { id: value.id, ok: true }) + '\\n')
    }
  })
})
server.listen(endpoint, () => {
  const file = path.join(run, ${JSON.stringify(name)})
  fs.writeFileSync(file + '.tmp', JSON.stringify({ protocol: ${PTY_PROTOCOL}, instance: ${JSON.stringify(instance)}, endpoint, pid: process.pid, version: 'fake', token: 'fake-token' }))
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
    const first = await clientOf(await ensurePtyHost(dir, { target: null, binary }))
    expect(spawnCount(dir)).toBe(1)
    const second = await clientOf(await ensurePtyHost(dir, { target: null, binary: null }))
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
      await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') }))
      expect(JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8'))).toEqual({ TMUX: null, TMUX_PANE: null, KEPT: 'yes' })
      expect(process.env.TMUX_PANE).toBe('%42')
    } finally { vi.unstubAllEnvs() }
  })

  it('starts the host in its home, not in the daemon\'s directory', async () => {
    const dir = home()
    await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') }))
    expect(readFileSync(path.join(dir, 'cwd'), 'utf8')).toBe(realpathSync(dir))
    expect(realpathSync(process.cwd())).not.toBe(realpathSync(dir))
  })

  it('starts the host in a home that does not exist yet, making it', async () => {
    const parent = home()
    const dir = path.join(parent, 'not', 'yet')
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') }))
    cleanup.push(() => {
      const pid = readInstanceDiscovery(dir, LEGACY)?.pid
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    })
    expect(client.instance).toBe(LEGACY)
    expect(readFileSync(path.join(dir, 'cwd'), 'utf8')).toBe(realpathSync(dir))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('starts a host when there is no discovery file, and waits for it', async () => {
    const dir = home()
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') }))
    expect(client.instance).toBe(LEGACY)
    expect(readInstanceDiscovery(dir, LEGACY)?.pid).toBe(Number(readFileSync(path.join(dir, 'spawns'), 'utf8').trim()))
  })

  it('starts a host when the endpoint in the discovery file refuses', async () => {
    const dir = home()
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint: path.join(dir, 'gone.sock'), pid: 999_999, version: 'old', token: 't' })
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
    expect(readInstanceDiscovery(dir, LEGACY)?.version).toBe('fake')
  })

  it('without a target, waits for whichever host of this protocol the binary starts: a versioned one too', async () => {
    const dir = home()
    // A legacy host that has exited is no host.
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint: path.join(dir, 'gone.sock'), pid: deadPid(), version: 'old', token: 't' })
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve', { instance: `p${PTY_PROTOCOL}-0.4.21` }) }))
    expect(client.instance).toBe(`p${PTY_PROTOCOL}-0.4.21`)
    expect(spawnCount(dir)).toBe(1)
  })

  it('starts one host for concurrent calls', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    const results = await Promise.all([ensurePtyHost(dir, { target: null, binary }), ensurePtyHost(dir, { target: null, binary }), ensurePtyHost(dir, { target: null, binary })])
    for (const result of results) await clientOf(result)
    expect(spawnCount(dir)).toBe(1)
  })

  it('is unavailable when there is no binary', async () => {
    expect(await ensurePtyHost(home(), { target: null, binary: null })).toEqual({
      unavailable: expect.stringContaining('harness-pty'), code: 'PTY_HOST_UNAVAILABLE',
    })
  })

  it('is unavailable when the binary cannot be started', async () => {
    const result = await ensurePtyHost(home(), { target: null, binary: path.join(tempDir('bin-'), 'missing') })
    expect(result).toEqual({ unavailable: expect.stringContaining('could not start'), code: 'PTY_HOST_UNAVAILABLE' })
  })

  it('is unavailable at once when the host exits with an error', async () => {
    const started = Date.now()
    const result = await ensurePtyHost(home(), { target: null, binary: fakeBinary('fail'), waitMs: 5_000 })
    expect(result).toEqual({ unavailable: expect.stringContaining('exited with code 4'), code: 'PTY_HOST_UNAVAILABLE' })
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('is unavailable when no discovery file appears in time', async () => {
    const result = await ensurePtyHost(home(), { target: null, binary: fakeBinary('quiet'), waitMs: 300 })
    expect(result).toEqual({ unavailable: expect.stringContaining('300 ms'), code: 'PTY_HOST_UNAVAILABLE' })
  })

  it('is unavailable, saying so, when the endpoint a new discovery file names refuses connections', async () => {
    const result = await ensurePtyHost(home(), { target: null, binary: fakeBinary('deaf') })
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
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint, pid: 1, version: 'v', token: 'stale' })
    expect(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') })).toEqual({ incompatible: 'incompatible: wrong token' })
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
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint, pid: deadPid(), version: 'v', token: 'stale' })
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve') }))
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
    writeDiscovery(dir, { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint, pid: process.pid, version: 'v', token: 'stale' })
    // The host that wrote the file started before it; this one after: not it.
    // (The host started in its place is listed too, as having started before its own file.)
    const started = () => existsSync(path.join(dir, 'spawns'))
      ? readFileSync(path.join(dir, 'spawns'), 'utf8').split('\n').filter(Boolean).map(Number) : []
    const later = { alive: () => true, rows: async () => [
      { pid: process.pid, executable: 'x', startMarker: filetime(Date.now() + 60_000) },
      ...started().map(pid => ({ pid, executable: 'harness-pty', startMarker: filetime(Date.now() - 60_000) })),
    ] }
    expect(await clientOf(await ensurePtyHost(dir, { target: null, binary: fakeBinary('serve'), liveness: later }))).toBeTruthy()
    expect(dialled).toBe(0)
    // The process that wrote it, still running and refusing: an error, and no other host is started.
    const other = home()
    writeDiscovery(other, { protocol: PTY_PROTOCOL, instance: LEGACY, endpoint, pid: process.pid, version: 'v', token: 'stale' })
    const earlier = { alive: () => true, rows: async () => [{ pid: process.pid, executable: 'x', startMarker: filetime(Date.now() - 60_000) }] }
    expect(await ensurePtyHost(other, { target: null, binary: fakeBinary('serve'), liveness: earlier })).toEqual({ incompatible: 'incompatible: wrong token' })
    expect(dialled).toBe(1)
    expect(spawnCount(other)).toBe(0)
  })

  it('tries again once when the discovery file changed during a refused hello', async () => {
    const dir = home()
    const binary = fakeBinary('serve')
    await clientOf(await ensurePtyHost(dir, { target: null, binary }))
    const live = readInstanceDiscovery(dir, LEGACY)!
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
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: null }))
    expect(await client.call({ op: 'inventory' })).toMatchObject({ state: 'ok' })
  })
})

/** An endpoint for a test server: a named pipe on Windows, a socket file in [dir] elsewhere. */
const endpointIn = (dir: string, name: string) => process.platform === 'win32'
  ? `\\\\.\\pipe\\pty-launch-${path.basename(dir)}-${name}`
  : path.join(dir, `${name}.sock`)

/**
 * A host stand-in in this process that proves [token] and answers every request `ok`, saying hello as [instance]
 * (`p<protocol>` by default); the protocols said hello in.
 */
async function answeringHost(endpoint: string, token: string, instance?: string): Promise<number[]> {
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
        socket.write(`${JSON.stringify({ hello: { ok: true, instance: instance ?? `p${value.hello.protocol}`, version: 'v', pid: process.pid, proof: helloProof(token, value.hello.nonce) } })}\n`)
      }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  cleanup.push(() => new Promise(resolve => server.close(resolve)))
  return protocols
}

/** [instance]'s discovery file (a legacy `p<protocol>` by default), in the file it is read from. */
const writeDiscoveryOf = (home: string, protocol: number, value: Record<string, unknown>, instance = `p${protocol}`) => {
  mkdirSync(path.join(home, 'run'), { recursive: true })
  writeFileSync(path.join(home, 'run', discoveryFileName(instance)!), JSON.stringify({ protocol, instance, version: '0.1.0', token: 't', ...value }))
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
    const discovery = { instance: `p${PTY_PROTOCOL}`, pid: 42 }
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
    // A versioned instance is judged against its own file: another instance's says nothing of it.
    const versioned = { instance: `p${PTY_PROTOCOL}-0.4.21`, pid: 42 }
    expect(await discoveredHostDead(dir, versioned, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(false)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: '/x', pid: 42 }, versioned.instance)
    expect(await discoveredHostDead(dir, versioned, { alive: () => true, rows: async () => [row(filetime(Date.now() + 60_000))] })).toBe(true)
  })
})


describe('reachPtyHost', () => {
  it('connects to the host of the instance asked, in its own protocol, and never starts one', async () => {
    const dir = tempDir('h-')
    const protocol = SUPPORTED_PTY_PROTOCOLS[0]
    const endpoint = endpointIn(dir, 'old')
    const protocols = await answeringHost(endpoint, 't')
    writeDiscoveryOf(dir, protocol, { endpoint, pid: process.pid })
    const result = await reachPtyHost(dir, `p${protocol}`)
    const client = await clientOf(result as Awaited<ReturnType<typeof ensurePtyHost>>)
    expect(client.protocol).toBe(protocol)
    expect(protocols).toEqual([protocol])
    // A versioned instance, from its own file.
    const versioned = endpointIn(dir, 'versioned')
    const heard = await answeringHost(versioned, 't', `p${PTY_PROTOCOL}-0.4.21`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: versioned, pid: process.pid }, `p${PTY_PROTOCOL}-0.4.21`)
    const other = await clientOf(await reachPtyHost(dir, `p${PTY_PROTOCOL}-0.4.21`) as Awaited<ReturnType<typeof ensurePtyHost>>)
    expect(other.instance).toBe(`p${PTY_PROTOCOL}-0.4.21`)
    expect(heard).toEqual([PTY_PROTOCOL])
    expect(protocols).toEqual([protocol])
  })

  it('never dials a dead host\'s endpoint, even when something answers there', async () => {
    const dir = tempDir('h-')
    const protocol = SUPPORTED_PTY_PROTOCOLS[0]
    const endpoint = endpointIn(dir, 'squatted')
    const protocols = await answeringHost(endpoint, 't')
    const dead = deadPid()
    writeDiscoveryOf(dir, protocol, { endpoint, pid: dead })
    expect(await reachPtyHost(dir, `p${protocol}`)).toEqual({ unavailable: expect.stringContaining(`pid ${dead}`), code: 'PTY_HOST_UNAVAILABLE', pid: dead, missing: false })
    expect(protocols).toEqual([])
  })

  it('says what the file named when nothing answers, and never that the host has gone', async () => {
    const dir = tempDir('h-')
    expect(await reachPtyHost(dir, 'p1')).toEqual({ unavailable: 'there is no pty-host-1.json', code: 'PTY_HOST_UNAVAILABLE', pid: null, missing: true })
    expect(await reachPtyHost(dir, 'p2-0.4.21')).toEqual({ unavailable: 'there is no pty-host-p2-0.4.21.json', code: 'PTY_HOST_UNAVAILABLE', pid: null, missing: true })
    mkdirSync(path.join(dir, 'run'), { recursive: true })
    writeFileSync(path.join(dir, 'run', 'pty-host-1.json'), '{"protocol":')
    expect(await reachPtyHost(dir, 'p1')).toEqual({ unavailable: 'pty-host-1.json cannot be read', code: 'PTY_HOST_UNAVAILABLE', pid: null, missing: false })
    const dead = deadPid()
    writeDiscoveryOf(dir, 1, { endpoint: endpointIn(dir, 'none'), pid: dead })
    expect(await reachPtyHost(dir, 'p1')).toEqual({ unavailable: expect.stringContaining(`pid ${dead}`), code: 'PTY_HOST_UNAVAILABLE', pid: dead, missing: false })
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
    forgetExitedHost(dir, 'p1', dead + 1)
    expect(existsSync(file)).toBe(true)
    writeDiscoveryOf(dir, 1, { endpoint: socket, pid: process.pid })
    forgetExitedHost(dir, 'p1', process.pid)
    expect(existsSync(file)).toBe(true)
    writeDiscoveryOf(dir, 1, { endpoint: socket, pid: dead })
    forgetExitedHost(dir, 'p1', dead)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(socket)).toBe(process.platform === 'win32')
    // Nothing there: nothing to do.
    forgetExitedHost(dir, 'p1', dead)
    // A versioned instance's own file, and never another instance's.
    const instance = `p${PTY_PROTOCOL}-0.4.21`
    const own = path.join(dir, 'run', `pty-host-${instance}.json`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: socket, pid: dead }, instance)
    writeDiscoveryOf(dir, 1, { endpoint: socket, pid: dead })
    forgetExitedHost(dir, instance, dead)
    expect([existsSync(own), existsSync(file)]).toEqual([false, true])
  })

  it('takes the lock and pane-id files of the exited instance with it, and never while the host runs or another instance\'s', () => {
    const dir = tempDir('h-')
    const instance = `p${PTY_PROTOCOL}-0.4.21`
    const other = `p${PTY_PROTOCOL}-0.4.22`
    const run = path.join(dir, 'run')
    const files = (name: string) => ['json', 'lock', 'panes'].map((ext) => path.join(run, `pty-host-${name}.${ext}`))
    const dead = deadPid()
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: path.join(run, 'x.sock'), pid: process.pid }, instance)
    for (const file of [...files(instance).slice(1), ...files(other)]) writeFileSync(file, '1')
    // A live host keeps all of them.
    forgetExitedHost(dir, instance, process.pid)
    expect(files(instance).map((file) => existsSync(file))).toEqual([true, true, true])
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: path.join(run, 'x.sock'), pid: dead }, instance)
    forgetExitedHost(dir, instance, dead)
    expect(files(instance).map((file) => existsSync(file))).toEqual([false, false, false])
    expect(files(other).map((file) => existsSync(file))).toEqual([true, true, true])
  })

  it('goes on when a lock file cannot be removed', () => {
    const dir = tempDir('h-')
    const instance = `p${PTY_PROTOCOL}-0.4.23`
    const run = path.join(dir, 'run')
    const dead = deadPid()
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: path.join(run, 'x.sock'), pid: dead }, instance)
    // A directory in the lock's place cannot be removed as a file, as a lock a scanner still holds on Windows.
    mkdirSync(path.join(run, `pty-host-${instance}.lock`))
    writeFileSync(path.join(run, `pty-host-${instance}.panes`), '1')
    forgetExitedHost(dir, instance, dead)
    expect([existsSync(path.join(run, `pty-host-${instance}.json`)), existsSync(path.join(run, `pty-host-${instance}.panes`))]).toEqual([false, false])
  })
})

const SEED_LINE = (version: string) => JSON.stringify({ version, protocol: PTY_PROTOCOL, features: ['seed'] })

// The fake binary is a script with a shebang, which Windows cannot run.
describe.skipIf(process.platform === 'win32')('targetHost', () => {
  it('targetHost reads current-pty, and is installed', () => {
    const runtime = tempDir('rt-')
    // The binary says another version than its folder: the installed CLI's pointer names the version.
    fakeBinary('serve', { file: path.join(runtime, 'pty', '0.4.21', exe), versionLine: SEED_LINE('0.4.21') })
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.4.21\n')
    expect(targetHost({ env: {}, runtimeDir: runtime, besideDir: '/nowhere' })).toEqual({
      protocol: PTY_PROTOCOL, version: '0.4.21', instance: `p${PTY_PROTOCOL}-0.4.21`, features: ['seed'], source: 'installed',
    })
    // HARNESS_PTY_BIN naming that very binary is still the installed one.
    expect(targetHost({ env: { HARNESS_PTY_BIN: path.join(runtime, 'pty', '0.4.21', exe) }, runtimeDir: runtime, besideDir: '/nowhere' })?.source).toBe('installed')
  })

  it('targetHost asks a dev binary its version, and is binary', () => {
    const runtime = tempDir('rt-')
    const binary = fakeBinary('serve', { versionLine: SEED_LINE('9.9.9') })
    expect(targetHost({ env: { HARNESS_PTY_BIN: binary }, runtimeDir: runtime, besideDir: '/nowhere' })).toEqual({
      protocol: PTY_PROTOCOL, version: '9.9.9', instance: `p${PTY_PROTOCOL}-9.9.9`, features: ['seed'], source: 'binary',
    })
    // No current-pty: the binary beside the bundle, asked.
    const besideDir = tempDir('dist-')
    fakeBinary('serve', { file: path.join(besideDir, 'pty', exe), versionLine: SEED_LINE('0.4.21-dev.win1') })
    expect(targetHost({ env: {}, runtimeDir: runtime, besideDir })).toMatchObject({ version: '0.4.21-dev.win1', instance: `p${PTY_PROTOCOL}-0.4.21-dev.win1`, source: 'binary' })
    // A host from before versioned instances lists no features, and is still `p<protocol>`.
    const old = fakeBinary('serve', { versionLine: JSON.stringify({ version: '0.4.19', protocol: PTY_PROTOCOL }) })
    expect(targetHost({ env: { HARNESS_PTY_BIN: old }, runtimeDir: runtime, besideDir: '/nowhere' })).toEqual({
      protocol: PTY_PROTOCOL, version: '0.4.19', instance: LEGACY, features: [], source: 'binary',
    })
  })

  it('targetHost is null when neither is known', () => {
    const runtime = tempDir('rt-')
    expect(targetHost({ env: {}, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
    for (const line of ['', 'harness-pty 0.4.21', '{"version":"","protocol":2}', '{"version":"1","protocol":"2"}', '{"version":"1","protocol":2,"features":"seed"}']) {
      const binary = fakeBinary('serve', { versionLine: line })
      expect(targetHost({ env: { HARNESS_PTY_BIN: binary }, runtimeDir: runtime, besideDir: '/nowhere' }), line).toBeNull()
    }
    // A binary that is not there.
    expect(targetHost({ env: { HARNESS_PTY_BIN: path.join(runtime, 'missing') }, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
  })

  it('targetHost is unknown, said once, for a host of a protocol this daemon does not speak: the newest supported host is used', () => {
    const runtime = tempDir('rt-')
    // A paired host left in current-pty without its CLI build: above this daemon's protocol, or below every supported one.
    fakeBinary('serve', { file: path.join(runtime, 'pty', '0.5.0', exe), versionLine: JSON.stringify({ version: '0.5.0', protocol: PTY_PROTOCOL + 1, features: ['seed'] }) })
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.5.0\n')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(targetHost({ env: {}, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
      expect(targetHost({ env: {}, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
      const said = error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('0.5.0'))
      expect(said).toEqual([`[terminal] ptyhost: the host 0.5.0 speaks protocol ${PTY_PROTOCOL + 1}, which this daemon does not (it speaks ${SUPPORTED_PTY_PROTOCOLS.join(' and ')}): target unknown, the newest running host of protocol ${PTY_PROTOCOL} is used`])
      const old = fakeBinary('serve', { versionLine: JSON.stringify({ version: '0.0.9', protocol: 0, features: [] }) })
      expect(targetHost({ env: { HARNESS_PTY_BIN: old }, runtimeDir: runtime, besideDir: '/nowhere' })).toBeNull()
    } finally { error.mockRestore() }
  })

  it('binaryVersion runs the binary once per build: cached by its path and mtime', () => {
    const runs = path.join(tempDir('runs-'), 'runs')
    vi.stubEnv('FAKE_PTY_RUNS', runs)
    try {
      const binary = fakeBinary('serve', { versionLine: SEED_LINE('1.2.3') })
      expect(binaryVersion(binary)).toEqual({ version: '1.2.3', protocol: PTY_PROTOCOL, features: ['seed'] })
      expect(binaryVersion(binary)).toEqual({ version: '1.2.3', protocol: PTY_PROTOCOL, features: ['seed'] })
      expect(readFileSync(runs, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
      // A new build at the same path is asked again.
      fakeBinary('serve', { file: binary, versionLine: SEED_LINE('1.2.4') })
      utimesSync(binary, new Date(), new Date(Date.now() + 10_000))
      expect(binaryVersion(binary)?.version).toBe('1.2.4')
      expect(readFileSync(runs, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    } finally { vi.unstubAllEnvs() }
  })
})

/** A target for [version] of this protocol, as `targetHost` gives it. */
const targetOf = (version: string) => ({
  protocol: PTY_PROTOCOL, version, instance: `p${PTY_PROTOCOL}-${version}`, features: ['seed'], source: 'binary' as const,
})

describe('ensurePtyHost by instance', () => {
  it('ensurePtyHost with a target never connects to another version\'s host', async () => {
    const dir = tempDir('h-')
    const older = await answeringHost(endpointIn(dir, 'older'), 't', `p${PTY_PROTOCOL}-0.4.20`)
    const newer = await answeringHost(endpointIn(dir, 'newer'), 't', `p${PTY_PROTOCOL}-0.4.21`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'older'), pid: process.pid, version: '0.4.20' }, `p${PTY_PROTOCOL}-0.4.20`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'newer'), pid: process.pid, version: '0.4.21' }, `p${PTY_PROTOCOL}-0.4.21`)
    // The older one is the target: never the newer, though it runs too.
    const client = await clientOf(await ensurePtyHost(dir, { target: targetOf('0.4.20'), binary: null }))
    expect(client.instance).toBe(`p${PTY_PROTOCOL}-0.4.20`)
    expect([older, newer]).toEqual([[PTY_PROTOCOL], []])
    // A target with no host: started (here there is no binary), and neither running host is dialled.
    expect(await ensurePtyHost(dir, { target: targetOf('0.5.0'), binary: null })).toEqual({
      unavailable: expect.stringContaining('harness-pty'), code: 'PTY_HOST_UNAVAILABLE',
    })
    expect([older, newer]).toEqual([[PTY_PROTOCOL], []])
  })

  it('ensurePtyHost without a target connects to the newest running host', async () => {
    const dir = tempDir('h-')
    const legacy = await answeringHost(endpointIn(dir, 'legacy'), 't')
    const older = await answeringHost(endpointIn(dir, 'older'), 't', `p${PTY_PROTOCOL}-0.4.20`)
    const newer = await answeringHost(endpointIn(dir, 'newer'), 't', `p${PTY_PROTOCOL}-0.4.21`)
    const squatted = await answeringHost(endpointIn(dir, 'squatted'), 't', `p${PTY_PROTOCOL}-0.4.22`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'legacy'), pid: process.pid, version: '0.4.19' })
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'older'), pid: process.pid, version: '0.4.20' }, `p${PTY_PROTOCOL}-0.4.20`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'newer'), pid: process.pid, version: '0.4.21' }, `p${PTY_PROTOCOL}-0.4.21`)
    // Newest of all, but its host has exited: its endpoint is never dialled.
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'squatted'), pid: deadPid(), version: '0.4.22' }, `p${PTY_PROTOCOL}-0.4.22`)
    const client = await clientOf(await ensurePtyHost(dir, { target: null, binary: null }))
    expect(client.instance).toBe(`p${PTY_PROTOCOL}-0.4.21`)
    expect([legacy, older, newer, squatted]).toEqual([[], [], [PTY_PROTOCOL], []])
  })

  it.skipIf(process.platform === 'win32')('ensurePtyHost with a target starts its binary beside another version\'s host, once for concurrent calls', async () => {
    const dir = home()
    const older = await answeringHost(endpointIn(dir, 'older'), 't', `p${PTY_PROTOCOL}-0.4.20`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: endpointIn(dir, 'older'), pid: process.pid, version: '0.4.20' }, `p${PTY_PROTOCOL}-0.4.20`)
    const target = targetOf('0.4.21')
    const binary = fakeBinary('serve', { instance: target.instance })
    const results = await Promise.all([ensurePtyHost(dir, { target, binary }), ensurePtyHost(dir, { target, binary })])
    for (const result of results) expect((await clientOf(result)).instance).toBe(target.instance)
    expect(spawnCount(dir)).toBe(1)
    expect(readInstanceDiscovery(dir, target.instance)?.pid).toBe(Number(readFileSync(path.join(dir, 'spawns'), 'utf8').trim()))
    expect(older).toEqual([])
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

  it('removeUnusedPtyVersions keeps a folder a versioned host runs from', () => {
    const runtime = tempDir('rt-')
    const dir = tempDir('h-')
    for (const version of ['0.4.19', '0.4.20', '0.4.21', '0.4.22']) executable(path.join(runtime, 'pty', version, exe))
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.4.21')
    // Two hosts of one protocol, side by side: 0.4.20's runs, 0.4.19's has exited.
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: '/a', pid: process.pid, version: '0.4.20' }, `p${PTY_PROTOCOL}-0.4.20`)
    writeDiscoveryOf(dir, PTY_PROTOCOL, { endpoint: '/b', pid: deadPid(), version: '0.4.19' }, `p${PTY_PROTOCOL}-0.4.19`)
    expect(removeUnusedPtyVersions(dir, runtime)).toEqual(['0.4.19'])
    // Newer than current-pty stays, as before.
    expect(readdirSync(path.join(runtime, 'pty')).sort()).toEqual(['0.4.20', '0.4.21', '0.4.22', 'current-pty'])
  })

  it('removeUnusedPtyVersions keeps the version a host on probation would roll back to', () => {
    const runtime = tempDir('rt-')
    const dir = tempDir('h-')
    for (const version of ['0.4.19', '0.4.20', '0.4.21']) executable(path.join(runtime, 'pty', version, exe))
    writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.4.21')
    // 0.4.21 is on probation (lib/windows/ptyInstall.ts): no host runs from 0.4.20, and it is the rollback target.
    writeFileSync(path.join(runtime, 'pty', 'pty-pending.json'), JSON.stringify({ version: '0.4.21', previous: '0.4.20' }))
    expect(removeUnusedPtyVersions(dir, runtime)).toEqual(['0.4.19'])
    // Once it is kept, the marker goes, and so may the folder.
    rmSync(path.join(runtime, 'pty', 'pty-pending.json'))
    expect(removeUnusedPtyVersions(dir, runtime)).toEqual(['0.4.20'])
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
    const target = targetHost({ runtimeDir: tempDir('rt-') })
    if (!target) throw new Error('the real harness-pty did not say its version')
    cleanup.push(() => {
      const pid = readInstanceDiscovery(dir, target.instance)?.pid
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    })
    const client = await clientOf(await ensurePtyHost(dir, { target }))
    expect(client.instance).toBe(target.instance)
    expect(client.features).toEqual(target.features)
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
