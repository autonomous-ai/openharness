/**
 * A desk for hand checks of the dial on Windows (README.md beside it), in three modes:
 *
 * - a stand-in dial (`[--port <n>] [--own-account] [--quit-on <file>]`): Task 23's daemon and FakeDial, driven from
 *   stdin, sealed unless `--own-account` gives it the account it runs as (the VM's test user only);
 * - a look (`--dial-read <COMn> --out <file> --serial-bin <exe> [--against <file>]`): the real dial's own `hello`,
 *   read with not one byte written to the port;
 * - the real dial (`--dial <COMn> --speech <text> --first-read <file> --pets-from <dir> --serial-bin <exe> [--port <n>]
 *   [--quit-on <file>]`): a sealed daemon on it, that leaves its settings and its pets as the first look found them.
 *
 * Exit codes: 1 not on Windows, or the desk failed (it says what); 2 bad arguments, before anything starts; 3 a port is
 * busy; 4 the dial must not be greeted (no hello, or pets the desk would drop); 5 the settings were not restored, or a
 * look found them changed; 6 the dial's pets changed.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import WebSocket from 'ws'
import { LocalClient } from '../../e2e/harness/client.js'
import { FakeBackend, type FakeMachine } from '../../e2e/harness/fakeBackend.js'
import type { DialMessage } from '../../e2e/harness/fakeDial.js'
import { startWindowsDaemon } from '../../e2e/harness/windowsDaemon.js'
import { CableDecoder, CableType } from '../../src/cable/cableFrame.js'
import { PetStore } from '../../src/cable/pets/store.js'
import { planPetSync } from '../../src/cable/pets/sync.js'
import { openWindowsPort } from '../../src/cable/windowsSerial.js'
import { openLocalWs } from '../../src/lib/localTransport.js'

const USAGE = `usage:
  desk.mts [--port <n>] [--own-account] [--quit-on <file>]
  desk.mts --dial-read <COMn> --out <file> --serial-bin <harness-serial.exe> [--against <first read>]
  desk.mts --dial <COMn> --speech <text> --first-read <file> --pets-from <dir> --serial-bin <harness-serial.exe> [--port <n>] [--quit-on <file>]`

/** A stop the desk names, with its exit code. */
class DeskStop extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

const VALUED = new Set(['--port', '--quit-on', '--dial-read', '--out', '--against', '--serial-bin', '--dial', '--speech', '--first-read', '--pets-from'])
const COM = /^COM[1-9][0-9]{0,2}$/
/** The account's own daemon's port: a desk never takes it. */
const ACCOUNT_PORT = 18473
const SPEECH_MAX = 200

type Mode =
  | { kind: 'stand-in'; port?: number; own: boolean; quitOn?: string }
  | { kind: 'look'; com: string; out: string; against?: string; serialBin: string }
  | { kind: 'real'; com: string; speech: string; firstRead: string; petsFrom: string; serialBin: string; port?: number; quitOn?: string }

