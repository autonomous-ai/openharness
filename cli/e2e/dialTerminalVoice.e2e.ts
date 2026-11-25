/**
 * The dial's spoken words reach an agent in a plain Ghostty tab (docs/plans/2026-11-25-dial-voice-codex-terminals-design.md,
 * part B), on the real daemon: Claude Code without its mod runs on a pseudo-terminal of its own (harness/outsideAgent.ts)
 * with Ghostty's hints in its hook environment, so `ps` and `lsof` read a real tty of the test's own process, and a fake
 * dial speaks to it. The real Ghostty is never asked anything: no Harness Device runs, and the test plays it on the real
 * `harness hardware watch --json`: told on its stdin first that it answers writes, as Harness Device tells it (no write
 * line goes to a watch never told so), then Ghostty in front, each write and enter line read on its stdout and
 * answered on its stdin, an enter typed into the tab as the words kept from the write and Enter. An agent in iTerm2 gets
 * no write line: iTerm2's write reaches every pane its Broadcast Input joins.
 *
 * macOS only: off macOS the watch prints no write line.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { INJECT_PASTE_DELAY_BASE_MS } from '../src/lib/submitTiming.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c7'.repeat(16), computerId: 'e2e-dial-terminal-voice-computer', name: 'Fixture', token: 'e2e-dial-terminal-voice-token' }
const GHOSTTY = 'com.mitchellh.ghostty'
/** What Ghostty and iTerm2 set in their tabs: the hints that name the app the agent runs in. */
const IN_GHOSTTY = { TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: GHOSTTY }
const IN_ITERM = { TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: 'com.googlecode.iterm2' }
/** The everyday daemon's port: a watch under test that reached it would take the stream from this Mac's Harness Device. */
const EVERYDAY_PORT = '18473'
/** Node may fire the settle's timer a millisecond early; the exact settle is twoStep.spec.ts's, on a fake clock. */
const SETTLE_AT_LEAST_MS = INJECT_PASTE_DELAY_BASE_MS - 5
/** Words no log line holds by chance: each is looked for alone. */
const WORDS = 'quokka marmalade zeppelin'
const ID = /^[0-9a-f]{16}$/

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The name of [pid]'s terminal, as `ps` gives it. */
const ttyName = (pid: number): string => execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()

type Write = { write: { id: string; app: string; tty: string; text: string } }
type Enter = { enter: { id: string; app: string; tty: string } }
/** A write or enter line the watch printed, its id, when it came, and when the test answered it. */
interface Typing { line: Write | Enter; id: string; at: number; answered: number }

