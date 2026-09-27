/**
 * `harness pair <verb>` and its loopback request (pair/client.ts), against a scripted socket: never a real
 * daemon, never a real port. What is pinned: a request settles exactly once whatever the socket does
 * (answer, error, close, silence), a reply for another request is never taken as ours, every verb's words
 * become the payload the daemon expects (or a usage error), and the person-only lesson actions ask the
 * person and carry the daemon's nonce — never a nonce this side made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pairCommand, pairRequest, parsePairArgs, PairUsageError, PAIR_USAGE, type PairCommandDeps, type PairSocket } from './client.js'

type Json = Record<string, unknown>

/**
 * A socket whose daemon side is a script: `onSend` sees each frame this side sends and may answer with
 * `emit`. `open` fires on the first listener registration unless `silent`.
 */
function scripted(onSend: (frame: { type: string; payload: Json }, s: ReturnType<typeof control>) => void, opts: { silent?: boolean; closeThrows?: boolean } = {}) {
  const sockets: Array<ReturnType<typeof control>> = []
  function control() {
    const handlers: Record<string, (...args: never[]) => void> = {}
    const sent: Array<{ type: string; payload: Json }> = []
    let closes = 0
    const c = {
      handlers, sent,
      get closes() { return closes },
      emit: (frame: unknown) => (handlers.message as (d: { toString(): string }) => void)({ toString: () => typeof frame === 'string' ? frame : JSON.stringify(frame) }),
      error: (err: Error) => (handlers.error as (e: Error) => void)(err),
      close: (code: number, reason: string) => (handlers.close as (c: number, r: { toString(): string }) => void)(code, { toString: () => reason }),
      socket: {
        send: (data: string) => { const frame = JSON.parse(data) as { type: string; payload: Json }; sent.push(frame); onSend(frame, c) },
        close: () => { closes++; if (opts.closeThrows) throw new Error('already closed') },
        on: ((event: string, listener: (...args: never[]) => void) => {
          handlers[event] = listener
          if (event === 'open' && !opts.silent) queueMicrotask(() => listener())
        }) as PairSocket['on'],
      } as PairSocket,
    }
    return c
  }
  const connect = vi.fn((_url: string): PairSocket => { const c = control(); sockets.push(c); return c.socket })
  return { connect, sockets }
}

/** The ordinary daemon: connected on select, and `reply(payload)` to each pair request. */
function daemon(reply: (payload: Json) => Json) {
  return scripted((frame, s) => {
    if (frame.type === 'machine_select') queueMicrotask(() => s.emit({ type: 'connected', payload: {} }))
    if (frame.type === 'pair') queueMicrotask(() => s.emit({ type: 'pair_result', payload: { requestId: frame.payload.requestId, ...reply(frame.payload) } }))
  })
}

const base = (connect: (url: string) => PairSocket, over: Partial<PairCommandDeps> = {}): PairCommandDeps & { out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return { port: 4242, machineId: async () => 'machine-a', connect, env: {}, output: (l) => out.push(l), error: (l) => err.push(l), out, err, ...over }
}

let dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('pairRequest: one request, settled once', () => {
  it('dials the loopback port it is given, and takes only the reply to its own requestId', async () => {
    const d = scripted((frame, s) => {
      if (frame.type === 'machine_select') queueMicrotask(() => s.emit({ type: 'connected', payload: {} }))
      if (frame.type === 'pair') queueMicrotask(() => {
        s.emit('not json {')
        s.emit({ type: 'pair_result', payload: { requestId: 'someone-else', ok: false, error: 'NOT_YOURS' } })
        s.emit({ type: 'pair_result' })
        s.emit({ type: 'daemon_say', payload: { requestId: frame.payload.requestId } })
        s.emit({ type: 'pair_result', payload: { requestId: frame.payload.requestId, ok: true, n: 1 } })
        s.emit({ type: 'pair_result', payload: { requestId: frame.payload.requestId, ok: true, n: 2 } })
      })
    })
    const reply = await pairRequest(base(d.connect), { verb: 'status' })
    expect(reply).toEqual({ ok: true, n: 1 })
    expect(d.connect).toHaveBeenCalledWith('ws://127.0.0.1:4242/api/local-ws')
    expect(d.sockets[0].closes).toBe(1)
  })

  it('an error rejects with it; a close after it changes nothing and closes once', async () => {
    const d = scripted((frame, s) => {
      if (frame.type === 'machine_select') queueMicrotask(() => { s.error(new Error('ECONNREFUSED')); s.close(1006, '') })
    })
    await expect(pairRequest(base(d.connect), { verb: 'status' })).rejects.toThrow('ECONNREFUSED')
    expect(d.sockets[0].closes).toBe(1)
  })

  it('a close says its code, and its reason when there is one', async () => {
    const plain = scripted((frame, s) => { if (frame.type === 'machine_select') queueMicrotask(() => s.close(1006, '')) })
    await expect(pairRequest(base(plain.connect), { verb: 'status' })).rejects.toThrow('The connection to Harness closed (1006).')
    const why = scripted((frame, s) => { if (frame.type === 'machine_select') queueMicrotask(() => s.close(4403, 'not a local client')) })
    await expect(pairRequest(base(why.connect), { verb: 'status' })).rejects.toThrow('The connection to Harness closed (4403: not a local client).')
  })

  it('a daemon that never answers times out (the default is a minute); a close that throws is swallowed', async () => {
    vi.useFakeTimers()
    const silent = scripted(() => {}, { silent: true, closeThrows: true })
    const pending = pairRequest(base(silent.connect, { timeoutMs: 500 }), { verb: 'status' })
    const check = expect(pending).rejects.toThrow('Harness did not answer in time.')
    await vi.advanceTimersByTimeAsync(500)
    await check
    expect(silent.sockets[0].closes).toBe(1)

    const slow = scripted(() => {}, { silent: true })
    const defaulted = pairRequest(base(slow.connect), { verb: 'status' })
    let settled = false
    defaulted.catch(() => { settled = true })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(defaulted).rejects.toThrow('did not answer in time')
  })

  it('a machine id that cannot be resolved never dials', async () => {
    const d = daemon(() => ({ ok: true }))
    await expect(pairRequest(base(d.connect, { machineId: async () => null }), { verb: 'status' })).rejects.toThrow('harness start')
    expect(d.connect).not.toHaveBeenCalled()
  })
})

