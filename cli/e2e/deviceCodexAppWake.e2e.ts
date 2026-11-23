/**
 * Words spoken to a resting thread of the ChatGPT app (docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md), on
 * the real daemon: the app's Codex home is a fixture in the daemon's home (src/testing/codexAppFixture.ts), and Harness's
 * own CODEX_HOME is that same folder, as on a computer that never set it. A fake dial on the desk shows the thread with
 * voice; its words open the thread by the app's link, then go to Codex's queue of that thread alone; the thread's own
 * hooks then make it a live row that keeps its id and its voice. A link that fails queues nothing.
 *
 * macOS and Linux. The real ChatGPT app, `~/.codex`, /Applications, /usr/lib, `/usr/bin/open`, `xdg-open` and a real
 * Codex are never touched: the Codex home, CODEX_HOME, the app (a fake Info.plist in the home's `~/Applications` on macOS,
 * a file in the root's stand-in for /usr/lib on Linux), the app's own Codex CLI and the open are all checked to be inside
 * the daemon's root before it starts. The open is the recording one (harness/appEvalDriver.ts writeRecordingOpen), which
 * only notes its runs; on Linux the `codex` scheme's app is named by a fake `xdg-mime` (harness/schemeApps.ts). The queue
 * is the app's CLI fake on macOS (harness/codexAppCli.ts) and the PATH `codex` fake on Linux, each noting its calls in a
 * ledger under the root (harness/fakeEngine.mjs). The words are an in-memory backend's transcript
 * (harness/fakeBackend.ts), and the thread's process is told by its own hooks (harness/codexOutside.ts).
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { chatGptPlaces } from '../src/cable/hosts/appPlaces.js'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { codexAppFixture } from '../src/testing/codexAppFixture.js'
import { linksFail, openRuns, writeRecordingOpen } from './harness/appEvalDriver.js'
import { writeAppCodex } from './harness/codexAppCli.js'
import { CodexOutside } from './harness/codexOutside.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { writeSchemeApps } from './harness/schemeApps.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CODEX_APP = 'com.openai.codex'
const LINUX = process.platform === 'linux'
/** The open a wake runs: by the app's bundle on macOS; on Linux the link alone, as `xdg-open` takes it. */
const opened = (thread: string): string[] => {
  const url = `codex://threads/${thread}`
  return LINUX ? ['xdg-open', url] : ['open', '-b', CODEX_APP, url]
}
/** The queue ledgers under the root: the app's own CLI's, and the PATH `codex`'s. `codex queue` runs the app's CLI on
 *  macOS and the PATH's on Linux (cable/hosts/codexQueue.ts). */
