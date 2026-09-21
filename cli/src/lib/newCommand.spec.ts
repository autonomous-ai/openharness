import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { newAgentPayload, newCommand, NewUsageError, parseNewArgs, resolveNewMachine, type NewCommandDeps, type NewSocket } from './newCommand.js'

const env = { cwd: '/work/repo', home: '/home/me' }

describe('harness new: the words', () => {
  it('asks nothing: claude, here, on this machine', () => {
    expect(parseNewArgs([], env)).toEqual({
      agent: 'claude', machine: null, cwd: '/work/repo', projectName: null, mode: 'auto', prompt: null, name: null, json: false,
    })
  })

  it('reads agent, @machine and a folder in any order', () => {
    const typed = parseNewArgs(['codex', '@mini', '~/code/auth'], env)
    expect(typed).toMatchObject({ agent: 'codex', machine: 'mini', cwd: '~/code/auth', projectName: null })
    expect(parseNewArgs(['~/code/auth', '@mini', 'codex'], env)).toEqual(typed)
    // On this machine ~ and relative paths are resolved here, from where it was run.
    expect(parseNewArgs(['codex', '~/code/auth'], env).cwd).toBe('/home/me/code/auth')
    expect(parseNewArgs(['codex', './api'], env).cwd).toBe('/work/repo/api')
    expect(parseNewArgs(['.'], env)).toMatchObject({ agent: 'claude', cwd: '/work/repo' })
  })

  it('takes a second word, or --new, as a new project', () => {
    expect(parseNewArgs(['codex', 'my-game'], env)).toMatchObject({ agent: 'codex', cwd: null, projectName: 'my-game' })
    expect(parseNewArgs(['codex', '--new'], env)).toMatchObject({ cwd: null, projectName: '' })
    expect(parseNewArgs(['--new', 'my game', 'codex'], env)).toMatchObject({ agent: 'codex', projectName: 'my game' })
    // Another machine has no "here": with nothing named it is a new project there.
    expect(parseNewArgs(['codex', '@mini'], env)).toMatchObject({ machine: 'mini', cwd: null, projectName: '' })
  })

  it('takes the task after --, or as --task, with nothing to quote', () => {
    expect(parseNewArgs(['codex', '--', 'fix', 'the', 'flaky', 'login', 'test'], env)).toMatchObject({ agent: 'codex', prompt: 'fix the flaky login test', cwd: '/work/repo' })
    expect(parseNewArgs(['--task', 'write the README'], env).prompt).toBe('write the README')
    // Words after -- are never read as an agent, a machine or a folder.
    expect(parseNewArgs(['--', '@mini', '~/x'], env)).toMatchObject({ agent: 'claude', machine: null, prompt: '@mini ~/x' })
  })

  it('reads a path the shell already expanded as the other machine\'s home', () => {
    // `harness new codex @mini ~/code/auth`, unquoted: zsh hands over /home/me/code/auth.
    expect(parseNewArgs(['codex', '@mini', '/home/me/code/auth'], env).cwd).toBe('~/code/auth')
    expect(parseNewArgs(['codex', '@mini', '/home/me'], env).cwd).toBe('~')
    expect(parseNewArgs(['codex', '@mini', '/srv/app'], env).cwd).toBe('/srv/app')
    // On this machine an absolute path is just that.
    expect(parseNewArgs(['codex', '/home/me/code/auth'], env).cwd).toBe('/home/me/code/auth')
  })

  it('says what is wrong instead of guessing', () => {
    for (const argv of [['a', 'b', 'c'], ['@'], ['@a', '@b'], ['/x', '/y'], ['codex', 'game', '/x'], ['--mode', 'yolo'], ['--prompt'], ['--wat'], ['-x'], ['codex', '..'], ['codex', '@mini', './rel']]) {
      // `codex ..` is a folder, not an error; every other row must throw.
      if (argv.join(' ') === 'codex ..') { expect(parseNewArgs(argv, env).cwd).toBe('/work'); continue }
      expect(() => parseNewArgs(argv, env), argv.join(' ')).toThrow(NewUsageError)
    }
    expect(() => parseNewArgs(['codex', '!!!'], env)).toThrow(/no usable folder name/)
  })

  it('sends what the app sends', () => {
    const here = newAgentPayload(parseNewArgs(['codex', '--plan', '--prompt', 'fix the tests'], env), '/work/repo')
    expect(here).toMatchObject({ engine: 'codex', cwd: '/work/repo', permissionMode: 'plan', bypassPermission: false, prompt: 'fix the tests' })
    expect(here).not.toHaveProperty('projectSource')
    expect(typeof here.creationId).toBe('string')
    const fresh = newAgentPayload(parseNewArgs(['claude', 'My Game'], env), null)
    expect(fresh).toMatchObject({ engine: 'claude', projectSource: 'new', projectName: 'My-Game', permissionMode: 'auto', bypassPermission: true })
    expect(fresh).not.toHaveProperty('cwd')
    expect(newAgentPayload(parseNewArgs(['acme/blender', '.'], env), '/work/repo', 'codex')).toMatchObject({ engine: 'codex', dsh: 'acme/blender' })
  })

  it('finds the machine by id, name or an unambiguous start of one', () => {
    const machines = [
      { machineId: 'm1', label: 'Mac mini', status: 'online', current: false },
      { machineId: 'm2', label: 'MacBook Pro', status: 'online', current: true },
    ]
    expect(resolveNewMachine('m1', machines).label).toBe('Mac mini')
    expect(resolveNewMachine('mac mini', machines).machineId).toBe('m1')
    expect(resolveNewMachine('macb', machines).machineId).toBe('m2')
    expect(() => resolveNewMachine('mac', machines)).toThrow(/could be Mac mini or MacBook Pro/)
    expect(() => resolveNewMachine('linux', machines)).toThrow(/No machine called/)
  })
})