describe('parsePairArgs: words to the payload', () => {
  it('reads with no arguments, and list_harnesses with or without a machine', () => {
    for (const verb of ['status', 'list_machines', 'journal']) expect(parsePairArgs(verb, ['--machine', 'mb']).payload).toEqual({ verb })
    expect(parsePairArgs('list_harnesses', []).payload).toEqual({ verb: 'list_harnesses' })
    expect(parsePairArgs('list_harnesses', ['--machine=mb']).payload).toEqual({ verb: 'list_harnesses', machineId: 'mb' })
  })

  it('one-harness verbs need an agent id', () => {
    for (const verb of ['read_harness', 'stop_turn', 'pause_harness', 'resume_harness']) {
      expect(parsePairArgs(verb, ['api', '--machine', 'mb']).payload).toEqual({ verb, agentId: 'api', machineId: 'mb' })
      expect(() => parsePairArgs(verb, [])).toThrow(`${verb} needs an agent id.`)
    }
  })

  it('brief takes minutes, or nothing; anything else is a usage error', () => {
    expect(parsePairArgs('brief', []).payload).toEqual({ verb: 'brief' })
    expect(parsePairArgs('brief', ['--since=0']).payload).toEqual({ verb: 'brief', sinceMinutes: 0 })
    expect(() => parsePairArgs('brief', ['--since', 'yesterday'])).toThrow('--since takes minutes.')
  })

  it('answer_question needs three words; the choice keeps the rest, the tail included', () => {
    expect(() => parsePairArgs('answer_question', ['api', 'q1'])).toThrow("answer_question needs an agent id, the question's requestId and a choice.")
    expect(parsePairArgs('answer_question', ['api', 'q1', 'Yes', '--', '--json']).payload)
      .toEqual({ verb: 'answer_question', agentId: 'api', requestId: 'q1', choice: 'Yes --json' })
  })

  it('send_prompt needs an agent id and text; the text may come after --', () => {
    expect(() => parsePairArgs('send_prompt', [])).toThrow('send_prompt needs an agent id.')
    expect(() => parsePairArgs('send_prompt', ['api', '--'])).toThrow('send_prompt needs the text to send.')
    expect(parsePairArgs('send_prompt', ['api', '--', 'run', '--the', 'tests']).payload).toEqual({ verb: 'send_prompt', agentId: 'api', text: 'run --the tests' })
  })

  it('start_harness: engine and folder, an optional name and prompt (--prompt wins over the tail)', () => {
    expect(() => parsePairArgs('start_harness', ['codex'])).toThrow('start_harness needs an engine and a folder.')
    expect(parsePairArgs('start_harness', ['codex', '/w/api']).payload).toEqual({ verb: 'start_harness', engine: 'codex', cwd: '/w/api' })
    expect(parsePairArgs('start_harness', ['codex', '/w/api', '--prompt', 'fix it', '--machine', 'mb', 'ignored']).payload)
      .toEqual({ verb: 'start_harness', engine: 'codex', cwd: '/w/api', prompt: 'fix it', machineId: 'mb' })
    expect(parsePairArgs('start_harness', ['codex', '/w/api', 'add', 'tests']).payload.prompt).toBe('add tests')
  })

  it('say needs words; --json anywhere is the output switch, not a word', () => {
    expect(() => parsePairArgs('say', [])).toThrow('say needs words.')
    expect(parsePairArgs('say', ['hello', '--json', 'there'])).toEqual({ payload: { verb: 'say', line: 'hello there' }, json: true })
    // --create and --dry-run belong to lessons: anywhere else they are words.
    expect(parsePairArgs('say', ['--create', '--dry-run']).payload).toEqual({ verb: 'say', line: '--create --dry-run' })
  })

  it('lessons: an unknown action, a missing id; --create only on approve, --dry-run only on export, no id on export', () => {
    expect(() => parsePairArgs('lessons', ['teach'])).toThrow('lessons has no "teach" (list, show, approve, skip, revert, restore, export).')
    expect(() => parsePairArgs('lessons', ['show'])).toThrow('lessons show needs a lesson id (harness pair lessons list).')
    expect(parsePairArgs('lessons', ['show', 'beef01', '--create', '--dry-run']).payload).toEqual({ verb: 'lessons', action: 'show', id: 'beef01' })
    expect(parsePairArgs('lessons', ['export', 'beef01']).payload).toEqual({ verb: 'lessons', action: 'export' })
  })

  it('a flag with no value is a usage error; --token-file rides along for the command to take off', () => {
    for (const flag of ['--machine', '--name', '--prompt', '--token-file']) {
      expect(() => parsePairArgs('status', [flag])).toThrow(PairUsageError)
    }
    expect(parsePairArgs('stop_turn', ['api', '--token-file', '/tmp/t']).payload).toEqual({ verb: 'stop_turn', agentId: 'api', tokenFile: '/tmp/t' })
  })

  it('a verb the switch does not know (mcp is dispatched before this) is a usage error', () => {
    expect(() => parsePairArgs('mcp', [])).toThrow('pair has no verb "mcp".')
  })
})