const APP_LEDGER = 'codex-app-queue'
const PATH_LEDGER = 'codex-queue'
const [TAKEN, OTHER] = LINUX ? [PATH_LEDGER, APP_LEDGER] : [APP_LEDGER, PATH_LEDGER]
/** Every wake line of the ChatGPT app: fixed words and a time, never a name, id or the words. */
const WAKE = /^\[codex-app\] wake · (too long|open failed|timeout|busy|stopped|refused|pending|queue timeout|queue failed|sent · \d+ ms)$/
/** The app's bundle as the devices read it (`plutil`): its id and nothing else of the app. */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${CODEX_APP}</string>
</dict>
</plist>
`
/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c7'.repeat(16), computerId: 'e2e-codex-app-wake-computer', name: 'Fixture', token: 'e2e-codex-app-wake-token' }

const inside = (root: string, path: string | undefined): boolean => !!path && isAbsolute(path) && !relative(root, path).startsWith('..')
/** The calls a ledger noted, each `{ args, codexHome }`; none when it was never written. */
const queued = (d: IsolatedDaemon, ledger: string): unknown[] => {
  const file = join(d.root, ledger)
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown) : []
}

/** One list the dial was sent: its rows, between `agents.begin` and `agents.end`. */
function rosters(dial: FakeDial, since = 0): DialMessage[][] {
  const out: DialMessage[][] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push(rows); rows = null }
  }
  return out
}
/** The list once the rows [ids] take voice. On Linux the first list that holds them starts the `xdg-mime` read and can
 *  still say `sf`, and no change is pushed when the read answers: each list that has them without voice is asked again,
 *  once, until one has them at `svf`. */
const voiced = (dial: FakeDial, what: string, ids: string[]): Promise<DialMessage[]> => {
  let asked = -1
  return until(what, () => {
    const all = rosters(dial)
    const last = all.at(-1)
    if (!last || last.length !== ids.length || !last.every((row, i) => row.id === ids[i])) return null
    if (last.every((row) => row.caps === 'svf')) return last
    if (asked !== all.length) {
      asked = all.length
      dial.send({ t: 'agents.list' })
    }
    return null
  }, 45_000, 50)
}
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)
/** The ChatGPT app's wake lines, each from its `[codex-app]` on. */
const wakeLines = (d: IsolatedDaemon): string[] => d.log().split('\n').filter((line) => line.includes('[codex-app] wake'))
  .map((line) => line.slice(line.indexOf('[codex-app]')))
/** Words to [agentId] from [dial]: what it was answered. */
const speak = (dial: FakeDial, agentId: string, uploadId: string): Promise<DialMessage> => {
  const since = dial.messages.length
  dial.send({ t: 'voice.begin', agentId, uploadId, sr: 16_000, lang: 'en' })
  dial.audio(Buffer.alloc(3_200, 1))
  dial.send({ t: 'voice.end', uploadId })
  return dial.next((m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === uploadId, 65_000,
    'the answer to its words', since)
}

describe.skipIf(process.platform === 'win32')('words to a resting ChatGPT app thread, on a fixture ~/.codex', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })

  /** A daemon of its own signed in to a fake backend, its CODEX_HOME the app's Codex home, the app installed, and two
   *  threads there: t1 named `Fixture Wake`, whose rollout is in that home, and t2. */
  const fresh = async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await IsolatedDaemon.create({ env: {
      CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    } })
    daemon = d
    // Harness's CODEX_HOME the app's Codex home, as on a computer that never set it (the design's Decision 5).
    const home = join(d.env.HOME!, '.codex')
    d.env.CODEX_HOME = home
    // Before anything runs: its open, its /Applications (or /usr/lib), its home, the Codex home and the app's own CLI are
    // the root's; and on macOS its /Applications holds no ChatGPT app, so only the home's fake is found.
    const open = d.env.HARNESS_OPEN_BIN
    const apps = d.env.HARNESS_APPLICATIONS_DIR
    for (const path of [open, apps, d.env.HOME, home, d.env.CODEX_HOME, d.env.HARNESS_CODEX_APP_BIN]) expect(inside(d.root, path), path).toBe(true)
    const runs = join(dirname(open!), 'runs.log')
    writeRecordingOpen(open!, runs)
    if (LINUX) {
      const [program] = chatGptPlaces('linux', apps, d.env.HOME!)
      expect(inside(d.root, program), program).toBe(true)
      mkdirSync(dirname(program), { recursive: true })
      writeFileSync(program, '')
      writeSchemeApps(d, { claude: 'com.anthropic.Claude.desktop', codex: 'chatgpt.desktop' })
    } else {
      expect(existsSync(join(apps!, 'ChatGPT.app')), apps).toBe(false)
      const contents = join(d.env.HOME!, 'Applications', 'ChatGPT.app', 'Contents')
      mkdirSync(contents, { recursive: true })
      writeFileSync(join(contents, 'Info.plist'), INFO_PLIST)
      writeAppCodex(d)
    }

    // t1's rollout in the app's home before the words, as a real app thread's is: `codex queue` refuses a thread with none.
    const t2 = randomUUID()
    const codex = new CodexOutside(d, 'e2e-wake', children, LINUX ? {} : { __CFBundleIdentifier: CODEX_APP },
      { sessionId: randomUUID(), own: LINUX ? { title: 'ChatGPT' } : undefined })
    const t1 = codex.sessionId
    const fixture = codexAppFixture(home)
    const now = Date.now()
    fixture.threads([
      { id: t1, cwd: codex.cwd, recencyAtMs: now - 1_000 },
      { id: t2, cwd: `/work/e2e-${t2.slice(0, 8)}`, recencyAtMs: now - 2_000 },
    ])
    fixture.name(t1, 'Fixture Wake')

    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.env.HARNESS_AUTH_DIR!, 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    await d.start()
    await d.hooksInstalled(['codex'])

    // The round dial on the ChatGPT app's page, both threads at rest with voice.
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0e', FILTER)
    await dial.next((m) => m.t === 'apps' && m.shown === 'codex', 45_000, "the ChatGPT app's page")
    const ids = [t1, t2].map((id) => observedAgentId('codex', id))
    expect(await voiced(dial, 'both threads, with voice', ids)).toEqual([
      expect.objectContaining({ id: ids[0], name: 'Fixture Wake', host: 'codex', caps: 'svf' }),
      expect.objectContaining({ id: ids[1], host: 'codex', caps: 'svf' }),
    ])
    return { d, relay, dial, codex, t1, t2, home, open: open!, runs }
  }

  it('words to a resting ChatGPT thread open it, then reach its Codex queue alone; its hooks then make it a live row with voice', async () => {
    const { d, relay, dial, codex, t1, t2, home, runs } = await fresh()
    const id = codex.id

    // 2. The words, answered with their transcript.
    const words = 'run the wake tests'
    relay.speech = words
    expect(await speak(dial, id, 'e2e-voice-wake')).toMatchObject({ t: 'voice.transcript', agentId: id, text: words })

    // 3. One open: t1's link, by the app.
    expect(openRuns(runs, process.platform as 'darwin' | 'linux')).toEqual([{ argv: opened(t1), ok: true }])

    // 4. One queue call, t1's, under the app's Codex home, after the link; nothing in the other ledger.
    expect(queued(d, TAKEN)).toEqual([{ args: ['queue', '--thread', t1, `--message=${words}`], codexHome: home }])
    expect(queued(d, OTHER)).toEqual([])
    expect(statSync(runs).mtimeMs).toBeLessThanOrEqual(statSync(join(d.root, TAKEN)).mtimeMs)

    // 5. Its lines: fixed words and the time it took, and nothing of either thread or the words in the whole log.
    await said(d, '[device] voice · codex-wake-sent')
    const lines = wakeLines(d)
    const sent = lines.find((line) => line.startsWith('[codex-app] wake · sent · '))
    expect(sent, lines.join('\n')).toBeDefined()
    console.log(`[codex-app e2e] words → its queue: ${sent}`)
    for (const line of lines) expect(line).toMatch(WAKE)
    const log = d.log()
    for (const secret of [t1, t2, 'Fixture Wake', words]) expect(log).not.toContain(secret)

    // 6. The app runs the thread: its hooks make it one live row under the same id, working, still with voice.
    const since = dial.messages.length
    await codex.hook('SessionStart', { source: 'resume' })
    await codex.hook('UserPromptSubmit')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its turn started', since)
    const asked = dial.messages.length
    dial.send({ t: 'agents.list' })
    const live = await until('the list it asked for', () => rosters(dial, asked).at(-1) ?? null, 30_000, 50)
    const mine = live.filter((row) => row.id === id)
    expect(mine).toEqual([expect.objectContaining({ id, host: 'codex', caps: expect.stringContaining('v') })])
    for (const rows of rosters(dial)) expect(rows.filter((row) => row.id === id).length, JSON.stringify(rows)).toBeLessThanOrEqual(1)
    expect(openRuns(runs, process.platform as 'darwin' | 'linux')).toEqual([{ argv: opened(t1), ok: true }])
  })

  it('a link that fails queues nothing, and the dial is told it did not open in ChatGPT', async () => {
    const { d, relay, dial, codex, open } = await fresh()
    linksFail(open, ['chatgpt'])

    relay.speech = 'run the wake tests'
    expect(await speak(dial, codex.id, 'e2e-voice-fail'))
      .toMatchObject({ t: 'voice.error', message: 'Fixture Wake did not open in ChatGPT.' })
    await said(d, '[device] voice · codex-wake-open-failed')
    expect(wakeLines(d)).toContain('[codex-app] wake · open failed')
    expect(queued(d, APP_LEDGER)).toEqual([])
    expect(queued(d, PATH_LEDGER)).toEqual([])
  })
})
