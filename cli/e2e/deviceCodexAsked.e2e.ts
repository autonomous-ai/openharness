/**
 * The dial shows a Codex session waiting outside Harness's panes (docs/plans/2026-11-26-needs-you-right-design.md, Part 7),
 * on the real daemon: the session's own hooks (harness/codexOutside.ts) list it and start its turns, and the real
 * `harness device codex asked` runs as the plugin's Codex hooks run it (hooks/codex.json), with Codex's hook input on
 * stdin and the turn's own setting in its rollout. The fake engine runs no plugin's hooks, so the test runs the command
 * itself, as deviceClaudeOrca.e2e.ts runs `device claude asked`. A fake dial on the desk shows what it is shown:
 * - a permission ask the person reviews waits with "<command> · answer in Ghostty" and asks once; its Stop ends the wait;
 * - one Codex's automatic review takes shows nothing;
 * - a question in Plan mode shows its first question; one in Default mode nothing;
 * - a session no hook listed (one in a Harness pane, whose agent is Harness's) shows nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CodexOutside } from './harness/codexOutside.js'
import { IsolatedDaemon, sourcesCli } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'

/** The run's bundle when there is one (E2E_BUNDLE), as the daemon runs; else tsx and the sources by their paths, which
 *  resolve from the session's folder. */
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : sourcesCli()
/** A turn_context line Codex 0.172.0 wrote (the fixture's line 6): each ask's turn is a copy of it with its own setting. */
const TURN_CONTEXT = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'deviceClaude', '__fixtures__',
  'codex-turn-context.jsonl'), 'utf8').trim().split('\n')[5]!) as { payload: Record<string, unknown> & { collaboration_mode: Record<string, unknown> } }
const SHOWN = '[observed] waiting prompt · shown'

interface Turn { reviewer: 'user' | 'auto_review'; mode: 'default' | 'plan' }