describe('pairCommand', () => {
  it('prints the usage: 0 for --help on a verb, 2 for no verb or an unknown one', async () => {
    const d = daemon(() => ({ ok: true }))
    const help = base(d.connect)
    expect(await pairCommand(['status', '--help'], help)).toBe(0)
    expect(await pairCommand(['status', '-h'], help)).toBe(0)
    expect(await pairCommand([], help)).toBe(2)
    expect(await pairCommand(['reboot'], help)).toBe(2)
    expect(help.out).toEqual([PAIR_USAGE, PAIR_USAGE, PAIR_USAGE, PAIR_USAGE])
    expect(d.connect).not.toHaveBeenCalled()
  })

  it('a usage error prints why and the usage to stderr, and asks nothing', async () => {
    const d = daemon(() => ({ ok: true }))
    const deps = base(d.connect)
    expect(await pairCommand(['stop-turn'], deps)).toBe(2)
    expect(deps.err).toEqual(['stop_turn needs an agent id.', '', PAIR_USAGE])
    expect(d.connect).not.toHaveBeenCalled()
  })

  it('prints indented by default; --token-file is read for the token and never sent as a field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-client-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'token'), 'from-flag\n')
    const seen: Json[] = []
    const d = daemon((p) => { seen.push(p); return { ok: true, n: 1 } })
    const deps = base(d.connect)
    expect(await pairCommand(['stop_turn', 'api', '--token-file', join(dir, 'token')], deps)).toBe(0)
    expect(deps.out).toEqual([JSON.stringify({ ok: true, n: 1 }, null, 2)])
    expect(seen[0]).toMatchObject({ verb: 'stop_turn', agentId: 'api', token: 'from-flag' })
    expect(seen[0]).not.toHaveProperty('tokenFile')
  })

  it('a daemon it cannot reach: the message as it is, or UNREACHABLE in JSON; a non-Error is said too', async () => {
    const d = daemon(() => ({ ok: true }))
    const deps = base(d.connect, { machineId: async () => null })
    expect(await pairCommand(['status'], deps)).toBe(1)
    expect(deps.out.pop()).toContain('Harness is not running')
    expect(await pairCommand(['status', '--json'], deps)).toBe(1)
    expect(JSON.parse(deps.out.pop()!)).toMatchObject({ ok: false, error: 'UNREACHABLE', detail: expect.stringContaining('not running') })
    const weird = base(() => { throw 'socket factory broke' })
    expect(await pairCommand(['status'], weird)).toBe(1)
    expect(weird.out).toEqual(['socket factory broke'])
  })

  it('export --dry-run is a read: no challenge, no question', async () => {
    const seen: Json[] = []
    const d = daemon((p) => { seen.push(p); return { ok: true, plan: [] } })
    const confirm = vi.fn(async () => true)
    expect(await pairCommand(['lessons', 'export', '--dry-run'], base(d.connect, { confirm }))).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(seen.map(({ requestId: _r, ...p }) => p)).toEqual([{ verb: 'lessons', action: 'export', dryRun: true }])
  })
})

