// Tier A's live sessions (sessions.ts) on a fake world: what each hook tells the devices, the process the machine model
// runs for it, and the Claude mod's inbox poll, recorded rather than run on the real devices. Every folder is a temp one.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLastAnswer } from '../../../../cable/hosts/lastAnswer.js'
import type { InboxAnswer, InboxPoll } from '../../../../core/deviceHookCalls.js'
import type { ObservedEvent, ObservedHookEvent } from '../../../../core/observedHook.js'
import { lastCursorTurnText } from '../../../../engines/cursor/normalizer.js'
import { claudeSession, editorSession, thread } from '../../catalog.js'
import type { Delivery, Platform, Scenario, SessionKey, StepOf } from '../../types.js'
import { machine } from '../machine.js'
import type { TierAWorld } from '../world.js'
import { agentPid, keyOfShell, sessionsSteps, shellOf } from './sessions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const scenario: Scenario = {
  id: 'S1', app: 'claude', title: 'Eval sessions', dims: ['D4'], platforms: ['darwin', 'win32', 'linux'], tiers: ['a'],
  heldOut: false, steps: [], checks: [], probes: [],
  sessions: [claudeSession('a', 60_000), claudeSession('b', 120_000), thread('t1', 60_000), thread('c1', 180_000, { cli: true }),
    // A folder with a control character, which the core takes as forged.
    claudeSession('x', 60_000, { cwd: '/work/eval-\u0007' })],
}

/** One of each editor agent: a terminal Claude Code, a panel, a Codex with its own home, Cursor's own agent and
 *  cursor-agent in a terminal. */
const editors: Scenario = {
  id: 'S2', app: 'vscode', title: 'Eval editors', dims: ['D1'], platforms: ['darwin', 'win32', 'linux'], tiers: ['a'],
  heldOut: false, steps: [], checks: [], probes: [],
  sessions: [editorSession('a', 'vscode'), editorSession('d', 'vscode', { place: 'panel' }),
    editorSession('b', 'vscode', { engine: 'codex', codexHome: 'own' }),
    editorSession('c', 'cursor', { place: 'agent', folders: ['/work/eval-c'] }), editorSession('e', 'cursor', { engine: 'cursor' })],
}
/** VS Code started with `code .` from Terminal.app (V11). */
const fromTerminal: Scenario = { ...editors, id: 'S3', platforms: ['darwin'], world: { launchedFrom: 'terminal-app' } }

/** A world whose devices record what they are told, and hold each mod poll until the test answers it. */
function fakeWorld(platform: Platform, of: Scenario = scenario) {
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-sessions-'))
  roots.push(root)
  machine.reset()
  const told: ObservedEvent[] = []
  const polls: Array<{ poll: InboxPoll; answer(a: InboxAnswer): void; open: boolean }> = []
  const gone: string[] = []
  const deliveries: Array<Omit<Delivery, 'at'>> = []
  const devices = {
    observed: (event: ObservedEvent) => { told.push(event); return true },
    inboxPoll: (poll: InboxPoll) => new Promise<InboxAnswer>((resolve) => {
      const held = { poll, open: true, answer: (a: InboxAnswer) => { held.open = false; resolve(a) } }
      polls.push(held)
    }),
    // As the devices' inbox does: the poll it names is answered with nothing.
    inboxGone: (pollId: string) => {
      gone.push(pollId)
      polls.find((p) => p.open && p.poll.pollId === pollId)?.answer({})
    },
  }
  const world = {
    scenario: of, platform, machine,
    ports: { devices },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions'),
      cursorProjects: join(root, 'cursor', 'projects'), codexHomes: join(root, 'codex-homes') },
    codexHome: { home: join(root, '.codex') },
    session: (key: SessionKey) => of.sessions.find((s) => s.key === key)!,
    deliver: (d: Omit<Delivery, 'at'>) => { deliveries.push(d) },
  } as unknown as TierAWorld
  const hook = (session: SessionKey, event: StepOf<'hook'>['event'], more: Partial<StepOf<'hook'>> = {}) =>
    sessionsSteps.hook(world, { kind: 'hook', session, event, ...more })
  const open = () => polls.filter((p) => p.open).map((p) => p.poll.sessionId)
  return { world, told, polls, gone, deliveries, hook, open }
}

