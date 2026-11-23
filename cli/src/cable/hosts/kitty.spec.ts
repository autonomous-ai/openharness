import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoundFrom, TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import { RECORDED_KITTY } from '../../testing/recordedKitty.js'
import type { Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { FOCUS_READ_MS } from './focusPoll.js'
import { createKittyAdapter, createKittyTabAdapter, FOCUS_CALLS_MAX, kittyFinder, type KittyDeps } from './kitty.js'
import { MAX_TEXT } from './orca.js'
import type { ProcessName } from './scannedApp.js'

/** The person's login shell, as the finder asks it: never this machine's own. It answers [answer] for any name. */
const shell = vi.hoisted(() => ({ asked: [] as string[], answer: null as string | null }))
vi.mock('../../lib/tmuxOnPath.js', async (real) => ({
  ...await real<typeof import('../../lib/tmuxOnPath.js')>(),
  resolveViaLoginShell: async (command: string) => {
    shell.asked.push(command)
    return shell.answer
  },
}))
/** kitty.app's own kitten on macOS, which no spec may look for on this machine: there when [there]. */
const APP_KITTEN = '/Applications/kitty.app/Contents/MacOS/kitten'
const app = vi.hoisted(() => ({ there: false, asked: 0 }))
vi.mock('../../lib/binaryOnPath.js', async (real) => {
  const actual = await real<typeof import('../../lib/binaryOnPath.js')>()
  return {
    ...actual,
    binaryOnPath: (command: string, env?: NodeJS.ProcessEnv, accept?: (path: string) => boolean) => {
      if (command !== '/Applications/kitty.app/Contents/MacOS/kitten') return actual.binaryOnPath(command, env, accept)
      app.asked++
      return app.there
    },
  }
})

const FAKE_KITTEN = '/fake/bin/kitten'
const {
  env, envFromConf, envRemoteControlOff, focusWindow, sendText, sendTextBackslash, sendKeyOtherActive,
  sendTextOtherActive, enter, kittyAt, kittyPlusKitten, remoteControlOff, noSocket, missingWindow, focusWindowPid,
  focusWindowPidDescendant, focusedMatch,
} = RECORDED_KITTY
/** kitten where the finder found it, off the devices' PATH. */
const FOUND = async (): Promise<TmuxPathOutcome> => ({ state: 'adopted', path: FAKE_KITTEN, from: 'login shell' })
const ABSENT = async (): Promise<TmuxPathOutcome> => ({ state: 'absent', reason: 'kitty was not found' })
const OFF = '[device] kitty · remote control off'
/** This account, as the recording's: uid 1000, the owner of the socket kitty made at `/tmp/kitty`. */
const UID = 1000

interface Call { file: string; args: readonly string[]; timeoutMs: number }
type Answer = Awaited<ReturnType<KittyDeps['run']>>

/** A runner that answers as the recorded kitty did, so no spec speaks to the developer's own kitty: it listens at
 *  `unix:/tmp/kitty` alone, with windows 1 and 2; any other address has no socket, any other window is missing. [answer]
 *  replaces its answer for the verb it names, as long as it holds it. `get-colors --match` matches the window [focused]
 *  names for its socket, as RECORDED_KITTY.focusedMatch did; a socket [focused] has no entry for has no kitty. [ids] are
 *  the socket files of this account's, by path, with their identity. Each call moves the spec's [clock] by [tick]. */
function recorder(over: Partial<KittyDeps> = {}, answer: Record<string, Partial<Answer>> = {}) {
  const calls: Call[] = []
  const logs: string[] = []
  const owners: string[] = []
  const focused = new Map<string, string>([[env.KITTY_LISTEN_ON, '1']])
  const ids = new Map<string, string>([['/tmp/kitty', '1:1']])
  const clock = { ms: 0, tick: 0 }
  const colors = (to: string, match: string): Answer => {
    const window = focused.get(to)
    if (window === undefined) return { code: noSocket.code, stdout: '', stderr: noSocket.stderr }
    const asked = [...match.matchAll(/id:([0-9]+)/g)].map(([, id]) => id)
    return asked.includes(window) ? { code: focusedMatch.focused.code, stdout: `${focusedMatch.focused.stdoutFirstLine}\n`, stderr: '' }
      : { code: focusedMatch.notFocused.code, stdout: '', stderr: `Error: No matching windows for expression: ${match}\n` }
  }
  const deps: KittyDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      clock.ms += clock.tick
      const [, , to, verb, , match] = args
      if (answer[verb]) return { code: 0, stdout: '', ...answer[verb] }
      if (verb === 'get-colors') return colors(to, match)
      if (to !== env.KITTY_LISTEN_ON) return { code: noSocket.code, stdout: '' }
      if (match !== 'id:1' && match !== 'id:2') return { code: missingWindow.code, stdout: '' }
      return { code: verb === 'send-text' ? sendText.code : focusWindow.code, stdout: '' }
    },
    kitty: FOUND,
    platform: 'linux',
    log: (line) => { logs.push(line) },
    uid: UID,
    socketOwner: (path) => {
      owners.push(path)
      return ids.has(path) ? UID : null
    },
    now: () => clock.ms,
    socketId: (path) => ids.get(path) ?? null,
    ...over,
  }
  return { calls, logs, owners, focused, ids, clock, deps, adapter: createKittyAdapter(deps) }
}

/** A place, by default an agent on the pseudo-terminal of kitty's own window. */
const place = (hints: Record<string, string> = env, host = 'kitty', ptyOwner: string | null = 'kitty'): Place =>
  ({ host, app: 'kitty', hints, ...(ptyOwner === null ? {} : { ptyOwner }) })
const pane = (id: string) => ({ adapter: 'kitty', id })
const OWN = pane(`1@${env.KITTY_LISTEN_ON}`)
/** The window of an agent kitty did not make the terminal of, as paneOf gives it. */
const HELD = { ...pane(`held:${OWN.id}`), held: true }
/** A recorded argv, run as the adapter runs it: the binary where it was found, then the arguments. */
const ran = (args: readonly string[], file = FAKE_KITTEN): Call => ({ file, args: args.slice(1), timeoutMs: 10_000 })
const typing = (text: string, id = '1', to: string = env.KITTY_LISTEN_ON): Call[] => [
  ran(['kitten', '@', '--to', to, 'send-text', '--match', `id:${id}`, '--', text]),
  ran(['kitten', '@', '--to', to, 'send-text', '--match', `id:${id}`, '--', '\\r']),
]

