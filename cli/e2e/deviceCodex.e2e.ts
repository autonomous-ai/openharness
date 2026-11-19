/**
 * The dial talks to Codex outside Harness through `codex queue` (docs/specs/2026-11-15-device-codex.md), on the real
 * daemon: a Codex session in Ghostty tells of itself through its own hooks (harness/codexOutside.ts), a fake dial on the
 * desk speaks to it while it works, and the suite's fake `codex` (harness/fakeEngine.mjs), the one the daemon launches,
 * notes the queue call the devices process runs. The words never reach a terminal. A session in the ChatGPT app takes them
 * through the app's own Codex CLI, a fake under the daemon's root (harness/codexAppCli.ts), and never the developer's app.
 */
import type { ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { appQueued, pathQueueRuns, writeAppCodex, writePathCodexWhoseQueueFails } from './harness/codexAppCli.js'
import { CodexOutside } from './harness/codexOutside.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { FakeDial } from './harness/fakeDial.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c0'.repeat(16), computerId: 'e2e-device-codex-computer', name: 'Fixture', token: 'e2e-device-codex-token' }

describe('the dial talks to Codex outside Harness through codex queue', () => {
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

  /** A daemon signed in as ME, its fakes written by [before] ahead of its start, and a dial on the desk shown its first
   *  list. */
  const fresh = async (before: (d: IsolatedDaemon) => void = () => {}) => {
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
    before(d)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial, relay }
  }

  /** [codex] working, as its prompt hook tells, then the dial's voice to it: the fake backend transcribes [words]. */
  const spoken = async (dial: FakeDial, relay: FakeBackend, codex: CodexOutside, words: string) => {
    // Working: it runs no Stop hook, and no process of its own reads idle.
    let since = dial.messages.length
    await codex.hook('UserPromptSubmit', { prompt: 'work on it' })
    await dial.next((m) => m.t === 'turn.started' && m.agentId === codex.id, 45_000, 'its turn started', since)

    relay.speech = words
    since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: codex.id, uploadId: 'spoken-1', sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId: 'spoken-1' })
    const heard = await dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the transcript', since)
    expect(heard).toMatchObject({ t: 'voice.transcript', text: words, agentId: codex.id })
  }

  /** The devices said the words were queued. */
  const queuedSaid = (d: IsolatedDaemon) => until('"[device] voice · codex" in the daemon\'s log',
    () => d.log().split('\n').some((line) => line.endsWith('[device] voice · codex')), 30_000, 50)

  it("a working Codex in Ghostty takes the dial's spoken words: one codex queue call with its thread and the words, under the daemon's Codex home", async () => {
    const { d, dial, relay } = await fresh()

    // 1. Listed, with voice: no Orca handle and no mod, only its thread in the daemon's Codex home.
    const codex = new CodexOutside(d, 'api', children, { TERM_PROGRAM: 'ghostty' })
    await codex.hook('SessionStart', { source: 'startup' })
    const row = await dial.next((m) => m.t === 'agent' && m.id === codex.id, 45_000, 'the agent listed')
    expect(row.caps).toContain('v')

    // 2. Working, and the dial speaks to it: the fake backend transcribes, the devices queue the words.
    await spoken(dial, relay, codex, 'run the spoken tests')

    // 3. One queue call, for its thread, with the words joined to their flag, under the daemon's Codex home.
    await queuedSaid(d)
    const queued = readFileSync(join(d.root, 'codex-queue'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)
    expect(queued).toEqual([{ args: ['queue', '--thread', codex.sessionId, '--message=run the spoken tests'], codexHome: d.env.CODEX_HOME }])

    // 4. Never the thread, its rollout's path or the words.
    const log = d.log()
    expect(log).not.toContain(codex.sessionId)
    expect(log).not.toContain(codex.transcriptPath)
    expect(log.split('\n').filter((line) => line.includes('[device]') && line.includes('run the spoken tests'))).toEqual([])
  })

  // The `codex` on the daemon's PATH may be one that cannot queue (an npm shim with no node, exit 127): a session in the
  // ChatGPT app takes the words through the app's own CLI, and never runs them twice.
  it.skipIf(process.platform !== 'darwin')("a Codex session in the ChatGPT app takes the dial's spoken words through the app's own codex, when the codex on PATH cannot queue", async () => {
    const { d, dial, relay } = await fresh((d) => {
      writeAppCodex(d)
      writePathCodexWhoseQueueFails(d)
    })

    const codex = new CodexOutside(d, 'api', children, { __CFBundleIdentifier: 'com.openai.codex' })
    await codex.hook('SessionStart', { source: 'startup' })
    const row = await dial.next((m) => m.t === 'agent' && m.id === codex.id && m.host === 'codex', 45_000, 'the agent listed in the app')
    expect(row.caps).toContain('v')

    await spoken(dial, relay, codex, 'run the spoken tests')
    await queuedSaid(d)
    expect(appQueued(d)).toEqual([{ args: ['queue', '--thread', codex.sessionId, '--message=run the spoken tests'], codexHome: d.env.CODEX_HOME }])
    expect(pathQueueRuns(d)).toBe(0)

    const log = d.log()
    expect(log).not.toContain('codex-failed')
    expect(log).not.toContain(codex.sessionId)
    expect(log).not.toContain(codex.transcriptPath)
    expect(log).not.toContain(d.env.HARNESS_CODEX_APP_BIN)
  })
})
