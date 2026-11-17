/**
 * `harness device claude …` and `harness device codex …` as a person, the plugin's hook and its mod run them: a
 * fake `claude` (a ClaudeRun that answers from a table), Claude Code's settings in a throwaway CLAUDE_CONFIG_DIR, Codex's
 * home a throwaway folder, and a daemon and the devices' listener on sockets in a throwaway folder. The real `claude`,
 * ~/.claude, ~/.codex and the daemon are never touched.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIAL_SKILL } from '../devices/dialSkill.js'
import { readPluginHomes } from '../devices/dialSkillFiles.js'
import { devicesListenerPath } from '../devices/listenerPath.js'
import { listenLocalSocket, unixSocketPath } from '../lib/localSocket.js'
import { socketIsPrivate } from '../lib/localTransport.js'
import { DEVICE_USAGE, runDeviceCommand, takesConnect, type DeviceDeps } from './command.js'
import type { ClaudeRun } from '../devices/claudePlugin.js'

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
/** Claude Code's default home, the throwaway CLAUDE_CONFIG_DIR. */
let claudeHome: string
function pluginOn(on: boolean): void {
  writeFileSync(settings, JSON.stringify({ enabledPlugins: on ? { 'harness-device@openharness': true } : {} }))
}
beforeEach(() => {
  claudeHome = folder()
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

type Answers = Record<string, { code: number; stdout?: string; stderr?: string }>

/** A `claude` 2.1.287 with nothing installed, whose calls answer from [answers] by their arguments. */
function fakeClaude(answers: Answers = {}): ClaudeRun {
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
    orcaHomes: async () => [], claudeIn: () => null,
    // The command's own: CLAUDE_CONFIG_DIR stands for ~/.claude unless a spec runs it in an Orca terminal.
    defaultClaudeHome: claudeHome,
    codexHome: folder(), codex: () => true, env: {}, cwd: '/',
    out: (line) => { out.push(line) }, err: (line) => { err.push(line) },
    ...deps,
  })
  return { code, out, err }
}

/** The plugin installed at user scope and on, as `claude plugin list --json` prints it. */
const INSTALLED = { 'plugin list --json': { code: 0, stdout: JSON.stringify([{ id: 'harness-device@openharness', scope: 'user', enabled: true }]) } }
const UNINSTALL = 'plugin uninstall harness-device@openharness --scope user'
/** A person's own dial skill: no marker line. */
const PERSONS = '---\nname: dial\ndescription: mine\n---\n\nMine.\n'

const skillAt = (home: string) => join(home, 'skills', 'dial', 'SKILL.md')
const answers = (dataDir: string): unknown => JSON.parse(readFileSync(join(dataDir, 'dial-skill.json'), 'utf8'))

/** [text] at the dial skill's path in [home]; returns the resolved skills folder, as the devices service lists it. */
function skillIn(home: string, text = DIAL_SKILL): string {
  mkdirSync(dirname(skillAt(home)), { recursive: true })
  writeFileSync(skillAt(home), text)
  return realpathSync(join(home, 'skills'))
}

/** dial-setup.json as the devices service leaves it once a dial attached, with the homes it wrote; returns its bytes. */
function recorded(dataDir: string, homes: { claude?: string[]; codex?: string[] }): Buffer {
  writeFileSync(join(dataDir, 'dial-setup.json'), JSON.stringify({ dial: true, homes: { claude: homes.claude ?? [], codex: homes.codex ?? [] } }))
  return readFileSync(join(dataDir, 'dial-setup.json'))
}

