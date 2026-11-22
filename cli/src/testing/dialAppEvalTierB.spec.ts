import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN } from './dialAppEval/catalog.js'
import type { App, Platform, Scenario } from './dialAppEval/types.js'

// The dial eval's tier B harness, the parts that need no daemon. It is outside tsconfig's rootDir (src), so it is loaded
// untyped, as fakeEngineUntil.spec.ts loads the harness.
const driver = await import('../../e2e/harness/appEvalDriver.js' as string) as {
  writeRecordingOpen(path: string, runs: string): void
  linksFail(path: string, apps: readonly App[]): void
  openRuns(runs: string, platform: Platform): Array<{ argv: string[]; ok: boolean }>
  tierBGaps(scenario: Scenario, platform: Platform): string[]
  writeRecordingCli(path: string, runs: string): void
  cliRuns(runs: string): Array<{ argv: string[]; ok: boolean }>
  deviceLines(log: string, from: number): { lines: string[]; next: number }
  workPaths(argv: readonly string[], projects: readonly string[]): string[]
  deskEmpty(messages: ReadonlyArray<Record<string, unknown>>): boolean
}

const claude = await import('../../e2e/harness/appEvalClaude.js' as string) as {
  linkedSocket(root: string, code: number | null, stdout: string, stderr: string): string
  typedPrompts(transcript: string): Array<{ at?: number; text: string }>
  writeWhole(file: string, text: string): void
}

const modInbox = await import('../../e2e/harness/modInbox.js' as string) as {
  inboxPoll(d: { socketPath: string }, sessionId: string): Promise<{ status: number; body: unknown }>
}

let dir = ''
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A recording open in a throwaway folder: its path and the file it notes its runs in. */
function open(): { path: string; runs: string; run(...args: string[]): number | null } {
  dir = mkdtempSync(join(tmpdir(), 'tier-b-open-'))
  const path = join(dir, 'open')
  const runs = join(dir, 'runs.log')
  driver.writeRecordingOpen(path, runs)
  return { path, runs, run: (...args) => spawnSync(path, args).status }
}

const CHATGPT_LINK = 'codex://threads/00000000-0000-4000-a000-000000007431'
const CLAUDE_LINK = 'claude://code/continue?session=local_00000000-0000-4000-9000-000000000061'

describe("tier B's recording open", () => {
  it('notes each run with its exit, as the command it stands for: open on macOS, xdg-open on Linux', () => {
    const o = open()
    expect(o.run('-b', 'com.openai.codex', CHATGPT_LINK)).toBe(0)
    expect(driver.openRuns(o.runs, 'darwin')).toEqual([{ argv: ['open', '-b', 'com.openai.codex', CHATGPT_LINK], ok: true }])
    expect(driver.openRuns(o.runs, 'linux')).toEqual([{ argv: ['xdg-open', '-b', 'com.openai.codex', CHATGPT_LINK], ok: true }])
  })

  it('fails the links of an app the world says fails, on every platform, and no other app\'s', () => {
    const o = open()
    driver.linksFail(o.path, ['chatgpt'])
    expect(o.run(CHATGPT_LINK)).toBe(1)
    expect(o.run(CLAUDE_LINK)).toBe(0)
    driver.linksFail(o.path, [])
    expect(o.run(CHATGPT_LINK)).toBe(0)
    expect(driver.openRuns(o.runs, 'linux')).toEqual([
      { argv: ['xdg-open', CHATGPT_LINK], ok: false }, { argv: ['xdg-open', CLAUDE_LINK], ok: true }, { argv: ['xdg-open', CHATGPT_LINK], ok: true },
    ])
  })

  it('has noted nothing before its first run', () => {
    const o = open()
    expect(driver.openRuns(o.runs, 'darwin')).toEqual([])
  })
})