/** [argv] as a mode, every argument checked; nothing is read or started. */
function modeOf(argv: string[]): Mode {
  const args = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!
    if (args.has(name)) throw new DeskStop(2, `${name} is given twice`)
    if (name === '--own-account') { args.set(name, true); continue }
    if (!VALUED.has(name)) throw new DeskStop(2, name.startsWith('--') ? `${name} is no argument of the desk` : 'an argument that is no flag')
    const value = argv[++i]
    if (value === undefined || value.startsWith('--') || value === '') throw new DeskStop(2, `${name} needs a value`)
    args.set(name, value)
  }
  const only = (names: string[]): void => {
    for (const name of args.keys()) if (!names.includes(name)) throw new DeskStop(2, `${name} does not go with this mode`)
  }
  const need = (name: string): string => {
    const value = args.get(name)
    if (typeof value !== 'string') throw new DeskStop(2, `${name} is required in this mode`)
    return value
  }
  const com = (name: string): string => {
    const value = need(name)
    if (!COM.test(value)) throw new DeskStop(2, `${name} takes a port named COM1 to COM999`)
    return value
  }
  // Smart App Control runs only signed programs: the installed release's harness-serial.exe, named by its whole path.
  const serialBin = (): string => {
    const value = need('--serial-bin')
    if (!win32.isAbsolute(value) || !/\\harness-serial\.exe$/i.test(value)) throw new DeskStop(2, '--serial-bin takes the whole path of a harness-serial.exe')
    return value
  }
  const port = ((): number | undefined => {
    const value = args.get('--port')
    if (value === undefined) return undefined
    const n = /^[1-9][0-9]{0,4}$/.test(String(value)) ? Number(value) : NaN
    if (!(n <= 65_535)) throw new DeskStop(2, '--port takes a port number')
    if (n === ACCOUNT_PORT) throw new DeskStop(2, `--port ${ACCOUNT_PORT} is the account's own daemon's`)
    return n
  })()
  const quitOn = args.get('--quit-on') as string | undefined

  if (args.has('--dial-read')) {
    only(['--dial-read', '--out', '--against', '--serial-bin'])
    return { kind: 'look', com: com('--dial-read'), out: need('--out'), against: args.get('--against') as string | undefined, serialBin: serialBin() }
  }
  if (args.has('--dial')) {
    only(['--dial', '--speech', '--first-read', '--pets-from', '--serial-bin', '--port', '--quit-on'])
    const dial = com('--dial')
    const speech = need('--speech')
    if (speech.length > SPEECH_MAX) throw new DeskStop(2, `--speech takes at most ${SPEECH_MAX} characters`)
    return { kind: 'real', com: dial, speech, firstRead: need('--first-read'), petsFrom: need('--pets-from'), serialBin: serialBin(), port, quitOn }
  }
  only(['--port', '--own-account', '--quit-on'])
  return { kind: 'stand-in', port, own: args.has('--own-account'), quitOn }
}

const say = (line: string): void => { process.stdout.write(`${line}\n`) }

// ── what the dial says of itself ─────────────────────────────────────────────────────────────────────

/** What a look keeps of the dial's `hello`: its settings and the custom pets it holds, never its serial or mac. */
interface DialRead { settings: Record<string, unknown>; pets: number; petIds: string[]; at: number }

const PET_ID = /^[0-9a-f]{16}$/
/** How long a port that was just let go may still be busy. */
const BUSY_WAIT_MS = 10_000
/** A dial in a session greets every 15 s, alone every 2 s (firmware cable_client.c, HELLO_SESSION_MS, HELLO_ALONE_MS). */
const HELLO_WAIT_MS = 20_000
/** The fields `settings.set` takes (cableSession.ts DeviceSettingsPatch), compared when the first read has them. */
const SETTINGS_SET = ['brightness', 'character', 'muted', 'quiet', 'straightTitle', 'focusFace', 'scrollReversed', 'voiceLang', 'uiSkin', 'followCompanion']

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function dialRead(message: Record<string, unknown>): DialRead {
  const petIds = Array.isArray(message.petIds) ? message.petIds.filter((id): id is string => typeof id === 'string' && PET_ID.test(id)).slice(0, 16) : []
  return { settings: message.settings as Record<string, unknown>, pets: petIds.length, petIds, at: Date.now() }
}

/** A read written earlier (`--first-read`, `--against`), or a stop naming [flag]. */
function recorded(file: string, flag: string): DialRead {
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new DeskStop(2, `${flag} names no dial read`) }
  if (!isObject(value) || !isObject(value.settings) || !Array.isArray(value.petIds)
    || !value.petIds.every((id) => typeof id === 'string' && PET_ID.test(id))) throw new DeskStop(2, `${flag} names no dial read`)
  return { settings: value.settings, pets: value.petIds.length, petIds: value.petIds as string[], at: Number(value.at) || 0 }
}

/** The settings fields [first] has that [now] holds otherwise. */
function settingsChanged(first: DialRead, now: Record<string, unknown> | undefined): string[] {
  return SETTINGS_SET.filter((field) => field in first.settings && now?.[field] !== first.settings[field])
}