describe('the kitty adapter', () => {
  it('its id is kitty, it taps before its app, its app is kitty\'s, it types, and it has no show', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('kitty')
    expect(adapter.tap).toBe('before')
    expect(adapter.bundle).toBe(APP_BUNDLES.kitty)
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.canFocus(OWN)).toBe(true)
    expect(adapter.canType(OWN)).toBe(true)
  })

  it('paneOf takes the window and the socket kitty set, and refuses each out of form', () => {
    const { adapter, logs } = recorder()
    expect(adapter.paneOf(place())).toEqual(OWN)
    // A path from kitty.conf, to which kitty adds its pid.
    expect(adapter.paneOf(place(envFromConf))).toEqual(pane('1@unix:/tmp/kitty-4555'))
    expect(adapter.paneOf(place({ ...env, KITTY_WINDOW_ID: '123456789' }))).toEqual(pane('123456789@unix:/tmp/kitty'))
    expect(adapter.paneOf(place({ ...env, KITTY_LISTEN_ON: 'unix:@mykitty' }))).toEqual(pane('1@unix:@mykitty'))
    const longest = `unix:/${'a'.repeat(58)}`
    expect(adapter.paneOf(place({ ...env, KITTY_LISTEN_ON: longest }))).toEqual(pane(`1@${longest}`))
    for (const id of ['-1', '1a', ' 1', '1 ', '1234567890', '1; rm -rf /', '']) {
      expect(adapter.paneOf(place({ ...env, KITTY_WINDOW_ID: id })), id).toBeUndefined()
    }
    for (const to of ['tcp:localhost:5000', 'unix:kitty', 'unix:./kitty', 'unix:', 'unix:/', 'unix:@', 'unix:@a/b',
      'unix:/tmp/a b', 'unix:/tmp/kitty\n', '/tmp/kitty', 'fd:3', `unix:/${'a'.repeat(59)}`, `unix:@${'a'.repeat(59)}`, '']) {
      expect(adapter.paneOf(place({ ...env, KITTY_LISTEN_ON: to })), to).toBeUndefined()
    }
    // No window, no pane, and nothing to say.
    expect(adapter.paneOf(place({ KITTY_LISTEN_ON: env.KITTY_LISTEN_ON }))).toBeUndefined()
    expect(logs).toEqual([])
  })

  it('an abstract socket is Linux\'s alone', () => {
    const { adapter } = recorder({ platform: 'darwin' })
    expect(adapter.paneOf(place())).toEqual(OWN)
    expect(adapter.paneOf(place({ ...env, KITTY_LISTEN_ON: 'unix:@mykitty' }))).toBeUndefined()
    expect(adapter.canFocus(pane('1@unix:@mykitty'))).toBe(false)
    expect(adapter.canType(pane('1@unix:@mykitty'))).toBe(false)
  })

  it('a window with remote control off has no pane, and says so once across many looks', () => {
    const { adapter, logs } = recorder()
    for (let look = 0; look < 5; look++) expect(adapter.paneOf(place(envRemoteControlOff))).toBeUndefined()
    expect(adapter.paneOf(place({ ...envRemoteControlOff, KITTY_WINDOW_ID: '2' }))).toBeUndefined()
    expect(adapter.paneOf(place())).toEqual(OWN)
    expect(logs).toEqual([OFF])
  })

  it('a window id out of form says nothing of remote control', () => {
    const { adapter, logs } = recorder()
    expect(adapter.paneOf(place({ KITTY_WINDOW_ID: 'x' }))).toBeUndefined()
    expect(logs).toEqual([])
  })

  // A multiplexer, a terminal or an editor started in a kitty window keeps its variables: that window shows whichever of
  // their panes is in front, or a shell that runs whatever is typed. Only the process that made the agent's
  // pseudo-terminal says whose it is (Place.ptyOwner): any but kitty's, or none read yet, only focuses.
  it('types only into a window whose pseudo-terminal is the agent\'s', async () => {
    const { calls, adapter } = recorder()
    const held = [
      ...['tmux', 'zellij', 'wezterm', null].map((owner) => place(env, 'kitty', owner)),
      ...['tmux', 'zellij', 'herdr', 'rex'].map((host) => place(env, host, null)),
    ]
    for (const at of held) {
      const found = adapter.paneOf(at)!
      expect(found, `${at.host} ${at.ptyOwner}`).toEqual(HELD)
      expect(adapter.canFocus(found)).toBe(true)
      expect(adapter.canType(found)).toBe(false)
      expect(await adapter.type(found, 'hello', 'claude')).toBe(false)
      expect(calls).toEqual([])
    }
    expect(await adapter.focus(pane(`held:${OWN.id}`))).toBe(true)
    expect(calls).toEqual([ran(focusWindow.args)])
  })

  // The observed source reads the field alone, never an id's form: a held window is tapped after the agent's other panes,
  // and takes no words, rest or key.
  it('a held pane says so; an own one does not', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place())).toStrictEqual(OWN)
    for (const ptyOwner of [undefined, null, 'wezterm']) {
      expect(adapter.paneOf({ ...place(), ptyOwner }), String(ptyOwner)).toStrictEqual(HELD)
    }
  })

  // VS Code, WezTerm, screen or nvim's :terminal started from kitty window 1 carries KITTY_WINDOW_ID=1, and detectHost
  // says kitty.
  it('a terminal started from the window takes no words', async () => {
    const { calls, adapter } = recorder()
    const found = adapter.paneOf(place({ ...env, TERM_PROGRAM: 'vscode' }, 'kitty', null))!
    expect(found).toEqual(HELD)
    expect(adapter.canType(found)).toBe(false)
    expect(await adapter.type(found, 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([])
  })

  // kitty started from an Orca terminal or a Zellij pane keeps their variables: kitty's own window is where the agent is.
  it('the agent\'s own window takes words whatever other host\'s variables it inherited', () => {
    const { adapter } = recorder()
    const inherited = place({ ...env, ORCA_TERMINAL_HANDLE: 'term_00000000-0000-0000-0000-000000000000', ZELLIJ: '0' }, 'zellij')
    expect(adapter.paneOf(inherited)).toEqual(OWN)
  })

  it('focus runs the recorded focus-window', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(OWN)).toBe(true)
    expect(calls).toEqual([ran(focusWindow.args)])
  })

  it('types the words with the recorded send-text, then Enter as send-text to the same window', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type(OWN, 'hello agent', 'claude')).toBe(true)
    expect(calls).toEqual([ran(sendText.args), ran(enter.args)])
    for (const { args } of calls) expect(args).not.toContain('send-key')
  })

  // kitty 0.32.2's send-key goes to the active window whatever --match names: Enter there would run another window's
  // line. Replayed from what landed in each window with window 2 active; a call not recorded fails.
  it('Enter reaches the agent\'s window when another window is active', async () => {
    const landed: Record<string, string> = { 1: '', 2: '' }
    const { adapter } = recorder({
      run: async (_file, args) => {
        const seen = [sendKeyOtherActive, sendTextOtherActive, enter].find((recorded) =>
          JSON.stringify(recorded.args.slice(1)) === JSON.stringify(args))
        if (!seen) throw new Error(`not recorded: ${args.join(' ')}`)
        for (const [window, bytes] of Object.entries(seen.landed)) landed[window] += bytes
        return { code: seen.code, stdout: '' }
      },
    })
    expect(await adapter.type(OWN, 'words', 'claude')).toBe(true)
    expect(landed).toEqual({ 1: 'words\r', 2: '' })
  })

  // kitty reads Python escapes in send-text: a lone backslash lands as an escape. The recorded words that landed as typed
  // are the ones the adapter sends.
  it('words with a backslash reach the prompt as typed', async () => {
    const asTyped = sendTextBackslash.filter(({ landed }) => !/\p{Cc}/u.test(landed.slice(0, -1)))
    expect(asTyped.map(({ landed }) => landed.slice(0, -1))).toEqual(['a\\nb', '\\x1b[31m', 'c:\\new'])
    for (const { sent, landed } of asTyped) {
      const { calls, adapter } = recorder()
      expect(await adapter.type(OWN, landed.slice(0, -1), 'claude'), landed).toBe(true)
      expect(calls, landed).toEqual(typing(sent))
    }
  })

  it('words starting with --, and with control characters', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.type(OWN, '--not-a-flag\nnow\u001b[2J', 'claude')).toBe(true)
    expect(calls).toEqual(typing('--not-a-flag now [2J'))
    expect(await adapter.type(OWN, '', 'claude')).toBe(false)
    expect(await adapter.type(OWN, 'x'.repeat(MAX_TEXT + 1), 'claude')).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('a socket that is another account\'s is never spoken to', async () => {
    for (const owner of [0, 1001, null]) {
      const { calls, owners, adapter } = recorder({ socketOwner: (path) => { owners.push(path); return owner } })
      expect(await adapter.focus(OWN), String(owner)).toBe(false)
      expect(await adapter.focus(pane(`held:${OWN.id}`)), String(owner)).toBe(false)
      expect(await adapter.type(OWN, 'hello', 'claude'), String(owner)).toBe(false)
      expect(calls, String(owner)).toEqual([])
      expect(owners, String(owner)).toEqual(['/tmp/kitty', '/tmp/kitty', '/tmp/kitty'])
    }
  })

  it('the socket\'s owner is asked at each verb', async () => {
    const { owners, adapter } = recorder()
    await adapter.focus(OWN)
    await adapter.type(OWN, 'hello', 'claude')
    expect(owners).toEqual(['/tmp/kitty', '/tmp/kitty'])
  })

  // Linux's abstract sockets have no file and so no owner to read: once kitty is gone, any account may take the name. A
  // tap there costs a look; words would run at that account's prompt.
  it('an abstract socket keeps the tap, with no owner asked, and takes no words', async () => {
    const { calls, owners, adapter } = recorder()
    const abstract = pane('1@unix:@mykitty')
    expect(await adapter.focus(abstract)).toBe(false)
    expect(calls).toEqual([ran(['kitten', '@', '--to', 'unix:@mykitty', 'focus-window', '--match', 'id:1'])])
    expect(adapter.canFocus(abstract)).toBe(true)
    expect(adapter.canType(abstract)).toBe(false)
    expect(await adapter.type(abstract, 'hello', 'claude')).toBe(false)
    expect(calls).toHaveLength(1)
    expect(owners).toEqual([])
  })

  it('remote control refused is false, and sends no Enter', async () => {
    const focus = recorder({}, { 'focus-window': remoteControlOff })
    expect(await focus.adapter.focus(OWN)).toBe(false)
    const words = recorder({}, { 'send-text': remoteControlOff })
    expect(await words.adapter.type(OWN, 'hello', 'claude')).toBe(false)
    expect(words.calls).toEqual(typing('hello').slice(0, 1))
  })

  it('no socket is false', async () => {
    const [, , , nothing] = noSocket.args
    // The socket of a path is gone with its kitty: its owner is none, and nothing runs.
    const gone = recorder()
    expect(await gone.adapter.focus(pane(`1@${nothing}`))).toBe(false)
    expect(await gone.adapter.type(pane(`1@${nothing}`), 'hello', 'claude')).toBe(false)
    expect(gone.calls).toEqual([])
    // One there that nothing listens on answers as recorded.
    const deaf = recorder({ socketOwner: () => UID })
    expect(await deaf.adapter.focus(pane(`1@${nothing}`))).toBe(false)
    expect(deaf.calls).toEqual([ran(['kitten', '@', '--to', nothing, 'focus-window', '--match', 'id:1'])])
  })

  it('a window that is gone is false', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focus(pane(`99@${env.KITTY_LISTEN_ON}`))).toBe(false)
    expect(await adapter.type(pane(`99@${env.KITTY_LISTEN_ON}`), 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([ran(missingWindow.args), typing('hello', '99')[0]])
  })

  it('an Enter that fails is false', async () => {
    const calls: Call[] = []
    const { adapter } = recorder({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return { code: args.at(-1) === enter.args.at(-1) ? 1 : 0, stdout: '' }
      },
    })
    expect(await adapter.type(OWN, 'hello', 'claude')).toBe(false)
    expect(calls).toEqual(typing('hello'))
  })

  it('one send at a time for a window', async () => {
    const calls: Call[] = []
    let release = () => {}
    const { adapter } = recorder({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return calls.length === 1 ? new Promise((resolve) => { release = () => resolve({ code: 0, stdout: '' }) })
          : Promise.resolve({ code: 0, stdout: '' })
      },
    })
    const first = adapter.type(OWN, 'first', 'claude')
    expect(await adapter.type(OWN, 'second', 'claude')).toBe(false)
    expect(await adapter.type(pane(`2@${env.KITTY_LISTEN_ON}`), 'other', 'claude')).toBe(true)
    release()
    expect(await first).toBe(true)
    expect(await adapter.type(OWN, 'third', 'claude')).toBe(true)
    const [text, key] = typing('first')
    expect(calls).toEqual([text, ...typing('other', '2'), key, ...typing('third')])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, owners, adapter } = recorder()
    for (const id of ['1', 'unix:/tmp/kitty', '@unix:/tmp/kitty', '1@', '1@tcp:localhost:5000', '1@unix:kitty',
      '-1@unix:/tmp/kitty', '1@unix:/tmp/a b', 'held:', 'held:1', 'held:held:1@unix:/tmp/kitty', `1@unix:/${'a'.repeat(59)}`]) {
      expect(adapter.canFocus(pane(id)), id).toBe(false)
      expect(adapter.canType(pane(id)), id).toBe(false)
      expect(await adapter.type(pane(id), 'hello', 'claude'), id).toBe(false)
      expect(await adapter.focus(pane(id)), id).toBe(false)
    }
    expect(calls).toEqual([])
    expect(owners).toEqual([])
  })

  it('Windows has no pane, and says nothing', () => {
    const { adapter, logs } = recorder({ platform: 'win32' })
    expect(adapter.paneOf(place())).toBeUndefined()
    expect(adapter.paneOf(place(envRemoteControlOff))).toBeUndefined()
    expect(logs).toEqual([])
  })

  it('its one line names no socket, window or words', async () => {
    const { adapter, logs } = recorder({}, { 'focus-window': remoteControlOff, 'send-text': remoteControlOff })
    adapter.paneOf(place(envRemoteControlOff))
    adapter.paneOf(place())
    await adapter.focus(OWN)
    await adapter.type(OWN, 'hello', 'claude')
    expect(logs).toEqual([OFF])
  })
})

