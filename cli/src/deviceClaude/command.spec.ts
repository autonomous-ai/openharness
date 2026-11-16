/**
 * `harness device claude …` and `harness device codex …` as the menu-bar app, the plugin's hook and its mod run them: a
 * fake `claude` (a ClaudeRun that answers from a table), Claude Code's settings in a throwaway CLAUDE_CONFIG_DIR, Codex's
 * home a throwaway folder, and a daemon and the devices' listener on sockets in a throwaway folder. The real `claude`,
 * ~/.claude, ~/.codex and the daemon are never touched.
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { devicesListenerPath } from '../devices/listenerPath.js'
import { listenLocalSocket, unixSocketPath } from '../lib/localSocket.js'
import { socketIsPrivate } from '../lib/localTransport.js'
import { DEVICE_USAGE, runDeviceCommand, takesConnect, type DeviceDeps } from './command.js'
import type { ClaudeRun } from './plugin.js'

const SRC = fileURLToPath(new URL('..', import.meta.url))
/** Names the daemon's socket only: the daemon here listens on a socket in a throwaway folder. */
const PORT = 4998

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const step of cleanup.splice(0).reverse()) await step()
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Claude Code's user settings as `claude plugin` leaves them: the entry true once enabled, gone once uninstalled. */
let settings: string
function pluginOn(on: boolean): void {
  writeFileSync(settings, JSON.stringify({ enabledPlugins: on ? { 'harness-device@openharness': true } : {} }))
}
beforeEach(() => {
  const claudeHome = folder()
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
  settings = join(claudeHome, 'settings.json')
  pluginOn(true)
})

/** A daemon on its socket in [dataDir] that records each body and answers 200. */
async function daemonAt(dataDir: string): Promise<string[]> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => { bodies.push(body); res.writeHead(200).end('{}') })
  })
  server.on('connection', (socket) => { socket.on('error', () => {}) })
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  await new Promise<void>((resolve) => { server.listen(unixSocketPath(dataDir, PORT)!, resolve) })
  return bodies
}

/** The daemon on its socket in [dataDir] as the daemon serves it (owner only), counting the connections it took, those
 *  that closed, and the requests its handler got. */
async function ownDaemonAt(dataDir: string) {
  const seen = { connections: 0, closed: 0, requests: 0 }
  const served = await listenLocalSocket((_req, res) => { seen.requests++; res.end('{}') }, unixSocketPath(dataDir, PORT)!)
  served.server.on('connection', (socket) => {
    seen.connections++
    socket.on('error', () => {})
    socket.on('close', () => { seen.closed++ })
  })
  cleanup.push(served.close)
  return { path: served.path, server: served.server, seen }
}

/** The devices' listener on its real socket in [dataDir], answering nothing: `link` only looks at the file. */
async function devicesAt(dataDir: string): Promise<string> {
  const path = devicesListenerPath(dataDir)!
  // Beside the throwaway folder, never in the short folder under the real home.
  expect(path.startsWith(dataDir)).toBe(true)
  const served = await listenLocalSocket((_req, res) => res.end(), path)
  cleanup.push(served.close)
  return path
}