const samePets = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id) => b.includes(id))

/**
 * The dial's next `hello` on [com], through [serialBin]'s `open`: the port is opened, read and closed, and not one byte
 * is written to it. A port still busy after BUSY_WAIT_MS is a stop (3); no hello in HELLO_WAIT_MS is another (4).
 */
async function look(com: string, serialBin: string): Promise<DialRead> {
  const busyUntil = Date.now() + BUSY_WAIT_MS
  let port: Duplex
  for (;;) {
    try {
      port = await openWindowsPort({ file: serialBin, args: ['open', com] })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY') throw new DeskStop(4, `${com} did not open (${code ?? 'error'}), so no hello`)
      if (Date.now() >= busyUntil) throw new DeskStop(3, `${com} is busy: another program has it`)
      await sleep(500)
    }
  }
  try {
    return await new Promise<DialRead>((resolve, reject) => {
      const decoder = new CableDecoder()
      const timer = setTimeout(() => reject(new DeskStop(4, `the dial said no hello in ${HELLO_WAIT_MS / 1000} s`)), HELLO_WAIT_MS)
      const stop = (why: string): void => { clearTimeout(timer); reject(new DeskStop(4, `${com} closed before a hello (${why})`)) }
      port.on('data', (chunk: Buffer) => decoder.feed(chunk, (frame) => {
        if (frame.type !== CableType.Json) return
        let message: unknown
        try { message = JSON.parse(Buffer.from(frame.payload).toString('utf8')) } catch { return }
        if (!isObject(message) || message.t !== 'hello' || !isObject(message.settings)) return
        clearTimeout(timer)
        resolve(dialRead(message))
      }))
      port.once('error', (error: NodeJS.ErrnoException) => stop(error.code ?? 'error'))
      port.once('end', () => stop('end'))
    })
  } finally {
    // Closed before the look returns, so the next program to take the port finds it free. A port that went by itself
    // has closed already.
    if (!port.closed) {
      const closed = new Promise<void>((done) => port.once('close', () => done()))
      port.destroy()
      await closed
    }
  }
}

/** [file] whole, owner-only: a reader finds the old file or the new one, never half of one. */
function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
  renameSync(temp, file)
}

async function lookMode(mode: Extract<Mode, { kind: 'look' }>): Promise<number> {
  const against = mode.against === undefined ? null : recorded(mode.against, '--against')
  const read = await look(mode.com, mode.serialBin)
  writeWhole(mode.out, `${JSON.stringify(read)}\n`)
  if (!against) {
    say(`pets: ${read.pets}`)
    say(`settings: ${Object.keys(read.settings).join(', ')}`)
    return 0
  }
  const changed = settingsChanged(against, read.settings)
  const petsSame = samePets(against.petIds, read.petIds)
  say(changed.length ? `settings: changed (${changed.join(', ')})` : 'settings: unchanged')
  say(petsSame ? 'pets: unchanged' : 'pets: changed')
  return changed.length ? 5 : petsSame ? 0 : 6
}

// ── a desk ───────────────────────────────────────────────────────────────────────────────────────────

function needEnv(name: 'E2E_BUNDLE_PATH' | 'HARNESS_PTY_BIN', what: string): void {
  const value = process.env[name]
  if (!value || !existsSync(value)) throw new DeskStop(2, `${name} must name ${what}`)
}

async function portBusy(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once('error', () => resolve(true))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)))
  })
}

/** Commands from stdin, one a line, and the quit a desk in a task with no stdin gets from [quitOn] once it exists. A
 *  stdin that ends is no quit: a task's may end at once. */
