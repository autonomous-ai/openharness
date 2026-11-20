import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The mod against the engine: each hook here stands for what is beneath it (the launcher, the daemon's socket, the
// prompt box), and the clock moves only when a test moves it.
const HOME = '/home/dee'
const LOCAL = `${HOME}/.local/bin/harness`
const SOCKET = '/tmp/harnessd/daemon.sock'
const DEVICES = '/tmp/harnessd/devices.sock'
const SESSION = 'session-1'
const MINUTE = 60_000

type Answer = { status: number; text?: string } | 'reject' | ((clock: Clock) => Promise<{ status: number; text?: string }>)
type Clock = MockClock
/** A launcher run: how it exits and what it prints, or that it cannot start or is killed at its timeout. */
type Run = { exitCode: number; stdout: string } | 'cannot start' | 'killed'

type World = {
  clock: Clock
  /** The argv of each launcher the mod ran. */
  runs: string[][]
  /** The init of each launcher run, in the same order. */
  inits: unknown[]
  /** Each fetch the mod sent on the core's socket (any socket but the devices'): its URL and init. */
  polls: { url: string; init: unknown }[]
  /** Each fetch the mod sent on the devices' socket: its URL and init. */
  attaches: { url: string; init: unknown }[]
  /** The devicesSocket the launcher prints, '' for none. */
  devices: string
  /** Once set, what each launcher run does instead of the launcher's `link`. */
  relink?: (clock: Clock) => Promise<Run>
  /** Whether the devices' listener refuses the connection. */
  devicesRefuse: boolean
  /** Each prompt the mod submitted. */
  submitted: unknown[]
  /** The variables the mod asked for, by name. */
  envAsked: string[]
  /** In order, each timer of the mod's that fired and each poll it sent. */
  steps: ('timer' | 'poll')[]
  /** Whether Claude Code's user settings enable the plugin: `disable` uninstalls it, which drops the entry. */
  enabled: boolean
  /** The path of each file the mod read. */
  reads: string[]
  /** How long each read of a file takes, by the clock. */
  readMs: number
  /** How many processes the mod started with $.process.spawn: Windows' way, never this world's. */
  spawns: number
  /** Each variable the mod set, with its value. */
  envSet: [string, string | undefined][]
  /** How many times the hooks beneath the mod ran for a permission prompt: the plugin's own hook among them. */
  beneath: number
}

/**
 * Sets the world beneath the mod. `launchers` are the argv[0]s that start, and `exitCode` is what each exits with, as
 * the launcher's `link` exits 1 too while the plugin is off; `answers` are the daemon's answers, one per poll, the last
 * repeated. `configDir` is CLAUDE_CONFIG_DIR, and `settings: 'unreadable'` makes every read of a file fail. `devices` is
 * the devices' socket the launcher prints, '' for none. `platform` is the session's, macOS unless given.
 */
function world(
  on: On,
  { launchers = [LOCAL], exitCode = 0, answers, configDir, settings = 'readable', devices = DEVICES, platform = 'macos' }: {
    launchers?: string[]; exitCode?: number; answers: Answer[]; configDir?: string; settings?: 'readable' | 'unreadable'
    devices?: string; platform?: 'macos' | 'linux'
  },
): World {
  const steps: World['steps'] = []
  // Before the clock's own hook, so above it: it hears each of the mod's waits fire, just before the mod's function runs.
  on('clock.after', { ms: [0, MINUTE, 10 * MINUTE] }, async (_, e, next) => {
    const fired = await next(e)
    steps.push('timer')
    return fired
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  const w: World = {
    clock, runs: [], inits: [], polls: [], attaches: [], devices, devicesRefuse: false, submitted: [], envAsked: [], steps,
    enabled: true, reads: [], readMs: 0, spawns: 0, envSet: [], beneath: 0,
  }
  on('env.set', (_, e) => {
    w.envSet.push([e.name, e.value])
    return { value: {} }
  })
  on('classic.PermissionRequest', () => {
    w.beneath += 1
    return {}
  })
  on('session.info', () => ({ value: { transcriptPath: '', platform } }))
  on('process.spawn', async function* () {
    w.spawns += 1
    return { deny: 'not on this platform' }
  })
  const env: Record<string, string> = {
    HOME,
    ORCA_PAIRING_CODE: 'pairing-secret',
    ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-secret',
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  }
  on('env.get', (_, e) => {
    w.envAsked.push(e.name)
    return { value: env[e.name] }
  })
  on('fs.read', async (_, e) => {
    w.reads.push(e.path)
    if (w.readMs) await clock.sleep(w.readMs)
    if (settings === 'unreadable') return { deny: 'EACCES' }
    return { value: JSON.stringify({ enabledPlugins: w.enabled ? { 'harness-device@openharness': true } : {} }) }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', async (_, e) => {
    w.runs.push([...e.argv])
    w.inits.push(e.init)
    if (!launchers.includes(e.argv[0] ?? '')) return { deny: 'cannot start' }
    const run = w.relink ? await w.relink(clock) : undefined
    if (run === 'cannot start') return { deny: 'cannot start' }
    if (run === 'killed') return { deny: 'timed out' }
    const out = run ? { ...run, stderr: '' }
      : exitCode !== 0 ? { exitCode, stdout: '', stderr: 'Unknown command: device' }
      : !w.enabled ? { exitCode: 1, stdout: '', stderr: '' }
      : { exitCode, stdout: JSON.stringify({ socketPath: SOCKET, ...(w.devices ? { devicesSocket: w.devices } : {}) }), stderr: '' }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async (_, e) => {
    if (e.init?.socketPath === DEVICES) {
      w.attaches.push({ url: e.url, init: e.init })
      return w.devicesRefuse ? { deny: 'connect ECONNREFUSED' } : { value: { status: 200, ok: true, headers: {}, text: '' } }
    }
    w.polls.push({ url: e.url, init: e.init })
    w.steps.push('poll')
    const answer = answers[Math.min(w.polls.length, answers.length) - 1]
    if (answer === 'reject' || answer === undefined) return { deny: 'connect ECONNREFUSED' }
    const { status, text = '' } = typeof answer === 'function' ? await answer(clock) : answer
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
  on('prompt.submit', (_, e) => {
    w.submitted.push(e)
    return { text: e.text }
  })
  return w
}

async function start($: Engine, w: { clock: Clock }) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

/** Claude Code about to ask the person to allow a tool call: its PermissionRequest hooks run, the plugin's beneath. */
const prompt = ($: Engine) => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })

/** A poll the daemon holds `ms` before it answers `{}`. */
const held = (ms: number) => async (clock: Clock) => {
  await clock.sleep(ms)
  return { status: 200, text: '{}' }
}

test('a delivered text is submitted as the user, and the next poll opens at once', async ($, on) => {
  const w = world(on, { answers: [{ status: 200, text: JSON.stringify({ text: 'run the tests' }) }, held(25_000)] })
  await start($, w)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatchObject({ text: 'run the tests', origin: { asUser: true } })
  expect(w.polls).toHaveLength(2)
})

// A timer is the module's own: a reload cancels it, where a loop that went on in a continuation would outlive it.
test('every poll is sent from a timer of its own, after a text and after a hold alike', async ($, on) => {
  const text = { status: 200, text: JSON.stringify({ text: 'run the tests' }) }
  const w = world(on, { answers: [text, held(25_000), text, held(25_000)] })
  await start($, w)
  await w.clock.advance(25_000)
  await w.clock.advance(25_000)
  expect(w.polls).toHaveLength(5)
  expect(w.steps.join(' ')).toBe('timer timer poll timer poll timer poll timer poll timer poll')
})

test('an empty 200 after a hold polls again at once and submits nothing', async ($, on) => {
  const w = world(on, { answers: [held(25_000), held(25_000)] })
  await start($, w)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(25_000)
  expect(w.polls).toHaveLength(2)
  expect(w.submitted).toHaveLength(0)
})

test('an empty 200 that came back at once waits 60 s', async ($, on) => {
  const w = world(on, { answers: [{ status: 200, text: '{}' }] })
  await start($, w)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(MINUTE - 1)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.polls).toHaveLength(2)
})

test('no daemon: the fetch rejects, and the next try is 60 s later, not before', async ($, on) => {
  const w = world(on, { answers: ['reject'] })
  await start($, w)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(MINUTE - 1)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.polls).toHaveLength(2)
})

test('a 503 waits 60 s', async ($, on) => {
  const w = world(on, { answers: [{ status: 503 }] })
  await start($, w)
  await w.clock.advance(MINUTE - 1)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.polls).toHaveLength(2)
})

test('a 404 waits 10 minutes', async ($, on) => {
  const w = world(on, { answers: [{ status: 404 }] })
  await start($, w)
  await w.clock.advance(10 * MINUTE - 1)
  expect(w.polls).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.polls).toHaveLength(2)
})

