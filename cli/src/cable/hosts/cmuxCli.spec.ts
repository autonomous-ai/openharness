import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { fakeCmux, type FakeCmuxSession, type FakeCmuxState } from '../../testing/fakeCmux.js'
import {
  CMUX_APP_BINARY, cmuxClientDeps, type CmuxClientDeps, cmuxKind, cmuxPaneId, cmuxPaneOf, createCmuxClient,
} from './cmuxCli.js'
import { RUN_TIMEOUT_MS } from './orca.js'

vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, spawn: vi.fn(real.spawn) }
})

// cmux prints its ids in upper case.
const S = '6F1C2B3A-4D5E-4F60-8A1B-2C3D4E5F6A7B'
const W = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'
const S2 = '0B1C2D3E-4F50-4A6B-9C7D-8E9FA0B1C2D3'
const RECORD: FakeCmuxSession = { agent: 'claude', surface_id: S, workspace_id: W, pid: 4242, session_id: 'sess-1' }
const MIB = 1024 * 1024

/** A client on a fake cmux of its own, on macOS, whose deadlines the test fires by hand. */
function setup(over: Partial<CmuxClientDeps> = {}, state?: FakeCmuxState) {
  vi.mocked(spawn).mockClear()
  const fake = fakeCmux()
  onTestFinished(() => fake.remove())
  if (state) fake.set(state)
  const deadlines = new Set<{ ms: number; run: () => void }>()
  const deps: CmuxClientDeps = {
    env: {},
    home: '/nowhere',
    platform: 'darwin',
    onPath: (name) => resolveBinaryOnPath(name, { PATH: fake.dir }),
    realpath: (path) => { try { return realpathSync(path) } catch { return null } },
    exists: () => false,
    after: (ms, run) => {
      const deadline = { ms, run }
      deadlines.add(deadline)
      return () => { deadlines.delete(deadline) }
    },
    ...over,
  }
  const fire = () => { for (const deadline of [...deadlines]) deadline.run() }
  return { fake, cmux: createCmuxClient(deps), deadlines, fire }
}

/** The child the client spawned last, killed when the test ends should the client not have. */
function lastChild(): ChildProcess {
  const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess
  onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  return child
}

async function killed(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  return child.signalCode
}

/** A temp folder, removed when the test ends. */
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'cmux-spec-'))
  onTestFinished(() => rmSync(path, { recursive: true, force: true }))
  return path
}

/** An executable named cmux at `inside`, under `root`, linked from a PATH folder of its own. */
function program(root: string, inside: string): string {
  const file = join(root, inside, 'cmux')
  mkdirSync(join(root, inside), { recursive: true })
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  const path = join(root, `path-${inside.replaceAll('/', '-')}`)
  mkdirSync(path)
  symlinkSync(file, join(path, 'cmux'))
  return path
}