describe('pairCommand: the person-only lesson actions', () => {
  function lessonDaemon(challenge: Json, final: Json = { ok: true }) {
    const seen: Json[] = []
    const d = daemon((p) => { seen.push(p); return p.action === 'challenge' ? challenge : final })
    return { ...d, seen }
  }

  it('restore asks its own question; export asks about the plan it was shown (not text: shown as JSON, nonce kept out)', async () => {
    const nonce = 'cd'.repeat(16)
    const r = lessonDaemon({ ok: true, nonce, expiresInMs: 60_000, text: 'the skill as it was' })
    const asked: string[] = []
    const deps = base(r.connect, { confirm: async (q) => { asked.push(q); return true } })
    expect(await pairCommand(['lessons', 'restore', 'beef01'], deps)).toBe(0)
    expect(asked).toEqual(['Restore lesson beef01? [y/N] '])
    expect(deps.err).toEqual(['the skill as it was'])
    expect(r.seen.map(({ requestId: _r, ...p }) => p)).toEqual([
      { verb: 'lessons', action: 'challenge', for: 'restore', id: 'beef01' },
      { verb: 'lessons', action: 'restore', id: 'beef01', nonce },
    ])

    const e = lessonDaemon({ ok: true, nonce, expiresInMs: 60_000, plan: [{ to: '/w/.claude/skills/x' }] }, { ok: false, error: 'STALE_PLAN' })
    const deps2 = base(e.connect, { confirm: async (q) => { asked.push(q); return true } })
    expect(await pairCommand(['lessons', 'export', '--json'], deps2)).toBe(1)
    expect(asked.at(-1)).toBe('Export as shown? [y/N] ')
    expect(deps2.err).toEqual([JSON.stringify({ ok: true, plan: [{ to: '/w/.claude/skills/x' }] }, null, 2)])
    expect(deps2.err[0]).not.toContain(nonce)
    expect(deps2.out).toEqual(['{"ok":false,"error":"STALE_PLAN"}'])
    expect(e.seen.map(({ requestId: _r, ...p }) => p)[0]).toEqual({ verb: 'lessons', action: 'challenge', for: 'export' })
  })

  it('a refused challenge, or one without a nonce, is printed and nothing is asked or done', async () => {
    for (const challenge of [{ ok: false, error: 'NOT_PENDING' }, { ok: true, text: 'no nonce here' }, { ok: true, nonce: 42 }]) {
      const r = lessonDaemon(challenge)
      const confirm = vi.fn(async () => true)
      const deps = base(r.connect, { confirm })
      expect(await pairCommand(['lessons', 'approve', 'beef01', '--json'], deps)).toBe(1)
      expect(deps.out).toEqual([JSON.stringify(challenge)])
      expect(confirm).not.toHaveBeenCalled()
      expect(r.seen).toHaveLength(1)
    }
  })

  it('a pane-session lookup that fails is treated as "not in a pane" (the daemon checks again)', async () => {
    const r = lessonDaemon({ ok: true, nonce: 'ef'.repeat(16), text: 'x' })
    const deps = base(r.connect, { confirm: async () => true, paneSession: async () => { throw new Error('no tmux') } })
    expect(await pairCommand(['lessons', 'approve', 'beef01'], deps)).toBe(0)
    expect(deps.out).toEqual([JSON.stringify({ ok: true }, null, 2)])
  })

  it('any harness pane variable refuses, the token among them, before the daemon is asked', async () => {
    for (const name of ['HARNESSD_PAIR_TOKEN', 'HARNESSD_PAIR_TOKEN_FILE', 'HARNESS_DSH', 'HARNESS_SKILLS_DIR', 'HARNESS_WORKSPACE']) {
      const r = lessonDaemon({ ok: true, nonce: 'ab'.repeat(16) })
      const deps = base(r.connect, { confirm: async () => true, env: { [name]: 'x' } })
      expect(await pairCommand(['lessons', 'restore', 'beef01', '--json'], deps)).toBe(1)
      expect(JSON.parse(deps.out[0]!)).toMatchObject({ ok: false, error: 'INSIDE_HARNESS', detail: expect.stringContaining(`${name} is set`) })
      expect(r.connect).not.toHaveBeenCalled()
    }
    // An empty variable is not a sign.
    const r = lessonDaemon({ ok: true, nonce: 'ab'.repeat(16) })
    expect(await pairCommand(['lessons', 'restore', 'beef01'], base(r.connect, { confirm: async () => true, env: { HARNESS_DSH: '' } }))).toBe(0)
  })
})