describe('kitty\'s binary', () => {
  it('kitten on the devices\' PATH runs by its name', async () => {
    const { calls, adapter } = recorder({ kitty: async () => ({ state: 'present' }) })
    expect(await adapter.focus(OWN)).toBe(true)
    expect(calls).toEqual([{ ...ran(focusWindow.args), file: 'kitten' }])
  })

  // kitty 0.32.2 takes `kitty @`, and refuses `kitty +kitten @` (RECORDED_KITTY.kittyPlusKitten).
  it('only kitty found: it runs as kitty @', async () => {
    expect(kittyAt.args.slice(1, 4)).toEqual(focusWindow.args.slice(1, 4))
    expect(kittyPlusKitten.code).not.toBe(0)
    const { calls, adapter } = recorder({ kitty: async () => ({ state: 'adopted', path: '/usr/bin/kitty', from: 'PATH' }) })
    expect(await adapter.focus(OWN)).toBe(true)
    expect(await adapter.type(OWN, 'hello agent', 'claude')).toBe(true)
    expect(calls).toEqual([focusWindow, sendText, enter].map(({ args }) => ran(args, '/usr/bin/kitty')))
    for (const { args } of calls) expect(args).not.toContain('+kitten')
  })

  // An agent in a kitty window has a kitty on this machine: only a lookup that failed finds none, and a tap then brings
  // its app forward.
  it('none found: a tap and the words run nothing', async () => {
    const { calls, adapter } = recorder({ kitty: ABSENT })
    expect(adapter.canFocus(OWN)).toBe(true)
    expect(await adapter.focus(OWN)).toBe(false)
    expect(await adapter.focus(pane(`held:${OWN.id}`))).toBe(false)
    expect(await adapter.type(OWN, 'hello', 'claude')).toBe(false)
    expect(calls).toEqual([])
  })
})