test('no launcher in ~/.local/bin falls back to PATH', async ($, on) => {
  const w = world(on, { launchers: ['harness'], answers: [held(25_000)] })
  await start($, w)
  expect(w.runs).toEqual([
    [LOCAL, 'device', 'claude', 'link', '--json'],
    ['harness', 'device', 'claude', 'link', '--json'],
  ])
  expect(w.polls).toHaveLength(1)
})

test('no launcher at all stays idle and asks again in 60 s', async ($, on) => {
  const w = world(on, { launchers: [], answers: [held(25_000)] })
  await start($, w)
  expect(w.runs).toHaveLength(2)
  expect(w.polls).toHaveLength(0)
  await w.clock.advance(MINUTE - 1)
  expect(w.runs).toHaveLength(2)
  await w.clock.advance(1)
  expect(w.runs).toHaveLength(4)
  expect(w.polls).toHaveLength(0)
})

// An older Harness with no `device` word: no answer comes before an update.
test('a launcher that starts but exits non-zero is asked again in 10 minutes, not before', async ($, on) => {
  const w = world(on, { exitCode: 1, answers: [held(25_000)] })
  await start($, w)
  expect(w.runs).toHaveLength(1)
  await w.clock.advance(10 * MINUTE - 1)
  expect(w.runs).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.runs).toHaveLength(2)
  expect(w.polls).toHaveLength(0)
})

test('a HOME the engine refuses once is asked again in 60 s, and the mod still polls', async ($, on) => {
  let refused = false
  // Before the world's own env hook, so above it.
  on('env.get', { name: 'HOME' }, async (_, e, next) => {
    if (refused) return await next(e)
    refused = true
    throw new Error('env.get refused')
  })
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  expect(w.runs).toHaveLength(0)
  await w.clock.advance(MINUTE - 1)
  expect(w.runs).toHaveLength(0)
  await w.clock.advance(1)
  expect(w.runs).toEqual([[LOCAL, 'device', 'claude', 'link', '--json']])
  expect(w.polls).toHaveLength(1)
})

test('the poll goes over the socket path link printed, with only the session id in its body', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  expect(w.polls).toEqual([
    {
      url: 'http://harness/api/hook/inbox',
      init: {
        method: 'POST',
        socketPath: SOCKET,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION }),
      },
    },
  ])
})