describe.skipIf(process.platform === 'win32')('cmux client (docs/plans/2026-11-17-dial-cmux-design.md)', () => {
  describe('the binary', () => {
    it('a cmux on PATH whose real path ends in /cmux.app/Contents/Resources/bin/cmux is the binary, by its real path', () => {
      const { fake, cmux } = setup()
      expect(cmux.binary()).toBe(realpathSync(fake.binary))
      expect(cmux.binary()).not.toBe(join(fake.dir, 'cmux'))
    })

    it('another program called cmux is not: a plain file, and one in xcmux.app; then the app\'s own binary when it exists, else none', () => {
      const root = folder()
      for (const path of [program(root, 'bin'), program(root, 'xcmux.app/Contents/Resources/bin')]) {
        const onPath = (name: string) => resolveBinaryOnPath(name, { PATH: path })
        expect(onPath('cmux')).not.toBeNull()
        expect(setup({ onPath }).cmux.binary()).toBeNull()
        expect(setup({ onPath, exists: (file) => file === CMUX_APP_BINARY }).cmux.binary()).toBe(CMUX_APP_BINARY)
      }
    })

    it('off macOS there is none, whatever is on PATH', () => {
      for (const platform of ['linux', 'win32'] as const) {
        expect(setup({ platform, exists: () => true }).cmux.binary()).toBeNull()
      }
    })

    it('with no binary every call answers its failure and nothing is spawned', async () => {
      const { fake, cmux } = setup({ onPath: () => null }, { mode: 'automation', sessions: [RECORD] })
      expect(cmux.binary()).toBeNull()
      expect(await cmux.sessions()).toEqual({ ok: false, fault: 'no-binary' })
      expect(await cmux.sessions('claude')).toEqual({ ok: false, fault: 'no-binary' })
      expect(await cmux.mode()).toBeUndefined()
      expect(await cmux.inputState(S)).toBeUndefined()
      expect(await cmux.paste(W, S, 'hello')).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
      expect(fake.calls()).toEqual([])
    })
  })

  it('cmuxKind keeps the ten, maps hermes-agent and antigravity, keeps gemini, and refuses a word out of form', () => {
    for (const word of ['claude', 'codex', 'cursor', 'opencode', 'pi', 'omp', 'muse', 'amp', 'grok', 'copilot']) {
      expect(cmuxKind(word)).toBe(word)
    }
    expect(cmuxKind('hermes-agent')).toBe('hermes')
    expect(cmuxKind('antigravity')).toBe('agy')
    expect(cmuxKind('gemini')).toBe('gemini')
    for (const word of ['Gemini', 'a b', 'a'.repeat(33), 7, undefined]) expect(cmuxKind(word)).toBeUndefined()
  })

  it('cmuxPaneOf takes <workspace>/<surface>, and refuses any other', () => {
    expect(cmuxPaneOf(cmuxPaneId(W, S))).toEqual({ workspace: W, surface: S })
    expect(cmuxPaneOf(`${W.toLowerCase()}/${S.toLowerCase()}`)).toEqual({ workspace: W.toLowerCase(), surface: S.toLowerCase() })
    for (const id of [S, `${W}/--help`, `--help/${S}`, `${W}/${S}/${S}`, `${W}/`, '']) expect(cmuxPaneOf(id)).toBeUndefined()
  })

  describe('sessions', () => {
    it('sessions() is one run of sessions list --json --all, with an empty stdin', async () => {
      const { fake, cmux } = setup({}, { sessions: [{ ...RECORD, agent_lifecycle: 'running', updated_at_unix: 1_700_000_100.5 }] })
      expect(await cmux.sessions()).toEqual({
        ok: true,
        unread: 0,
        sessions: [{
          word: 'claude', kind: 'claude', surface: S, workspace: W, pid: 4242, lifecycle: 'running', updatedAt: 1_700_000_100.5,
          sessionId: 'sess-1', cwd: '/work/api',
        }],
      })
      expect(fake.calls()).toEqual([{ args: ['sessions', 'list', '--json', '--all'], stdin: '', env: [] }])
    })

    it('sessions(\'claude\') adds --agent claude; a word out of form (\'--help\', \'Claude Code\') runs nothing and is failed', async () => {
      const { fake, cmux } = setup({}, { sessions: [RECORD, { ...RECORD, agent: 'codex', surface_id: S2 }] })
      const answer = await cmux.sessions('claude')
      expect(answer.ok && answer.sessions.map((session) => session.word)).toEqual(['claude'])
      expect(await cmux.sessions('--help')).toEqual({ ok: false, fault: 'failed' })
      expect(await cmux.sessions('Claude Code')).toEqual({ ok: false, fault: 'failed' })
      expect(fake.calls().map((call) => call.args)).toEqual([['sessions', 'list', '--json', '--agent', 'claude', '--all']])
    })

    it('it tells only records active for their surface, in form', async () => {
      const { cmux } = setup({}, {
        sessions: [
          RECORD,
          { ...RECORD, active_for_surface: false },
          { ...RECORD, surface_id: '--help' },
          { ...RECORD, workspace_id: `${W}0` },
          { ...RECORD, pid: null },
          { ...RECORD, pid: 0 },
          { ...RECORD, pid: 1.5 },
          { ...RECORD, agent: 'Bad Word' },
        ],
      })
      const answer = await cmux.sessions()
      expect(answer.ok && answer.sessions.map((session) => [session.surface, session.workspace, session.pid])).toEqual([[S, W, 4242]])
    })

    it('a session id out of form, a null cwd and a null lifecycle list the record without them, as unknown; a cwd is cut at 4096', async () => {
      const { cmux } = setup({}, {
        sessions: [
          { ...RECORD, session_id: 'a b', cwd: null, agent_lifecycle: null, updated_at_unix: 2 },
          { ...RECORD, surface_id: S2, session_id: 'x'.repeat(129), cwd: `/${'a'.repeat(5000)}`, agent_lifecycle: 'asleep', updated_at_unix: 1 },
        ],
      })
      const answer = await cmux.sessions()
      if (!answer.ok) throw new Error('no answer')
      const [first, second] = answer.sessions
      expect(first).toEqual({ word: 'claude', kind: 'claude', surface: S, workspace: W, pid: 4242, lifecycle: 'unknown', updatedAt: 2 })
      expect(second.sessionId).toBeUndefined()
      expect(second.lifecycle).toBe('unknown')
      expect(second.cwd).toBe(`/${'a'.repeat(5000)}`.slice(0, 4096))
    })

    it('nothing of transcript_path or launch_arguments is in the answer', async () => {
      const transcript = '/Users/someone/.claude/projects/-work-api/sess-1.jsonl'
      const { cmux } = setup({}, {
        sessions: [{ ...RECORD, more: { transcript_path: transcript, launch_arguments: ['--model', 'their-secret-model'] } }],
      })
      const answer = JSON.stringify(await cmux.sessions())
      expect(answer).toContain(S)
      expect(answer).not.toContain(transcript)
      expect(answer).not.toContain('their-secret-model')
    })

    it('total_matches above what was printed is unread', async () => {
      const { fake, cmux } = setup({}, { sessions: [RECORD, { ...RECORD, surface_id: S2 }], totalMatches: 5 })
      expect(await cmux.sessions()).toMatchObject({ ok: true, unread: 3 })
      fake.set({ sessions: [RECORD], totalMatches: 1 })
      expect(await cmux.sessions()).toMatchObject({ ok: true, unread: 0 })
    })

    it('exit 1 and bytes that are no JSON are failed; one byte past 8 MiB is too-big and the child is killed; no answer by the deadline is timeout and the child is killed', async () => {
      const { fake, cmux, deadlines, fire } = setup()
      fake.set({ fail: { sessions: { exit: 1 } } })
      expect(await cmux.sessions()).toEqual({ ok: false, fault: 'failed' })
      fake.set({ fail: { sessions: { raw: 'not json' } } })
      expect(await cmux.sessions()).toEqual({ ok: false, fault: 'failed' })
      fake.set({ fail: { sessions: { raw: '{"sessions":{}}' } } })
      expect(await cmux.sessions()).toEqual({ ok: false, fault: 'failed' })
      // An answer cancels its deadline.
      expect(deadlines.size).toBe(0)

      fake.set({ fail: { sessions: { flood: 8 * MIB + 1 } } })
      const flooding = cmux.sessions()
      const flood = lastChild()
      expect(await flooding).toEqual({ ok: false, fault: 'too-big' })
      expect(await killed(flood)).toBe('SIGKILL')

      fake.set({ fail: { sessions: 'hold' } })
      const holding = cmux.sessions()
      const held = lastChild()
      expect([...deadlines].map((deadline) => deadline.ms)).toEqual([RUN_TIMEOUT_MS])
      fire()
      expect(await holding).toEqual({ ok: false, fault: 'timeout' })
      expect(await killed(held)).toBe('SIGKILL')
    })

    it('a binary that cannot be executed is failed, and nothing rejects', async () => {
      const { fake, cmux } = setup({ onPath: () => join(fake.dir, 'cmux') }, { mode: 'automation', sessions: [RECORD] })
      chmodSync(fake.binary, 0o644)
      expect(cmux.binary()).toBe(realpathSync(fake.binary))
      expect(await cmux.sessions()).toEqual({ ok: false, fault: 'failed' })
      expect(await cmux.mode()).toBeUndefined()
      expect(await cmux.inputState(S)).toBeUndefined()
      expect(await cmux.paste(W, S, 'hello')).toBe(false)
      expect(fake.calls()).toEqual([])
    })
  })

  it('a run\'s environment has no CMUX_* variable', async () => {
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.stubEnv('CMUX_SOCKET_PATH', '/tmp/cmux-other.sock')
    vi.stubEnv('CMUX_AGENT_HOOK_STATE_DIR', '/tmp/other-store')
    vi.stubEnv('CMUX_BUNDLE_ID', 'com.cmuxterm.app.nightly')
    vi.stubEnv('CMUX_SURFACE_ID', S)
    // The fake tells the variables it was given: with the process's own, it names the four.
    const given = setup({ env: process.env })
    await given.cmux.sessions()
    expect(given.fake.calls()[0].env)
      .toEqual(expect.arrayContaining(['CMUX_AGENT_HOOK_STATE_DIR', 'CMUX_BUNDLE_ID', 'CMUX_SOCKET_PATH', 'CMUX_SURFACE_ID']))

    const { env } = cmuxClientDeps()
    expect(Object.keys(env).filter((name) => name.startsWith('CMUX_'))).toEqual([])
    expect(env.HOME).toBe(process.env.HOME)
    const own = setup({ env })
    await own.cmux.sessions()
    expect(own.fake.calls().map((call) => call.env)).toEqual([[]])
  })

  it('mode() tells effective_mode; a failed run, bytes that are no JSON, or a value that is no word, is none', async () => {
    const { fake, cmux } = setup()
    expect(await cmux.mode()).toBe('cmuxOnly')
    fake.set({ mode: 'automation' })
    expect(await cmux.mode()).toBe('automation')
    expect(fake.calls()).toEqual([
      { args: ['socket-status', '--json'], stdin: '', env: [] },
      { args: ['socket-status', '--json'], stdin: '', env: [] },
    ])
    for (const fault of [{ exit: 1 }, { raw: 'Socket control mode: automation.' }, { raw: '{"effective_mode":"auto mation"}' },
      { raw: '{"effective_mode":7}' }, { raw: '{"effective_mode":""}' }, { raw: '["automation"]' }]) {
      fake.set({ mode: 'automation', fail: { 'socket-status': fault } })
      expect(await cmux.mode()).toBeUndefined()
    }
  })

  it('inputState() is one rpc with the surface id as JSON, and tells the five fields; a surface out of form runs nothing; a refused socket, or a field of another type, is none', async () => {
    const { fake, cmux } = setup({}, { mode: 'automation', input: { [S]: { lifecycle: 'running', state: 'draft' } } })
    expect(await cmux.inputState(S)).toEqual({ terminal: true, agent: true, lifecycle: 'running', state: 'draft', blocksTyping: true })
    expect(fake.calls()).toEqual([{ args: ['--json', 'rpc', 'surface.input_state', JSON.stringify({ surface_id: S })], stdin: '', env: [] }])
    expect(await cmux.inputState(S2)).toEqual({ terminal: true, agent: true, lifecycle: 'idle', state: 'empty', blocksTyping: false })

    expect(await cmux.inputState('--help')).toBeUndefined()
    expect(await cmux.inputState(`${S}"}`)).toBeUndefined()
    expect(fake.calls()).toHaveLength(2)

    fake.set({ mode: 'cmuxOnly' })
    expect(await cmux.inputState(S)).toBeUndefined()
    const fields = { terminal: true, agent: true, lifecycle: 'idle', state: 'empty', blocks_typing: false }
    for (const raw of [{ ...fields, terminal: 'yes' }, { ...fields, agent: 1 }, { ...fields, lifecycle: null },
      { ...fields, state: 3 }, { ...fields, blocks_typing: 'false' }, { terminal: true }]) {
      fake.set({ mode: 'automation', fail: { rpc: { raw: JSON.stringify(raw) } } })
      expect(await cmux.inputState(S)).toBeUndefined()
    }
  })

  it('paste() puts the text on stdin and in no argument, with --workspace, --surface, --submit and -; true only on exit 0 and submitted: true', async () => {
    const text = 'Fix the login test'
    const { fake, cmux, fire } = setup({}, { mode: 'automation' })
    expect(await cmux.paste(W, S, text)).toBe(true)
    expect(fake.calls()).toEqual([
      { args: ['--json', 'paste', '--workspace', W, '--surface', S, '--submit', '-'], stdin: text, env: [] },
    ])

    fake.set({ mode: 'automation', submitted: false })
    expect(await cmux.paste(W, S, text)).toBe(false)
    fake.set({ mode: 'automation', fail: { paste: { exit: 1 } } })
    expect(await cmux.paste(W, S, text)).toBe(false)
    fake.set({ mode: 'cmuxOnly' })
    expect(await cmux.paste(W, S, text)).toBe(false)
    // cmux's own Draft guard refuses, and the client never passes --force to get past it.
    fake.set({ mode: 'automation', input: { [S]: { state: 'draft' } } })
    expect(await cmux.paste(W, S, text)).toBe(false)
    expect(await cmux.paste('--help', S, text)).toBe(false)
    expect(await cmux.paste(W, `${S}/x`, text)).toBe(false)

    const calls = fake.calls()
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(call.args).not.toContain('--force')
      expect(call.args.join(' ')).not.toContain(text)
    }

    fake.set({ mode: 'automation', fail: { paste: 'hold' } })
    const pasting = cmux.paste(W, S, text)
    const held = lastChild()
    fire()
    expect(await pasting).toBe(false)
    expect(await killed(held)).toBe('SIGKILL')
  })
})