describe("tier B's recording Cursor CLI", () => {
  it('notes each run as cursor and its arguments, and exits 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-cursor-'))
    const path = join(dir, 'cursor', 'cursor')
    const runs = join(dir, 'cursor-runs.log')
    expect(driver.cliRuns(runs)).toEqual([])
    driver.writeRecordingCli(path, runs)
    expect(spawnSync(path, ['/work/eval-alpha']).status).toBe(0)
    expect(spawnSync(path, ['--list-extensions']).status).toBe(0)
    expect(driver.cliRuns(runs)).toEqual([
      { argv: ['cursor', '/work/eval-alpha'], ok: true }, { argv: ['cursor', '--list-extensions'], ok: true },
    ])
  })
})

describe("tier B's devices' log lines", () => {
  it("deviceLines gives the devices' lines after an offset, from their tag on", () => {
    const before = '12:00:00 [device] voice · codex\n'
    const log = `${before}12:00:01 [cli] ready\n12:00:02 [device] scroll · skipped · not on screen\n12:00:03 [device] tap · mo`
    const read = driver.deviceLines(log, before.length)
    expect(read.lines).toEqual(['[device] scroll · skipped · not on screen'])
    // A line not yet ended is read once it is.
    expect(read.next).toBe(log.lastIndexOf('\n') + 1)
    expect(driver.deviceLines(`${log}ved\n`, read.next)).toEqual({ lines: ['[device] tap · moved'], next: log.length + 4 })
    expect(driver.deviceLines(log, log.length)).toEqual({ lines: [], next: log.length })
  })
})

describe("tier B's commands", () => {
  it("a command's folder under the daemon's projects is recorded as the catalog's /work/ one", () => {
    const projects = ['/tmp/htmux-eval/projects', '/private/tmp/htmux-eval/projects']
    expect(driver.workPaths(['open', '-b', 'com.todesktop.230313mzl4w4u92', '/private/tmp/htmux-eval/projects/eval-alpha'], projects))
      .toEqual(['open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-alpha'])
    expect(driver.workPaths(['cursor', '/tmp/htmux-eval/projects/eval-beta/src'], projects)).toEqual(['cursor', '/work/eval-beta/src'])
    // Only a folder inside the projects: one beside them, or the link of an app, is kept as it is.
    expect(driver.workPaths(['cursor', '/tmp/htmux-eval/projects-other/eval-alpha', 'cursor://file/x'], projects))
      .toEqual(['cursor', '/tmp/htmux-eval/projects-other/eval-alpha', 'cursor://file/x'])
  })
})

describe("tier B's start", () => {
  const welcome = { t: 'welcome' }
  const list = (...ids: string[]): Array<Record<string, unknown>> => [{ t: 'agents.begin' }, ...ids.map((id) => ({ t: 'agent', id })), { t: 'agents.end' }]
  const apps = (...counts: Array<[string, number]>): Record<string, unknown> =>
    ({ t: 'apps', shown: '', apps: counts.map(([id, count]) => ({ id, name: id, count, waiting: 0 })) })

  it('goes on once the dial was welcomed, shown an empty list, and told no app has a row', () => {
    expect(driver.deskEmpty([welcome, apps(), ...list()])).toBe(true)
  })

  it("waits while another app's page still has a row of an earlier scenario, though the list shown is empty", () => {
    expect(driver.deskEmpty([welcome, apps(['vscode', 2]), ...list()])).toBe(false)
    expect(driver.deskEmpty([welcome, apps(['vscode', 2]), ...list(), apps()])).toBe(true)
  })

  it('waits for a welcome, an empty list and a word of the apps', () => {
    expect(driver.deskEmpty([apps(), ...list()])).toBe(false)
    expect(driver.deskEmpty([welcome, apps(), ...list('a')])).toBe(false)
    expect(driver.deskEmpty([welcome, ...list()])).toBe(false)
  })
})

const byId = (id: string): Scenario => MAIN.find((s) => s.id === id)!