function commands(quitOn: string | undefined, run: (words: string[], line: string) => void, quit: () => void): void {
  let quitting = false
  const once = (): void => { if (!quitting) { quitting = true; quit() } }
  createInterface({ input: process.stdin }).on('line', (line) => {
    const words = line.trim().split(/\s+/).filter(Boolean)
    if (words[0] === 'quit') once()
    else if (words.length) run(words, line.trim())
  })
  process.once('SIGINT', once)
  if (quitOn) {
    const timer = setInterval(() => { if (existsSync(quitOn)) { clearInterval(timer); once() } }, 1_000)
  }
}

/** Every write so far reaches stdout and stderr before the process ends. */
async function end(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((done) => stream.write('', () => done()))))
  process.exit(code)
}

/** The rows of the last list the dial was sent: between `agents.begin` and `agents.end`. */
function lastRows(messages: DialMessage[]): DialMessage[] {
  let rows: DialMessage[] = []
  let open: DialMessage[] | null = null
  for (const m of messages) {
    if (m.t === 'agents.begin') open = []
    else if (m.t === 'agent' && open) open.push(m)
    else if (m.t === 'agents.end' && open) { rows = open; open = null }
  }
  return rows
}

async function standInMode(mode: Extract<Mode, { kind: 'stand-in' }>): Promise<void> {
  needEnv('E2E_BUNDLE_PATH', 'the CLI bundle (bundle.mjs puts it beside the bundled desk)')
  needEnv('HARNESS_PTY_BIN', 'a harness-pty.exe')
  if (mode.port !== undefined && await portBusy(mode.port)) throw new DeskStop(3, `port ${mode.port} is busy`)
  const own = mode.own ? join(process.env.USERPROFILE ?? homedir(), '.harness-dial-check') : undefined
  // As the firmware greets: one app's agents at a time (`app.pick`), and questions as silent rows.
  const d = await startWindowsDaemon({ port: mode.port, own, capabilities: { appFilter: 'v1', questionTier: 'v1' } })
  say(JSON.stringify({ desk: { dataDir: d.dataDir, port: d.port, root: d.root } }))
  d.dial.keepGreeting()
  // Each message the daemon sends, as it comes; its keepalive pings are left out.
  let printed = 0
  const printer = setInterval(() => {
    for (; printed < d.dial.messages.length; printed++) if (d.dial.messages[printed]!.t !== 'ping') say(JSON.stringify(d.dial.messages[printed]))
  }, 100)
  const row = (word: string | undefined): string | null => {
    const id = lastRows(d.dial.messages)[Number(word)]?.id
    return /^[0-9]+$/.test(word ?? '') && typeof id === 'string' ? id : null
  }
  commands(mode.quitOn, (words, line) => {
    const [command, first] = words
    const agentId = row(first)
    if (command === 'list') say(JSON.stringify({ rows: lastRows(d.dial.messages).map((m, i) => ({ row: i, ...m })) }))
    else if (command === 'tap' && agentId) d.dial.send({ t: 'agent.open', agentId })
    else if (command === 'rest' && agentId) d.dial.send({ t: 'focus', agentId })
    else if (command === 'say' && agentId && words.length > 2) d.dial.send({ t: 'turn.send', agentId, text: line.replace(/^say\s+\S+\s+/, '') })
    else if (command === 'pick' && first && /^[a-z][a-z0-9.-]{0,15}$/.test(first)) d.dial.send({ t: 'app.pick', app: first })
    else process.stderr.write('commands: list | tap <row> | rest <row> | say <row> <text> | pick <app> | quit\n')
  }, () => void (async () => {
    clearInterval(printer)
    await d.close()
    await end(0)
  })().catch(stop))
}

/** The machine a real-dial desk signs in as, to its FakeBackend alone: the dial's words come back as `--speech`. */
const ME: FakeMachine = { machineId: 'd1'.repeat(16), computerId: 'harness-dial-desk', name: 'Desk', token: 'harness-dial-desk-token' }

/** Only the pet files the daemon's store reads (cable/pets/store.ts), each bounded. */
const PET_FILE = /^(?:[0-9a-f]{16}\.(?:hpet|png|json)|pets\.json)$/
const PET_FILES_MAX = 64
const PET_FILE_MAX_BYTES = 64 * 1024 * 1024