/** A folder the test makes read-only, opened again before its home is removed. */
function readOnly(dir: string): void {
  chmodSync(dir, 0o500)
  cleanup.push(() => chmodSync(dir, 0o700))
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

  it('disable with no claude found while the plugin is on says so and exits 1, the rest still done', async () => {
    const dataDir = folder()
    skillIn(claudeHome)
    expect(await device(['claude', 'disable'], { dataDir, claude: () => null })).toEqual({
      code: 1, out: [], err: ['Claude Code was not found, so its harness-device plugin is still on; /plugin in Claude Code removes it.'],
    })
    expect(answers(dataDir)).toEqual({ removed: { claude: true } })
    expect(existsSync(skillAt(claudeHome))).toBe(false)
    // Off, or settings that say nothing of it: nothing is left on.
    pluginOn(false)
    expect(await device(['claude', 'disable'], { claude: () => null })).toEqual({ code: 0, out: [], err: [] })
    rmSync(settings)
    expect(await device(['claude', 'disable'], { claude: () => null })).toEqual({ code: 0, out: [], err: [] })
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

  // The devices service installs the plugin into the daemon's Claude Code home, which may not be this command's: there a
  // disable uninstalls nothing, and the plugin stays on in the settings its hook and mod read.
  it('asked and link after a disable that left the plugin on tell nothing, and after enable act again', async () => {
    const dataDir = folder()
    const bodies = await daemonAt(dataDir)
    const asked = (session: string) => device(['claude', 'asked'], {
      dataDir, stdin: chunks(JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command: 'npm test' } })),
    })
    expect(await device(['claude', 'disable'], { dataDir })).toEqual({ code: 0, out: [], err: [] })
    expect(readFileSync(settings, 'utf8')).toContain('"harness-device@openharness":true')
    expect(await asked('sess-off')).toEqual({ code: 0, out: [], err: [] })
    expect(await device(['claude', 'link', '--json'], { dataDir })).toEqual({ code: 1, out: [], err: [] })
    expect(await device(['claude', 'enable'], { dataDir })).toEqual({ code: 0, out: [], err: [] })
    expect(await asked('sess-on')).toEqual({ code: 0, out: [], err: [] })
    expect(await device(['claude', 'link', '--json'], { dataDir }))
      .toEqual({ code: 0, err: [], out: [JSON.stringify({ socketPath: unixSocketPath(dataDir, PORT) })] })
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(JSON.parse(bodies[0]).sessionId).toBe('sess-on')
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

  it('the usage says a dial sets the agents up, and that disable is a removal Harness leaves alone', () => {
    for (const line of [
      'Harness device (with a dial plugged in, Claude Code and Codex are set up to ring it; disable takes that away, enable brings it back):',
      'harness device claude status [--json]  whether the dial is on for Claude Code (its harness-device plugin on, and not removed), and its version',
      'harness device claude enable           set Claude Code up again: the plugin and the dial skill (Claude Code 2.1.287 or later), in each Orca account too',
      'harness device claude disable          remove the plugin and the dial skill, in each Orca account too; Harness leaves them removed',
      'harness device codex status [--json]   whether the dial is on for Codex',
      'harness device codex enable            set Codex up again: the dial skill in its homes',
      'harness device codex disable           remove the dial skill Harness wrote; Harness leaves it removed',
    ]) expect(DEVICE_USAGE.split('\n').map((usage) => usage.trim())).toContain(line)
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

describe('the dial skill', () => {
  it('claude enable writes the skill into the default home and records the folder it wrote', async () => {
    const dataDir = folder()
    expect(await device(['claude', 'enable'], { dataDir })).toEqual({ code: 0, out: [], err: [] })
    expect(readFileSync(skillAt(claudeHome), 'utf8')).toBe(DIAL_SKILL)
    expect(answers(dataDir)).toEqual({ homes: { claude: [realpathSync(join(claudeHome, 'skills'))], codex: [] } })
  })

  it('disable marks the removal before it removes, and status reads off', async () => {
    const dataDir = folder()
    const codexHome = folder()
    recorded(dataDir, { codex: [skillIn(codexHome)] })
    const enabled = async () => JSON.parse((await device(['codex', 'status', '--json'], { dataDir, codexHome })).out[0]).enabled
    expect(await enabled()).toBe(true)
    expect((await device(['codex', 'disable'], { dataDir, codexHome })).code).toBe(0)
    expect(answers(dataDir)).toEqual({ removed: { codex: true } })
    expect(existsSync(skillAt(codexHome))).toBe(false)
    expect(await enabled()).toBe(false)
  })

  it('enable clears the removal and writes the skill back into every recorded home the person cleared', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const dataDir = folder()
      const codexHome = folder()
      writeFileSync(join(dataDir, 'dial-skill.json'), JSON.stringify({ removed: { [engine]: true } }))
      // The person deleted the skill and kept the skills folder in one home, and deleted the whole skills folder in another.
      const kept = folder()
      mkdirSync(join(kept, 'skills'))
      const cleared = [realpathSync(join(kept, 'skills')), join(realpathSync(folder()), 'skills')]
      // A recorded folder whose home is gone is not made again.
      const gone = join(folder(), 'home', 'skills')
      recorded(dataDir, { [engine]: [...cleared, gone] })
      expect(await device([engine, 'enable'], { dataDir, codexHome }), engine).toEqual({ code: 0, out: [], err: [] })
      const home = engine === 'claude' ? claudeHome : codexHome
      expect(answers(dataDir), engine).toEqual({ homes: { claude: [], codex: [], [engine]: [realpathSync(join(home, 'skills'))] } })
      for (const skills of cleared) expect(readFileSync(join(skills, 'dial', 'SKILL.md'), 'utf8'), engine).toBe(DIAL_SKILL)
      // Made as a skill's own folder is: this account's alone.
      expect(statSync(cleared[1]).mode & 0o777, engine).toBe(0o700)
      expect(existsSync(dirname(gone)), engine).toBe(false)
    }
  })

  it('disable removes the skill from the homes the devices service recorded', async () => {
    const dataDir = folder()
    const homes = [folder(), folder()]
    const setup = recorded(dataDir, { codex: homes.map((home) => skillIn(home)) })
    // The old service's list is not read: the folder it names keeps its skill.
    const old = folder()
    writeFileSync(join(dataDir, 'dial-skill-homes.json'), JSON.stringify({ claude: [], codex: [skillIn(old)] }))
    expect(await device(['codex', 'disable'], { dataDir })).toEqual({ code: 0, out: [], err: [] })
    for (const home of homes) expect(existsSync(skillAt(home)), home).toBe(false)
    expect(readFileSync(skillAt(old), 'utf8')).toBe(DIAL_SKILL)
    // The service's record is only read: its one writer is the service.
    expect(readFileSync(join(dataDir, 'dial-setup.json'))).toEqual(setup)
  })

  it('a dial-setup.json that cannot be read: disable and enable do the rest, say so and exit 1', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const dataDir = folder()
      const codexHome = folder()
      const home = engine === 'claude' ? claudeHome : codexHome
      const listed = folder()
      recorded(dataDir, { [engine]: [skillIn(listed)] })
      // Stands for any read error: EACCES, EIO, EMFILE. Read as no homes, the folders it lists would be passed by.
      chmodSync(join(dataDir, 'dial-setup.json'), 0o000)
      cleanup.push(() => chmodSync(join(dataDir, 'dial-setup.json'), 0o600))
      skillIn(home)
      const unread = { code: 1, out: [], err: ['Could not read the dial setup.'] }
      expect(await device([engine, 'disable'], { dataDir, codexHome, claude: () => fakeClaude() }), engine).toEqual(unread)
      expect(existsSync(skillAt(home)), engine).toBe(false)
      expect(answers(dataDir), engine).toEqual({ removed: { [engine]: true } })

      rmSync(skillAt(listed))
      expect(await device([engine, 'enable'], { dataDir, codexHome }), engine).toEqual(unread)
      expect(readFileSync(skillAt(home), 'utf8'), engine).toBe(DIAL_SKILL)
    }
  })

  it('disable removes the skill an enable run with another home wrote', async () => {
    // A person may run the command with CODEX_HOME or CLAUDE_CONFIG_DIR set, Device 0.1.1's menu with neither.
    const dataDir = folder()
    const [codexThen, codexNow] = [folder(), folder()]
    expect(await device(['codex', 'enable'], { dataDir, codexHome: codexThen })).toEqual({ code: 0, out: [], err: [] })
    expect(await device(['codex', 'disable'], { dataDir, codexHome: codexNow })).toEqual({ code: 0, out: [], err: [] })
    expect(existsSync(join(codexThen, 'skills', 'dial'))).toBe(false)

    const claudeThen = claudeHome
    expect(await device(['claude', 'enable'], { dataDir })).toEqual({ code: 0, out: [], err: [] })
    vi.stubEnv('CLAUDE_CONFIG_DIR', folder())
    // The default home the enable ran with shares its plugin: turned off there too.
    expect(await device(['claude', 'disable'], { dataDir, claudeIn: () => fakeClaude(INSTALLED) })).toEqual({ code: 0, out: [], err: [] })
    expect(existsSync(join(claudeThen, 'skills', 'dial'))).toBe(false)
    // Nothing is left to find: the record holds no folder.
    expect(answers(dataDir)).toEqual({ removed: { claude: true, codex: true } })
  })

  it('an enable whose setting cannot be saved makes nothing', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const dataDir = folder()
      readOnly(dataDir)
      const codexHome = join(folder(), 'codex')
      expect(await device([engine, 'enable'], { dataDir, codexHome }), engine).toEqual({ code: 1, out: [], err: ['Could not save the dial setting.'] })
      expect(existsSync(codexHome), engine).toBe(false)
      expect(readdirSync(claudeHome), engine).toEqual(['settings.json'])
    }
  })

  it('an enable into a home no record could hold writes no skill', async () => {
    const dataDir = folder()
    // U+0085 is a control character the record refuses: written, the skill would be one a disable never finds.
    const codexHome = join(folder(), 'co\u0085dex')
    expect(await device(['codex', 'enable'], { dataDir, codexHome })).toEqual({ code: 1, out: [], err: ['Could not write the Codex skill.'] })
    expect(existsSync(join(codexHome, 'skills', 'dial'))).toBe(false)
    expect(answers(dataDir)).toEqual({})
  })

  it('an enable that fails writes nothing', async () => {
    const failedInstall = fakeClaude({ 'plugin install harness-device@openharness --scope user': { code: 1, stderr: 'Plugin not found' } })
    const cases: Array<[string, string[], Partial<DeviceDeps>]> = [
      ['a failed install', ['claude', 'enable'], { claude: () => failedInstall }],
      ['Claude Code on Windows', ['claude', 'enable'], { platform: 'win32' }],
      ['Codex on Windows', ['codex', 'enable'], { platform: 'win32' }],
      ['Codex not installed', ['codex', 'enable'], { codex: () => false }],
    ]
    for (const [what, argv, deps] of cases) {
      const dataDir = folder()
      const codexHome = folder()
      expect((await device(argv, { dataDir, codexHome, ...deps })).code, what).toBe(1)
      expect(readdirSync(dataDir), what).toEqual([])
      expect(readdirSync(codexHome), what).toEqual([])
      expect(readdirSync(claudeHome), what).toEqual(['settings.json'])
    }
  })

  it('enable over a person\'s skill leaves it, records that folder and exits 0', async () => {
    for (const [engine, name] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
      const dataDir = folder()
      const codexHome = folder()
      skillIn(engine === 'claude' ? claudeHome : codexHome, PERSONS)
      const path = skillAt(engine === 'claude' ? claudeHome : codexHome)
      const before = lstatSync(path)
      expect(await device([engine, 'enable'], { dataDir, codexHome }), engine)
        .toEqual({ code: 0, out: [], err: [`${name} already has a skill named dial that Harness did not write; it stays.`] })
      const after = lstatSync(path)
      expect([after.ino, after.mode, after.mtimeMs], engine).toEqual([before.ino, before.mode, before.mtimeMs])
      expect(readFileSync(path, 'utf8'), engine).toBe(PERSONS)
      const homes = { claude: [], codex: [], [engine]: [realpathSync(dirname(dirname(path)))] }
      expect(answers(dataDir), engine).toEqual({ homes })
    }
  })

  it('claude disable marks the removal first, then uninstalls, then removes, and keeps a person\'s skill', async () => {
    const dataDir = folder()
    writeFileSync(join(dataDir, 'dial-skill.json'), '{"removed":{"codex":true}}')
    skillIn(claudeHome)
    const ours = [folder(), folder()]
    const persons = folder()
    const setup = recorded(dataDir, { claude: [...ours.map((home) => skillIn(home)), skillIn(persons, PERSONS)] })
    const atUninstall: unknown[] = []
    const installed = fakeClaude(INSTALLED)
    const claude: ClaudeRun = async (args, timeoutMs) => {
      if (args.join(' ') === UNINSTALL) atUninstall.push({ answers: answers(dataDir), skill: existsSync(skillAt(claudeHome)) })
      return installed(args, timeoutMs)
    }
    expect(await device(['claude', 'disable'], { dataDir, claude: () => claude })).toEqual({ code: 0, out: [], err: [] })
    expect(atUninstall).toEqual([{ answers: { removed: { claude: true, codex: true } }, skill: true }])
    for (const home of [claudeHome, ...ours]) {
      expect(existsSync(join(home, 'skills', 'dial')), home).toBe(false)
      expect(existsSync(join(home, 'skills')), home).toBe(true)
    }
    expect(readFileSync(skillAt(persons), 'utf8')).toBe(PERSONS)
    expect(readFileSync(join(dataDir, 'dial-setup.json'))).toEqual(setup)
  })

  it('disable keeps the skill in a folder the other engine holds it in', async () => {
    const ok = { code: 0, out: [], err: [] }
    const claudeSkills = skillIn(claudeHome)
    // Claude Code holds its skill once a dial attached here, or once its enable wrote a folder.
    const attached = folder()
    recorded(attached, {})
    const enabled = folder()
    writeFileSync(join(enabled, 'dial-skill.json'), JSON.stringify({ homes: { claude: [claudeSkills], codex: [] } }))
    for (const dataDir of [attached, enabled]) {
      skillIn(claudeHome)
      // Codex's skills linked to Claude Code's, as a person may link them.
      const codexHome = folder()
      symlinkSync(claudeSkills, join(codexHome, 'skills'))
      expect(await device(['codex', 'disable'], { dataDir, codexHome })).toEqual(ok)
      expect(readFileSync(skillAt(claudeHome), 'utf8')).toBe(DIAL_SKILL)
      // With Codex removed as well, the last disable takes it.
      expect(await device(['claude', 'disable'], { dataDir, codexHome })).toEqual(ok)
      expect(existsSync(skillAt(claudeHome))).toBe(false)
    }

    // Neither: Claude Code's plugin is on, but Harness set nothing up for it here, so Codex's disable takes the skill.
    skillIn(claudeHome)
    const codexHome = folder()
    symlinkSync(claudeSkills, join(codexHome, 'skills'))
    expect(await device(['codex', 'disable'], { dataDir: folder(), codexHome })).toEqual(ok)
    expect(existsSync(skillAt(claudeHome))).toBe(false)
  })

  it('a failing step still runs the rest', async () => {
    const dataDir = folder()
    skillIn(claudeHome)
    const other = folder()
    recorded(dataDir, { claude: [skillIn(other)] })
    const failing = fakeClaude({ ...INSTALLED, [UNINSTALL]: { code: 1, stderr: 'x' } })
    expect(await device(['claude', 'disable'], { dataDir, claude: () => failing })).toEqual({ code: 1, out: [], err: ['x'] })
    expect(answers(dataDir)).toEqual({ removed: { claude: true } })
    for (const home of [claudeHome, other]) expect(existsSync(skillAt(home)), home).toBe(false)

    const locked = folder()
    skillIn(claudeHome)
    const another = folder()
    recorded(locked, { claude: [skillIn(another)] })
    readOnly(locked)
    const uninstalls: string[] = []
    const installed = fakeClaude(INSTALLED)
    const claude: ClaudeRun = async (args, timeoutMs) => {
      if (args.join(' ') === UNINSTALL) uninstalls.push(UNINSTALL)
      return installed(args, timeoutMs)
    }
    expect(await device(['claude', 'disable'], { dataDir: locked, claude: () => claude }))
      .toEqual({ code: 1, out: [], err: ['Could not save the dial setting.'] })
    expect(uninstalls).toEqual([UNINSTALL])
    for (const home of [claudeHome, another]) expect(existsSync(skillAt(home)), home).toBe(false)

    // A skill that cannot be removed is the error, and the next folder is still cleared.
    const codexHome = folder()
    const stuck = folder()
    const next = folder()
    recorded(dataDir, { codex: [skillIn(stuck), skillIn(next)] })
    readOnly(join(stuck, 'skills', 'dial'))
    expect(await device(['codex', 'disable'], { dataDir, codexHome })).toEqual({ code: 1, out: [], err: ['Could not remove the Codex skill.'] })
    expect(readFileSync(skillAt(stuck), 'utf8')).toBe(DIAL_SKILL)
    expect(existsSync(skillAt(next))).toBe(false)
    expect(answers(dataDir)).toEqual({ removed: { claude: true, codex: true } })
  })

  it('claude status: on with the plugin on and no removal', async () => {
    const enabled = async (plugin: boolean, file: string | null) => {
      const dataDir = folder()
      if (file !== null) writeFileSync(join(dataDir, 'dial-skill.json'), file)
      const list = JSON.stringify([{ id: 'harness-device@openharness', scope: 'user', enabled: plugin }])
      const { out } = await device(['claude', 'status', '--json'], { dataDir, claude: () => fakeClaude({ 'plugin list --json': { code: 0, stdout: list } }) })
      return (JSON.parse(out[0]) as { enabled: boolean }).enabled
    }
    expect(await enabled(true, null)).toBe(true)
    // The old menu's Off is not read.
    expect(await enabled(true, '{"claude":false}')).toBe(true)
    expect(await enabled(true, '{"removed":{"codex":true}}')).toBe(true)
    expect(await enabled(true, '{"removed":{"claude":true}}')).toBe(false)
    expect(await enabled(false, null)).toBe(false)
  })

  it('codex status: on once a dial attached or enable wrote; the old menu\'s false is not read', async () => {
    const enabled = async (files: Record<string, string>) => {
      const dataDir = folder()
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dataDir, name), text)
      return (JSON.parse((await device(['codex', 'status', '--json'], { dataDir })).out[0]) as { enabled: boolean }).enabled
    }
    const dial = '{"dial":true}'
    const wrote = '"homes":{"claude":[],"codex":["/a/skills"]}'
    expect(await enabled({})).toBe(false)
    // The old menu's On is no setup either.
    expect(await enabled({ 'dial-skill.json': '{"codex":true}' })).toBe(false)
    expect(await enabled({ 'dial-setup.json': dial })).toBe(true)
    expect(await enabled({ 'dial-setup.json': dial, 'dial-skill.json': '{"codex":false}' })).toBe(true)
    expect(await enabled({ 'dial-skill.json': `{${wrote}}` })).toBe(true)
    expect(await enabled({ 'dial-setup.json': dial, 'dial-skill.json': `{"removed":{"codex":true},${wrote}}` })).toBe(false)
  })

  it('codex: enable writes the skill and status reads on; disable removes every copy and status reads off', async () => {
    const dataDir = folder()
    const status = (enabled: boolean) => ({ code: 0, err: [], out: [`{"supported":true,"installed":true,"enabled":${enabled}}`] })
    // Harness's own skill in a home sets nothing up: only a dial attached here or an enable does.
    const holding = folder()
    skillIn(holding)
    expect(await device(['codex', 'status', '--json'], { dataDir, codexHome: holding })).toEqual(status(false))

    const codexHome = join(folder(), 'codex')
    expect(await device(['codex', 'enable'], { dataDir, codexHome })).toEqual({ code: 0, out: [], err: [] })
    expect(readFileSync(skillAt(codexHome), 'utf8')).toBe(DIAL_SKILL)
    expect(answers(dataDir)).toEqual({ homes: { claude: [], codex: [realpathSync(join(codexHome, 'skills'))] } })
    expect(await device(['codex', 'status', '--json'], { dataDir, codexHome })).toEqual(status(true))

    const others = [folder(), folder()]
    recorded(dataDir, { codex: others.map((home) => skillIn(home)) })
    expect(await device(['codex', 'disable'], { dataDir, codexHome })).toEqual({ code: 0, out: [], err: [] })
    expect(answers(dataDir)).toEqual({ removed: { codex: true } })
    for (const home of [codexHome, ...others]) expect(existsSync(join(home, 'skills', 'dial')), home).toBe(false)
    expect(await device(['codex', 'status', '--json'], { dataDir, codexHome })).toEqual(status(false))
  })

  it('an enable whose skill cannot be written exits 1', async () => {
    const codexHome = folder()
    for (const home of [claudeHome, codexHome]) writeFileSync(join(home, 'skills'), 'mine')
    expect(await device(['claude', 'enable'])).toEqual({ code: 1, out: [], err: ['Could not write the Claude Code skill.'] })
    expect(await device(['codex', 'enable'], { codexHome })).toEqual({ code: 1, out: [], err: ['Could not write the Codex skill.'] })
    for (const home of [claudeHome, codexHome]) expect(readFileSync(join(home, 'skills'), 'utf8'), home).toBe('mine')
  })
})