describe('the dial shows a Codex session waiting outside Harness', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon of its own, a dial on the desk shown its first list, and a Codex in Ghostty listed on it, its turn started. */
  const fresh = async (): Promise<{ d: IsolatedDaemon; dial: FakeDial; codex: CodexOutside }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const codex = new CodexOutside(d, 'api', children, { TERM_PROGRAM: 'ghostty' })
    await codex.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'agent' && m.id === codex.id, 45_000, 'the agent listed')
    const since = dial.messages.length
    await codex.hook('UserPromptSubmit', { prompt: 'work on it' })
    await dial.next((m) => m.t === 'turn.started' && m.agentId === codex.id, 45_000, 'its turn started', since)
    return { d, dial, codex }
  }

  /** A new turn of [turn]'s setting in [codex]'s rollout, then the real `device codex asked` for [event] in it, as the
   *  plugin's hook runs it: under the session's environment, Codex's hook input on stdin. */
  const asked = async (codex: CodexOutside, turn: Turn, event: 'PermissionRequest' | 'PreToolUse', tool: string,
    toolInput: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number | null }> => {
    const turnId = randomUUID()
    const line = { ...TURN_CONTEXT, payload: { ...TURN_CONTEXT.payload, turn_id: turnId, root_turn_id: turnId,
      approvals_reviewer: turn.reviewer, collaboration_mode: { ...TURN_CONTEXT.payload.collaboration_mode, mode: turn.mode } } }
    appendFileSync(codex.transcriptPath, `${JSON.stringify(line)}\n`)
    const input = { session_id: codex.sessionId, turn_id: turnId, transcript_path: codex.transcriptPath, cwd: codex.cwd,
      hook_event_name: event, model: 'probe-model', permission_mode: 'default', tool_name: tool, tool_input: toolInput,
      ...(event === 'PreToolUse' ? { tool_use_id: `call_${randomUUID()}` } : {}) }
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', 'codex', 'asked'], { cwd: codex.cwd, env: codex.env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
    child.stdin!.end(JSON.stringify(input))
    return { stdout, stderr, code: await exited }
  }
  const quiet = { stdout: '', stderr: '', code: 0 }
  const USER: Turn = { reviewer: 'user', mode: 'default' }

  /** The dial told the agent's line is [text], from [since]. */
  const line = (dial: FakeDial, agentId: string, text: string, what: string, since = 0): Promise<DialMessage> =>
    dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === agentId && m.text === text, 45_000, what, since)
  const questions = (dial: FakeDial, agentId: string): DialMessage[] => dial.messages.filter((m) => m.t === 'question' && m.agentId === agentId)
  const shownLogged = (d: IsolatedDaemon): number => d.log().split('\n').filter((entry) => entry.endsWith(SHOWN)).length

  it('a user-reviewed escalation shows "touch /tmp/probe · answer in Ghostty", asks once, and its Stop ends the wait', async () => {
    const { d, dial, codex } = await fresh()
    const since = dial.messages.length
    expect(await asked(codex, USER, 'PermissionRequest', 'Bash', { command: 'touch /tmp/probe', description: 'Make the probe' })).toEqual(quiet)
    await line(dial, codex.id, 'touch /tmp/probe · answer in Ghostty', 'the waiting line', since)
    const question = await dial.next((m) => m.t === 'question' && m.agentId === codex.id, 45_000, 'the question', since)
    expect(question.questions).toEqual([{ key: '', q: 'touch /tmp/probe · answer in Ghostty', options: [] }])

    // Answered in Ghostty, the turn goes to its end: the session's Stop.
    const answered = dial.messages.length
    await codex.hook('Stop', { stop_hook_active: false })
    await dial.next((m) => m.t === 'question.close' && m.agentId === codex.id && m.id === question.id, 45_000, 'the question closed', answered)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === codex.id, 45_000, 'its turn done', answered)
    expect(questions(dial, codex.id)).toHaveLength(1)
    expect(shownLogged(d)).toBe(1)
    // The command's description never left the hook.
    expect(JSON.stringify(dial.messages)).not.toContain('Make the probe')
  })

  it('an auto_review escalation shows nothing', async () => {
    const { d, dial, codex } = await fresh()
    const since = dial.messages.length
    expect(await asked(codex, { reviewer: 'auto_review', mode: 'default' }, 'PermissionRequest', 'Bash', { command: 'rm -rf build' })).toEqual(quiet)
    // The anchor: a user-reviewed one after it, so the first would have reached the dial by now.
    expect(await asked(codex, USER, 'PermissionRequest', 'Bash', { command: 'touch /tmp/probe' })).toEqual(quiet)
    await line(dial, codex.id, 'touch /tmp/probe · answer in Ghostty', 'the waiting line', since)
    expect(JSON.stringify(dial.messages)).not.toContain('rm -rf build')
    expect(questions(dial, codex.id)).toHaveLength(1)
    expect(shownLogged(d)).toBe(1)
  })

  it('a question in Plan mode shows its first question and asks once; in Default mode nothing', async () => {
    const { d, dial, codex } = await fresh()
    const since = dial.messages.length
    const ask = (question: string) => ({ questions: [{ id: 'q1', header: 'Probe', question, options: [{ label: 'Red', description: 'Warm' }] },
      { id: 'q2', header: 'Second', question: 'Which size?', options: [{ label: 'Small', description: 'Fits' }] }] })
    expect(await asked(codex, { reviewer: 'user', mode: 'default' }, 'PreToolUse', 'request_user_input', ask('Which shape?'))).toEqual(quiet)
    expect(await asked(codex, { reviewer: 'user', mode: 'plan' }, 'PreToolUse', 'request_user_input', ask('Which color?'))).toEqual(quiet)
    await line(dial, codex.id, 'Which color? · answer in Ghostty', 'the waiting line', since)
    const shown = JSON.stringify(dial.messages)
    for (const absent of ['Which shape?', 'Which size?', 'Warm', 'Fits']) expect(shown).not.toContain(absent)
    expect(questions(dial, codex.id)).toHaveLength(1)
    expect(shownLogged(d)).toBe(1)
  })

  it('a session no hook listed (one in a Harness pane) shows nothing', async () => {
    const { d, dial, codex } = await fresh()
    const since = dial.messages.length
    // Its rollout in the same Codex home, but no hook of its own ever ran: the observed source holds no such session.
    const unlisted = new CodexOutside(d, 'in-pane', children, { TERM_PROGRAM: 'ghostty' })
    expect(await asked(unlisted, USER, 'PermissionRequest', 'Bash', { command: 'rm -rf build' })).toEqual(quiet)
    expect(await asked(codex, USER, 'PermissionRequest', 'Bash', { command: 'touch /tmp/probe' })).toEqual(quiet)
    await line(dial, codex.id, 'touch /tmp/probe · answer in Ghostty', 'the waiting line', since)
    const shown = JSON.stringify(dial.messages)
    expect(shown).not.toContain(unlisted.id)
    expect(shown).not.toContain('rm -rf build')
    expect(shownLogged(d)).toBe(1)
  })
})