describe("tier B's gaps", () => {
  it('leaves out on Linux an open check whose link fails: the fallback there is the raise, which no fake records', () => {
    expect(driver.tierBGaps(byId('X5'), 'linux')).toEqual([expect.stringContaining('raise')])
    expect(driver.tierBGaps(byId('X5'), 'darwin')).toEqual([])
    expect(driver.tierBGaps(byId('X4'), 'linux')).toEqual([])
  })

  it('refuses a world it does not build: no ChatGPT app installed, a Claude Code that asks a question', () => {
    expect(() => driver.tierBGaps({ ...byId('X4'), world: { chatgptInstalled: false } }, 'darwin')).toThrow('no ChatGPT app')
    const c7 = byId('C7')
    const question = { ...c7, steps: c7.steps.map((step) => step.kind === 'hook' && step.event === 'needs-input' ? { ...step, asks: 'question' as const } : step) }
    expect(() => driver.tierBGaps(question, 'darwin')).toThrow('question')
    expect(driver.tierBGaps(c7, 'darwin')).toEqual([])
  })

  it("leaves out on Linux an open check on an editor's terminal row, and not on a panel or Cursor's agent, nor on macOS", () => {
    const tapped = (app: App, place?: 'terminal' | 'panel' | 'agent'): Scenario => ({
      id: 'EVAL', app, title: 'Eval tap', dims: ['D2'], platforms: ['darwin', 'linux'], tiers: ['b'], heldOut: false,
      sessions: [{ key: 'a', app, id: '00000000-0000-4000-a000-00000000e001', title: 'Eval alpha', cwd: '/work/eval-alpha', ageMs: 0,
        ...(place ? { place } : {}) }],
      steps: [{ kind: 'tap', session: 'a' }], checks: [{ id: 'EVAL.open', dim: 'D2', kind: 'open', session: 'a', link: false }], probes: [],
    })
    expect(driver.tierBGaps(tapped('vscode'), 'linux')).toEqual([expect.stringContaining("Linux's raise")])
    expect(driver.tierBGaps(tapped('cursor', 'terminal'), 'linux')).toEqual([expect.stringContaining("Linux's raise")])
    expect(driver.tierBGaps(tapped('vscode', 'panel'), 'linux')).toEqual([])
    expect(driver.tierBGaps(tapped('cursor', 'agent'), 'linux')).toEqual([])
    expect(driver.tierBGaps(tapped('vscode'), 'darwin')).toEqual([])
    expect(driver.tierBGaps(tapped('claude'), 'linux')).toEqual([])
  })
})

describe("tier B's Claude mod: the socket its link names", () => {
  const root = '/tmp/htmux-eval'
  const named = (path: string): string => JSON.stringify({ devicesSocket: path })

  it('is the one the link named inside the daemon\'s root', () => {
    expect(claude.linkedSocket(root, 0, named(`${root}/data/devices.sock`), '')).toBe(`${root}/data/devices.sock`)
  })

  it('is refused outside the root, so the attach reaches no other daemon\'s devices', () => {
    expect(() => claude.linkedSocket(root, 0, named('/tmp/htmux-other/data/devices.sock'), '')).toThrow("outside the daemon's root")
    expect(() => claude.linkedSocket(root, 0, named('data/devices.sock'), '')).toThrow("outside the daemon's root")
  })

  it('says what the link printed on its stderr when it named none', () => {
    expect(() => claude.linkedSocket(root, 1, '', 'no devices process\n')).toThrow('no devices process')
    expect(() => claude.linkedSocket(root, 0, 'not json', '')).toThrow("named no devices' socket")
  })
})