describe('Orca\'s Claude Code homes', () => {
  const ENABLE = 'plugin enable harness-device@openharness --scope user'
  const DISABLE = 'plugin disable harness-device@openharness --scope user'
  const ON_FAILED = 'Could not turn on Claude Code in one Orca account.'
  const OFF_FAILED = 'Could not turn off Claude Code in one Orca account.'
  const ok = { code: 0, out: [], err: [] }

  /** The plugin as an Orca home lists it: installed, since its `plugins/` is the default home's, and on or off there. */
  const listed = (enabled: boolean): Answers =>
    ({ 'plugin list --json': { code: 0, stdout: JSON.stringify([{ id: 'harness-device@openharness', scope: 'user', enabled }]) } })

  /** The command's `claude` (home null) and Claude Code pointed at an Orca home, each answering from [answersOf] its home;
   *  every call is kept in order with the home it ran in. */
  function claudes(answersOf: (home: string | null) => Answers) {
    const calls: Array<{ home: string | null; args: string }> = []
    const at = (home: string | null): ClaudeRun => {
      const run = fakeClaude(answersOf(home))
      return async (args, timeoutMs) => {
        calls.push({ home, args: args.join(' ') })
        return run(args, timeoutMs)
      }
    }
    return { calls, claude: () => at(null), claudeIn: (home: string) => at(home) }
  }

  /** [claudeIn], with [first] run once, before an Orca home's first call. */
  function before(claudeIn: (home: string) => ClaudeRun, first: () => void): (home: string) => ClaudeRun {
    let ran = false
    return (home) => {
      const run = claudeIn(home)
      return async (args, timeoutMs) => {
        if (!ran) first()
        ran = true
        return run(args, timeoutMs)
      }
    }
  }

  it('enable turns the plugin on in each Orca home after the default home', async () => {
    const dataDir = folder()
    const homes = [folder(), folder()]
    const real = homes.map((home) => realpathSync(home))
    const { calls, claude, claudeIn } = claudes((home) => home === null ? {} : listed(false))
    let atFirst: unknown
    const watched = before(claudeIn, () => { atFirst = { answers: answers(dataDir), skill: existsSync(skillAt(claudeHome)) } })
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn: watched, orcaHomes: async () => homes })).toEqual(ok)
    // The default home whole first: its plugin, its removal cleared and its skill.
    expect(atFirst).toEqual({ answers: { homes: { claude: [realpathSync(join(claudeHome, 'skills'))], codex: [] } }, skill: true })
    const first = calls.findIndex((call) => call.home !== null)
    expect(calls.slice(0, first).map((call) => call.home)).toEqual(Array(first).fill(null))
    expect(calls.slice(0, first).map((call) => call.args)).toContain('plugin install harness-device@openharness --scope user')
    // Each by its real path, turned on alone: its files are the default home's.
    expect(calls.slice(first)).toEqual(real.flatMap((home) => [
      { home, args: '--version' }, { home, args: 'plugin list --json' }, { home, args: ENABLE },
    ]))
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(claudeHome)
    expect(readPluginHomes(dataDir)).toEqual({ homes: real })
    // The devices' record has one writer, the devices service.
    expect(existsSync(join(dataDir, 'dial-setup.json'))).toBe(false)
  })

  it('an Orca home already on is recorded with no enable', async () => {
    const dataDir = folder()
    const home = folder()
    const { calls, claude, claudeIn } = claudes((at) => at === null ? {} : listed(true))
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn, orcaHomes: async () => [home] })).toEqual(ok)
    expect(calls.filter((call) => call.home !== null).map((call) => call.args)).toEqual(['--version', 'plugin list --json'])
    expect(readPluginHomes(dataDir)).toEqual({ homes: [realpathSync(home)] })
  })

  it('a home that fails to turn on prints one line and the command still exits 0', async () => {
    const dataDir = folder()
    const [failing, next] = [folder(), folder()]
    const { calls, claude, claudeIn } = claudes((home) => home === null ? {}
      : home === realpathSync(failing) ? { ...listed(false), [ENABLE]: { code: 1, stderr: `Could not write ${failing}/settings.json\n` } }
      : listed(false))
    // Claude Code's own line names the account's folder: only the fixed line is said.
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn, orcaHomes: async () => [failing, next] }))
      .toEqual({ code: 0, out: [], err: [ON_FAILED] })
    expect(calls).toContainEqual({ home: realpathSync(next), args: ENABLE })
    expect(readPluginHomes(dataDir)).toEqual({ homes: [realpathSync(next)] })

    // No Claude Code there either is that home's failure.
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn: () => null, orcaHomes: async () => [next] }))
      .toEqual({ code: 0, out: [], err: [ON_FAILED] })
    expect(readPluginHomes(dataDir)).toEqual({ homes: [] })
  })

  it('a home whose real path no record could hold is turned on and not recorded', async () => {
    const dataDir = folder()
    // U+0085 is a control character the record refuses; the home Orca names links to it.
    const odd = join(realpathSync(folder()), 'or\u0085ca')
    mkdirSync(odd)
    const named = join(folder(), 'home')
    symlinkSync(odd, named)
    const other = folder()
    const { calls, claude, claudeIn } = claudes((home) => home === null ? {} : listed(false))
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn, orcaHomes: async () => [named, other] })).toEqual(ok)
    expect(calls).toContainEqual({ home: odd, args: ENABLE })
    expect(readPluginHomes(dataDir)).toEqual({ homes: [realpathSync(other)] })
  })

  it('an enable that fails in the default home asks Orca nothing', async () => {
    const failedInstall = fakeClaude({ 'plugin install harness-device@openharness --scope user': { code: 1, stderr: 'Plugin not found' } })
    let asked = 0
    const orca: Partial<DeviceDeps> = {
      orcaHomes: async () => { asked++; return [folder()] },
      claudeIn: () => { asked++; return fakeClaude(listed(false)) },
    }
    expect(await device(['claude', 'enable'], { claude: () => failedInstall, ...orca })).toEqual({ code: 1, out: [], err: ['Plugin not found'] })
    const locked = folder()
    readOnly(locked)
    expect(await device(['claude', 'enable'], { dataDir: locked, ...orca })).toEqual({ code: 1, out: [], err: ['Could not save the dial setting.'] })
    expect(asked).toBe(0)
  })

  it('an Orca record that cannot be saved says so and exits 1', async () => {
    const dataDir = folder()
    const { claude, claudeIn } = claudes((home) => home === null ? {} : listed(false))
    // The data folder shut after the default home was set up, before the Orca homes are recorded.
    const shutting = before(claudeIn, () => readOnly(dataDir))
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn: shutting, orcaHomes: async () => [folder()] }))
      .toEqual({ code: 1, out: [], err: ['Could not save the dial setting.'] })
  })

  /** Claude Code's default home in a throwaway folder, its plugin on there: the command run in an Orca terminal has the
   *  account's home as its own (CLAUDE_CONFIG_DIR), and this one beside it, sharing its `plugins/`. */
  function defaultHomeOn(): string {
    const home = join(folder(), '.claude')
    mkdirSync(home)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-device@openharness': true } }))
    return home
  }

  it('the command\'s own home is not run twice', async () => {
    const dataDir = folder()
    const home = folder()
    const links = folder()
    const defaultHome = defaultHomeOn()
    symlinkSync(claudeHome, join(links, 'own'))
    symlinkSync(home, join(links, 'home'))
    // The command run in an Orca terminal: its own home is one Orca lists, as itself and through a link. Another home is
    // listed twice and through a link.
    const listing = async () => [claudeHome, join(links, 'own'), home, join(links, 'home'), home]
    for (const [verb, on] of [['enable', false], ['disable', true]] as const) {
      const { calls, claude, claudeIn } = claudes((at) => at === null ? INSTALLED : listed(on))
      expect(await device(['claude', verb], { dataDir, claude, claudeIn, orcaHomes: listing, defaultClaudeHome: defaultHome }), verb).toEqual(ok)
      expect(new Set(calls.map((call) => call.home)), verb).toEqual(new Set([null, defaultHome, realpathSync(home)]))
      const turned = on ? DISABLE : ENABLE
      expect(calls.filter((call) => call.args === turned), verb).toEqual([{ home: defaultHome, args: turned }, { home: realpathSync(home), args: turned }])
    }
    // The default home is no Orca account's.
    expect(readPluginHomes(dataDir)).toEqual({ homes: [realpathSync(home)] })
  })

  // An uninstall in the command's own home takes the files the default home names: its entry would stay on, with nothing
  // left to turn off.
  it('disable in an Orca terminal turns the default home off before the uninstall', async () => {
    const defaultHome = defaultHomeOn()
    const other = folder()
    const { calls, claude, claudeIn } = claudes((home) => home === null ? INSTALLED : listed(true))
    expect(await device(['claude', 'disable'], { claude, claudeIn, orcaHomes: async () => [claudeHome, other], defaultClaudeHome: defaultHome })).toEqual(ok)
    expect(calls).toEqual([
      { home: defaultHome, args: 'plugin list --json' }, { home: defaultHome, args: DISABLE },
      { home: realpathSync(other), args: 'plugin list --json' }, { home: realpathSync(other), args: DISABLE },
      { home: null, args: 'plugin list --json' }, { home: null, args: UNINSTALL },
    ])
  })

  // Off there, plain sessions would never ring, and the devices turn on no Orca home while it reads off.
  it('enable after a disable in an Orca terminal turns the default home on after the install', async () => {
    const dataDir = folder()
    const defaultHome = defaultHomeOn()
    const listing = async () => [claudeHome]
    const off = claudes((home) => home === null ? INSTALLED : listed(true))
    expect(await device(['claude', 'disable'], { dataDir, claude: off.claude, claudeIn: off.claudeIn, orcaHomes: listing, defaultClaudeHome: defaultHome })).toEqual(ok)
    // Uninstalled, and off in the default home.
    const { calls, claude, claudeIn } = claudes((home) => home === null ? {} : listed(false))
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn, orcaHomes: listing, defaultClaudeHome: defaultHome })).toEqual(ok)
    const install = calls.findIndex((call) => call.args === 'plugin install harness-device@openharness --scope user')
    expect(install).toBeGreaterThan(-1)
    expect(calls.slice(install + 1)).toEqual([
      { home: defaultHome, args: '--version' }, { home: defaultHome, args: 'plugin list --json' }, { home: defaultHome, args: ENABLE },
    ])
    expect(readPluginHomes(dataDir)).toEqual({ homes: [] })
  })

  it('disable turns off each Orca home first, then the default home', async () => {
    const dataDir = folder()
    skillIn(claudeHome)
    const homes = [folder(), folder()]
    const real = homes.map((home) => realpathSync(home))
    const { calls, claude, claudeIn } = claudes((home) => home === null ? INSTALLED : listed(true))
    let atFirst: unknown
    const watched = before(claudeIn, () => { atFirst = answers(dataDir) })
    expect(await device(['claude', 'disable'], { dataDir, claude, claudeIn: watched, orcaHomes: async () => homes })).toEqual(ok)
    expect(atFirst).toEqual({ removed: { claude: true } })
    // Never an uninstall in an Orca home: it would take the files every home names. The default home's comes last.
    expect(calls).toEqual([
      ...real.flatMap((home) => [{ home, args: 'plugin list --json' }, { home, args: DISABLE }]),
      { home: null, args: 'plugin list --json' }, { home: null, args: UNINSTALL },
    ])
    expect(existsSync(skillAt(claudeHome))).toBe(false)
  })

  it('a home that fails to turn off prints one line and the command exits 1', async () => {
    const dataDir = folder()
    skillIn(claudeHome)
    const [failing, next] = [folder(), folder()]
    const answersOf = (uninstall: Answers) => (home: string | null): Answers => home === null ? { ...INSTALLED, ...uninstall }
      : home === realpathSync(failing) ? { ...listed(true), [DISABLE]: { code: 1, stderr: `${failing}/settings.json: denied` } }
      : listed(true)
    const { calls, claude, claudeIn } = claudes(answersOf({}))
    expect(await device(['claude', 'disable'], { dataDir, claude, claudeIn, orcaHomes: async () => [failing, next] }))
      .toEqual({ code: 1, out: [], err: [OFF_FAILED] })
    expect(calls).toContainEqual({ home: realpathSync(next), args: DISABLE })
    expect(calls.at(-1)).toEqual({ home: null, args: UNINSTALL })
    expect(existsSync(skillAt(claudeHome))).toBe(false)
    expect(answers(dataDir)).toEqual({ removed: { claude: true } })

    // The default home's own failure is still said, after the Orca home's line.
    const both = claudes(answersOf({ [UNINSTALL]: { code: 1, stderr: 'x' } }))
    expect(await device(['claude', 'disable'], { dataDir, claude: both.claude, claudeIn: both.claudeIn, orcaHomes: async () => [failing, next] }))
      .toEqual({ code: 1, out: [], err: [OFF_FAILED, 'x'] })
  })

  it('with no claude and an Orca home\'s settings on, disable says that home failed', async () => {
    pluginOn(false)
    const [on, off, none] = [folder(), folder(), folder()]
    writeFileSync(join(on, 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-device@openharness': true } }))
    writeFileSync(join(off, 'settings.json'), JSON.stringify({ enabledPlugins: { 'harness-device@openharness': false } }))
    expect(await device(['claude', 'disable'], { claude: () => null, claudeIn: () => null, orcaHomes: async () => [on, off, none] }))
      .toEqual({ code: 1, out: [], err: [OFF_FAILED] })
  })

  it('with no Orca home, or Orca not read, enable and disable are as before', async () => {
    const dataDir = folder()
    const { calls, claude, claudeIn } = claudes(() => INSTALLED)
    expect(await device(['claude', 'enable'], { dataDir, claude, claudeIn, orcaHomes: async () => [] })).toEqual(ok)
    expect(answers(dataDir)).toEqual({ homes: { claude: [realpathSync(join(claudeHome, 'skills'))], codex: [] } })
    expect(await device(['claude', 'disable'], { dataDir, claude, claudeIn, orcaHomes: async () => [] })).toEqual(ok)
    expect(answers(dataDir)).toEqual({ removed: { claude: true } })
    expect(calls.every((call) => call.home === null)).toBe(true)
  })

  it('status and Codex\'s verbs ask Orca nothing', async () => {
    let asked = 0
    const orca: Partial<DeviceDeps> = {
      orcaHomes: async () => { asked++; return [folder()] },
      claudeIn: () => { asked++; return fakeClaude(listed(true)) },
    }
    for (const argv of [['claude', 'status', '--json'], ['codex', 'status', '--json'], ['codex', 'enable'], ['codex', 'disable']]) {
      expect((await device(argv, orca)).code, argv.join(' ')).toBe(0)
    }
    expect(asked).toBe(0)
  })
})