/**
 * The owner's pets folder [from], read and never written, copied into [to], the desk's devices folder's `pets`: its
 * greeting then plans the pets as the owner's daemon does (cable/pets/sync.ts planPetSync), and drops none of [held].
 * A stop (4) before the daemon starts when the folder cannot be copied, or its mapping does not name a pet held.
 */
function copyPets(from: string, to: string, held: string[]): void {
  let names: string[]
  try {
    names = readdirSync(from)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // No folder and no pet held: nothing to keep.
    if (code === 'ENOENT' && !held.length) return
    throw new DeskStop(4, `--pets-from could not be read (${code ?? 'error'}), and the dial holds ${held.length} pets`)
  }
  const files = names.filter((name) => PET_FILE.test(name))
  if (files.length > PET_FILES_MAX) throw new DeskStop(4, `--pets-from holds more than ${PET_FILES_MAX} pet files`)
  mkdirSync(to, { recursive: true })
  for (const name of files) {
    const source = join(from, name)
    try {
      const stat = lstatSync(source)
      if (!stat.isFile() || stat.size > PET_FILE_MAX_BYTES) throw new Error('not a file of its size')
      writeFileSync(join(to, name), readFileSync(source), { mode: 0o600, flag: 'wx' })
    } catch {
      throw new DeskStop(4, `${name} in --pets-from could not be copied`)
    }
  }
  const dropped = planPetSync(new PetStore(to).mapping(), held).drop
  if (dropped.length) throw new DeskStop(4, `the dial holds ${dropped.length} pets that --pets-from's pets.json does not name: the desk's greeting would drop them`)
}

/** An ESP32's address (the dial's mac and USB serial) and any serial number, cut to their last 4 characters. */
const MAC = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g
const SERIAL = /\b(serial(?:Number)?["']?\s*[:=]\s*["']?)([^\s"',}]{5,})/gi
const shortened = (line: string): string => line.replace(MAC, (mac) => `…${mac.slice(-4)}`).replace(SERIAL, (_, label: string, value: string) => `${label}…${value.slice(-4)}`)

async function realMode(mode: Extract<Mode, { kind: 'real' }>): Promise<void> {
  const first = recorded(mode.firstRead, '--first-read')
  needEnv('E2E_BUNDLE_PATH', 'the CLI bundle (bundle.mjs puts it beside the bundled desk)')
  needEnv('HARNESS_PTY_BIN', 'a signed harness-pty.exe')
  if (!existsSync(mode.serialBin)) throw new DeskStop(2, '--serial-bin names no file')
  if (mode.port !== undefined && await portBusy(mode.port)) throw new DeskStop(3, `port ${mode.port} is busy`)

  const backend = await FakeBackend.start()
  backend.addMachine(ME)
  backend.speech = mode.speech
  // The daemon's `[device]` and `cable:` lines, as they come, once the desk's first line is out.
  let pending = ''
  let started = false
  const held: string[] = []
  let rows: string | null = null
  const lines = (text: string): void => {
    pending += text
    const done = pending.split('\n')
    pending = done.pop() ?? ''
    for (const line of done.map((each) => each.replace(/\r$/, ''))) {
      if (!/\[device\]|cable:/.test(line)) continue
      const sent = /cable: agents → (\d+) of (\d+)/.exec(line)
      if (sent) rows = JSON.stringify({ rows: Number(sent[1]), of: Number(sent[2]) })
      if (started) say(shortened(line))
      else held.push(shortened(line))
    }
  }
  const daemon = await startWindowsDaemon({
    port: mode.port,
    dial: { port: mode.com, serialBin: mode.serialBin },
    env: { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
    onOutput: lines,
    prepare: ({ auth, devices }) => {
      copyPets(mode.petsFrom, join(devices, 'pets'), first.petIds)
      // Signed in as ME: the session `harness login` leaves, which the core reads at start.
      writeFileSync(join(auth, 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token, autonomousEnv: 'prod',
        computerId: ME.computerId, machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'desk',
      }), { mode: 0o600 })
    },
  }).catch(async (error: unknown) => {
    await backend.close()
    throw error
  })
  say(JSON.stringify({ desk: { dataDir: daemon.dataDir, port: daemon.port, root: daemon.root } }))
  started = true
  for (const line of held.splice(0)) say(line)
  // A tool that watches the dial, as `harness hardware watch` does: it hears every dial_status and sends dial_settings,
  // and is no window, so what the dial shows is what it shows with no Harness Desktop open.
  const watch = await (async () => LocalClient.over(openLocalWs(daemon.dataDir, daemon.port, (url, headers) => new WebSocket(url, { headers })),
    ME.machineId, { tool: true, watch: ['dial'] }))().catch(async (error: unknown) => {
    await daemon.close()
    await backend.close()
    throw error
  })

  commands(mode.quitOn, ([command]) => {
    if (command === 'list') say(rows ?? JSON.stringify({ rows: null }))
    else process.stderr.write('commands: list | quit\n')
  }, () => void (async () => {
    let settings = await restoreSettings(watch, first)
    watch.close()
    await daemon.close()
    await backend.close()
    let pets = 0
    try {
      const after = await look(mode.com, mode.serialBin)
      pets = samePets(first.petIds, after.petIds) ? 0 : 6
      say(pets ? 'pets: changed' : 'pets: unchanged')
      if (settings === null) {
        const changed = settingsChanged(first, after.settings)
        say(changed.length ? `settings: changed (${changed.join(', ')})` : 'settings: unchanged')
        settings = changed.length ? 5 : 0
      }
    } catch (error) {
      if (!(error instanceof DeskStop)) throw error
      say(`pets: not checked (${error.message})`)
      if (settings === null) say('settings: not checked')
      pets = error.code
    }
    // Settings no look read stay unknown: the look's own stop (3, 4) is the code then.
    await end(settings || pets)
  })().catch(stop))
}

