/**
 * The second look at a stop, and `runStop` as the plugin's Stop hook runs it: the hook's input handed as stdin, the
 * devices' answer injected, Codex's rollout heads (Codex 0.172.0's own first lines, paths cut to /home/person/project)
 * copied into throwaway folders. No listener, engine or home of the person's is touched.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asksOf, codexExecRun, DIAL_STOP_REASON, NUDGE_ANSWER_MS, ROLLOUT_HEAD_MAX_BYTES, runStop, stopOutput, type StopDeps,
} from './stop.js'

const REASON = 'Your answer asks the person something, and they are not at this session. If the task cannot go on without them, run harness device notify now, as the dial skill says, and end your turn. If nothing is needed from them, end your turn.'
const EVALS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'dial-skill')
const SESSION = '3f9c2a10-7d4e-4b8a-9c61-0e5b2d7f8a43'
const ASKING = 'Which database should the export use?'

const cleanup: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stop-'))
  cleanup.push(dir)
  return dir
}

async function* chunks(...parts: string[]): AsyncIterable<string> {
  yield* parts
}

const STOP_INPUT = (fields: Record<string, unknown> = {}) => JSON.stringify({
  session_id: SESSION, transcript_path: '/home/person/.claude/projects/p/s.jsonl', cwd: '/repo', hook_event_name: 'Stop',
  stop_hook_active: false, last_assistant_message: ASKING, ...fields,
})

type Answer = Awaited<ReturnType<StopDeps['ask']>>

/** runStop with every check passing and the devices answering yes, unless [deps] says otherwise; what it printed. */
async function stop(stdin: AsyncIterable<string>, deps: Partial<StopDeps> = {}) {
  const out: string[] = []
  const ask = vi.fn<StopDeps['ask']>(async () => ({ nudge: true }))
  const code = await runStop({
    stdin, dataDir: folder(), engine: 'claude', headless: () => false, acts: () => true, ask,
    out: (line) => { out.push(line) }, ...deps,
  })
  return { code, out, ask: (deps.ask ?? ask) as typeof ask }
}

describe('the block', () => {
  it('the reason is the plan\'s, word for word, one line of printable ASCII with no < or >, naming harness device notify', () => {
    expect(DIAL_STOP_REASON).toBe(REASON)
    expect(DIAL_STOP_REASON).toMatch(/^[\x20-\x7e]+$/)
    expect(DIAL_STOP_REASON).not.toMatch(/[<>]/)
    expect(DIAL_STOP_REASON).toContain('harness device notify')
  })

  it('stopOutput is the block on one line', () => {
    expect(stopOutput()).not.toContain('\n')
    expect(JSON.parse(stopOutput())).toStrictEqual({ decision: 'block', reason: DIAL_STOP_REASON })
  })
})

describe('asksOf', () => {
  const CASES = JSON.parse(readFileSync(join(EVALS, 'test-data', 'stop-inputs.json'), 'utf8')) as { name: string; input: Record<string, unknown>; asks: boolean }[]

  // The eval's fake harness reads the same file, so the two keep one rule.
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(asksOf(c.input)).toBe(c.asks)
  })

  it('no ask carries a word of the answer, in any case of the eval\'s', async () => {
    for (const c of CASES) {
      const { ask } = await stop(chunks(JSON.stringify(c.input)))
      expect(ask.mock.calls.map(([sent]) => sent), c.name).toStrictEqual([{ type: 'nudge', engine: 'claude', sessionId: SESSION, ask: c.asks }])
      const message = c.input.last_assistant_message
      const words = typeof message === 'string' ? message.split(/\s+/).filter((word) => word.length > 3) : []
      for (const word of words) expect(JSON.stringify(ask.mock.calls), c.name).not.toContain(word)
    }
  })
})

