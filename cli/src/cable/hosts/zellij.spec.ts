import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import { RECORDED_ZELLIJ } from '../../testing/recordedZellij.js'
import type { Place } from './adapter.js'
import { MAX_TEXT } from './orca.js'
import { parseProcessNames, type ProcessName } from './scannedApp.js'
import { createOuter, tmuxClients, type OuterDeps } from './tmux.js'
import { createZellijAdapter, zellijClients, zellijFinder, type ZellijDeps } from './zellij.js'

/** The person's login shell, as the finder asks it: never this machine's own. It answers [answer] for any name. */
const shell = vi.hoisted(() => ({ asked: [] as string[], answer: null as string | null }))
vi.mock('../../lib/tmuxOnPath.js', async (real) => ({
  ...await real<typeof import('../../lib/tmuxOnPath.js')>(),
  resolveViaLoginShell: async (command: string) => {
    shell.asked.push(command)
    return shell.answer
  },
}))

const FAKE_ZELLIJ = '/fake/bin/zellij'
const { env, listPanes, focusPaneId, writeChars, sendKeys, missingPane, missingSession, listClients } = RECORDED_ZELLIJ
/** zellij where the core's lookup found it, off the devices' PATH. */
const FOUND = async (): Promise<TmuxPathOutcome> => ({ state: 'adopted', path: FAKE_ZELLIJ, from: '/fake/bin' })
const ABSENT = async (): Promise<TmuxPathOutcome> => ({ state: 'absent', reason: 'zellij was not found' })

interface Call { file: string; args: readonly string[]; timeoutMs: number }

/** The recorded listing with its terminal pane [id] left out: the pane closed, or never was. */
const withoutTerminal = (id: number) =>
  JSON.stringify((JSON.parse(listPanes.stdout) as Array<{ id: number; is_plugin: boolean }>).filter((one) => one.is_plugin || one.id !== id))

/** A runner that answers as the recorded session `s1` did, so no spec moves the developer's own Zellij: another session
 *  is gone; `focus-pane-id` fails for a terminal pane the listing lacks; `write-chars` and `send-keys` exit 0 for any
 *  pane; `list-clients` lists one client. [fail] names a verb that exits 1 instead. */
function recorder(over: Partial<ZellijDeps> = {}, panes: string = listPanes.stdout, fail?: string) {
  const calls: Call[] = []
  const deps: ZellijDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const [, session, , verb, id] = args
      if (session !== env.ZELLIJ_SESSION_NAME) return { code: missingSession.code, stdout: '' }
      if (verb === fail) return { code: 1, stdout: '' }
      if (verb === 'list-panes') return { code: listPanes.code, stdout: panes }
      if (verb === 'list-clients') return { code: listClients.code, stdout: listClients.one }
      if (verb === 'focus-pane-id') {
        const listed = (JSON.parse(panes) as Array<{ id: number; is_plugin: boolean }>).some((one) => !one.is_plugin && String(one.id) === id)
        return { code: listed ? focusPaneId.code : missingPane.code, stdout: '' }
      }
      return { code: verb === 'write-chars' ? writeChars.code : sendKeys.code, stdout: '' }
    },
    zellij: FOUND,
    platform: 'linux',
    ...over,
  }
  return { calls, deps, adapter: createZellijAdapter(deps) }
}

const hints = { ZELLIJ: env.ZELLIJ, ZELLIJ_PANE_ID: env.ZELLIJ_PANE_ID, ZELLIJ_SESSION_NAME: env.ZELLIJ_SESSION_NAME }
const place = (over: Record<string, string> = {}, host = 'zellij'): Place => ({ host, app: 'terminal', hints: { ...hints, ...over } })
const pane = (id: string) => ({ adapter: 'zellij', id })
/** A recorded argv, run as the adapter runs it: the binary where it was found, then the arguments. */
const ran = (args: readonly string[]): Call => ({ file: FAKE_ZELLIJ, args: args.slice(1), timeoutMs: 10_000 })
const typing = (id: string, text: string, session = 's1'): Call[] => [
  ran(['zellij', '--session', session, 'action', 'list-panes', '--json']),
  ran(['zellij', '--session', session, 'action', 'write-chars', '--pane-id', id, '--', text]),
  ran(['zellij', '--session', session, 'action', 'send-keys', '--pane-id', id, 'Enter']),
]

