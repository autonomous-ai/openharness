import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_BUNDLES } from '../cable/hosts/hostDetect.js'
import { MAIN } from './dialAppEval/catalog.js'
import type { Platform, Scenario, SessionDef } from './dialAppEval/types.js'

// The dial eval's tier B editor steps, the parts that need no daemon. They are outside tsconfig's rootDir (src), so they
// are loaded untyped, as dialAppEvalTierB.spec.ts loads the harness.
const editor = await import('../../e2e/harness/appEvalEditor.js' as string) as {
  windowRecords(window: string, keyOf: (pid: number) => string | undefined,
    record: (line: Record<string, unknown>, at: number) => void): (printed: Record<string, unknown>, at: number) => void
  windowTyped(keyOf: (pid: number) => string | undefined,
    deliver: (d: { path: string; target: string | null; text: string }, at: number) => void): (printed: Record<string, unknown>, at: number) => void
  editorHints(world: { platform: Platform; scenario: Scenario }, s: SessionDef): Record<string, string>
}
/** The parts of a daemon a Cursor agent's start uses: its root, projects and home, and its note of what its tab starts (own). */
interface CursorDaemon { root: string; projectsDir: string; env: NodeJS.ProcessEnv; own(pid: number): void }
interface CursorAgent { readonly pid: number; readonly shellPid?: number; readonly transcriptPath: string; close(): Promise<void>; killTab(): void }
const cursor = await import('../../e2e/harness/cursorOutside.js' as string) as {
  hookRun(codexLine: string, env: NodeJS.ProcessEnv, hints: Record<string, string>, event: string,
    session: { sessionId: string; roots: string[]; transcriptPath: string }): { command: string; env: NodeJS.ProcessEnv; input: string }
  CursorOutside: { start(d: CursorDaemon, folder: string, children: ChildProcess[],
    options: { sessionId: string; roots: string[]; terminal: boolean; hints: Record<string, string> }): Promise<CursorAgent> }
}
interface CodexAgent { readonly pid?: number; readonly shellPid?: number; end(): Promise<void>; killTab(): void }
const codex = await import('../../e2e/harness/codexOutside.js' as string) as {
  CodexOutside: { inTab(d: CursorDaemon, folder: string, children: ChildProcess[], hints: Record<string, string>,
    tab: Record<string, unknown>): Promise<CodexAgent> }
}

type HookRun = (command: string, env: NodeJS.ProcessEnv, input: string) => Promise<{ code: number | null; stderr: string }>
const outside = await import('../../e2e/harness/outsideAgent.js' as string) as {
  HOOK_RUNNER: string
  hookRuns(answers: NodeJS.ReadableStream, requests: NodeJS.WritableStream, cwd: string, what: string): HookRun
}

describe("tier B's agents' own hook runner", () => {
  const runner = () => spawn(process.execPath, ['-e', outside.HOOK_RUNNER], { stdio: ['pipe', 'pipe', 'ignore'] })
  const env = { PATH: process.env.PATH }

  it('runs hooks asked at once one at a time, each answered with its own exit and stderr', async () => {
    const own = runner()
    try {
      const run = outside.hookRuns(own.stdout, own.stdin, tmpdir(), 'eval')
      // The first ends last: were both run at once, its answer would go to the second's caller.
      const [slow, quick] = await Promise.all([run('sleep 0.2; echo slow >&2; exit 3', env, ''), run('cat >&2', env, 'quick')])
      expect(slow).toEqual({ code: 3, stderr: 'slow\n' })
      expect(quick).toEqual({ code: 0, stderr: 'quick' })
    } finally {
      own.kill('SIGKILL')
    }
  })

  it('fails a hook its runner ended before, naming whose', async () => {
    const own = runner()
    const run = outside.hookRuns(own.stdout, own.stdin, tmpdir(), "eval's agent")
    own.kill('SIGKILL')
    await expect(run('exit 0', env, '')).rejects.toThrow("eval's agent")
  })
})