describe('runStop', () => {
  it.each(['claude', 'codex'] as const)('%s: prints the block once on a yes, after one ask of the engine, the session and ask true', async (engine) => {
    const { code, out, ask } = await stop(chunks(STOP_INPUT()), { engine })
    expect({ code, out }).toEqual({ code: 0, out: [stopOutput()] })
    expect(ask.mock.calls).toStrictEqual([[{ type: 'nudge', engine, sessionId: SESSION, ask: true }]])
    for (const word of ASKING.split(' ')) expect(JSON.stringify(ask.mock.calls)).not.toContain(word)
  })

  it.each<[string, Record<string, unknown>]>([
    ['stop_hook_active true', { stop_hook_active: true }],
    ['no message', { last_assistant_message: undefined }],
    ['an empty message', { last_assistant_message: '' }],
    ['a message that is not a string', { last_assistant_message: ['Which one?'] }],
    ['no question mark in the tail', { last_assistant_message: `Which one?${'x'.repeat(400)}` }],
  ])('reports every stop past step 1, with ask false and nothing printed: %s', async (_name, fields) => {
    const { code, out, ask } = await stop(chunks(STOP_INPUT(fields)))
    expect({ code, out }).toEqual({ code: 0, out: [] })
    expect(ask.mock.calls).toStrictEqual([[{ type: 'nudge', engine: 'claude', sessionId: SESSION, ask: false }]])
  })

  it.each<[string, (dataDir: string) => { stdin?: AsyncIterable<string>; deps?: Partial<StopDeps> }]>([
    ['a cwd that is the data folder', (dataDir) => ({ stdin: chunks(STOP_INPUT({ cwd: dataDir })) })],
    ['a cwd in the voice router\'s folder', (dataDir) => ({ stdin: chunks(STOP_INPUT({ cwd: join(dataDir, 'voice-route-scratch') })) })],
    ['no cwd', () => ({ stdin: chunks(STOP_INPUT({ cwd: undefined })) })],
    ['no session id', () => ({ stdin: chunks(STOP_INPUT({ session_id: undefined })) })],
    ['a session id with /', () => ({ stdin: chunks(STOP_INPUT({ session_id: '../s' })) })],
    ['a headless run', () => ({ deps: { headless: () => true } })],
    ['the skill not on', () => ({ deps: { acts: () => false } })],
    ['acts throwing', () => ({ deps: { acts: () => { throw new Error('unreadable') } } })],
    ['input that is not JSON', () => ({ stdin: chunks('{"session_id":') })],
    ['input that is a JSON array', () => ({ stdin: chunks(`[${STOP_INPUT()}]`) })],
    ['input over 256 KiB', () => ({ stdin: chunks(STOP_INPUT({ pad: 'x'.repeat(256 * 1024) })) })],
  ])('tells the devices nothing, prints nothing and returns 0: %s', async (_name, arrange) => {
    const dataDir = folder()
    const { stdin, deps } = arrange(dataDir)
    const { code, out, ask } = await stop(stdin ?? chunks(STOP_INPUT()), { dataDir, ...deps })
    expect({ code, out }).toEqual({ code: 0, out: [] })
    expect(ask).not.toHaveBeenCalled()
  })

  it('the order of checks: no headless look before the session id and cwd pass, and no acts for a headless run', async () => {
    const dataDir = folder()
    for (const input of [STOP_INPUT({ session_id: 'a/b' }), STOP_INPUT({ cwd: dataDir })]) {
      const headless = vi.fn(() => false)
      const acts = vi.fn(() => true)
      await stop(chunks(input), { dataDir, headless, acts })
      expect(headless).not.toHaveBeenCalled()
      expect(acts).not.toHaveBeenCalled()
    }
    const acts = vi.fn(() => true)
    await stop(chunks(STOP_INPUT()), { headless: () => true, acts })
    expect(acts).not.toHaveBeenCalled()
  })

  it.each<[string, Answer]>([
    ['{ nudge: false }', { nudge: false }],
    ['{}', {}],
    ['{ nudge: \'yes\' }', { nudge: 'yes' }],
    ['a yes with more in it', { nudge: true, reason: 'r' }],
    ['429', 429],
    ['null', null],
  ])('prints nothing for the answer %s', async (_name, answer) => {
    const { code, out, ask } = await stop(chunks(STOP_INPUT()), { ask: vi.fn<StopDeps['ask']>(async () => answer) })
    expect({ code, out }).toEqual({ code: 0, out: [] })
    expect(ask).toHaveBeenCalledOnce()
  })

  it('an ask that never answers: done within NUDGE_ANSWER_MS, nothing printed', async () => {
    vi.useFakeTimers()
    // As askDevices: its bound aborts a request with no answer, and an aborted request is null.
    const ask = vi.fn<StopDeps['ask']>(() => new Promise((resolve) => {
      const abort = new AbortController()
      abort.signal.addEventListener('abort', () => resolve(null))
      setTimeout(() => abort.abort(), NUDGE_ANSWER_MS)
    }))
    let settled = false
    const run = stop(chunks(STOP_INPUT()), { ask }).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(NUDGE_ANSWER_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    const { code, out } = await run
    expect({ code, out }).toEqual({ code: 0, out: [] })
  })

  it('out throwing still returns 0', async () => {
    const { code } = await stop(chunks(STOP_INPUT()), { out: () => { throw new Error('EPIPE') } })
    expect(code).toBe(0)
  })
})

describe('codexExecRun', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
  const EXEC_HEAD = readFileSync(join(FIXTURES, 'codex-rollout-head-exec.jsonl'), 'utf8')

  /** [name] from the fixtures, copied into a throwaway folder; its path. */
  function copied(name: string): string {
    const path = join(folder(), name)
    copyFileSync(join(FIXTURES, name), path)
    return path
  }

  /** [text] in a throwaway rollout; its path. */
  function rollout(text: string): string {
    const path = join(folder(), 'rollout.jsonl')
    writeFileSync(path, text)
    return path
  }

  /** exec's head with its `source` padded by spaces, so the line before its newline is [bytes] long. */
  function padded(bytes: number): string {
    const line = EXEC_HEAD.trimEnd()
    const pad = ' '.repeat(bytes - Buffer.byteLength(line))
    return `${line.replace('"source":"exec"', `"source":${pad}"exec"`)}\n`
  }

  it('the fixtures are Codex\'s session_meta lines of about 22 KB, one line each, their folders cut to /home/person/project', () => {
    for (const name of ['codex-rollout-head-tui.jsonl', 'codex-rollout-head-exec.jsonl']) {
      const text = readFileSync(join(FIXTURES, name), 'utf8')
      expect(text.indexOf('\n'), name).toBe(text.length - 1)
      expect(Buffer.byteLength(text), name).toBeGreaterThan(20_000)
      const { type, payload } = JSON.parse(text) as { type: string; payload: { cwd: string; runtime_workspace_roots: string[] } }
      expect({ type, cwd: payload.cwd, roots: payload.runtime_workspace_roots }, name)
        .toStrictEqual({ type: 'session_meta', cwd: '/home/person/project', roots: ['/home/person/project'] })
    }
  })

  it('the TUI\'s head is not exec', () => {
    expect(codexExecRun(copied('codex-rollout-head-tui.jsonl'))).toBe(false)
  })

  it('exec\'s head is exec', () => {
    expect(codexExecRun(copied('codex-rollout-head-exec.jsonl'))).toBe(true)
  })

  // Codex run as another agent's MCP tool: nobody is there to ring.
  it('an mcp head is headless', () => {
    expect(codexExecRun(rollout(EXEC_HEAD.replace('"source":"exec"', '"source":"mcp"')))).toBe(true)
  })

  it('exec\'s head with more rollout lines after it is exec', () => {
    const more = '{"type":"event_msg","payload":{"type":"task_started"}}\n'.repeat(4_000)
    expect(codexExecRun(rollout(`${EXEC_HEAD}${more}`))).toBe(true)
  })

  it('exec\'s head whose newline is the last byte read is exec; one byte longer is not', () => {
    expect(codexExecRun(rollout(padded(ROLLOUT_HEAD_MAX_BYTES - 1)))).toBe(true)
    expect(codexExecRun(rollout(padded(ROLLOUT_HEAD_MAX_BYTES)))).toBe(false)
  })

  it.each<[string, () => string]>([
    ['a missing file', () => join(folder(), 'gone.jsonl')],
    ['a folder', () => folder()],
    ['an empty file', () => rollout('')],
    ['a first line that is not JSON', () => rollout(`not json\n${EXEC_HEAD}`)],
    ['a first line with no newline', () => rollout(EXEC_HEAD.trimEnd())],
    ['another type with source exec', () => rollout('{"type":"event_msg","payload":{"source":"exec"}}\n')],
    ['a session_meta with no payload', () => rollout('{"type":"session_meta"}\n')],
  ])('is false for %s', (_name, pathOf) => {
    expect(codexExecRun(pathOf())).toBe(false)
  })

  it.each([undefined, '', 42, null, ['/rollout.jsonl']])('is false for the path %j', (path) => {
    expect(codexExecRun(path)).toBe(false)
  })

  // Opening a FIFO for reading waits for a writer, so a return at all shows it was never opened.
  it.skipIf(process.platform === 'win32')('is false for a FIFO at the path, at once', () => {
    const path = join(folder(), 'rollout.jsonl')
    execFileSync('mkfifo', [path])
    expect(codexExecRun(path)).toBe(false)
  })
})

// The eval runs the variants against a fake harness, so its answer must be this command's output byte for byte.
describe('the eval', () => {
  it.each(['v5', 'v6'])('the eval\'s Part 5 variant %s answers exactly what this command prints', (variant) => {
    const flow = join(EVALS, 'flow', variant)
    const answers = JSON.parse(readFileSync(join(flow, 'harness-answers.json'), 'utf8')) as { argv: string[]; stdout?: string; stop?: boolean }[]
    expect(answers.filter((answer) => answer.argv.join(' ') === 'device claude stop'))
      .toEqual([{ argv: ['device', 'claude', 'stop'], stdout: `${stopOutput()}\n`, stop: true }])
    const hooks = JSON.parse(readFileSync(join(flow, 'hooks.json'), 'utf8')) as Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]>
    expect(hooks.Stop).toStrictEqual([{ hooks: [{ type: 'command', command: 'harness device claude stop', timeout: 5 }] }])
  })
})