test('with ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN set, neither is read', async ($, on) => {
  const w = world(on, { answers: [{ status: 200, text: JSON.stringify({ text: 'hi' }) }, held(25_000)] })
  await start($, w)
  await w.clock.advance(25_000)
  expect(new Set(w.envAsked)).toEqual(new Set(['HOME', 'CLAUDE_CONFIG_DIR']))
})

// A session started before `harness device claude disable` keeps the mod loaded: it reads the plugin is off and goes
// idle, as with a launcher that has no socket.
test('disabled while a poll is held: its text is not submitted, link answers off and no poll follows', async ($, on) => {
  const said = async (clock: Clock) => {
    await clock.sleep(10_000)
    return { status: 200, text: JSON.stringify({ text: 'run the tests' }) }
  }
  const w = world(on, { answers: [said, held(25_000)] })
  await start($, w)
  expect(w.polls).toHaveLength(1)
  w.enabled = false
  await w.clock.advance(10_000)
  expect(w.submitted).toHaveLength(0)
  expect(w.runs).toHaveLength(2)
  await w.clock.advance(10 * MINUTE - 1)
  expect(w.runs).toHaveLength(2)
  expect(w.polls).toHaveLength(1)
})

test('enabled again: the next link polls and submits again', async ($, on) => {
  const text = { status: 200, text: JSON.stringify({ text: 'run the tests' }) }
  const w = world(on, { answers: [held(25_000), text, held(25_000)] })
  await start($, w)
  w.enabled = false
  await w.clock.advance(25_000)
  expect(w.runs).toHaveLength(2)
  w.enabled = true
  await w.clock.advance(10 * MINUTE)
  expect(w.runs).toHaveLength(3)
  expect(w.polls).toHaveLength(3)
  expect(w.submitted).toHaveLength(1)
})

test('each poll costs one read, of ~/.claude/settings.json', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  await w.clock.advance(25_000)
  await w.clock.advance(25_000)
  expect(w.polls).toHaveLength(3)
  expect(w.reads).toEqual([`${HOME}/.claude/settings.json`, `${HOME}/.claude/settings.json`])
})

test('with CLAUDE_CONFIG_DIR set, the settings are read there', async ($, on) => {
  const w = world(on, { answers: [held(25_000)], configDir: '/home/dee/profile-b' })
  await start($, w)
  await w.clock.advance(25_000)
  expect(w.reads).toEqual(['/home/dee/profile-b/settings.json'])
})

test('settings it cannot read keep the mod as it was: the text is submitted', async ($, on) => {
  const w = world(on, { answers: [{ status: 200, text: JSON.stringify({ text: 'run the tests' }) }, held(25_000)], settings: 'unreadable' })
  await start($, w)
  expect(w.submitted).toHaveLength(1)
  expect(w.polls).toHaveLength(2)
})

// The Claude app showing this session: the mod tells the devices, on their own socket, so the dial can turn to it.
const LINK = ['device', 'claude', 'link', '--json']
const ATTACH = {
  url: 'http://harness/',
  init: {
    method: 'POST',
    socketPath: DEVICES,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'attach', sessionId: SESSION }),
  },
}
const attach = ($: Engine, surface: 'desktop' | 'mobile' | 'vscode' | 'terminal' = 'desktop') =>
  $.session.attach({ surface, clientId: `${surface}:default` })
const detach = ($: Engine) => $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
/** The launcher's answer once it prints the devices' socket. */
const withDevices: Run = { exitCode: 0, stdout: JSON.stringify({ socketPath: SOCKET, devicesSocket: DEVICES }) }
/** A launcher that answers `run` `ms` after it is asked. */
const slow = (ms: number, run: Run) => async (clock: Clock) => {
  await clock.sleep(ms)
  return run
}

test('an attach on the desktop surface tells the devices its own session id, and nothing else', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toEqual([ATTACH])
})

test('the attach is sent from a timer, never inside the hook', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  await attach($)
  expect(w.attaches).toHaveLength(0)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(1)
})

test('a detach, and an attach on the mobile, vscode or terminal surface, send nothing', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  await detach($)
  await attach($, 'mobile')
  await attach($, 'vscode')
  await attach($, 'terminal')
  await w.clock.settle()
  expect(w.attaches).toHaveLength(0)
})

test('an attach before the mod has linked is sent once it links, the latest only', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await attach($)
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toEqual([ATTACH])
})

test('a detach on another surface keeps the desktop attach held', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await attach($)
  await $.session.detach({ surface: 'mobile', clientId: 'mobile:default', reason: 'detach' })
  await w.clock.settle()
  expect(w.attaches).toEqual([ATTACH])
})

test('attached and detached again before the link: nothing is sent', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await attach($)
  await detach($)
  await w.clock.settle()
  expect(w.polls).toHaveLength(1)
  expect(w.attaches).toHaveLength(0)
})