/** The recording's window 1 under its kitty: kitty's child `sh` 1430, its `sh` 1431, and that one's process 1432, here a
 *  multiplexer's client; kitty's own pid was not recorded. */
const KITTY_TABLE: ProcessName[] = [
  { pid: 1, ppid: 0, executable: 'init' },
  { pid: 1420, ppid: 1, executable: 'kitty' },
  { pid: 1430, ppid: 1420, executable: 'sh' },
  { pid: 1431, ppid: 1430, executable: 'sh' },
  { pid: 1432, ppid: 1431, executable: 'herdr' },
]
const CLIENT = 1432
/** The terminal each of KITTY_TABLE's processes runs on (readTtyName): kitty's own window's, and none for kitty. */
const KITTY_TTYS: ReadonlyMap<number, string> = new Map([[1430, '/dev/pts/0'], [1431, '/dev/pts/0'], [1432, '/dev/pts/0']])
/** The pid kitty matches a window by: the window's own process alone (focusWindowPid, focusWindowPidDescendant). */
const WINDOW_PROCESS = focusWindowPid.args.at(-1)!

/** kitty's tab adapter, with a runner that answers as the recorded kitty did: `focus-window --match pid:` finds a window
 *  on a socket in form only by its own process; [table] is the machine's processes, [tty] reads a
 *  process's terminal, and kitty is in front. */
function tabRecorder(over: Partial<KittyDeps> = {}, table: () => Promise<readonly ProcessName[]> = async () => KITTY_TABLE,
  tty: (pid: number) => Promise<string | undefined> = async (pid) => KITTY_TTYS.get(pid)) {
  const calls: Call[] = []
  const owners: string[] = []
  let front: string | undefined = 'kitty'
  let reads = 0
  const adapter = createKittyTabAdapter({
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: args.at(-1) === WINDOW_PROCESS ? focusWindowPid.code : focusWindowPidDescendant.code, stdout: '' }
    },
    kitty: FOUND,
    platform: 'linux',
    log: () => {},
    uid: UID,
    socketOwner: (path) => {
      owners.push(path)
      return path === '/tmp/kitty' ? UID : null
    },
    now: () => 0,
    socketId: () => null,
    ...over,
    front: () => front,
    processes: () => { reads++; return table() },
    tty,
  })
  return { calls, owners, adapter, reads: () => reads, toFront: (app: string | undefined) => { front = app } }
}

/** An agent in a multiplexer whose client is in a kitty window, as the outer lookup placed it. */
const outerPlace = (outer?: Place['outer'], hints: Record<string, string> = { KITTY_LISTEN_ON: env.KITTY_LISTEN_ON }): Place =>
  ({ host: 'herdr', app: 'kitty', hints, ...(outer ? { outer } : {}) })
const tab = (id: string) => ({ adapter: 'kitty-tab', id })
const CLIENT_TAB = tab(`${CLIENT}@${env.KITTY_LISTEN_ON}`)