describe("tier B's Claude sessions: the words typed into one", () => {
  const row = (type: string, content: unknown, timestamp?: string): string =>
    JSON.stringify({ type, ...(timestamp ? { timestamp } : {}), message: { role: type, content } })

  it('are each prompt its transcript took that no step typed, at the time its own row says', () => {
    const transcript = [
      row('user', '!until eval-turn-3', '2026-11-21T10:00:00.000Z'),
      row('assistant', [{ type: 'text', text: 'answer' }], '2026-11-21T10:00:01.000Z'),
      row('user', 'Eval words for alpha.', '2026-11-21T10:00:05.250Z'),
      row('user', [{ type: 'tool_result', tool_use_id: 'call', content: 'ran' }], '2026-11-21T10:00:06.000Z'),
      '{"half a row',
    ].join('\n')
    expect(claude.typedPrompts(transcript)).toEqual([{ at: Date.parse('2026-11-21T10:00:05.250Z'), text: 'Eval words for alpha.' }])
  })

  it('has no time for a prompt whose row names none', () => {
    expect(claude.typedPrompts(row('user', 'Eval words.'))).toEqual([{ text: 'Eval words.' }])
  })
})

/**
 * A reader in a thread of its own, as the fake Claude Code polls for its release file: it spins on file `i` until it
 * is there and reads it at once. The writer writes file `i` only once the reader spins on it.
 */
const READER = `
const { readFileSync } = require('node:fs')
const { workerData: { dir, count, turn } } = require('node:worker_threads')
const at = new Int32Array(turn)
let empty = 0
for (let i = 0; i < count; i++) {
  Atomics.store(at, 0, i + 1)
  Atomics.notify(at, 0)
  for (;;) {
    let text
    try { text = readFileSync(dir + '/eval-turn-' + i + '.release', 'utf8') } catch { continue }
    if (text === '') empty++
    break
  }
}
require('node:worker_threads').parentPort.postMessage(empty)
`

describe("tier B's Claude sessions: a turn's release file", () => {
  it('is never seen empty by a reader that looks the moment it is there, so its turn answers with its text', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-release-'))
    const count = 300
    const turn = new SharedArrayBuffer(4)
    const at = new Int32Array(turn)
    const reader = new Worker(READER, { eval: true, workerData: { dir, count, turn } })
    const empty = new Promise<number>((resolve, reject) => { reader.once('message', resolve); reader.once('error', reject) })
    for (let i = 0; i < count; i++) {
      while (Atomics.load(at, 0) !== i + 1) Atomics.wait(at, 0, Atomics.load(at, 0), 1_000)
      claude.writeWhole(join(dir, `eval-turn-${i}.release`), 'Eval answer one.')
    }
    expect(await empty).toBe(0)
  }, 30_000)
})

describe("the Claude mod's inbox poll", () => {
  let server: Server | undefined
  afterEach(() => { server?.close() })

  /** A daemon's socket in a throwaway folder that answers every poll with [answer]. */
  async function daemon(answer: (res: import('node:http').ServerResponse) => void): Promise<{ socketPath: string }> {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-inbox-'))
    const socketPath = join(dir, 'daemon.sock')
    server = createServer((_req, res) => answer(res))
    await new Promise<void>((done) => server!.listen(socketPath, done))
    return { socketPath }
  }

  it('is answered with the JSON the daemon sent', async () => {
    const d = await daemon((res) => res.end(JSON.stringify({ text: 'Eval words.' })))
    expect(await modInbox.inboxPoll(d, 'eval')).toEqual({ status: 200, body: { text: 'Eval words.' } })
  })

  it('fails, never throws past its caller, on an answer that is not JSON', async () => {
    const d = await daemon((res) => res.end('not json'))
    await expect(modInbox.inboxPoll(d, 'eval')).rejects.toThrow(SyntaxError)
  })

  it('fails on an answer cut short', async () => {
    const d = await daemon((res) => { res.writeHead(200, { 'content-length': '100' }); res.write('{"te'); setTimeout(() => res.socket?.destroy(), 20) })
    await expect(modInbox.inboxPoll(d, 'eval')).rejects.toThrow()
  })
})