describe("tier B's editor windows", () => {
  it("the window's printed lines become stream records: a show with the raise after it folded in, each scrolled line for the active terminal, each page key as a scroll for its shell, each state taken, shells by key", () => {
    const shells: Record<number, string> = { 41_001: 'a', 41_002: 'b' }
    const records: Array<{ at: number; line: Record<string, unknown> }> = []
    const take = editor.windowRecords('eval-w1-1', (pid) => shells[pid], (line, at) => records.push({ at, line }))
    const printed: Array<Record<string, unknown>> = [
      { took: { terminals: [41_001, 41_002], active: 41_001, focused: true } },
      { log: 'state: connected' },
      { state: 'connected' },
      // A tap's show, then its raise.
      { show: 41_002 },
      { raise: true },
      { scroll: 'up' },
      { scroll: 'up' },
      { took: { terminals: [41_001, 41_002], active: 41_002, focused: false } },
      { scroll: 'down' },
      { key: 'up', pid: 41_002 },
      // A rest's show, with no raise, and one of a shell no session of the scenario has.
      { show: 41_001 },
      { show: 41_999 },
    ]
    printed.forEach((line, i) => take(line, 100 + i))
    expect(records).toEqual([
      { at: 100, line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'a', focused: true } },
      { at: 102, line: { type: 'vscode', window: 'eval-w1-1' } },
      { at: 103, line: { show: 'b', raise: true } },
      { at: 105, line: { scroll: 'up', pid: 'a' } },
      { at: 106, line: { scroll: 'up', pid: 'a' } },
      { at: 107, line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'b', focused: false } },
      { at: 108, line: { scroll: 'down', pid: 'b' } },
      // A page key moves a fullscreen Claude Code's view as the scrolled lines move a terminal's.
      { at: 109, line: { scroll: 'up', pid: 'b' } },
      { at: 110, line: { show: 'a' } },
      { at: 111, line: { show: 'other' } },
    ])
  })

  it('a typed line is a typed delivery to the session whose shell it names, at its time; one for a shell no session has goes to none', () => {
    const shells: Record<number, string> = { 41_001: 'a', 41_002: 'b' }
    const deliveries: Array<{ at: number; d: Record<string, unknown> }> = []
    const take = editor.windowTyped((pid) => shells[pid], (d, at) => deliveries.push({ at, d }))
    const printed: Array<Record<string, unknown>> = [
      { typed: 'Eval words for bravo.', pid: 41_002 },
      { show: 41_001 },
      { typed: 'x', pid: 41_999 },
    ]
    printed.forEach((line, i) => take(line, 100 + i))
    expect(deliveries).toEqual([
      { at: 100, d: { path: 'typed', target: 'b', text: 'Eval words for bravo.' } },
      { at: 102, d: { path: 'typed', target: null, text: 'x' } },
    ])
  })
})

describe("tier B's Cursor agents", () => {
  it("Cursor's agent's hook carries engine cursor and no TERM_PROGRAM, cursor-agent's TERM_PROGRAM=vscode", () => {
    // U1: cursor-agent in a terminal (b) and Cursor's own agent (c).
    const u1 = MAIN.find((s) => s.id === 'U1')!
    const codexLine = "'/eval/node' '/eval/hook/notify.mjs' --port 1 --data-dir /eval/data --engine codex"
    const run = (platform: Platform, key: string, event = 'start') => {
      const s = u1.sessions.find((one) => one.key === key)!
      return cursor.hookRun(codexLine, { HOME: '/eval/home' }, editor.editorHints({ platform, scenario: u1 }, s), event,
        { sessionId: s.id, roots: [`/eval/projects/eval-${key}`], transcriptPath: `/eval/${key}.jsonl` })
    }
    const [agent, cli] = [run('darwin', 'c'), run('darwin', 'b')]
    for (const one of [agent, cli]) {
      expect(one.command).toBe("'/eval/node' '/eval/hook/notify.mjs' --port 1 --data-dir /eval/data --engine cursor")
      expect(one.env).toMatchObject({ HOME: '/eval/home', __CFBundleIdentifier: APP_BUNDLES.cursor })
    }
    expect(agent.env).not.toHaveProperty('TERM_PROGRAM')
    expect(cli.env.TERM_PROGRAM).toBe('vscode')
    // On Linux Cursor's agent names no app: the walk finds Cursor above it.
    expect(run('linux', 'c').env).toEqual({ HOME: '/eval/home' })
    // Each event in Cursor's own words, on its conversation and its workspace's folder.
    const c = u1.sessions.find((s) => s.key === 'c')!
    const inputs = ['start', 'turn-start', 'turn-stop', 'end'].map((event) => JSON.parse(run('darwin', 'c', event).input) as Record<string, unknown>)
    expect(inputs.map((input) => input.hook_event_name)).toEqual(['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd'])
    for (const input of inputs) {
      expect(input).toMatchObject({ conversation_id: c.id, workspace_roots: ['/eval/projects/eval-c'], transcript_path: '/eval/c.jsonl' })
    }
    expect(inputs[2]!.status).toBe('completed')
    // A line the daemon did not write for Codex is not Cursor's to run.
    expect(() => cursor.hookRun('/eval/other', {}, {}, 'start', { sessionId: c.id, roots: ['/eval'], transcriptPath: '/eval/c.jsonl' }))
      .toThrow("Codex's hook line")
  })

  it("a multi-root workspace's agent says each of its roots, in order: notify.mjs takes the first for its folder (UH2)", () => {
    const codexLine = "'/eval/node' '/eval/hook/notify.mjs' --port 1 --data-dir /eval/data --engine codex"
    const roots = ['/eval/projects/eval-c1', '/eval/projects/eval-c2']
    const run = cursor.hookRun(codexLine, {}, {}, 'start', { sessionId: 'eval', roots, transcriptPath: '/eval/c.jsonl' })
    expect((JSON.parse(run.input) as Record<string, unknown>).workspace_roots).toEqual(roots)
  })
})