class FakeSocket extends EventEmitter implements NewSocket {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  constructor(private answer: (frame: { type: string; payload: Record<string, unknown> }) => Record<string, unknown> | null) {
    super()
  }
  // Opens once somebody is listening for it, as a real socket opens after it is constructed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'open') queueMicrotask(() => this.emit('open'))
    return this
  }
  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> }
    this.sent.push(frame)
    queueMicrotask(() => {
      if (frame.type === 'machine_select') { this.emit('message', JSON.stringify({ type: 'connected', payload: {} })); return }
      const payload = this.answer(frame)
      if (payload) this.emit('message', JSON.stringify({ type: `${frame.type}_result`, payload: { ...payload, requestId: frame.payload.requestId } }))
    })
  }
  close(): void {}
}

function deps(argv: string[], socket: FakeSocket, over: Partial<NewCommandDeps> = {}): NewCommandDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    argv, cwd: env.cwd, home: env.home, port: 1, localMachineId: 'm2',
    daemonRunning: () => true,
    listMachines: async () => [
      { machineId: 'm1', label: 'Mac mini', status: 'online', current: false },
      { machineId: 'm2', label: 'MacBook Pro', status: 'online', current: true },
    ],
    connect: () => socket,
    output: (line) => out.push(line), error: (line) => err.push(line),
    timeoutMs: 200, out, err, ...over,
  }
}

describe('harness new: the daemon', () => {
  it('selects this machine, creates here and says where', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'agent_create'
      ? { state: 'created', agent: { id: 'a1', name: 'Codex harness 9-19 10:02', cwd: '/work/repo' } } : null)
    const d = deps(['codex'], socket)
    expect(await newCommand(d)).toBe(0)
    expect(socket.sent.map((frame) => frame.type)).toEqual(['machine_select', 'agent_create'])
    expect(socket.sent[0]!.payload).toEqual({ machineId: 'm2', localProtocolVersion: 1 })
    expect(socket.sent[1]!.payload).toMatchObject({ engine: 'codex', cwd: '/work/repo' })
    expect(d.out[0]).toBe('Created Codex harness 9-19 10:02 on this computer in /work/repo.')
  })

  it('asks another machine where its home is before using ~', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'fs_list_dir' ? { path: '/Users/mini', entries: [] }
      : frame.type === 'agent_create' ? { state: 'created', agent: { id: 'a2', name: 'auth' } } : null)
    const d = deps(['codex', '@mini', '~/code/auth', '--json'], socket)
    expect(await newCommand(d)).toBe(0)
    expect(socket.sent[0]!.payload.machineId).toBe('m1')
    expect(socket.sent.map((frame) => frame.type)).toEqual(['machine_select', 'fs_list_dir', 'agent_create'])
    expect(socket.sent[2]!.payload.cwd).toBe('/Users/mini/code/auth')
    expect(JSON.parse(d.out[0]!)).toMatchObject({ ok: true, machineId: 'm1', agent: { id: 'a2' } })
  })

  it('reads a store harness\'s engine off the machine, and will not create one that is not installed', async () => {
    const catalog = [{ id: 'acme/blender', engine: 'codex', installed: true }, { id: 'acme/typst', engine: 'claude', installed: false }]
    const socket = new FakeSocket((frame) => frame.type === 'dsh_list' ? { dsh: catalog }
      : frame.type === 'agent_create' ? { state: 'created', agent: { id: 'a3', name: 'Blender' } } : null)
    expect(await newCommand(deps(['acme/blender'], socket))).toBe(0)
    expect(socket.sent[2]!.payload).toMatchObject({ engine: 'codex', dsh: 'acme/blender' })
    const refused = deps(['acme/typst'], new FakeSocket((frame) => frame.type === 'dsh_list' ? { dsh: catalog } : null))
    expect(await newCommand(refused)).toBe(1)
    expect(refused.err[0]).toBe('Install it first: harness dsh install acme/typst')
  })

  it('turns the machine\'s refusal into words, and a usage slip into the usage', async () => {
    const socket = new FakeSocket((frame) => frame.type === 'agent_create' ? { error: 'INVALID_CWD', detail: '/nope' } : null)
    const d = deps(['codex', '/nope'], socket)
    expect(await newCommand(d)).toBe(1)
    expect(d.err[0]).toBe('That folder does not exist on the machine. (/nope)')
    const help = deps(['--help'], socket)
    expect(await newCommand(help)).toBe(0)
    expect(help.out.join('\n')).toContain('Usage: harness new')
    expect(help.err).toEqual([])
    const slip = deps(['a', 'b', 'c'], socket)
    expect(await newCommand(slip)).toBe(2)
    expect(slip.err.join('\n')).toContain('Usage: harness new')
    const stopped = deps(['codex'], socket, { daemonRunning: () => false })
    expect(await newCommand(stopped)).toBe(1)
    expect(stopped.err[0]).toMatch(/harness start/)
  })
})
