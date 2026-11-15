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
}

/**
 * Sets the world beneath the mod. `launchers` are the argv[0]s that start, and `exitCode` is what each exits with, as
 * the launcher's `link` exits 1 too while the plugin is off; `answers` are the daemon's answers, one per poll, the last
 * repeated. `configDir` is CLAUDE_CONFIG_DIR, and `settings: 'unreadable'` makes every read of a file fail. `devices` is
 the devices' socket the launcher prints, '' for none.
 */
function world(
  on: On,
  { launchers = [LOCAL], exitCode = 0, answers, configDir, settings = 'readable', devices = DEVICES }: {
    launchers?: string[]; exitCode?: number; answers: Answer[]; configDir?: string; settings?: 'readable' | 'unreadable'
    devices?: string
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
    enabled: true, reads: [],
  }
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
  on('fs.read', (_, e) => {
    w.reads.push(e.path)
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

async function start($: Engine, w: World) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

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

// An older Harness with no `device` word, or one with no socket here (Windows): no answer comes before an update.
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