describe("tier B's Cursor agents' processes", () => {
  let root = ''
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  /** A daemon's root, its projects and its home, in a throwaway folder. */
  const daemon = (): CursorDaemon => {
    root = mkdtempSync(join(tmpdir(), 'tier-b-cursor-'))
    return { root, projectsDir: join(root, 'projects'), env: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), PATH: process.env.PATH }, own: () => {} }
  }
  const gone = (pid: number): boolean => {
    try { process.kill(pid, 0) } catch { return true }
    return false
  }
  /** The tab's processes all gone, its command and shell first: the tab itself was killed, not left to see them go. */
  const allGone = async (pids: number[], children: ChildProcess[]): Promise<void> => {
    expect(children.every((child) => child.killed || child.exitCode !== null || child.signalCode !== null)).toBe(true)
    await vi.waitFor(() => { expect(pids.filter((pid) => !gone(pid))).toEqual([]) }, { timeout: 10_000, interval: 20 })
  }
  const ps = (field: string, pid: number): string => execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()
  const start = (d: CursorDaemon, terminal: boolean): Promise<CursorAgent> =>
    cursor.CursorOutside.start(d, 'eval-c', [], { sessionId: 'eval-c', roots: [join(d.projectsDir, 'eval-c')], terminal, hints: {} })

  it("Cursor's own agent is a process of the fake Cursor's, with no terminal", async () => {
    const agent = await start(daemon(), false)
    try {
      expect(ps('tty', agent.pid)).toMatch(/^\?+$/)
      expect(basename(ps('comm', Number(ps('ppid', agent.pid))))).toBe('cursor')
    } finally {
      await agent.close()
    }
  })

  it('a Cursor agent started again in its session goes on in the same transcript, as one Cursor relaunched does', async () => {
    const d = daemon()
    const turn = `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Eval prompt.' }] } })}\n`
    const first = await start(d, true)
    appendFileSync(first.transcriptPath, turn)
    await first.close()
    const again = await start(d, true)
    try {
      expect(readFileSync(again.transcriptPath, 'utf8')).toBe(turn)
    } finally {
      await again.close()
    }
  })

  it("a Codex in an editor's terminal is the driver's to end too, and killed with its tab, its shell and its command at once", async () => {
    const d = daemon()
    const children: ChildProcess[] = []
    const agent = await codex.CodexOutside.inTab(d, 'eval-b', children, {}, {})
    try {
      expect(children).toHaveLength(1)
      agent.killTab()
      await allGone([agent.pid!, agent.shellPid!], children)
    } finally {
      await agent.end()
    }
  })

  it("a Cursor agent killed with its tab: its shell and its command go at once", async () => {
    const children: ChildProcess[] = []
    const d = daemon()
    const agent = await cursor.CursorOutside.start(d, 'eval-a', children, { sessionId: 'eval-a', roots: [join(d.projectsDir, 'eval-a')], terminal: true, hints: {} })
    try {
      agent.killTab()
      await allGone([agent.pid, agent.shellPid!], children)
    } finally {
      await agent.close()
    }
  })
})