describe.skipIf(process.platform !== 'darwin')('the dial\'s words reach an agent in a plain Ghostty tab', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const children: ChildProcess[] = []
  const outside: Outside[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })

  /**
   * `harness hardware watch --json` as Harness Device runs it, under the daemon's environment only: it finds this
   * daemon's data folder and the devices' socket in it, never this Mac's, so it can never take the tabs stream from a
   * real Harness Device's watch. Its first line says it answers writes, as Harness Device's does, then Ghostty is in
   * front. The test is Harness Device: each write line is
   * kept and answered [written]; each enter line types the words kept into [engine]'s tab with Enter, as Ghostty's
   * `send key "enter"` submits them, and is answered ok.
   */
  const watch = (d: IsolatedDaemon, engine: Outside, written: boolean) => {
    const env: NodeJS.ProcessEnv = { ...d.env, TMUX_PANE: '' }
    expect(env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(devicesListenerPath(d.dataDir, process.platform, env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
    expect(env.PORT).not.toBe(EVERYDAY_PORT)
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], { cwd: CLI_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stderr = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const typings: Typing[] = []
    let kept = ''
    const tell = (value: unknown): void => { child.stdin!.write(`${JSON.stringify(value)}\n`) }
    createInterface({ input: child.stdout! }).on('line', (text) => {
      if (!text.startsWith('{"write"') && !text.startsWith('{"enter"')) return
      const at = Date.now()
      const line = JSON.parse(text) as Write | Enter
      const { id } = 'write' in line ? line.write : line.enter
      if ('write' in line) kept = line.write.text
      else engine.type(kept)
      tell({ wrote: { id, ok: 'enter' in line || written } })
      typings.push({ line, id, at, answered: Date.now() })
    })
    tell({ writes: true })
    tell({ front: GHOSTTY })
    return { typings: () => [...typings], stderr: () => stderr }
  }

  /**
   * A daemon signed in as ME, a dial on the desk shown its first list, Claude Code without its mod in a Ghostty tab
   * (with a shell in it when [shell]), and the watch answering each write [written]. Resolves once the dial lists the
   * agent with voice: its only way in is the tab, which types only while the watch holds the tabs stream.
   */
  const fresh = async ({ shell = false, written = true }: { shell?: boolean; written?: boolean } = {}) => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await IsolatedDaemon.create({
      env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
    })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const engine = await Outside.start(d, 'in-ghostty', IN_GHOSTTY, undefined, { shell })
    outside.push(engine)
    await dial.next((m) => m.t === 'agent' && m.id === engine.id, 45_000, 'the agent listed')
    const run = watch(d, engine, written)
    const row = await dial.next((m) => m.t === 'agent' && m.id === engine.id && String(m.caps ?? '').includes('v'), 45_000,
      'the agent listed with voice')
    return { d, dial, relay, engine, run, name: String(row.name) }
  }

  /** [words] spoken at the agent: the fake backend transcribes them. The dial's answer, sent or not. */
  const speak = async (dial: FakeDial, relay: FakeBackend, engine: Outside, words: string): Promise<DialMessage> => {
    relay.speech = words
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: engine.id, uploadId: 'spoken-1', sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId: 'spoken-1' })
    return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
  }

  /** Whether the devices logged [what] as a voice's outcome. */
  const voiced = (d: IsolatedDaemon, what: string): boolean =>
    d.log().split('\n').some((line) => line.endsWith(`[device] voice · ${what}`))

  /** Neither the daemon's log nor the watch's stderr names the tab's tty, by its name alone too, or a word spoken. */
  const keptPrivate = (d: IsolatedDaemon, run: ReturnType<typeof watch>, engine: Outside): void => {
    for (const said of [d.log(), run.stderr()]) {
      for (const secret of [ttyName(engine.pid), ...WORDS.split(' ')]) expect(said).not.toContain(secret)
    }
  }

  it('the words go as one write naming the agent\'s tty, then an Enter after the settle, and the agent takes them as one prompt', async () => {
    const { d, dial, relay, engine, run } = await fresh()
    const tty = `/dev/${ttyName(engine.pid)}`
    const since = dial.messages.length

    expect(await speak(dial, relay, engine, WORDS)).toMatchObject({ t: 'voice.transcript', text: WORDS, agentId: engine.id })
    await until('"[device] voice · tabs" in the daemon\'s log', () => voiced(d, 'tabs'), 30_000, 50)

    const typings = run.typings()
    expect(typings).toHaveLength(2)
    const [write, enter] = typings
    expect(write.line).toEqual({ write: { id: expect.stringMatching(ID), app: 'ghostty', tty, text: WORDS } })
    expect(enter.line).toEqual({ enter: { id: expect.stringMatching(ID), app: 'ghostty', tty } })
    expect(enter.id).not.toBe(write.id)
    expect(enter.at - write.answered).toBeGreaterThanOrEqual(SETTLE_AT_LEAST_MS)

    // Submitted once: its prompt hook ran, and its turn ended.
    await until('its UserPromptSubmit hook to run', () => engine.ran(d, 'UserPromptSubmit'), 30_000, 100)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === engine.id, 45_000, 'its turn done', since)
    expect(engine.ran(d, 'UserPromptSubmit', 2)).toBe(false)
    keptPrivate(d, run, engine)
  })

  it('a write Harness Device answers not written gets no Enter, and the dial says the agent did not answer', async () => {
    const { d, dial, relay, engine, run, name } = await fresh({ written: false })

    expect(await speak(dial, relay, engine, WORDS)).toMatchObject({ t: 'voice.error', message: `${name} did not answer.` })
    await until('"[device] voice · refused (tabs · no-session)" in the daemon\'s log',
      () => voiced(d, 'refused (tabs · no-session)'), 30_000, 50)
    expect(run.typings().map(({ line }) => Object.keys(line))).toEqual([['write']])
    expect(voiced(d, 'tabs')).toBe(false)
    expect(engine.ran(d, 'UserPromptSubmit')).toBe(false)
    keptPrivate(d, run, engine)
  })

  // PM decision 2 (2026-11-25): with Broadcast Input on, iTerm2's write would reach a shell pane of the group too.
  it('an agent in a plain iTerm2 tab gets no write line, and the dial says iTerm2 takes no words yet', async () => {
    // Ghostty's agent listed with voice: the watch holds the tabs stream.
    const { d, dial, relay, run } = await fresh()
    const iterm = await Outside.start(d, 'in-iterm', IN_ITERM)
    outside.push(iterm)
    await dial.next((m) => m.t === 'agent' && m.id === iterm.id, 45_000, 'the iTerm2 agent listed')

    // No route takes its words, so it is listed without voice and the dial's turn is refused before any route is asked.
    const refusal = 'This agent is in iTerm2. Talking to it from the device comes in an update.'
    expect(await speak(dial, relay, iterm, WORDS)).toMatchObject({ t: 'voice.error', message: refusal })
    await until('the refusal in the daemon\'s log',
      () => d.log().split('\n').some((line) => line.endsWith(`cable: voice → error "${refusal}"`)), 30_000, 50)
    expect(run.typings()).toEqual([])
    expect(iterm.ran(d, 'UserPromptSubmit')).toBe(false)
    keptPrivate(d, run, iterm)
  })

  it('an agent stopped with Ctrl-Z, its shell in front, gets no write', async () => {
    const { d, dial, relay, engine, run, name } = await fresh({ shell: true })
    await engine.background()

    expect(await speak(dial, relay, engine, WORDS)).toMatchObject({ t: 'voice.error', message: `${name} did not answer.` })
    await until('"[device] voice · refused (tabs · background)" in the daemon\'s log',
      () => voiced(d, 'refused (tabs · background)'), 30_000, 50)
    expect(run.typings()).toEqual([])
    keptPrivate(d, run, engine)
  })
})