describe('the Zellij adapter', () => {
  it('its id is zellij, it taps before its app, it types, and it has no show and no bundle', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('zellij')
    expect(adapter.tap).toBe('before')
    expect(adapter.bundle).toBeUndefined()
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.canFocus(pane('s1:1'))).toBe(true)
    expect(adapter.canType(pane('s1:1'))).toBe(true)
  })

  it('paneOf takes its two hints, and refuses each out of form', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place())).toEqual(pane('s1:1'))
    expect(adapter.paneOf(place({ ZELLIJ_SESSION_NAME: 'a'.repeat(64) }))).toEqual(pane(`${'a'.repeat(64)}:1`))
    expect(adapter.paneOf(place({ ZELLIJ_SESSION_NAME: 'my.proj_2-x', ZELLIJ_PANE_ID: '123456789' }))).toEqual(pane('my.proj_2-x:123456789'))
    for (const session of ['-s1', '--help', 'a/b', '../s1', 'my proj', 'a'.repeat(65), '.s1', 's1:1', '']) {
      expect(adapter.paneOf(place({ ZELLIJ_SESSION_NAME: session })), session).toBeUndefined()
    }
    for (const id of ['terminal_1', 'plugin_0', '-1', '1 ', '1; rm -rf /', '1234567890', '']) {
      expect(adapter.paneOf(place({ ZELLIJ_PANE_ID: id })), id).toBeUndefined()
    }
    expect(adapter.paneOf({ host: 'zellij', app: 'terminal', hints: { ZELLIJ: '0', ZELLIJ_PANE_ID: '1' } })).toBeUndefined()
    expect(adapter.paneOf({ host: 'zellij', app: 'terminal', hints: { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 's1' } })).toBeUndefined()
  })

  it('types only into the agent\'s own pane', async () => {
    const { calls, adapter } = recorder()
    const held = [place({}, 'herdr'), place({}, 'rex'), place({ TMUX_PANE: '%3' })]
    for (const at of held) {
      const found = adapter.paneOf(at)!
      expect(found, at.host).toEqual(pane('held:s1:1'))
      expect(adapter.canType(found)).toBe(false)
      expect(await adapter.type(found, 'hello', 'claude')).toBe(false)
      expect(calls).toEqual([])
    }
    expect(await adapter.focus(pane('held:s1:1'))).toBe(true)
    expect(calls).toEqual([ran(focusPaneId.args)])
  })

  it('a session named held is still the agent\'s own', async () => {
    const { calls, adapter } = recorder({ run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: 0, stdout: args[3] === 'list-panes' ? listPanes.stdout : '' }
    } })
    const found = adapter.paneOf(place({ ZELLIJ_SESSION_NAME: 'held' }))!
    expect(found).toEqual(pane('held:1'))
    expect(adapter.canType(found)).toBe(true)
    expect(await adapter.type(found, 'hello', 'claude')).toBe(true)
    expect(calls).toEqual(typing('1', 'hello', 'held'))
  })

  it('focus runs the recorded focus-pane-id', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane('s1:1'))).toBe(true)
    expect(calls).toEqual([ran(focusPaneId.args)])
  })

  it('types the words with the three recorded calls', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type(pane('s1:1'), 'echo agent-words', 'claude')).toBe(true)
    expect(calls).toEqual([ran(listPanes.args), ran(writeChars.args), ran(sendKeys.args)])
  })

  it('a pane that is gone, or a plugin\'s, is not typed into', async () => {
    const gone = recorder({}, withoutTerminal(1))
    expect(await gone.adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(await gone.adapter.focus(pane('s1:1'))).toBe(false)
    expect(gone.calls).toEqual([ran(listPanes.args), ran(focusPaneId.args)])

    // Plugin 0 is listed, terminal 0 is not: the ids are counted apart.
    const plugin = recorder({}, withoutTerminal(0))
    expect(await plugin.adapter.type(pane('s1:0'), 'hello', 'claude')).toBe(false)
    expect(plugin.calls).toEqual([ran(listPanes.args)])

    const never = recorder()
    expect(await never.adapter.type(pane('s1:9'), 'hello', 'claude')).toBe(false)
    expect(await never.adapter.focus(pane('s1:9'))).toBe(false)
    expect(never.calls).toEqual([ran(listPanes.args), ran(missingPane.args)])
  })

  it('a listing that is not the recorded shape types nothing', async () => {
    for (const stdout of ['', 'not json', '{"id":1,"is_plugin":false}', '[null]', '[{"id":"1","is_plugin":false}]', '[{"id":1}]']) {
      const { calls, adapter } = recorder({}, stdout)
      expect(await adapter.type(pane('s1:1'), 'hello', 'claude'), stdout).toBe(false)
      expect(calls).toEqual([ran(listPanes.args)])
    }
  })

  it('a session that is gone is false', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane('gone:1'))).toBe(false)
    expect(await adapter.type(pane('gone:1'), 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([ran(missingSession.args), ran(['zellij', '--session', 'gone', 'action', 'list-panes', '--json'])])
  })

  it('a call that fails sends nothing after it', async () => {
    const written = recorder({}, listPanes.stdout, 'write-chars')
    expect(await written.adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(written.calls).toEqual(typing('1', 'hello').slice(0, 2))
    const entered = recorder({}, listPanes.stdout, 'send-keys')
    expect(await entered.adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(entered.calls).toEqual(typing('1', 'hello'))
  })

  it('one send at a time for a pane', async () => {
    const calls: Call[] = []
    let release = () => {}
    const { adapter } = recorder({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        const answer = { code: 0, stdout: args[3] === 'list-panes' ? listPanes.stdout : '' }
        return calls.length === 1 ? new Promise((resolve) => { release = () => resolve(answer) }) : Promise.resolve(answer)
      },
    })
    const first = adapter.type(pane('s1:1'), 'first', 'claude')
    expect(await adapter.type(pane('s1:1'), 'second', 'claude')).toBe(false)
    expect(await adapter.type(pane('s1:0'), 'other', 'claude')).toBe(true)
    release()
    expect(await first).toBe(true)
    expect(await adapter.type(pane('s1:1'), 'third', 'claude')).toBe(true)
    const [listing, ...typed] = typing('1', 'first')
    expect(calls).toEqual([listing, ...typing('0', 'other'), ...typed, ...typing('1', 'third')])
  })

  it('words starting with --, and with control characters', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type(pane('s1:1'), '--not-a-flag\nnow\u001b[2J', 'claude')).toBe(true)
    expect(calls).toEqual(typing('1', '--not-a-flag now [2J'))
    expect(await adapter.type(pane('s1:1'), '', 'claude')).toBe(false)
    expect(await adapter.type(pane('s1:1'), 'x'.repeat(MAX_TEXT + 1), 'claude')).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder()
    for (const id of ['1', 's1', 's1:', ':1', 's1:1; rm -rf /', '-s1:1', 's1:terminal_1', 'held:', 'held:-s1:1', `${'a'.repeat(65)}:1`]) {
      expect(adapter.canType(pane(id)), id).toBe(false)
      expect(await adapter.type(pane(id), 'hello', 'claude'), id).toBe(false)
      expect(await adapter.focus(pane(id)), id).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('Windows has no pane', () => {
    const { adapter } = recorder({ platform: 'win32' })
    expect(adapter.paneOf(place())).toBeUndefined()
  })
})