test('an attach before the link, with no devicesSocket, runs the launcher once', async ($, on) => {
  const w = world(on, { answers: [held(25_000)], devices: '' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await attach($)
  await w.clock.settle()
  expect(w.runs).toEqual([[LOCAL, ...LINK]])
  expect(w.attaches).toHaveLength(0)
  // Still held: the next attach asks again.
  w.devices = DEVICES
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
  expect(w.attaches).toEqual([ATTACH])
})

test('an attach with no devicesSocket asks the launcher again, and the devices are told once it prints one', async ($, on) => {
  const w = world(on, { answers: [held(25_000)], devices: '' })
  await start($, w)
  w.devices = DEVICES
  await attach($)
  await w.clock.settle()
  expect(w.runs).toEqual([[LOCAL, ...LINK], [LOCAL, ...LINK]])
  expect(w.inits[1]).toEqual({ timeoutMs: 5_000 })
  expect(w.attaches).toEqual([ATTACH])
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
  expect(w.attaches).toEqual([ATTACH, ATTACH])
})

// A reload while the launcher is asked cancels the module's timers: the send its answer allows waits on one too.
test('the attach the launcher allows is sent from a timer of its own', async ($, on) => {
  const order: string[] = []
  // Before the world's own, so above it: each timer that fires, with the attaches sent by then.
  on('clock.after', { ms: [0] }, async (_, e, next) => {
    const fired = await next(e)
    order.push(`timer, ${w.attaches.length} sent`)
    return fired
  })
  const w = world(on, { answers: [held(25_000)], devices: '' })
  await start($, w)
  order.length = 0
  w.relink = async () => {
    order.push('launcher')
    return withDevices
  }
  await attach($)
  await w.clock.settle()
  expect(order).toEqual(['timer, 0 sent', 'launcher', 'timer, 0 sent'])
  expect(w.attaches).toEqual([ATTACH])
})

test('only the launcher that linked is asked again', async ($, on) => {
  const w = world(on, { launchers: ['harness'], answers: [held(25_000)], devices: '' })
  await start($, w)
  const asked = [...w.envAsked]
  w.devices = DEVICES
  await attach($)
  await w.clock.settle()
  expect(w.runs).toEqual([[LOCAL, ...LINK], ['harness', ...LINK], ['harness', ...LINK]])
  expect(w.envAsked).toEqual(asked)
  expect(w.attaches).toEqual([ATTACH])
})

test('a second attach within 30 s does not ask again, and one after 30 s does', async ($, on) => {
  const w = world(on, { answers: [held(25_000)], devices: '' })
  await start($, w)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
  await w.clock.advance(29_999)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
  await w.clock.advance(1)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(3)
  expect(w.attaches).toHaveLength(0)
})

const failed: Record<string, (clock: Clock) => Promise<Run>> = {
  'exits 1': async () => ({ exitCode: 1, stdout: '' }),
  'cannot start': async () => 'cannot start',
  'prints no JSON': async () => ({ exitCode: 0, stdout: '{' }),
  'prints socketPath alone': async () => ({ exitCode: 0, stdout: JSON.stringify({ socketPath: SOCKET }) }),
  'is killed at its 5 s': slow(5_000, 'killed'),
}
for (const [how, run] of Object.entries(failed)) {
  test(`a launcher that ${how} sends nothing, and the polls go on`, async ($, on) => {
    const w = world(on, { answers: [{ status: 200, text: '{}' }], devices: '' })
    await start($, w)
    expect(w.polls).toHaveLength(1)
    w.relink = run
    await attach($)
    await w.clock.settle()
    await w.clock.advance(5_000)
    expect(w.runs).toEqual([[LOCAL, ...LINK], [LOCAL, ...LINK]])
    expect(w.attaches).toHaveLength(0)
    await w.clock.advance(MINUTE - 5_000 - 1)
    expect(w.polls).toHaveLength(1)
    await w.clock.advance(1)
    expect(w.polls).toHaveLength(2)
    expect(w.attaches).toHaveLength(0)
  })
}

test('shown and left again while the launcher is asked: nothing is sent', async ($, on) => {
  const w = world(on, { answers: [held(25_000)], devices: '' })
  await start($, w)
  w.relink = slow(1_000, withDevices)
  await attach($)
  await w.clock.settle()
  await detach($)
  await w.clock.advance(1_000)
  expect(w.runs).toHaveLength(2)
  expect(w.attaches).toHaveLength(0)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
  expect(w.attaches).toEqual([ATTACH])
})

// The send reads the settings before it tells the devices: what came during that read decides.
test('while the settings are read: left again sends nothing, and shown twice is told once', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  w.readMs = 1_000
  await attach($)
  await w.clock.settle()
  await detach($)
  await w.clock.advance(1_000)
  expect(w.attaches).toHaveLength(0)
  await attach($)
  await attach($)
  await w.clock.settle()
  await w.clock.advance(1_000)
  expect(w.attaches).toEqual([ATTACH])
})

// The launcher read the plugin on before `disable`; the poll that read it off has unlinked the mod since.
test('switched off while the launcher is asked: its answer sends nothing', async ($, on) => {
  const w = world(on, { answers: [held(2_000)], devices: '' })
  await start($, w)
  let asked = 0
  w.relink = async (clock) => {
    asked += 1
    if (asked > 1) return { exitCode: 1, stdout: '' }
    await clock.sleep(5_000)
    return withDevices
  }
  await attach($)
  await w.clock.settle()
  w.enabled = false
  await w.clock.advance(2_000)
  expect(w.runs).toHaveLength(3)
  await w.clock.advance(3_000)
  expect(w.attaches).toHaveLength(0)
  await w.clock.advance(10 * MINUTE)
  expect(w.attaches).toHaveLength(0)
})

test('an attach while the launcher is asked is told once, when it answers', async ($, on) => {
  const w = world(on, { answers: [held(25_000)], devices: '' })
  await start($, w)
  w.relink = slow(1_000, withDevices)
  await attach($)
  await w.clock.settle()
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(0)
  await w.clock.advance(1_000)
  expect(w.runs).toHaveLength(2)
  expect(w.attaches).toEqual([ATTACH])
})

test('a mod that never linked asks nothing at an attach', async ($, on) => {
  const w = world(on, { exitCode: 1, answers: [held(25_000)] })
  await start($, w)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toEqual([[LOCAL, ...LINK]])
  expect(w.attaches).toHaveLength(0)
})

test('a failed send is dropped', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  w.devicesRefuse = true
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(1)
  await w.clock.advance(10 * MINUTE)
  expect(w.attaches).toHaveLength(1)
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(2)
})