/** A `claude` 2.1.287 with nothing installed, whose calls answer from [answers] by their arguments. */
function fakeClaude(answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): ClaudeRun {
  const table: typeof answers = { '--version': { code: 0, stdout: '2.1.287 (Claude Code)\n' }, 'plugin list --json': { code: 0, stdout: '[]' }, ...answers }
  return async (args) => {
    const answer = table[args.join(' ')] ?? { code: 0 }
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
}

async function* chunks(...parts: string[]): AsyncIterable<string> {
  yield* parts
}

async function device(argv: string[], deps: Partial<DeviceDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runDeviceCommand(argv, {
    dataDir: folder(), port: PORT, platform: 'darwin', stdin: chunks(), claude: () => fakeClaude(),
    codexHome: folder(), codex: () => true,
    out: (line) => { out.push(line) }, err: (line) => { err.push(line) },
    ...deps,
  })
  return { code, out, err }
}

describe('harness device claude', () => {
  it('status --json prints the four fields on one line', async () => {
    const status = await device(['claude', 'status', '--json'])
    expect(status).toEqual({
      code: 0, err: [],
      out: ['{"supported":true,"installed":false,"enabled":false,"claudeVersion":"2.1.287"}'],
    })
  })

  it('enable prints its error on stderr and exits 1', async () => {
    const claude = fakeClaude({ 'plugin install harness-device@openharness --scope user': { code: 1, stderr: 'Plugin not found\nmore' } })
    expect(await device(['claude', 'enable'], { claude: () => claude })).toEqual({ code: 1, out: [], err: ['Plugin not found'] })
    expect(await device(['claude', 'enable'], { claude: () => null }))
      .toEqual({ code: 1, out: [], err: ['Claude Code 2.1.287 or later is needed.'] })
  })

  it('disable exits 0', async () => {
    const installed = fakeClaude({ 'plugin list --json': { code: 0, stdout: JSON.stringify([{ id: 'harness-device@openharness', scope: 'user', enabled: true }]) } })
    expect(await device(['claude', 'disable'], { claude: () => installed })).toEqual({ code: 0, out: [], err: [] })
  })

  it('link --json prints the socket path and nothing else', async () => {
    const dataDir = folder()
    expect(await device(['claude', 'link', '--json'], { dataDir }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT) })] })
  })

  it('link on Windows exits 1 with no output', async () => {
    expect(await device(['claude', 'link', '--json'], { platform: 'win32' })).toEqual({ code: 1, out: [], err: [] })
  })

  it('link --json prints devicesSocket beside the socket when the devices\' listener is this account\'s own', async () => {
    const dataDir = folder()
    const devicesSocket = await devicesAt(dataDir)
    expect(await device(['claude', 'link', '--json'], { dataDir }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT), devicesSocket })] })
  })

  // A socket another account could have put there, or could reach: the mod would post the session id to it.
  it('link --json leaves devicesSocket out when the socket is not private', async () => {
    const alone = (dataDir: string) => ({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT) })] })
    const open = folder()
    chmodSync(await devicesAt(open), 0o666)
    expect(await device(['claude', 'link', '--json'], { dataDir: open })).toEqual(alone(open))
    const shared = folder()
    await devicesAt(shared)
    chmodSync(shared, 0o777)
    expect(await device(['claude', 'link', '--json'], { dataDir: shared })).toEqual(alone(shared))
    const plain = folder()
    writeFileSync(devicesListenerPath(plain)!, '', { mode: 0o600 })
    expect(await device(['claude', 'link', '--json'], { dataDir: plain })).toEqual(alone(plain))
  })

  // The daemon, or anything that holds its socket, may answer allow: the client reads no answer and prints nothing, so the
  // prompt is always the app's.
  it('asked tells the daemon, prints nothing and exits 0 even when the daemon answers allow', async () => {
    const dataDir = folder()
    const bodies: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        bodies.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"decision":"allow","hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}')
      })
    })
    server.on('connection', (socket) => { socket.on('error', () => {}) })
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    await new Promise<void>((resolve) => { server.listen(unixSocketPath(dataDir, PORT)!, resolve) })
    const stdin = chunks(JSON.stringify({ session_id: 'sess-1', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    expect(await device(['claude', 'asked'], { dataDir, stdin, claude: () => { throw new Error('asked never looks for claude') } }))
      .toEqual({ code: 0, out: [], err: [] })
    await vi.waitFor(() => expect(bodies.map((body) => JSON.parse(body)))
      .toEqual([{ engine: 'claude', sessionId: 'sess-1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/repo' }]))
  })

  // A session started before disable keeps the plugin's hook: it still runs `asked`, which reads the plugin is off.
  it('asked after disable tells the daemon nothing, and after enable tells it again', async () => {
    const dataDir = folder()
    const bodies = await daemonAt(dataDir)
    const asked = (session: string) => device(['claude', 'asked'], {
      dataDir, stdin: chunks(JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command: 'npm test' } })),
    })
    pluginOn(false)
    expect(await asked('sess-off')).toEqual({ code: 0, out: [], err: [] })
    pluginOn(true)
    expect(await asked('sess-on')).toEqual({ code: 0, out: [], err: [] })
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(JSON.parse(bodies[0]).sessionId).toBe('sess-on')
  })

  it('link after disable exits 1 with no output, a listener there or not, and after enable prints the socket again', async () => {
    const dataDir = folder()
    pluginOn(false)
    expect(await device(['claude', 'link', '--json'], { dataDir })).toEqual({ code: 1, out: [], err: [] })
    pluginOn(true)
    expect(await device(['claude', 'link', '--json'], { dataDir }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT) })] })
    const devicesSocket = await devicesAt(dataDir)
    pluginOn(false)
    expect(await device(['claude', 'link', '--json'], { dataDir })).toEqual({ code: 1, out: [], err: [] })
    pluginOn(true)
    expect(await device(['claude', 'link', '--json'], { dataDir }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT), devicesSocket })] })
  })

  it('asked with no daemon prints nothing and exits 0', async () => {
    const stdin = chunks(JSON.stringify({ session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    expect(await device(['claude', 'asked'], { stdin })).toEqual({ code: 0, out: [], err: [] })
  })

  it('approve is gone: the usage, and exit 1', async () => {
    const stdin = chunks(JSON.stringify({ session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    expect(await device(['claude', 'approve'], { stdin })).toEqual({ code: 1, out: [], err: [DEVICE_USAGE] })
  })

  it('an unknown subcommand prints the usage and exits 1', async () => {
    for (const argv of [[], ['claude'], ['claude', 'install'], ['claude', 'status', 'extra']]) {
      expect(await device(argv), argv.join(' ')).toEqual({ code: 1, out: [], err: [DEVICE_USAGE] })
    }
  })

  it('DEVICE_USAGE names status, enable and disable for Claude Code and Codex, and neither asked nor link, and claims no answering', () => {
    for (const engine of ['claude', 'codex']) {
      for (const word of ['status', 'enable', 'disable']) expect(DEVICE_USAGE).toContain(`harness device ${engine} ${word}`)
    }
    expect(DEVICE_USAGE).not.toMatch(/asked|approve|link|answers/)
  })

  it('no file under core/, services/ or cable/ imports deviceClaude/', () => {
    const importsDevice = /(?:from|import\s*\()\s*['"][^'"]*deviceClaude\//
    // The pattern catches a static and a dynamic import, or an empty list would prove nothing.
    expect(["import { runAsked } from '../deviceClaude/asked.js'", "await import('../deviceClaude/plugin.js')"].every((line) => importsDevice.test(line))).toBe(true)
    const importers = ['core', 'services', 'cable'].flatMap((dir) =>
      readdirSync(join(SRC, dir), { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(dir, name))
        .filter((file) => importsDevice.test(readFileSync(join(SRC, file), 'utf8'))))
    expect(importers).toEqual([])
  })
})

describe('harness device codex', () => {
  it('status --json, enable and disable write and remove the skill in Codex\'s home', async () => {
    const codexHome = folder()
    const status = (enabled: boolean) => ({ code: 0, err: [], out: [`{"supported":true,"installed":true,"enabled":${enabled}}`] })
    expect(await device(['codex', 'status', '--json'], { codexHome })).toEqual(status(false))
    expect(await device(['codex', 'enable'], { codexHome })).toEqual({ code: 0, out: [], err: [] })
    expect(readFileSync(join(codexHome, 'skills', 'dial', 'SKILL.md'), 'utf8')).toContain('harness device notify')
    expect(await device(['codex', 'status', '--json'], { codexHome })).toEqual(status(true))
    expect(await device(['codex', 'disable'], { codexHome })).toEqual({ code: 0, out: [], err: [] })
    expect(await device(['codex', 'status', '--json'], { codexHome })).toEqual(status(false))
  })

  it('status without --json prints the same fields, indented', async () => {
    expect(await device(['codex', 'status'], { codex: () => false }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ supported: true, installed: false, enabled: false }, null, 2)] })
  })

  it('enable prints its error on stderr and exits 1', async () => {
    expect(await device(['codex', 'enable'], { codex: () => false })).toEqual({ code: 1, out: [], err: ['Codex is not on this computer.'] })
  })

  it('codex with no verb, another verb or an extra word prints the usage and exits 1', async () => {
    for (const argv of [['codex'], ['codex', 'install'], ['codex', 'status', 'extra']]) {
      expect(await device(argv), argv.join(' ')).toEqual({ code: 1, out: [], err: [DEVICE_USAGE] })
    }
  })
})

describe('harness device orca link', () => {
  const link = (dataDir: string, ready: boolean, daemon = false) =>
    ({ code: 0, err: [], out: [JSON.stringify({ daemon, devicesSocket: devicesListenerPath(dataDir), devicesReady: ready })] })

  it('with no daemon and no dial it prints daemon false, the devices\' path and devicesReady false, and exits 0', async () => {
    const dataDir = folder()
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, false))
  })

  it('daemon is true once the daemon\'s socket is there, this account\'s own, and takes a connect', async () => {
    const dataDir = folder()
    await ownDaemonAt(dataDir)
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, false, true))
  })

  it('the connect asks the daemon nothing', async () => {
    const dataDir = folder()
    const { seen } = await ownDaemonAt(dataDir)
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, false, true))
    await vi.waitFor(() => expect(seen).toEqual({ connections: 1, closed: 1, requests: 0 }))
  })

  it('a socket a crashed daemon left behind is daemon false', async () => {
    const dataDir = folder()
    const crashed = await listenLocalSocket((_req, res) => res.end(), unixSocketPath(dataDir, PORT)!)
    crashed.server.close()
    // Still there and still this account's own: only the connect tells it from a live one.
    expect(socketIsPrivate(crashed.path)).toBe(true)
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, false))
  })

  it('a daemon\'s socket that is not private is daemon false, and is not connected to', async () => {
    const dataDir = folder()
    const { path, seen } = await ownDaemonAt(dataDir)
    chmodSync(path, 0o666)
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, false))
    // A connect of the test's own, once it has closed, is the only one the server took: `link`'s would have come first.
    expect(await takesConnect(path)).toBe(true)
    await vi.waitFor(() => expect(seen.closed).toBe(1))
    expect(seen.connections).toBe(1)
  })

  it('devicesReady is true once the devices\' socket is there and this account\'s own', async () => {
    const dataDir = folder()
    await devicesAt(dataDir)
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, true))
  })

  it('a devices\' socket nothing listens on is still devicesReady true', async () => {
    const dataDir = folder()
    const crashed = await listenLocalSocket((_req, res) => res.end(), devicesListenerPath(dataDir)!)
    crashed.server.close()
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, true))
  })

  it('a devices\' socket that is not private is devicesReady false, its path still printed', async () => {
    const open = folder()
    chmodSync(await devicesAt(open), 0o666)
    expect(await device(['orca', 'link'], { dataDir: open })).toEqual(link(open, false))
    const shared = folder()
    await devicesAt(shared)
    chmodSync(shared, 0o777)
    expect(await device(['orca', 'link'], { dataDir: shared })).toEqual(link(shared, false))
    const plain = folder()
    writeFileSync(devicesListenerPath(plain)!, '', { mode: 0o600 })
    expect(await device(['orca', 'link'], { dataDir: plain })).toEqual(link(plain, false))
  })

  it('on Windows it prints {"daemon":false,"devicesReady":false} and exits 0', async () => {
    expect(await device(['orca', 'link'], { platform: 'win32' })).toEqual({ code: 0, err: [], out: ['{"daemon":false,"devicesReady":false}'] })
  })

  it('with the harness-device plugin off in Claude Code it prints the same', async () => {
    const dataDir = folder()
    pluginOn(false)
    expect(await device(['orca', 'link'], { dataDir })).toEqual(link(dataDir, false))
  })

  it('it never looks for claude', async () => {
    const dataDir = folder()
    expect(await device(['orca', 'link'], { dataDir, claude: () => { throw new Error('never') } })).toEqual(link(dataDir, false))
  })

  it('orca with no verb, another verb or an extra word prints the usage and exits 1', async () => {
    for (const argv of [['orca'], ['orca', 'status'], ['orca', 'link', 'extra']]) {
      expect(await device(argv), argv.join(' ')).toEqual({ code: 1, out: [], err: [DEVICE_USAGE] })
    }
    expect(DEVICE_USAGE).not.toMatch(/orca/i)
  })
})

describe('takesConnect', () => {
  it('a path nothing is at is false', async () => {
    expect(await takesConnect(join(folder(), 'none.sock'))).toBe(false)
  })

  it('a connect that neither opens nor fails is false after 1 s, and its socket is destroyed', async () => {
    vi.useFakeTimers()
    cleanup.push(() => vi.useRealTimers())
    const socket = new Socket()
    let answer: boolean | undefined
    void takesConnect('/never', undefined, () => socket).then((taken) => { answer = taken })
    await vi.advanceTimersByTimeAsync(999)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe(false)
    expect(socket.destroyed).toBe(true)
  })

  it('an error after it answered is not thrown', async () => {
    vi.useFakeTimers()
    cleanup.push(() => vi.useRealTimers())
    const socket = new Socket()
    const answer = takesConnect('/never', undefined, () => socket)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await answer).toBe(false)
    expect(() => socket.emit('error', new Error('late'))).not.toThrow()
  })
})