describe('harness device codex', () => {
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

describe('harness device notify', () => {
  /** The devices' listener on its real socket in [dataDir], answering every message with [answer]; it hears each body. */
  async function devicesAnswering(dataDir: string, answer: string): Promise<string[]> {
    const bodies: string[] = []
    const served = await listenLocalSocket((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => { bodies.push(body); res.writeHead(200, { 'content-type': 'application/json' }).end(answer) })
    }, devicesListenerPath(dataDir)!)
    cleanup.push(served.close)
    return bodies
  }

  it('device notify reaches the devices\' listener and prints its answer', async () => {
    const dataDir = folder()
    const bodies = await devicesAnswering(dataDir, '{"result":"shown"}')
    expect(await device(['notify', 'Connect the VPN'], { dataDir, env: { CODEX_THREAD_ID: 't-1' }, cwd: '/code/api' }))
      .toEqual({ code: 0, out: ['shown'], err: [] })
    expect(bodies.map((body) => JSON.parse(body)))
      .toEqual([{ type: 'notice', text: 'Connect the VPN', engine: 'codex', sessionId: 't-1', folder: 'api' }])
  })

  it('with no listener it prints no dial, exit 0', async () => {
    expect(await device(['notify', 'Connect the VPN'])).toEqual({ code: 0, out: ['no dial'], err: [] })
  })

  it('the usage names notify', () => {
    expect(DEVICE_USAGE).toContain('harness device notify "<one line>" [--json]')
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
    expect(DEVICE_USAGE).not.toContain('device orca')
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