test('with the plugin switched off nothing is sent', async ($, on) => {
  const w = world(on, { answers: [held(10_000)] })
  await start($, w)
  w.enabled = false
  await w.clock.advance(10_000)
  expect(w.runs).toHaveLength(2)
  await attach($)
  await w.clock.advance(10 * MINUTE)
  expect(w.attaches).toHaveLength(0)
})

test('switched off while a poll is held: an attach sends nothing', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  w.enabled = false
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(0)
  await w.clock.advance(25_000)
  await w.clock.advance(10 * MINUTE)
  expect(w.attaches).toHaveLength(0)
})

test('an attach told is not told again once the plugin is switched off and on', async ($, on) => {
  const w = world(on, { answers: [held(10_000)] })
  await start($, w)
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toEqual([ATTACH])
  w.enabled = false
  await w.clock.advance(10_000)
  expect(w.runs).toHaveLength(2)
  w.enabled = true
  await w.clock.advance(10 * MINUTE)
  expect(w.runs).toHaveLength(3)
  expect(w.attaches).toEqual([ATTACH])
})

test('switched off and on again: the session the app still shows is told once the mod links', async ($, on) => {
  const w = world(on, { answers: [held(10_000)] })
  await start($, w)
  w.enabled = false
  await w.clock.advance(10_000)
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(0)
  w.enabled = true
  await w.clock.advance(10 * MINUTE)
  expect(w.runs).toHaveLength(3)
  expect(w.attaches).toEqual([ATTACH])
})

// The send noticing the plugin off before the poll does keeps the attach as the poll noticing it first would.
test('switched off during a held poll, then an attach: told once the mod links again', async ($, on) => {
  const w = world(on, { answers: [held(10_000)] })
  await start($, w)
  w.enabled = false
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(0)
  await w.clock.advance(10_000)
  expect(w.runs).toHaveLength(2)
  w.enabled = true
  await w.clock.advance(10 * MINUTE)
  expect(w.runs).toHaveLength(3)
  expect(w.attaches).toEqual([ATTACH])
  await w.clock.advance(10_000)
  expect(w.attaches).toEqual([ATTACH])
})

test("the polls go on the core's socket alone and the attach on the devices' alone", async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  await attach($)
  await w.clock.advance(25_000)
  await w.clock.advance(25_000)
  expect(w.polls).toHaveLength(3)
  for (const poll of w.polls) expect(poll).toMatchObject({ url: 'http://harness/api/hook/inbox', init: { socketPath: SOCKET } })
  expect(w.attaches).toEqual([ATTACH])
})

test('only HOME and CLAUDE_CONFIG_DIR are read with an attach sent', async ($, on) => {
  const w = world(on, { answers: [held(25_000)] })
  await start($, w)
  await attach($)
  await w.clock.settle()
  expect(w.attaches).toHaveLength(1)
  expect(new Set(w.envAsked)).toEqual(new Set(['HOME', 'CLAUDE_CONFIG_DIR']))
})

for (const platform of ['macos', 'linux'] as const) {
  test(`on ${platform} the mod links and polls over the sockets, and starts no process of its own`, async ($, on) => {
    const w = world(on, { answers: [held(25_000)], platform })
    await start($, w)
    await attach($)
    await w.clock.advance(25_000)
    expect(w.runs).toEqual([[LOCAL, ...LINK]])
    expect(w.polls).toHaveLength(2)
    expect(w.attaches).toEqual([ATTACH])
    expect(w.spawns).toBe(0)
  })

  // The plugin's hook tells there, as before the mod heard the prompt: a second tell would ring the dial twice.
  test(`on ${platform} a permission prompt is the hook's to tell: the mod sets nothing and runs nothing`, async ($, on) => {
    const w = world(on, { answers: [held(25_000)], platform })
    await start($, w)
    await prompt($)
    await w.clock.settle()
    expect(w.beneath).toBe(1)
    expect(w.runs).toEqual([[LOCAL, ...LINK]])
    expect(w.envSet).toEqual([])
  })
}

// Windows: Claude Code's mods reach no pipe and have no HMAC (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 2),
// so the mod runs the harness command, which proves the tokens in its own process: `inbox` holds the session's poll and
// prints a JSON line for each answer, and `attach` tells the devices the app shows the session. Each `process.spawn`
// here is one `inbox` run, printing what the test gives it.
const PROFILE = "C:\\Users\\Nguyễn Văn A' & 100%"
const EXE = `${PROFILE}\\.harness\\bin\\harness.exe`
const SETTINGS = `${PROFILE}\\.claude\\settings.json`
const INBOX = ['device', 'claude', 'inbox', SESSION]
const TELL = ['device', 'claude', 'attach', SESSION]
/** A child that runs past the end of any test. */
const HOLD = 24 * 60 * MINUTE
const line = (said: object) => `${JSON.stringify(said)}\n`
/** The path the mod gave a $.fs call: off Windows the kit resolves `C:\…` against the plugin's folder, as relative. */
const asked = (path: string) => path.slice(path.indexOf('C:\\'))
/** One `inbox` run: in order, a piece on stdout (a string), one on stderr, or a wait in ms; then it exits 0. */
type Child = (string | number | { stderr: string })[] | 'cannot start'
/** One `inbox` the mod started: its argv and folder, when, and whether the mod left its loop before it exited. */
type Spawned = { argv: string[]; cwd: string | undefined; at: number; left: boolean }