/**
 * The settings `settings.set` takes, back to the first read's where the dial holds others now (a press on its menus,
 * say): one dial_settings with those fields, then the dial's own answer checked within 10 s. 5 when not restored.
 * null when the dial is not attached (it never greeted the daemon, say): the last look then compares them.
 */
async function restoreSettings(watch: LocalClient, first: DialRead): Promise<number | null> {
  const status = watch.frames.findLast((frame) => frame.type === 'dial_status')?.payload as { attached?: boolean; id?: string; settings?: Record<string, unknown> } | undefined
  if (!status?.attached) return null
  const changed = settingsChanged(first, status.settings)
  if (!changed.length) { say('settings: unchanged'); return 0 }
  const since = watch.frames.length
  watch.send('dial_settings', { id: status.id ?? '', ...Object.fromEntries(changed.map((field) => [field, first.settings[field]])) })
  try {
    await watch.waitFor((frame) => frame.type === 'dial_status' && settingsChanged(first, (frame.payload as { settings?: Record<string, unknown> } | undefined)?.settings).length === 0,
      10_000, 'the settings read back', since)
    say(`settings: restored (${changed.join(', ')})`)
    return 0
  } catch {
    say(`settings: not restored (${changed.join(', ')})`)
    return 5
  }
}

/** The desk ends on [error], saying what stopped it. */
async function stop(error: unknown): Promise<never> {
  // A daemon that failed to start says its last lines, which can name the dial.
  process.stderr.write(`${shortened(error instanceof Error ? error.message : String(error))}\n`)
  if (error instanceof DeskStop && error.code === 2) process.stderr.write(`${USAGE}\n`)
  return end(error instanceof DeskStop ? error.code : 1)
}

try {
  const mode = modeOf(process.argv.slice(2))
  if (process.platform !== 'win32') throw new DeskStop(1, 'the desk runs on Windows')
  if (mode.kind === 'look') await end(await lookMode(mode))
  else if (mode.kind === 'stand-in') await standInMode(mode)
  else await realMode(mode)
} catch (error) {
  await stop(error)
}