describe('zellij as the core finds tmux', () => {
  /** A home of folders made for the spec: the devices' PATH, the core's install folder and Homebrew's prefix, each empty. */
  const homes: string[] = []
  const home = () => {
    const at = mkdtempSync(join(tmpdir(), 'zellij-finder-'))
    homes.push(at)
    for (const dir of ['path', 'bin', 'brew/bin']) mkdirSync(join(at, dir), { recursive: true })
    const where = { PATH: join(at, 'path'), HOME: at, HARNESS_BIN_DIR: join(at, 'bin'), HARNESS_HOMEBREW_PREFIXES: join(at, 'brew') }
    return { at, env: where }
  }
  const install = (dir: string) => {
    writeFileSync(join(dir, 'zellij'), '#!/bin/sh\n')
    chmodSync(join(dir, 'zellij'), 0o755)
    return join(dir, 'zellij')
  }
  beforeEach(() => {
    shell.asked.length = 0
    shell.answer = null
  })
  afterAll(() => {
    for (const at of homes) rmSync(at, { recursive: true, force: true })
  })

  it('zellij on the devices\' PATH runs by its name', async () => {
    const { calls, adapter } = recorder({ zellij: async () => ({ state: 'present' }) })
    expect(await adapter.focus(pane('s1:1'))).toBe(true)
    expect(calls).toEqual([{ ...ran(focusPaneId.args), file: 'zellij' }])
  })

  // An agent in a Zellij pane has a zellij on this machine: only a lookup that failed finds none, and a tap then brings
  // its app forward, as tmux's does.
  it('no zellij found: a tap and the words run nothing', async () => {
    const { calls, adapter } = recorder({ zellij: ABSENT })
    expect(await adapter.focus(pane('s1:1'))).toBe(false)
    expect(await adapter.focus(pane('held:s1:1'))).toBe(false)
    expect(await adapter.type(pane('s1:1'), 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([])
  })

  // The master hands the devices a PATH that holds no Homebrew or cargo folder under launchd or systemd.
  it('off the devices\' PATH, it is where the person\'s login shell finds it, asked once for every call', async () => {
    const { env: where } = home()
    shell.answer = '/home/u/.cargo/bin/zellij'
    const zellij = zellijFinder(where)
    const adopted = { state: 'adopted', path: '/home/u/.cargo/bin/zellij', from: '/home/u/.cargo/bin' }
    expect(await zellij()).toEqual(adopted)
    expect(await zellij()).toEqual(adopted)
    expect(shell.asked).toEqual(['zellij'])
  })

  it('on the devices\' PATH it runs by its name, and no shell is asked', async () => {
    const { env: where } = home()
    install(where.PATH)
    expect(await zellijFinder(where)()).toEqual({ state: 'present' })
    expect(shell.asked).toEqual([])
  })

  // As the core retries its own tmux (tmux.ts tmuxFinder): a zellij installed after the devices started, or a login
  // shell that timed out on a loaded Mac, otherwise left the dial with no zellij until the process restarted.
  it('none found is asked again once a zellij is in a folder the core looks in, and found there', async () => {
    const { env: where } = home()
    const zellij = zellijFinder(where)
    expect((await zellij()).state).toBe('absent')
    // None there yet: nothing is asked again.
    expect((await zellij()).state).toBe('absent')
    expect(shell.asked).toEqual(['zellij'])
    const path = install(where.HARNESS_BIN_DIR)
    const adopted = { state: 'adopted', path, from: where.HARNESS_BIN_DIR }
    expect(await zellij()).toEqual(adopted)
    expect(shell.asked).toEqual(['zellij', 'zellij'])
    // Found, it holds.
    expect(await zellij()).toEqual(adopted)
    expect(shell.asked).toHaveLength(2)
  })
})

/** The recorded table with one client (RECORDED_ZELLIJ.listClients), and what the container had none of: the agent (100)
 *  in `s1`'s pane shell (50), and Ghostty holding the client's pseudo-terminal (101). */
const GHOSTTY: ProcessName = { pid: 7000, ppid: 1, executable: 'ghostty' }
const TABLE: ProcessName[] = [
  ...parseProcessNames(listClients.ps).map((p) => (p.pid === 101 ? { ...p, ppid: GHOSTTY.pid } : p)),
  GHOSTTY,
  { pid: 100, ppid: 50, executable: 'claude' },
]
/** The same machine as macOS's `ps` names it: each process by its path, Ghostty's place taken by Terminal. */
const MAC_TABLE: ProcessName[] = TABLE.map((p) => (
  p.executable === 'zellij' ? { ...p, executable: '/opt/homebrew/bin/zellij' }
    : p === GHOSTTY ? { ...p, executable: '/Users/u/Applications/Terminal.app/Contents/MacOS/Terminal' } : p))
const MAC: Partial<OuterDeps> = {
  platform: 'darwin',
  roots: ['/Users/u/Applications/'],
  bundleId: async (bundle) => (bundle === '/Users/u/Applications/Terminal.app' ? 'com.apple.Terminal' : undefined),
}
/** Another client of zellij's, in a pseudo-terminal of Ghostty's of its own. */
const anotherClient = (pid: number): ProcessName[] => [{ pid: pid - 1, ppid: GHOSTTY.pid, executable: 'script' }, { pid, ppid: pid - 1, executable: 'zellij' }]
const found = ['[device] zellij client · found']
const none = ['[device] zellij client · none']
/** The lookup's line when a step could not be read, naming that step. */
const notRead = (why: 'zellij' | 'processes' | 'clients' | 'app') => [`[device] zellij client · not read · ${why}`]

/** The outer lookup with Zellij's part alone, on Linux, over [table]: zellij runs nothing, and `list-clients` of `s1`
 *  answers [clients] with exit [code]. */
function lookup(over: Partial<OuterDeps> & { table?: ProcessName[]; clients?: string; code?: number; zellij?: ZellijDeps['zellij'] } = {}) {
  const calls: Call[] = []
  const logs: string[] = []
  let reads = 0
  const { table = TABLE, clients = listClients.one, code = listClients.code, zellij = FOUND, ...deps } = over
  const run: ZellijDeps['run'] = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return args[1] === env.ZELLIJ_SESSION_NAME ? { code, stdout: clients } : { code: missingSession.code, stdout: '' }
  }
  const outerDeps: OuterDeps = {
    processes: async () => { reads++; return table },
    log: (line) => { logs.push(line) },
    now: () => 0,
    platform: 'linux',
    roots: [],
    bundleId: async () => undefined,
    ...deps,
  }
  const outer = createOuter(outerDeps, [zellijClients({ run, zellij, platform: outerDeps.platform })])
  return { calls, logs, reads: () => reads, outer }
}

describe('the outer place of an agent in a Zellij pane', () => {
  it('not Zellij: undefined at once, and nothing runs', () => {
    const { calls, reads, outer } = lookup()
    const out = [{}, { ZELLIJ: '0' }, { ZELLIJ_SESSION_NAME: 's1' }, { ...hints, ZELLIJ_SESSION_NAME: '-s1' }, { ...hints, ZELLIJ_PANE_ID: 'terminal_1' }]
    for (const at of out as Record<string, string>[]) expect(outer(at, 100), JSON.stringify(at)).toBeUndefined()
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(outer(hints, pid), String(pid)).toBeUndefined()
    expect(lookup({ platform: 'win32' }).outer(hints, 100)).toBeUndefined()
    expect([calls, reads()]).toEqual([[], 0])
  })

  // Zellij names no client's process (RECORDED_ZELLIJ.listClients): its one client is the machine's one.
  it('the session\'s one client, the machine\'s one: the client\'s app and process', async () => {
    const { calls, logs, reads, outer } = lookup()
    expect(await outer(hints, 100)).toStrictEqual({ app: 'ghostty', pid: 103 })
    expect(calls).toEqual([ran(listClients.args)])
    expect(reads()).toBe(1)
    expect(logs).toEqual(found)
  })

  it('on macOS, whose ps names zellij by its path', async () => {
    const { logs, outer } = lookup({ ...MAC, table: MAC_TABLE })
    expect(await outer(hints, 100)).toStrictEqual({ app: 'terminal-app', pid: 103 })
    expect(logs).toEqual(found)
  })

  it('a caller under no Zellij server answers {} and lists no client', async () => {
    for (const pid of [21, 4242]) {
      const { calls, logs, outer } = lookup()
      expect(await outer(hints, pid), String(pid)).toEqual({})
      expect(calls, String(pid)).toEqual([])
      expect(logs, String(pid)).toEqual(none)
    }
  })

  // Which of two is the person's is a guess: the agent stays where its hints place it.
  it('no client, two of the session\'s, or another session\'s beside its one: {}', async () => {
    const cases: Array<[string, ReturnType<typeof lookup>]> = [
      ['no client', lookup({ clients: listClients.none })],
      ['two of the session\'s', lookup({ clients: listClients.two, table: [...TABLE, ...anotherClient(138)] })],
      ['another session\'s', lookup({ table: [...TABLE, ...anotherClient(201)] })],
    ]
    for (const [name, { calls, logs, outer }] of cases) {
      expect(await outer(hints, 100), name).toEqual({})
      expect(calls, name).toEqual([ran(listClients.args)])
      expect(logs, name).toEqual(none)
    }
  })

  it('a server, a zellij run in a pane, and this process\'s own runs are no client', async () => {
    const table = [...TABLE, { pid: 300, ppid: 50, executable: 'zellij' }, { pid: 301, ppid: process.pid, executable: 'zellij' }]
    const { logs, outer } = lookup({ table })
    expect(await outer(hints, 100)).toStrictEqual({ app: 'ghostty', pid: 103 })
    expect(logs).toEqual(found)
  })

  it('zellij not found, a table not read, a session gone, or an app scan that throws: {} and not read, with the step', async () => {
    const roots = Object.assign([], { some: () => { throw new Error('roots not read') } })
    const cases: Array<[string, ReturnType<typeof lookup>, Call[], string[]]> = [
      ['no zellij is found', lookup({ zellij: ABSENT }), [], notRead('zellij')],
      ['the table is not read', lookup({ processes: async () => { throw new Error('process table not read') } }), [], notRead('processes')],
      ['the session is gone', lookup({ code: missingSession.code, clients: '' }), [ran(listClients.args)], notRead('clients')],
      ['the app scan throws', lookup({ ...MAC, table: MAC_TABLE, roots }), [ran(listClients.args)], notRead('app')],
    ]
    for (const [name, { calls, logs, outer }, ranCalls, lines] of cases) {
      expect(await outer(hints, 100), name).toEqual({})
      expect(calls, name).toEqual(ranCalls)
      expect(logs, name).toEqual(lines)
    }
  })

  it('its lines name no session, pane, process or app', async () => {
    const lines: string[] = []
    for (const { logs, outer } of [lookup(), lookup({ clients: listClients.none }), lookup({ code: missingSession.code })]) {
      await outer(hints, 100)
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('clients')])
    for (const line of lines) {
      for (const id of ['s1', '103', '100', 'ghostty', 'Ghostty', 'terminal_0']) expect(line).not.toContain(id)
    }
  })

  it('one lookup for tmux and Zellij: each one\'s hints ask its own', async () => {
    const calls: Call[] = []
    const run: ZellijDeps['run'] = async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: 0, stdout: '' }
    }
    const outer = createOuter({ processes: async () => TABLE, log: () => {}, now: () => 0, platform: 'linux', roots: [], bundleId: async () => undefined },
      [tmuxClients({ run, tmux: async () => ({ state: 'present' }) }), zellijClients({ run, zellij: FOUND, platform: 'linux' })])
    await outer(hints, 100)
    await outer({ TMUX_PANE: '%3' }, 100)
    expect(calls.map(({ file, args }) => [file, args.includes('list-clients') ? 'list-clients' : args[0]]))
      .toEqual([[FAKE_ZELLIJ, 'list-clients'], ['tmux', 'display-message']])
  })
})