type WindowsWorld = {
  clock: Clock
  spawns: Spawned[]
  /** Each `attach` the mod ran: its argv and init. */
  runs: { argv: string[]; init: unknown }[]
  /** What each `attach` run does: it prints `{"sent":true}` unless a test says otherwise. */
  attach: (clock: Clock) => Promise<Run>
  /** Whether the install's harness.exe is in the profile. */
  installed: boolean
  /** Each path the mod asked $.fs.exists about. */
  looked: string[]
  submitted: unknown[]
  reads: string[]
  envAsked: string[]
  /** How many fetches the mod sent: none reach a pipe from here. */
  fetches: number
  enabled: boolean
  /** In order, each timer of the mod's that fired and each `inbox` it started. */
  steps: ('timer' | 'spawn')[]
  /** Each variable the mod set, with its value. */
  envSet: [string, string | undefined][]
  /** What each $.env.set answers: made, held by the engine (`{ deny }` resolved), or refused (rejected). */
  envSetAnswer: 'made' | 'held' | 'refused'
  /** Each time the hooks beneath the mod ran for a permission prompt: their input, and the variables set by then. */
  beneath: { e: unknown; set: [string, string | undefined][] }[]
}

/** The world beneath the mod on Windows: `children` are the `inbox` runs, one per spawn, the last repeated. */
function windows(on: On, { children, configDir }: { children: Child[]; configDir?: string }): WindowsWorld {
  const steps: WindowsWorld['steps'] = []
  // Before the clock's own hook, so above it: it hears each of the mod's waits fire, just before the mod's function runs.
  on('clock.after', { ms: [0, 1_000, 2_000, 4_000, 8_000, 16_000, MINUTE, 10 * MINUTE] }, async (_, e, next) => {
    const fired = await next(e)
    steps.push('timer')
    return fired
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  const w: WindowsWorld = {
    clock, spawns: [], runs: [], attach: async () => ({ exitCode: 0, stdout: '{"sent":true}\n' }), installed: true,
    looked: [], submitted: [], reads: [], envAsked: [], fetches: 0, enabled: true, steps, envSet: [], envSetAnswer: 'made',
    beneath: [],
  }
  on('env.set', (_, e) => {
    if (w.envSetAnswer === 'refused') return { deny: 'refused' }
    if (w.envSetAnswer === 'held') return { value: { deny: 'held by the organization' } }
    w.envSet.push([e.name, e.value])
    return { value: {} }
  })
  on('classic.PermissionRequest', (_, e) => {
    w.beneath.push({ e, set: [...w.envSet] })
    return {}
  })
  const env: Record<string, string> = {
    USERPROFILE: PROFILE,
    HOME: PROFILE,
    ORCA_PAIRING_CODE: 'pairing-secret',
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  }
  on('session.info', () => ({ value: { transcriptPath: '', platform: 'windows' } }))
  on('env.get', (_, e) => {
    w.envAsked.push(e.name)
    return { value: env[e.name] }
  })
  on('fs.exists', (_, e) => {
    w.looked.push(asked(e.path))
    return { value: w.installed && asked(e.path) === EXE }
  })
  on('fs.read', (_, e) => {
    w.reads.push(asked(e.path))
    return { value: JSON.stringify({ enabledPlugins: w.enabled ? { 'harness-device@openharness': true } : {} }) }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
  on('session.id', () => ({ value: SESSION }))
  on('process.spawn', async function* (_, e) {
    const spawned: Spawned = { argv: [...e.argv], cwd: e.cwd, at: clock.now(), left: false }
    w.spawns.push(spawned)
    steps.push('spawn')
    const child = children[Math.min(w.spawns.length, children.length) - 1]!
    if (child === 'cannot start') return { deny: `ENOENT: Command '${e.argv[0]}' not found` }
    let exited = false
    try {
      for (const step of child) {
        if (typeof step === 'number') await clock.sleep(step)
        else if (typeof step === 'string') yield { stream: 'stdout' as const, text: step }
        else yield { stream: 'stderr' as const, text: step.stderr }
      }
      exited = true
      return { value: { code: 0, signal: null } }
    } finally {
      spawned.left = !exited
    }
  })
  on('process.run', async (_, e) => {
    w.runs.push({ argv: [...e.argv], init: e.init })
    const run = await w.attach(clock)
    if (run === 'cannot start') return { deny: 'cannot start' }
    if (run === 'killed') return { deny: 'timed out' }
    return { value: { ...run, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', () => {
    w.fetches += 1
    return { deny: 'a network location is not reached from here' }
  })
  on('prompt.submit', (_, e) => {
    w.submitted.push(e)
    return { text: e.text }
  })
  return w
}

/** The time between each `inbox` start and the next. */
const gaps = (w: WindowsWorld) => w.spawns.slice(1).map((spawned, i) => spawned.at - w.spawns[i]!.at)
const texts = (w: WindowsWorld) => w.submitted.map((submitted) => (submitted as { text: string }).text)

test("on Windows the follower is the install's harness.exe, run in the profile, with the session id", async ($, on) => {
  const w = windows(on, { children: [[HOLD]] })
  await start($, w)
  expect(w.spawns.map(({ argv, cwd }) => ({ argv, cwd }))).toEqual([{ argv: [EXE, ...INBOX], cwd: PROFILE }])
  expect(w.looked).toEqual([EXE])
})

test('no harness.exe in the profile: harness on PATH', async ($, on) => {
  const w = windows(on, { children: [[HOLD]] })
  w.installed = false
  await start($, w)
  expect(w.spawns.map(({ argv, cwd }) => ({ argv, cwd }))).toEqual([{ argv: ['harness', ...INBOX], cwd: PROFILE }])
})

test('harness on no PATH: looked for again every 60 s, outside the restart bound', async ($, on) => {
  const w = windows(on, { children: ['cannot start'] })
  w.installed = false
  await start($, w)
  expect(w.spawns).toHaveLength(1)
  await w.clock.advance(MINUTE - 1)
  expect(w.spawns).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.spawns).toHaveLength(2)
  expect(w.looked).toEqual([EXE, EXE])
  await w.clock.advance(6 * MINUTE)
  expect(gaps(w)).toEqual(Array(7).fill(MINUTE))
})

test('a text cut across two pieces is submitted once, whole, as the user', async ($, on) => {
  const said = 'hi & 100% "x"\nnext'
  const whole = line({ text: said })
  const w = windows(on, { children: [[whole.slice(0, 5), whole.slice(5), HOLD]] })
  await start($, w)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatchObject({ text: said, origin: { asUser: true } })
})

test('two lines in one piece are two submits, in order', async ($, on) => {
  const w = windows(on, { children: [[line({ text: 'one' }) + line({ text: 'two' }), HOLD]] })
  await start($, w)
  expect(texts(w)).toEqual(['one', 'two'])
})

test('a hold that ended with nothing, a line of another shape and stderr submit nothing, and the follower runs on', async ($, on) => {
  const w = windows(on, {
    children: [['{}\n', 'not json\n', 'null\n', '[1]\n', line({ text: '' }), '{"text":', { stderr: 'x\n' }, '"hi"}\n', HOLD]],
  })
  await start($, w)
  expect(texts(w)).toEqual(['hi'])
  await w.clock.advance(10 * MINUTE)
  expect(w.spawns).toHaveLength(1)
})

test('the plugin off in the settings: a text submits nothing', async ($, on) => {
  const w = windows(on, { children: [[HOLD, line({ text: 'run the tests' }), HOLD]] })
  await start($, w)
  w.enabled = false
  await w.clock.advance(HOLD)
  expect(w.reads).toEqual([SETTINGS])
  expect(w.submitted).toHaveLength(0)
})

test('with CLAUDE_CONFIG_DIR set, the settings are read there', async ($, on) => {
  const w = windows(on, { children: [[line({ text: 'hi' }), HOLD]], configDir: 'C:\\Users\\dee\\profile-b' })
  await start($, w)
  expect(w.reads).toEqual(['C:\\Users\\dee\\profile-b\\settings.json'])
})

test('{"off":true}, then the end: the next follower 10 minutes later, not before', async ($, on) => {
  const w = windows(on, { children: [['{"off":true}\n'], [HOLD]] })
  await start($, w)
  await w.clock.advance(10 * MINUTE - 1)
  expect(w.spawns).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.spawns).toHaveLength(2)
})

const quick: Record<string, Child> = { 'exits at once': [], 'cannot start': 'cannot start' }
for (const [how, child] of Object.entries(quick)) {
  test(`a harness.exe that ${how}: again after 1, 2, 4, 8 and 16 s, the sixth after 10 minutes, then 1 s`, async ($, on) => {
    const w = windows(on, { children: [child] })
    await start($, w)
    await w.clock.advance(31_000 + 10 * MINUTE + 1_000)
    expect(gaps(w)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 10 * MINUTE, 1_000])
  })
}

test('a follower that ran 60 s starts again after 1 s, and the count starts over; one that ran less is a quick end', async ($, on) => {
  const w = windows(on, { children: [[], [MINUTE - 1], [MINUTE], []] })
  await start($, w)
  await w.clock.advance(1_000 + MINUTE - 1 + 2_000 + MINUTE + 1_000 + 1_000 + 2_000)
  expect(gaps(w)).toEqual([1_000, MINUTE - 1 + 2_000, MINUTE + 1_000, 1_000, 2_000])
})

test('a line over 131,072 characters leaves the loop, and the follower starts again by the bound', async ($, on) => {
  const w = windows(on, { children: [['x'.repeat(100_000), 'x'.repeat(31_073), HOLD], [HOLD]] })
  await start($, w)
  expect(w.spawns[0]!.left).toBe(true)
  await w.clock.advance(999)
  expect(w.spawns).toHaveLength(1)
  await w.clock.advance(1)
  expect(w.spawns).toHaveLength(2)
})

test('a line of 131,072 characters is read and the follower runs on', async ($, on) => {
  const w = windows(on, { children: [['x'.repeat(131_072), '\n', line({ text: 'hi' }), HOLD]] })
  await start($, w)
  expect(w.spawns[0]!.left).toBe(false)
  expect(texts(w)).toEqual(['hi'])
})

test('every follower starts from a timer of its own', async ($, on) => {
  const w = windows(on, { children: [[], [HOLD]] })
  await start($, w)
  await w.clock.advance(1_000)
  expect(w.steps.join(' ')).toBe('timer spawn timer spawn')
})

test('one follower per session: two attaches and a detach start none', async ($, on) => {
  const w = windows(on, { children: [[HOLD]] })
  await start($, w)
  await attach($)
  await attach($)
  await detach($)
  await w.clock.advance(10 * MINUTE)
  expect(w.spawns).toHaveLength(1)
})

// The attach's cases hold no child: the kit waits a second of real time at each step while one runs.
const EXITS: Child[] = [[]]

test('an attach runs harness.exe attach in the profile once, and the app back on the session runs it again', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  await attach($)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toEqual([{ argv: [EXE, ...TELL], init: { timeoutMs: 5_000, cwd: PROFILE } }])
  await detach($)
  await attach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
})

test('an attach and a detach before its timer run nothing', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  await attach($)
  await detach($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(0)
})

const notSent: Record<string, (clock: Clock) => Promise<Run>> = {
  'prints {"sent":false}': async () => ({ exitCode: 0, stdout: '{"sent":false}\n' }),
  'prints another line': async () => ({ exitCode: 0, stdout: '{}\n' }),
  'exits non-zero': async () => ({ exitCode: 4, stdout: '' }),
  'cannot start': async () => 'cannot start',
  'is killed at its 5 s': slow(5_000, 'killed'),
}
for (const [how, run] of Object.entries(notSent)) {
  test(`an attach that ${how} is held: an attach within 30 s runs nothing, one after runs again`, async ($, on) => {
    const w = windows(on, { children: EXITS })
    await start($, w)
    w.attach = run
    await attach($)
    await w.clock.settle()
    expect(w.runs).toHaveLength(1)
    await w.clock.advance(29_999)
    await attach($)
    await w.clock.settle()
    expect(w.runs).toHaveLength(1)
    await w.clock.advance(1)
    await attach($)
    await w.clock.settle()
    expect(w.runs).toHaveLength(2)
  })
}

test('a detach while the attach runs: nothing runs after it', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  w.attach = slow(1_000, { exitCode: 0, stdout: '{"sent":false}\n' })
  await attach($)
  await w.clock.settle()
  await detach($)
  await w.clock.advance(10 * MINUTE)
  expect(w.runs).toHaveLength(1)
})

test('an attach before the session start learns it runs on Windows: told once it does', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await attach($)
  await start($, w)
  expect(w.runs).toEqual([{ argv: [EXE, ...TELL], init: { timeoutMs: 5_000, cwd: PROFILE } }])
})

