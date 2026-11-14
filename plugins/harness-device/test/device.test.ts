import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The mod against the engine: each hook here stands for what is beneath it (the launcher, the daemon's socket, the
// prompt box), and the clock moves only when a test moves it.
const HOME = '/home/dee'
const LOCAL = `${HOME}/.local/bin/harness`
const SOCKET = '/tmp/harnessd/daemon.sock'
const SESSION = 'session-1'
const MINUTE = 60_000

type Answer = { status: number; text?: string } | 'reject' | ((clock: Clock) => Promise<{ status: number; text?: string }>)
type Clock = MockClock

type World = {
  clock: Clock
  /** The argv of each launcher the mod ran. */
  runs: string[][]
  /** Each poll the mod sent: its URL and init. */
  polls: { url: string; init: unknown }[]
  /** Each prompt the mod submitted. */
  submitted: unknown[]
  /** The variables the mod asked for, by name. */
  envAsked: string[]
}

/**
 * Sets the world beneath the mod. `launchers` are the argv[0]s that start; `answers` are the daemon's answers, one
 * per poll, the last repeated.
 */
function world(on: On, { launchers = [LOCAL], answers }: { launchers?: string[]; answers: Answer[] }): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w: World = { clock, runs: [], polls: [], submitted: [], envAsked: [] }
  const env: Record<string, string> = {
    HOME,
    ORCA_PAIRING_CODE: 'pairing-secret',
    ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-secret',
  }
  on('env.get', (_, e) => {
    w.envAsked.push(e.name)
    return { value: env[e.name] }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    if (!launchers.includes(e.argv[0] ?? '')) return { deny: 'cannot start' }
    const out = { exitCode: 0, stdout: JSON.stringify({ socketPath: SOCKET }), stderr: '' }
    return { value: { ...out, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async (_, e) => {
    w.polls.push({ url: e.url, init: e.init })
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
  expect(new Set(w.envAsked)).toEqual(new Set(['HOME']))
})