describe("kitty's tab of an outer place", () => {
  it("a place in kitty by its client's process and the hinted socket is a tab after the app", () => {
    const { adapter, calls, owners } = tabRecorder()
    expect(adapter.id).toBe('kitty-tab')
    expect(adapter.tap).toBe('after')
    expect(adapter.paneOf(outerPlace({ app: 'kitty', tty: '/dev/pts/0', pid: CLIENT }))).toStrictEqual(CLIENT_TAB)
    expect(adapter.paneOf(outerPlace({ app: 'kitty', pid: CLIENT }, { KITTY_LISTEN_ON: 'unix:@mykitty' })))
      .toStrictEqual(tab(`${CLIENT}@unix:@mykitty`))
    expect(adapter.canFocus(CLIENT_TAB)).toBe(true)
    const notTabs: Array<Place['outer']> = [undefined, { app: 'wezterm', pid: CLIENT }, { app: 'kitty' },
      { app: 'kitty', tty: '/dev/pts/0' }, ...[0, -1, 1.5, 12345678901].map((pid) => ({ app: 'kitty', pid }))]
    for (const outer of notTabs) expect(adapter.paneOf(outerPlace(outer)), JSON.stringify(outer)).toBeUndefined()
    // No socket hint, or one out of form: no tab.
    const notSockets: Array<Record<string, string>> = [{}, { KITTY_LISTEN_ON: 'tcp:localhost:5000' }, { KITTY_LISTEN_ON: 'unix:/tmp/a b' },
      { KITTY_LISTEN_ON: '' }]
    for (const hints of notSockets) {
      expect(adapter.paneOf(outerPlace({ app: 'kitty', pid: CLIENT }, hints)), JSON.stringify(hints)).toBeUndefined()
    }
    for (const id of ['1432', '@unix:/tmp/kitty', '0@unix:/tmp/kitty', '1432@unix:kitty', '1432@', 'held:1432@unix:/tmp/kitty']) {
      expect(adapter.canFocus(tab(id)), id).toBe(false)
    }
    // An abstract socket is Linux's alone.
    const mac = tabRecorder({ platform: 'darwin' }).adapter
    expect(mac.paneOf(outerPlace({ app: 'kitty', pid: CLIENT }))).toStrictEqual(CLIENT_TAB)
    expect(mac.paneOf(outerPlace({ app: 'kitty', pid: CLIENT }, { KITTY_LISTEN_ON: 'unix:@mykitty' }))).toBeUndefined()
    const windows = tabRecorder({ platform: 'win32' }).adapter
    expect(windows.paneOf(outerPlace({ app: 'kitty', pid: CLIENT }))).toBeUndefined()
    expect(windows.canFocus(CLIENT_TAB)).toBe(false)
    expect(calls).toEqual([])
    expect(owners).toEqual([])
  })

  it('a rest only while kitty is in front', () => {
    const { adapter, toFront, calls } = tabRecorder()
    expect(adapter.canShow(CLIENT_TAB)).toBe(true)
    expect(adapter.canShow(tab('1432@unix:kitty'))).toBe(false)
    for (const app of ['wezterm', 'terminal-app', undefined]) {
      toFront(app)
      expect(adapter.canShow(CLIENT_TAB), String(app)).toBe(false)
    }
    expect(calls).toEqual([])
  })

  // `focus-window --match pid:` matches a window's own process alone, kitty's child (RECORDED_KITTY.focusWindowPid),
  // never one below it (focusWindowPidDescendant), and the match makes the window's tab active.
  it('show focuses the window whose own process holds the client', async () => {
    expect(focusWindowPid.tabActive).toBe(true)
    const { calls, adapter, reads } = tabRecorder()
    expect(await adapter.show(CLIENT_TAB, 'agent-1')).toBe('ok')
    expect(calls).toEqual([ran(focusWindowPid.args)])
    expect(reads()).toBe(1)
    // A client kitty started itself is its window's own process.
    expect(await adapter.focus(tab(`1430@${env.KITTY_LISTEN_ON}`))).toBe(true)
    expect(calls.slice(1)).toEqual([ran(focusWindowPid.args)])
    // macOS names kitty by its path.
    const mac = tabRecorder({ platform: 'darwin' }, async () =>
      KITTY_TABLE.map((p) => (p.executable === 'kitty' ? { ...p, executable: '/Applications/kitty.app/Contents/MacOS/kitty' } : p)))
    expect(await mac.adapter.show(CLIENT_TAB, 'agent-1')).toBe('ok')
    expect(mac.calls).toEqual([ran(focusWindowPid.args)])
  })

  // A terminal kitty does not list (xterm, Alacritty) opened from a kitty window leaves kitty the nearest app among the
  // client's parents, but kitty did not make the client's terminal: focusing the window that started it raises a
  // window the agent is not in.
  it('a client in a terminal started from a kitty window: no kitty window is focused', async () => {
    const table: ProcessName[] = [
      { pid: 1, ppid: 0, executable: 'init' },
      { pid: 1420, ppid: 1, executable: 'kitty' },
      { pid: 1430, ppid: 1420, executable: 'sh' },
      { pid: 1440, ppid: 1430, executable: 'xterm' },
      { pid: 1450, ppid: 1440, executable: 'sh' },
      { pid: 1460, ppid: 1450, executable: 'herdr' },
    ]
    const ttys = new Map([[1430, '/dev/pts/0'], [1440, '/dev/pts/0'], [1450, '/dev/pts/1'], [1460, '/dev/pts/1']])
    const { calls, adapter } = tabRecorder({}, async () => table, async (pid) => ttys.get(pid))
    const client = tab(`1460@${env.KITTY_LISTEN_ON}`)
    expect(await adapter.show(client, 'agent-1')).toBe('failed')
    expect(await adapter.focus(client)).toBe(false)
    expect(calls).toEqual([])
  })

  it("no kitty among the client's parents, or its terminal not read: nothing runs", async () => {
    const noKitty = KITTY_TABLE.map((p) => (p.executable === 'kitty' ? { ...p, executable: 'gnome-terminal-server' } : p))
    const tables = [async () => noKitty, async () => KITTY_TABLE.filter((p) => p.pid !== CLIENT),
      async (): Promise<ProcessName[]> => { throw new Error('process table not read') }]
    for (const table of tables) {
      const { calls, adapter } = tabRecorder({}, table)
      expect(await adapter.show(CLIENT_TAB, 'agent-1')).toBe('failed')
      expect(await adapter.focus(CLIENT_TAB)).toBe(false)
      expect(calls).toEqual([])
    }
    // The client's terminal could not be read: no maker, no window.
    const unread = tabRecorder({}, async () => KITTY_TABLE, async () => { throw new Error('tty not read') })
    expect(await unread.adapter.show(CLIENT_TAB, 'agent-1')).toBe('failed')
    expect(unread.calls).toEqual([])
  })

  // Another account's kitty would show that account's window. An abstract socket has no owner to read: a focus there
  // costs a look, never words, as the kitty adapter's own tap.
  it("a socket at a path not this account's: nothing runs; an abstract socket takes the focus", async () => {
    const theirs = tabRecorder({ socketOwner: () => 1001 })
    expect(await theirs.adapter.show(CLIENT_TAB, 'agent-1')).toBe('failed')
    expect(await theirs.adapter.focus(CLIENT_TAB)).toBe(false)
    expect(theirs.calls).toEqual([])
    expect(theirs.reads()).toBe(0)
    const abstract = tabRecorder()
    expect(await abstract.adapter.focus(tab(`${CLIENT}@unix:@mykitty`))).toBe(true)
    expect(abstract.calls).toEqual([ran(['kitten', '@', '--to', 'unix:@mykitty', 'focus-window', '--match', WINDOW_PROCESS])])
    expect(abstract.owners).toEqual([])
  })
})