// The app on this session, on another and back within the run: the devices last heard of the other, so it runs again.
test('left and shown again while an attach that tells runs: it runs once more when it ends', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  w.attach = slow(1_000, { exitCode: 0, stdout: '{"sent":true}\n' })
  await attach($)
  await w.clock.settle()
  await detach($)
  await attach($)
  await w.clock.advance(1_000)
  expect(w.runs).toHaveLength(2)
  await w.clock.advance(10 * MINUTE)
  expect(w.runs).toHaveLength(2)
})

test('no fetch at all, only the settings file is read, and only USERPROFILE and CLAUDE_CONFIG_DIR', async ($, on) => {
  const w = windows(on, { children: [[line({ text: 'hi' }), '{}\n', MINUTE], ['{"off":true}\n']] })
  await start($, w)
  await attach($)
  await w.clock.advance(20 * MINUTE)
  expect(w.spawns.length).toBeGreaterThan(2)
  expect(w.runs).toHaveLength(1)
  expect(w.fetches).toBe(0)
  expect(new Set(w.reads)).toEqual(new Set([SETTINGS]))
  expect(new Set(w.envAsked)).toEqual(new Set(['USERPROFILE', 'CLAUDE_CONFIG_DIR']))
})

// Claude Code waits on the PermissionRequest hook before the person can answer, and on Windows it starts the hook in
// Windows PowerShell where there is no Git Bash, 3-6 s on the VM (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task
// 2). So there the mod tells of the prompt itself, through `harness device claude asked`, and sets
// HARNESS_DEVICE_MOD_ASKS for the hooks beneath it, the plugin's own among them, which then run nothing.
const ASKED = ['device', 'claude', 'asked']

