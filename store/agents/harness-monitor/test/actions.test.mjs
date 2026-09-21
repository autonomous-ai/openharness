import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pause, resume } from '../lib/actions.mjs'
import { normalizePolicy } from '../lib/policy.mjs'
import { HOUR, fakeTmux, pane, row, table } from './fixtures.mjs'

const policy = normalizePolicy({})
const gone = { send: () => {}, alive: () => false }
const stubborn = { send: () => {}, alive: () => true }
const nowait = async () => {}

test('pause refuses a remote row: signals and pane facts are local', async () => {
  const result = await pause(row({ local: false, machine: 'studio' }), { policy })
  assert.equal(result.ok, false)
  assert.match(result.detail, /remote machine/)
})

test('pause refuses what the policy protects, and names the guard', async () => {
  for (const [field, expected] of [['pinned', /pinned/], ['needsInput', /waiting on you/], ['working', /mid-turn/], ['attached', /looking at it/]]) {
    const result = await pause(row({ [field]: true }), { policy, run: fakeTmux().run, signals: gone, wait: nowait })
    assert.equal(result.ok, false, field)
    assert.match(result.detail, expected)
    assert.match(result.detail, /--force/)
  }
})

test('pause refuses a pane that looks like it is waiting for an answer', async () => {
  const tmux = fakeTmux({ screen: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' })
  const result = await pause(row(), { policy, run: tmux.run, signals: gone, wait: nowait })
  assert.equal(result.ok, false)
  assert.match(result.detail, /waiting for an answer/)
  assert.equal(tmux.calls.some((call) => call[0] === 'set-option'), false, 'nothing was touched')
})

test('pause says nothing to do when it is already paused', async () => {
  const result = await pause(row({ state: 'paused' }), { policy })
  assert.equal(result.ok, true)
  assert.equal(result.already, true)
})

test('pause holds the pane open before it signals, in that order', async () => {
  const tmux = fakeTmux({ dead: true, remainOnExit: 'off' })
  const sent = []
  const result = await pause(row(), { policy, run: tmux.run, signals: { send: (pid, signal) => sent.push([pid, signal]), alive: () => false }, wait: nowait })
  assert.equal(result.ok, true)
  assert.equal(result.paneDead, true)
  assert.deepEqual(sent, [[100, 'SIGTERM']])
  const order = tmux.calls.map((call) => call[0])
  assert.ok(order.indexOf('set-option') < order.indexOf('display-message'), 'the hold comes before the check')
  assert.match(result.detail, /scrollback/)
  assert.equal(result.freed, 400 * 1024 * 1024)
  assert.equal(result.ticket.sessionId, 's1-0123456789ab')
  assert.equal(result.ticket.engine, 'claude')
})

test('pause refuses an engine it would not be able to resume', async () => {
  const devin = await pause(row({ engine: 'devin' }), { policy, run: fakeTmux().run, signals: gone, wait: nowait })
  assert.equal(devin.ok, false)
  assert.match(devin.detail, /does not know how to resume devin/)
  const unbound = await pause(row({ sessionId: null }), { policy, run: fakeTmux().run, signals: gone, wait: nowait })
  assert.equal(unbound.ok, false)
  assert.match(unbound.detail, /nothing to resume/)
})

test('a pane that fell back to a shell has the window setting put back', async () => {
  const tmux = fakeTmux({ dead: false, command: 'zsh', remainOnExit: 'off' })
  const result = await pause(row(), { policy, run: tmux.run, signals: gone, wait: nowait })
  assert.equal(result.ok, true)
  assert.equal(result.paneDead, false)
  const holds = tmux.calls.filter((call) => call[0] === 'set-option')
  assert.deepEqual(holds.map((call) => call.at(-1)), ['on', 'off'])
})

test('an engine that will not leave is left running, and said so', async () => {
  const tmux = fakeTmux({ remainOnExit: 'off' })
  const result = await pause(row(), { policy, run: tmux.run, signals: stubborn, wait: nowait, graceMs: 10 })
  assert.equal(result.ok, false)
  assert.match(result.detail, /still running, untouched/)
  assert.deepEqual(tmux.calls.filter((call) => call[0] === 'set-option').map((call) => call.at(-1)), ['on', 'off'])
})

test('--force ends it after the grace, and only then', async () => {
  const sent = []
  const tmux = fakeTmux({ dead: true })
  const result = await pause(row(), {
    policy, run: tmux.run, wait: nowait, graceMs: 10, force: true, killAfterGrace: true,
    signals: { send: (pid, signal) => sent.push(signal), alive: () => true },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL'])
})

test('resume types the engine\'s own resume command into the pane, and waits for it to come up', async () => {
  const tmux = fakeTmux({ dead: false, command: 'zsh' })
  const alivePane = new Map([['%1', pane({ pid: 100 })]])
  const result = await resume(row({ state: 'paused', sessionId: 'abcd1234-aaaa-bbbb-cccc-0123456789ab' }), {
    run: tmux.run, wait: async () => {}, inventory: { panes: async () => alivePane, processTable: async () => table() },
  })
  assert.equal(result.ok, true)
  assert.equal(result.resumed, true)
  const typed = tmux.calls.find((call) => call[0] === 'send-keys')
  assert.deepEqual(typed, ['send-keys', '-t', '%1', 'claude --resume abcd1234-aaaa-bbbb-cccc-0123456789ab', 'Enter'])
  assert.match(result.detail, /same pane/)
})

test('codex resumes with a subcommand, not a flag', async () => {
  const tmux = fakeTmux({ command: 'zsh' })
  await resume(row({ state: 'paused', engine: 'codex', sessionId: '7f3c2a10-5b8e-4d21-9a6f-3e0d1c2b4a58' }), {
    run: tmux.run, wait: async () => {}, inventory: { panes: async () => new Map([['%1', pane()]]), processTable: async () => table({ comm: '/usr/local/bin/codex' }) },
  })
  assert.deepEqual(tmux.calls.find((call) => call[0] === 'send-keys').at(-2), 'codex resume 7f3c2a10-5b8e-4d21-9a6f-3e0d1c2b4a58')
})

test('a dead pane is respawned before anything is typed into it', async () => {
  const tmux = fakeTmux({ dead: true })
  await resume(row({ state: 'paused', sessionId: 'abcd1234-aaaa-bbbb-cccc-0123456789ab' }), {
    run: tmux.run, wait: async () => {}, inventory: { panes: async () => new Map([['%1', pane()]]), processTable: async () => table() },
  })
  const order = tmux.calls.map((call) => call[0])
  assert.ok(order.indexOf('respawn-pane') < order.indexOf('send-keys'), 'the pane gets a shell first')
})

test('an engine that never comes up is reported as a failure, with the command it typed', async () => {
  const tmux = fakeTmux({ command: 'zsh' })
  const result = await resume(row({ state: 'paused', sessionId: 'abcd1234-aaaa-bbbb-cccc-0123456789ab' }), {
    run: tmux.run, wait: async () => {}, waitMs: 3,
    inventory: { panes: async () => new Map([['%1', pane()]]), processTable: async () => table({ comm: '-zsh' }) },
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /did not come up/)
  assert.match(result.detail, /claude --resume/)
})

test('resume refuses when nothing recorded which conversation this was', async () => {
  const result = await resume(row({ state: 'paused', sessionId: null }), { run: fakeTmux().run })
  assert.equal(result.ok, false)
  assert.match(result.detail, /no session id/)
})

test('resume uses the ticket pause left behind when the row has forgotten its session', async () => {
  const tmux = fakeTmux({ command: 'zsh' })
  const result = await resume(row({ state: 'paused', sessionId: null, engine: 'terminal' }), {
    ticket: { sessionId: 'abcd1234-aaaa-bbbb-cccc-0123456789ab', engine: 'claude' },
    run: tmux.run, wait: async () => {}, inventory: { panes: async () => new Map([['%1', pane()]]), processTable: async () => table() },
  })
  assert.equal(result.ok, true)
  assert.match(tmux.calls.find((call) => call[0] === 'send-keys').at(-2), /^claude --resume /)
})

test('resume refuses a row whose pane is gone rather than inventing one', async () => {
  const result = await resume(row({ state: 'gone', pane: null }), { run: fakeTmux().run })
  assert.equal(result.ok, false)
  assert.match(result.detail, /pane is gone/)
})

test('nothing in this module can delete anything', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/actions.mjs', import.meta.url), 'utf8')
  for (const word of ['kill-session', 'kill-pane', 'agent_delete', 'unlink', 'rm -rf']) {
    assert.equal(source.includes(word), false, `actions.mjs must not contain ${word}`)
  }
})