describe('kitty as the core finds tmux', () => {
  /** A home of folders made for the spec: the devices' PATH, the core's install folder and Homebrew's prefix, each empty. */
  const homes: string[] = []
  const home = () => {
    const at = mkdtempSync(join(tmpdir(), 'kitty-finder-'))
    homes.push(at)
    for (const dir of ['path', 'bin', 'brew/bin']) mkdirSync(join(at, dir), { recursive: true })
    return { PATH: join(at, 'path'), HOME: at, HARNESS_BIN_DIR: join(at, 'bin'), HARNESS_HOMEBREW_PREFIXES: join(at, 'brew') }
  }
  const install = (dir: string, name = 'kitten') => {
    writeFileSync(join(dir, name), '#!/bin/sh\n')
    chmodSync(join(dir, name), 0o755)
    return join(dir, name)
  }
  const adopted = (path: string, from: FoundFrom) => ({ state: 'adopted', path, from })
  beforeEach(() => {
    shell.asked.length = 0
    shell.answer = null
    app.there = false
    app.asked = 0
  })
  afterAll(() => {
    for (const at of homes) rmSync(at, { recursive: true, force: true })
  })

  it('kitten on the devices\' PATH runs by its name, and no shell is asked', async () => {
    const where = home()
    install(where.PATH)
    install(where.PATH, 'kitty')
    expect(await kittyFinder(where, 'linux')()).toEqual({ state: 'present' })
    expect(shell.asked).toEqual([])
  })

  // The master hands the devices a PATH that holds no Homebrew folder under launchd, and none of the person's own.
  it('off the devices\' PATH, it is where the person\'s login shell finds kitten, asked once for every call', async () => {
    const where = home()
    shell.answer = '/home/u/.local/kitty.app/bin/kitten'
    const kitty = kittyFinder(where, 'linux')
    expect(await kitty()).toEqual(adopted('/home/u/.local/kitty.app/bin/kitten', 'login shell'))
    expect(await kitty()).toEqual(adopted('/home/u/.local/kitty.app/bin/kitten', 'login shell'))
    expect(shell.asked).toEqual(['kitten'])
  })

  it('else in a folder the core looks in', async () => {
    const where = home()
    const brew = install(join(where.HARNESS_HOMEBREW_PREFIXES, 'bin'))
    expect(await kittyFinder(where, 'darwin')()).toEqual(adopted(brew, 'standard install location'))
    const user = home()
    const local = install(user.HARNESS_BIN_DIR)
    expect(await kittyFinder(user, 'linux')()).toEqual(adopted(local, 'standard install location'))
  })

  it('else on macOS kitty.app\'s own kitten, and on Linux that is never looked for', async () => {
    app.there = true
    expect(await kittyFinder(home(), 'darwin')()).toEqual(adopted(APP_KITTEN, 'standard install location'))
    app.asked = 0
    const where = home()
    const kitty = install(where.PATH, 'kitty')
    expect(await kittyFinder(where, 'linux')()).toEqual(adopted(kitty, 'PATH'))
    expect(app.asked).toBe(0)
  })

  it('else kitty on the devices\' PATH, run by its path', async () => {
    const where = home()
    const kitty = install(where.PATH, 'kitty')
    expect(await kittyFinder(where, 'darwin')()).toEqual(adopted(kitty, 'PATH'))
    expect(shell.asked).toEqual(['kitten'])
  })

  it('none found is asked again once one is where the finder looks with no shell, and found there', async () => {
    const where = home()
    const kitty = kittyFinder(where, 'linux')
    expect((await kitty()).state).toBe('absent')
    // None there yet: nothing is asked again.
    expect((await kitty()).state).toBe('absent')
    expect(shell.asked).toEqual(['kitten'])
    const path = install(where.HARNESS_BIN_DIR)
    expect(await kitty()).toEqual(adopted(path, 'standard install location'))
    expect(shell.asked).toEqual(['kitten', 'kitten'])
    // Found, it holds.
    expect(await kitty()).toEqual(adopted(path, 'standard install location'))
    expect(shell.asked).toHaveLength(2)
  })

  it('none found is asked again once kitty is on the PATH', async () => {
    const where = home()
    const kitty = kittyFinder(where, 'linux')
    expect((await kitty()).state).toBe('absent')
    const path = install(where.PATH, 'kitty')
    expect(await kitty()).toEqual(adopted(path, 'PATH'))
  })
})

const REFUSED = '[device] kitty · focus refused'
const L = env.KITTY_LISTEN_ON
/** A second kitty of this account's, at a path as kitty.conf's `listen_on` makes one. */
const KB = 'unix:/tmp/kB'
const ABSTRACT = 'unix:@kitty'
/** Window [id] on socket [to], as paneOf gives an own one. */
const at = (id: string, to: string = L) => pane(`${id}@${to}`)
const alone = (id: string) => `id:${id} and state:focused`
const colorsOf = (match: string, to: string = L) => ['kitten', '@', '--to', to, 'get-colors', '--match', match]
/** A call of the focus read, as the adapter runs it: with the read's time left. */
const reading = (args: readonly string[], timeoutMs = FOCUS_READ_MS): Call => ({ ...ran(args), timeoutMs })
const matches = (calls: Call[]) => calls.map(({ args }) => args.at(-1))