test("on Windows a permission prompt is told by the install's harness.exe asked, in the profile, its stdin the hook's input", async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  await prompt($)
  await w.clock.settle()
  expect(w.beneath).toHaveLength(1)
  expect(w.runs).toEqual([{ argv: [EXE, ...ASKED], init: { stdin: JSON.stringify(w.beneath[0]!.e), timeoutMs: 5_000, cwd: PROFILE } }])
})

test("the variable is set before the hooks beneath run, so the plugin's hook runs nothing", async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  await prompt($)
  expect(w.beneath.map(({ set }) => set)).toEqual([[['HARNESS_DEVICE_MOD_ASKS', '1']]])
})

test('the prompt waits on no asked: it starts from a timer, once the hooks beneath have answered', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  w.attach = slow(MINUTE, { exitCode: 0, stdout: '' })
  await prompt($)
  expect(w.runs).toHaveLength(0)
  await w.clock.settle()
  expect(w.runs).toHaveLength(1)
})

// What a PermissionRequest hook prints is Claude Code's decision: a launcher of any version must never decide the prompt.
test("what asked prints and how it exits decide nothing: the answer is the hooks' beneath", async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  w.attach = async () => ({ exitCode: 2, stdout: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' })
  expect(await prompt($)).toEqual({})
  await w.clock.settle()
  expect(w.runs).toHaveLength(1)
})

// Unset, the hook beneath tells, as it does where the mod's hook is passed over (an organization's Claude Code).
for (const answer of ['held', 'refused'] as const) {
  test(`the variable ${answer} by the engine: the mod runs nothing, and the hooks beneath run`, async ($, on) => {
    const w = windows(on, { children: EXITS })
    await start($, w)
    w.envSetAnswer = answer
    await prompt($)
    await w.clock.settle()
    expect(w.beneath).toHaveLength(1)
    expect(w.runs).toHaveLength(0)
  })
}

test('an asked that cannot start tells nothing, and the next prompt is told again', async ($, on) => {
  const w = windows(on, { children: EXITS })
  await start($, w)
  w.attach = async () => 'cannot start'
  await prompt($)
  await w.clock.settle()
  await prompt($)
  await w.clock.settle()
  expect(w.runs).toHaveLength(2)
  expect(w.beneath).toHaveLength(2)
})
