import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { APP_BUNDLES } from '../cable/hosts/hostDetect.js'
import { MAIN } from './dialAppEval/catalog.js'
import type { Platform, Scenario, SessionDef } from './dialAppEval/types.js'

// The dial eval's tier B editor steps, the parts that need no daemon. They are outside tsconfig's rootDir (src), so they
// are loaded untyped, as dialAppEvalTierB.spec.ts loads the harness.
const editor = await import('../../e2e/harness/appEvalEditor.js' as string) as {
  windowRecords(window: string, keyOf: (pid: number) => string | undefined,
    record: (line: Record<string, unknown>, at: number) => void): (printed: Record<string, unknown>, at: number) => void
  hintsOf(world: { platform: Platform; scenario: Scenario }, s: SessionDef): Record<string, string>
}
const cursor = await import('../../e2e/harness/cursorOutside.js' as string) as {
  hookRun(codexLine: string, env: NodeJS.ProcessEnv, hints: Record<string, string>, event: string,
    session: { sessionId: string; roots: string[]; transcriptPath: string }): { command: string; env: NodeJS.ProcessEnv; input: string }
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
})

describe("tier B's Cursor agents", () => {
  it("Cursor's agent's hook carries engine cursor and no TERM_PROGRAM, cursor-agent's TERM_PROGRAM=vscode", () => {
    // U1: cursor-agent in a terminal (b) and Cursor's own agent (c).
    const u1 = MAIN.find((s) => s.id === 'U1')!
    const codexLine = "'/eval/node' '/eval/hook/notify.mjs' --port 1 --data-dir /eval/data --engine codex"
    const run = (platform: Platform, key: string, event = 'start') => {
      const s = u1.sessions.find((one) => one.key === key)!
      return cursor.hookRun(codexLine, { HOME: '/eval/home' }, editor.hintsOf({ platform, scenario: u1 }, s), event,
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