/** The mod's next poll comes on the answer's own turn of the loop. */
const landed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

const a = scenario.sessions[0]!
const b = scenario.sessions[1]!
const t1 = scenario.sessions[2]!
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const CHATGPT_APP = 'com.openai.codex'
const VSCODE = 'com.microsoft.VSCode'
const CURSOR = 'com.todesktop.230313mzl4w4u92'
const TERMINAL = 'com.apple.Terminal'
const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux']

const toldOf = (told: readonly ObservedEvent[], sessionId: string, event = 'session-start') =>
  told.find((e): e is ObservedHookEvent => e.sessionId === sessionId && e.event === event)!
const sessionOf = (key: SessionKey) => editors.sessions.find((s) => s.key === key)!

describe("tier A's live sessions", () => {
  it('start puts the process in the machine, tells the devices and opens the mod\'s poll', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    expect(machine.processes.get(41000)).toMatchObject({ pid: 41000, app: 'claude' })
    expect(machine.owners.get(a.id)).toMatchObject({ engine: 'claude', pid: 41000, cwd: a.cwd })
    expect(w.told).toEqual([{
      engine: 'claude', sessionId: a.id, event: 'session-start', cwd: a.cwd, callerPid: 41000,
      transcriptPath: machine.owners.get(a.id)!.transcriptPath,
      hostHints: { __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: a.localId, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      title: 'Eval Alpha',
    }])
    expect(machine.owners.get(a.id)!.transcriptPath!.startsWith(w.world.folders.claudeProjects)).toBe(true)
    expect(w.open()).toEqual([a.id])
  })

  it('each platform names the app as its hook and its process table do, and only Claude runs the mod', async () => {
    const hints = async (platform: Platform) => {
      const w = fakeWorld(platform)
      await w.hook('a', 'start')
      await w.hook('t1', 'start')
      await w.hook('c1', 'start')
      return { told: w.told.map((e) => (e as ObservedHookEvent).hostHints), apps: [...machine.processes.values()].map((p) => p.app),
        open: w.open(), codexTranscript: machine.owners.get(t1.id)!.transcriptPath!.startsWith(w.world.folders.codexSessions) }
    }
    const claude = { CLAUDE_CODE_HOST_SESSION_ID: a.localId, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
    // The ChatGPT app's Codex inherits the app's bundle id on macOS, and the hook finds the app among its parents on
    // Windows; a Codex CLI names its terminal.
    const chatgpt = { __CFBundleIdentifier: CHATGPT_APP }
    const terminal = { TERM_PROGRAM: 'ghostty' }
    expect(await hints('darwin')).toEqual({ told: [{ __CFBundleIdentifier: CLAUDE_APP, ...claude }, chatgpt, terminal],
      apps: ['claude', 'codex', undefined], open: [a.id], codexTranscript: true })
    expect(await hints('linux')).toEqual({ told: [claude, {}, terminal], apps: ['claude', 'codex', undefined], open: [a.id],
      codexTranscript: true })
    expect(await hints('win32')).toEqual({ told: [{ __CFBundleIdentifier: CLAUDE_APP, ...claude }, chatgpt, terminal],
      apps: [undefined, undefined, undefined], open: [a.id], codexTranscript: true })
  })

  it('an answered poll is a mod delivery to that session, and the mod polls again', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    w.polls[0]!.answer({ text: 'Eval words for alpha.' })
    await landed()
    expect(w.deliveries).toEqual([{ path: 'mod', target: 'a', text: 'Eval words for alpha.' }])
    expect(w.open()).toEqual([a.id])
    // A hold that ran out is answered with nothing: nothing is delivered, and the mod asks again at once.
    w.polls[1]!.answer({})
    await landed()
    expect(w.deliveries).toHaveLength(1)
    expect(w.open()).toEqual([a.id])
    expect(new Set(w.polls.map((p) => p.poll.pollId)).size).toBe(3)
  })

  it('turn-stop writes the last answer where readLastAnswer reads it', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    await w.hook('a', 'turn-start')
    await w.hook('a', 'turn-stop', { lastAnswer: 'Eval answer one.' })
    await w.hook('t1', 'start')
    await w.hook('t1', 'turn-start')
    await w.hook('t1', 'turn-stop', { lastAnswer: 'Eval codex answer.' })
    const stop = (sessionId: string) =>
      w.told.find((e): e is ObservedHookEvent => e.sessionId === sessionId && e.event === 'turn-stop')
    expect(stop(a.id)).toMatchObject({ engine: 'claude', callerPid: 41000, transcriptPath: machine.owners.get(a.id)!.transcriptPath })
    expect(stop(t1.id)).toMatchObject({ engine: 'codex', callerPid: machine.owners.get(t1.id)!.pid, transcriptPath: machine.owners.get(t1.id)!.transcriptPath })
    const read = (engine: 'claude' | 'codex', path: string, root: string) =>
      readLastAnswer(engine, path, { roots: [root], maxBytes: 262_144, deadlineMs: 1_000 })
    expect(await read('claude', stop(a.id)!.transcriptPath!, w.world.folders.claudeProjects)).toBe('Eval answer one.')
    expect(await read('codex', stop(t1.id)!.transcriptPath!, w.world.folders.codexSessions)).toBe('Eval codex answer.')
  })

  it("turn-start writes the person's line, so a turn's last answer is that turn's alone", async () => {
    const w = fakeWorld('darwin')
    for (const key of ['a', 't1']) {
      await w.hook(key, 'start')
      await w.hook(key, 'turn-start')
      await w.hook(key, 'turn-stop', { lastAnswer: 'Eval answer one.' })
      // A second turn that ends with no answer of its own.
      await w.hook(key, 'turn-start')
      await w.hook(key, 'turn-stop')
    }
    const read = (engine: 'claude' | 'codex', sessionId: string, root: string) =>
      readLastAnswer(engine, machine.owners.get(sessionId)!.transcriptPath!, { roots: [root], maxBytes: 262_144, deadlineMs: 1_000 })
    expect(await read('claude', a.id, w.world.folders.claudeProjects)).toBeUndefined()
    expect(await read('codex', t1.id, w.world.folders.codexSessions)).toBeUndefined()
  })

  it('a hook the core would refuse fails its step, and the devices are told nothing', async () => {
    const w = fakeWorld('darwin')
    await expect(w.hook('x', 'start')).rejects.toThrow(/the core refuses/)
    expect(w.told).toEqual([])
  })

  it('needs-input tells the devices, and a permission in the Claude app is also the mod\'s asked', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    await w.hook('a', 'turn-start')
    await w.hook('a', 'needs-input', { asks: 'permission' })
    expect(w.told.slice(2).map((e) => ({ event: e.event, sessionId: e.sessionId }))).toEqual([
      { event: 'needs-input', sessionId: a.id }, { event: 'asked', sessionId: a.id },
    ])
  })

  it('quit ends the app\'s sessions and relaunch starts them again, each in a process of its own', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    await w.hook('b', 'start')
    await w.hook('t1', 'start')
    w.told.length = 0
    await sessionsSteps.quit(w.world, { kind: 'quit', app: 'claude' })
    await landed()
    expect(w.told.map((e) => [e.sessionId, e.event])).toEqual([[a.id, 'session-end'], [b.id, 'session-end']])
    expect([...machine.processes.keys()]).toEqual([41002])
    expect([...machine.owners.keys()]).toEqual([t1.id])
    expect(w.gone).toHaveLength(2)
    expect(w.open()).toEqual([])
    w.told.length = 0
    await sessionsSteps.relaunch(w.world, { kind: 'relaunch', app: 'claude' })
    // A process that ended is not back: the relaunched sessions' are new ones.
    expect(w.told.map((e) => [e.sessionId, e.event, (e as ObservedHookEvent).callerPid])).toEqual([
      [a.id, 'session-start', 41003], [b.id, 'session-start', 41004],
    ])
    expect([...machine.processes.keys()].sort()).toEqual([41002, 41003, 41004])
    expect(w.open()).toEqual([a.id, b.id])
  })

  it('a terminal Claude Code in VS Code runs under a shell under the editor, and its hook says TERM_PROGRAM=vscode with '
    + "VS Code's bundle id on macOS and Windows, and TERM_PROGRAM alone on Linux", async () => {
    const hints: Partial<Record<Platform, unknown>> = {}
    for (const platform of PLATFORMS) {
      const w = fakeWorld(platform, editors)
      await w.hook('a', 'start')
      const agent = agentPid(w.world, 'a')!
      const shell = shellOf(w.world, 'a')!
      const editor = machine.processes.get(shell)!.ppid
      expect(machine.processes.get(agent)).toMatchObject({ ppid: shell, executable: 'claude' })
      expect(machine.processes.get(editor)).toMatchObject({ ppid: 1 })
      expect(keyOfShell(w.world, shell)).toBe('a')
      expect(toldOf(w.told, sessionOf('a').id)).toMatchObject({ engine: 'claude', callerPid: agent })
      hints[platform] = toldOf(w.told, sessionOf('a').id).hostHints
    }
    expect(hints).toEqual({
      darwin: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE },
      win32: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE },
      linux: { TERM_PROGRAM: 'vscode' },
    })
  })

  it('a panel session runs under the editor and says claude-vscode, with no TERM_PROGRAM', async () => {
    const hints: Partial<Record<Platform, unknown>> = {}
    for (const platform of PLATFORMS) {
      const w = fakeWorld(platform, editors)
      await w.hook('a', 'start')
      await w.hook('d', 'start')
      const editor = machine.processes.get(shellOf(w.world, 'a')!)!.ppid
      expect(shellOf(w.world, 'd')).toBeUndefined()
      // One editor process for both of its sessions.
      expect(machine.processes.get(agentPid(w.world, 'd')!)).toMatchObject({ ppid: editor, executable: 'claude' })
      hints[platform] = toldOf(w.told, sessionOf('d').id).hostHints
    }
    expect(hints).toEqual({
      darwin: { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
      win32: { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
      linux: { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
    })
  })

  it("launched from Terminal.app: its hook says Terminal's bundle id with TERM_PROGRAM=vscode, and the editor's parent is "
    + "Terminal's process", async () => {
    const w = fakeWorld('darwin', fromTerminal)
    await w.hook('a', 'start')
    await w.hook('d', 'start')
    expect(toldOf(w.told, sessionOf('a').id).hostHints).toEqual({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: TERMINAL })
    expect(toldOf(w.told, sessionOf('d').id).hostHints).toEqual({ __CFBundleIdentifier: TERMINAL, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
    const editor = machine.processes.get(machine.processes.get(shellOf(w.world, 'a')!)!.ppid)!
    const terminal = machine.processes.get(editor.ppid)!
    expect(terminal.ppid).toBe(1)
    // Each app's bundle holds its executable, with its id, as plutil would read it.
    const bundleOf = (executable: string) => [...machine.bundleIds.keys()].find((bundle) => executable.startsWith(`${bundle}/`))
    expect(machine.bundleIds.get(bundleOf(terminal.executable)!)).toBe(TERMINAL)
    expect(machine.bundleIds.get(bundleOf(editor.executable)!)).toBe(VSCODE)
  })

  it("Cursor's own agent: engine cursor, no TERM_PROGRAM, its transcript under CURSOR_HOME's projects, its answer where the "
    + 'Cursor normalizer reads it', async () => {
    const hints: Partial<Record<Platform, unknown>> = {}
    for (const platform of PLATFORMS) {
      const w = fakeWorld(platform, editors)
      await w.hook('c', 'start')
      hints[platform] = toldOf(w.told, sessionOf('c').id).hostHints
      const editor = machine.processes.get(machine.processes.get(agentPid(w.world, 'c')!)!.ppid)!
      expect(editor).toMatchObject({ ppid: 1, app: platform === 'win32' ? undefined : 'cursor' })
      expect(shellOf(w.world, 'c')).toBeUndefined()
    }
    expect(hints).toEqual({ darwin: { __CFBundleIdentifier: CURSOR }, win32: { __CFBundleIdentifier: CURSOR }, linux: {} })
    const w = fakeWorld('darwin', editors)
    await w.hook('c', 'start')
    await w.hook('c', 'turn-start')
    await w.hook('c', 'turn-stop', { lastAnswer: 'Eval cursor answer.' })
    const stop = toldOf(w.told, sessionOf('c').id, 'turn-stop')
    expect(stop.engine).toBe('cursor')
    expect(stop.transcriptPath!.startsWith(join(w.world.folders.cursorProjects, 'work-eval-c', 'agent-transcripts'))).toBe(true)
    const lines = readFileSync(stop.transcriptPath!, 'utf8').split('\n').filter(Boolean)
    expect(lastCursorTurnText(lines)).toEqual({ userMessage: 'Eval prompt.', assistantText: 'Eval cursor answer.' })
  })

  it('cursor-agent in a terminal says TERM_PROGRAM=vscode', async () => {
    const hints: Partial<Record<Platform, unknown>> = {}
    for (const platform of PLATFORMS) {
      const w = fakeWorld(platform, editors)
      await w.hook('e', 'start')
      expect(toldOf(w.told, sessionOf('e').id).engine).toBe('cursor')
      expect(machine.processes.get(agentPid(w.world, 'e')!)!.ppid).toBe(shellOf(w.world, 'e'))
      hints[platform] = toldOf(w.told, sessionOf('e').id).hostHints
    }
    expect(hints).toEqual({
      darwin: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR },
      win32: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR },
      linux: { TERM_PROGRAM: 'vscode' },
    })
  })

  it("a Codex with its own home writes its rollout under it, neither Harness's CODEX_HOME nor the ChatGPT app's", async () => {
    const w = fakeWorld('darwin', editors)
    await w.hook('b', 'start')
    await w.hook('b', 'turn-start')
    await w.hook('b', 'turn-stop', { lastAnswer: 'Eval own codex answer.' })
    const stop = toldOf(w.told, sessionOf('b').id, 'turn-stop')
    expect(stop).toMatchObject({ engine: 'codex', hostHints: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE } })
    const path = stop.transcriptPath!
    expect(path.startsWith(w.world.folders.codexHomes)).toBe(true)
    expect(path.startsWith(w.world.folders.codexSessions)).toBe(false)
    expect(path.startsWith(w.world.codexHome.home)).toBe(false)
    // As Codex writes it: sessions/<year>/<month>/<day>/rollout-…-<id>.jsonl in its home.
    expect(path).toMatch(new RegExp(`/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-[^/]+-${sessionOf('b').id}\\.jsonl$`))
    expect(await readLastAnswer('codex', path, { roots: [w.world.folders.codexHomes], maxBytes: 262_144, deadlineMs: 1_000 }))
      .toBe('Eval own codex answer.')
  })

  it("only Claude Code's hook carries the title", async () => {
    const w = fakeWorld('darwin', editors)
    for (const key of ['a', 'd', 'b', 'c', 'e']) {
      await w.hook(key, 'start')
      await w.hook(key, 'turn-start')
    }
    const titles = (event: string) => Object.fromEntries(['a', 'd', 'b', 'c', 'e']
      .map((key) => [key, toldOf(w.told, sessionOf(key).id, event).title]))
    const said = { a: 'Eval Alpha', d: 'Eval Delta', b: undefined, c: undefined, e: undefined }
    expect(titles('session-start')).toEqual(said)
    expect(titles('turn-start')).toEqual(said)
  })

  it("the mod polls for every Claude Code session, the panel's included", async () => {
    const w = fakeWorld('darwin', editors)
    for (const key of ['a', 'd', 'b', 'c', 'e']) await w.hook(key, 'start')
    expect(w.open()).toEqual([sessionOf('a').id, sessionOf('d').id])
  })

  it("the machine answers each pid with the nearest app of its chain, an editor's agent with the editor, and Windows with none", async () => {
    const apps = async (platform: Platform, of: Scenario) => {
      const w = fakeWorld(platform, of)
      for (const key of ['a', 'd', 'c', 'e']) await w.hook(key, 'start')
      return Object.fromEntries(['a', 'd', 'c', 'e'].flatMap((key) => {
        const shell = shellOf(w.world, key)
        return [[key, machine.appOf(agentPid(w.world, key)!)], ...(shell === undefined ? [] : [[`${key} shell`, machine.appOf(shell)]])]
      }))
    }
    const walked = { a: 'vscode', 'a shell': 'vscode', d: 'vscode', c: 'cursor', e: 'cursor', 'e shell': 'cursor' }
    expect(await apps('darwin', editors)).toEqual(walked)
    expect(await apps('linux', editors)).toEqual(walked)
    // Under Terminal, the editor is the nearer app.
    expect(await apps('darwin', fromTerminal)).toEqual(walked)
    expect(await apps('win32', editors)).toEqual({ a: undefined, 'a shell': undefined, d: undefined, c: undefined,
      e: undefined, 'e shell': undefined })
  })

  it("an editor's quit ends its sessions, their shells and the editor's process, and its relaunch starts a new one", async () => {
    const w = fakeWorld('darwin', editors)
    // VS Code 41000, a's shell 41001 and agent 41002, d's agent 41003; Cursor 41004, c's agent 41005.
    await w.hook('a', 'start')
    await w.hook('d', 'start')
    await w.hook('c', 'start')
    await sessionsSteps.quit(w.world, { kind: 'quit', app: 'vscode' })
    await landed()
    expect([...machine.processes.keys()]).toEqual([41004, 41005])
    expect(w.open()).toEqual([])
    await sessionsSteps.relaunch(w.world, { kind: 'relaunch', app: 'vscode' })
    expect(machine.processes.get(shellOf(w.world, 'a')!)!.ppid).toBe(41006)
    expect(machine.processes.get(agentPid(w.world, 'd')!)!.ppid).toBe(41006)
    expect(w.open()).toEqual([sessionOf('a').id, sessionOf('d').id])
  })

  it("the Claude app's and the ChatGPT app's hooks, hints and processes are as before", async () => {
    for (const platform of PLATFORMS) {
      const w = fakeWorld(platform)
      for (const key of ['a', 't1', 'c1']) await w.hook(key, 'start')
      // One process each, from 41000, whose parent is none of the machine's, and whose app is its own.
      expect([...machine.processes.values()].map(({ pid, ppid, executable }) => ({ pid, ppid, executable }))).toEqual([
        { pid: 41000, ppid: 1, executable: 'claude' }, { pid: 41001, ppid: 1, executable: 'codex' },
        { pid: 41002, ppid: 1, executable: 'codex' },
      ])
      expect([41000, 41001, 41002].map((pid) => machine.appOf(pid)))
        .toEqual(platform === 'win32' ? [undefined, undefined, undefined] : ['claude', 'codex', undefined])
      expect(w.told.map((e) => [e.engine, (e as ObservedHookEvent).title]))
        .toEqual([['claude', 'Eval Alpha'], ['codex', undefined], ['codex', undefined]])
      expect(shellOf(w.world, 'a')).toBeUndefined()
    }
  })
})