describe("kitty's focused windows (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md)", () => {
  it('the recorder answers get-colors as the recorded kitty did', async () => {
    const { deps } = recorder()
    const asked = async ({ args }: { args: readonly string[] }) => deps.run(FAKE_KITTEN, args.slice(1), 1)
    expect(await asked(focusedMatch.focused)).toMatchObject({ code: 0, stderr: focusedMatch.focused.stderr })
    expect(await asked(focusedMatch.orFocused)).toMatchObject({ code: 0, stderr: focusedMatch.orFocused.stderr })
    expect(await asked(focusedMatch.notFocused)).toEqual({ code: 1, stdout: '', stderr: focusedMatch.notFocused.stderr })
    expect(await asked(focusedMatch.orNone)).toEqual({ code: 1, stdout: '', stderr: focusedMatch.orNone.stderr })
  })

  it('one call while focus stays on the pane asked first', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focusedWindows([OWN])).toEqual(new Map([[L, OWN.id]]))
    expect(calls).toEqual([reading(focusedMatch.focused.args)])
  })

  it('the first pane alone, then the rest in one or with parentheses, narrowed one id at a time', async () => {
    const { calls, focused, adapter } = recorder()
    focused.set(L, '3')
    expect(await adapter.focusedWindows([at('1'), at('2'), at('3')])).toEqual(new Map([[L, at('3').id]]))
    // The last left is asked alone too: focus may have moved since the `or`.
    expect(matches(calls)).toEqual([alone('1'), focusedMatch.orNone.args.at(-1), alone('2'), alone('3')])
    focused.set(L, '2')
    calls.length = 0
    expect(await adapter.focusedWindows([at('1'), at('2'), at('3')])).toEqual(new Map([[L, at('2').id]]))
    expect(matches(calls)).toEqual([alone('1'), 'state:focused and (id:2 or id:3)', alone('2')])
  })

  it('focus moved to another window after the or matched: null', async () => {
    const { calls, deps, focused, adapter } = recorder()
    focused.set(L, '3')
    const run = deps.run
    deps.run = async (...args) => {
      const answer = await run(...args)
      if (calls.length === 2) focused.set(L, '9')
      return answer
    }
    expect(await adapter.focusedWindows([at('1'), at('2'), at('3')])).toEqual(new Map([[L, null]]))
    expect(matches(calls)).toEqual([alone('1'), 'state:focused and (id:2 or id:3)', alone('2'), alone('3')])
  })

  it('focus on another window: two calls and null', async () => {
    const { calls, focused, adapter } = recorder()
    focused.set(L, '3')
    expect(await adapter.focusedWindows([at('1'), at('2')])).toEqual(new Map([[L, null]]))
    expect(calls).toEqual([reading(colorsOf(alone('1'))), reading(colorsOf(alone('2')))])
    calls.length = 0
    expect(await adapter.focusedWindows([at('1'), at('2'), at('4')])).toEqual(new Map([[L, null]]))
    expect(matches(calls)).toEqual([alone('1'), 'state:focused and (id:2 or id:4)'])
  })

  it('one pane, not focused: one call and null', async () => {
    const { calls, focused, adapter } = recorder()
    focused.set(L, '2')
    expect(await adapter.focusedWindows([OWN])).toEqual(new Map([[L, null]]))
    expect(calls).toEqual([reading(focusedMatch.focused.args)])
  })

  it("the caller's order: the pane it puts first is asked alone", async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focusedWindows([at('3'), at('1'), at('2')])).toEqual(new Map([[L, OWN.id]]))
    expect(matches(calls)).toEqual([alone('3'), 'state:focused and (id:1 or id:2)', alone('1')])
  })

  it('each socket its own entry, asked in the order its panes first come', async () => {
    const { calls, focused, ids, adapter } = recorder()
    ids.set('/tmp/kB', '2:1')
    focused.set(KB, '2')
    const answer = await adapter.focusedWindows([at('1', KB), OWN, at('2', KB)])
    expect([...answer!]).toEqual([[KB, at('2', KB).id], [L, OWN.id]])
    expect(calls).toEqual([reading(colorsOf(alone('1'), KB)), reading(colorsOf(alone('2'), KB)), reading(colorsOf(alone('1')))])
  })

  // Each pane is one call at most, and a socket's `or` one more once it has a third pane: on one socket, 15 panes.
  it('at most 16 calls', async () => {
    expect(FOCUS_CALLS_MAX).toBe(16)
    const many = recorder()
    many.focused.set(L, '16')
    const sixteen = Array.from({ length: 16 }, (_, i) => at(String(i + 1)))
    expect(await many.adapter.focusedWindows(sixteen)).toEqual(new Map([[L, null]]))
    for (const call of many.calls) expect(call.args.at(-1)).not.toMatch(/id:16\b/)
    const last = recorder()
    last.focused.set(L, '15')
    expect(await last.adapter.focusedWindows(sixteen)).toEqual(new Map([[L, at('15').id]]))
    expect(last.calls).toHaveLength(16)
    // Two panes a socket have no `or`: 16 panes on 8 sockets.
    const paired = recorder()
    const sockets = Array.from({ length: 9 }, (_, i) => `/tmp/k${i + 1}`)
    for (const [i, path] of sockets.entries()) {
      paired.ids.set(path, `3:${i}`)
      paired.focused.set(`unix:${path}`, '2')
    }
    const answer = await paired.adapter.focusedWindows(sockets.flatMap((path) => [at('1', `unix:${path}`), at('2', `unix:${path}`)]))
    expect(answer?.size).toBe(8)
    expect(paired.calls).toHaveLength(16)
  })

  it('one deadline for the read', async () => {
    const { calls, clock, focused, adapter } = recorder()
    focused.set(L, '3')
    clock.tick = 500
    await adapter.focusedWindows([at('1'), at('2'), at('3')])
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([2_000, 1_500, 1_000, 500])
    // The deadline is the read's own: the next starts with the whole time again.
    calls.length = 0
    focused.set(L, '2')
    clock.tick = FOCUS_READ_MS
    expect(await adapter.focusedWindows([at('1'), at('2')])).toBeUndefined()
    // The clock is at the deadline after the first call: the second is not started.
    expect(calls).toEqual([reading(colorsOf(alone('1')))])
  })

  it("only panes in form, of its own window and on a socket of this account's are asked", async () => {
    const { calls, focused, adapter } = recorder({ socketOwner: (path) => (path === '/tmp/kitty' ? UID : 1001) })
    focused.set(ABSTRACT, '1')
    expect(await adapter.focusedWindows([HELD, pane(`x@${L}`), pane('1@tcp:localhost:5000'), at('1', 'unix:/tmp/theirs')]))
      .toEqual(new Map())
    expect(calls).toEqual([])
    // Linux's abstract socket has no owner to read: it costs a look, as a tap does.
    expect(await adapter.focusedWindows([at('1', ABSTRACT)])).toEqual(new Map([[ABSTRACT, at('1', ABSTRACT).id]]))
    expect(calls).toEqual([reading(colorsOf(alone('1'), ABSTRACT))])
    const mac = recorder({ platform: 'darwin' })
    expect(await mac.adapter.focusedWindows([at('1', ABSTRACT)])).toEqual(new Map())
    expect(mac.calls).toEqual([])
  })

  const refusals: Array<[string, Partial<Answer>]> = [
    ['remote control off', remoteControlOff],
    ['a password kitty', focusedMatch.password],
    ['no kitty on the socket', noSocket],
    ['a timeout', { code: null }],
    ['exit 2', { code: 2, stderr: '' }],
    ['exit 1 with no stderr', { code: 1 }],
  ]
  it.each(refusals)('%s is undefined', async (_name, refusal) => {
    const { adapter } = recorder({}, { 'get-colors': { code: refusal.code, stderr: refusal.stderr } })
    expect(await adapter.focusedWindows([OWN])).toBeUndefined()
  })

  // kitty in password mode refused at once, asking the person nothing (focusedMatch.password); a refused socket is still
  // asked once a kitty start, so a refusing kitty is not asked twice a second, and a prompt an unrecorded version may
  // show comes once a start at most.
  describe('a refused socket is asked once a kitty start', () => {
    it('a refusal: that read is undefined, the next asks that socket nothing and answers no entry for it', async () => {
      const { calls, adapter } = recorder({}, { 'get-colors': focusedMatch.password })
      expect(await adapter.focusedWindows([OWN])).toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(await adapter.focusedWindows([OWN])).toEqual(new Map())
      expect(calls).toHaveLength(1)
    })

    it('a timeout (exit null) alike', async () => {
      const { calls, adapter } = recorder({}, { 'get-colors': { code: null } })
      expect(await adapter.focusedWindows([OWN])).toBeUndefined()
      expect(await adapter.focusedWindows([OWN])).toEqual(new Map())
      expect(calls).toHaveLength(1)
    })

    it('the same path with a new socket identity is asked again', async () => {
      const answer: Record<string, Partial<Answer>> = { 'get-colors': focusedMatch.password }
      const { calls, ids, adapter } = recorder({}, answer)
      await adapter.focusedWindows([OWN])
      expect(await adapter.focusedWindows([OWN])).toEqual(new Map())
      // A new kitty there, with remote control on.
      ids.set('/tmp/kitty', '1:2')
      delete answer['get-colors']
      expect(await adapter.focusedWindows([OWN])).toEqual(new Map([[L, OWN.id]]))
      expect(calls).toHaveLength(2)
    })

    it('an abstract socket refused, a read with no pane on it, then a pane on it again: asked again', async () => {
      const { calls, adapter } = recorder({}, { 'get-colors': focusedMatch.password })
      const abstract = at('1', ABSTRACT)
      expect(await adapter.focusedWindows([abstract])).toBeUndefined()
      expect(await adapter.focusedWindows([abstract])).toEqual(new Map())
      expect(calls).toHaveLength(1)
      expect(await adapter.focusedWindows([])).toEqual(new Map())
      expect(calls).toHaveLength(1)
      expect(await adapter.focusedWindows([abstract])).toBeUndefined()
      expect(calls).toEqual([reading(colorsOf(alone('1'), ABSTRACT)), reading(colorsOf(alone('1'), ABSTRACT))])
    })

    it('another socket keeps being asked', async () => {
      const { calls, ids, adapter } = recorder()
      // Ours, with no kitty listening: refused as noSocket.
      ids.set('/tmp/kB', '2:1')
      expect(await adapter.focusedWindows([at('1', KB), OWN])).toBeUndefined()
      expect(calls).toEqual([reading(colorsOf(alone('1'), KB)), reading(colorsOf(alone('1')))])
      for (let read = 0; read < 2; read++) {
        calls.length = 0
        expect(await adapter.focusedWindows([at('1', KB), OWN])).toEqual(new Map([[L, OWN.id]]))
        expect(calls).toEqual([reading(colorsOf(alone('1')))])
      }
    })

    it('the line once per refusal', async () => {
      const { logs, ids, adapter } = recorder({}, { 'get-colors': focusedMatch.password })
      for (let read = 0; read < 3; read++) await adapter.focusedWindows([OWN])
      expect(logs).toEqual([REFUSED])
      ids.set('/tmp/kitty', '1:2')
      expect(await adapter.focusedWindows([OWN])).toBeUndefined()
      expect(logs).toEqual([REFUSED, REFUSED])
    })

    // The poll stopped while the read ran (focusPoll.ts): its front is no longer followed.
    it('a read whose signal is aborted starts no more calls, marks nothing and says nothing', async () => {
      const { calls, deps, focused, logs, adapter } = recorder()
      focused.set(L, '9')
      const stop = new AbortController()
      const run = deps.run
      deps.run = async (...args) => {
        const answer = await run(...args)
        stop.abort()
        return answer
      }
      expect(await adapter.focusedWindows([at('1'), at('2'), at('3')], stop.signal)).toBeUndefined()
      expect(matches(calls)).toEqual([alone('1')])
      expect(logs).toEqual([])
      deps.run = run
      calls.length = 0
      expect(await adapter.focusedWindows([at('1'), at('2'), at('3')])).toEqual(new Map([[L, null]]))
      expect(calls).toHaveLength(2)
    })

    it('a read that ran out of time marks nothing', async () => {
      const { calls, clock, focused, logs, adapter } = recorder()
      focused.set(L, '2')
      clock.tick = FOCUS_READ_MS
      expect(await adapter.focusedWindows([at('1'), at('2')])).toBeUndefined()
      clock.tick = 0
      calls.length = 0
      expect(await adapter.focusedWindows([at('1'), at('2')])).toEqual(new Map([[L, at('2').id]]))
      expect(calls).toHaveLength(2)
      expect(logs).toEqual([])
    })

    // Two kittys: the first answers with half a millisecond of the read left, too little for the second's call, which
    // would time out (orca.ts' run gives it 1 ms) on a healthy kitty.
    it('a sliver of time left: the next socket is not asked and not marked', async () => {
      const { calls, clock, focused, ids, logs, adapter } = recorder()
      ids.set('/tmp/kB', '2:1')
      focused.set(KB, '2')
      clock.tick = FOCUS_READ_MS - 0.5
      expect(await adapter.focusedWindows([OWN, at('2', KB)])).toBeUndefined()
      expect(calls).toEqual([reading(colorsOf(alone('1')))])
      clock.tick = 0
      calls.length = 0
      expect(await adapter.focusedWindows([OWN, at('2', KB)])).toEqual(new Map([[L, OWN.id], [KB, at('2', KB).id]]))
      expect(calls).toHaveLength(2)
      expect(logs).toEqual([])
    })

    it('at most 16 refused sockets kept', async () => {
      const { calls, ids, logs, adapter } = recorder()
      const sockets = Array.from({ length: 17 }, (_, i) => `/tmp/k${i + 1}`)
      for (const [i, path] of sockets.entries()) ids.set(path, `3:${i}`)
      const on = (path: string) => at('1', `unix:${path}`)
      expect(await adapter.focusedWindows(sockets.slice(0, 16).map(on))).toBeUndefined()
      expect(await adapter.focusedWindows([on(sockets[16])])).toBeUndefined()
      expect(calls).toHaveLength(17)
      expect(logs).toEqual(Array(17).fill(REFUSED))
      // The first refused was dropped for the 17th, then the second for the first again; the third is still kept.
      expect(await adapter.focusedWindows([on(sockets[0])])).toBeUndefined()
      expect(calls).toHaveLength(18)
      expect(await adapter.focusedWindows([on(sockets[2])])).toEqual(new Map())
      expect(calls).toHaveLength(18)
    })
  })

  it('stdout is never read', async () => {
    const { adapter } = recorder({}, { 'get-colors': { code: 0, stdout: focusedMatch.notFocused.stderr } })
    expect(await adapter.focusedWindows([OWN])).toEqual(new Map([[L, OWN.id]]))
  })

  it('no kitty found runs nothing and is undefined', async () => {
    const { calls, adapter } = recorder({ kitty: ABSENT })
    expect(await adapter.focusedWindows([OWN])).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('no panes: an empty map, no call', async () => {
    const { calls, adapter } = recorder()
    expect(await adapter.focusedWindows([])).toEqual(new Map())
    expect(calls).toEqual([])
  })
})
