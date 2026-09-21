import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeEmptyShell, pause, pauseOnMachine, pauseViaDaemon, resume, resumeViaDaemon } from '../lib/actions.mjs'
import { normalizePolicy } from '../lib/policy.mjs'
import { HOUR, fakeTmux, pane, row, table } from './fixtures.mjs'

const policy = normalizePolicy({})
const gone = { send: () => {}, alive: () => false }
const stubborn = { send: () => {}, alive: () => true }
const nowait = async () => {}

test('another machine whose daemon cannot save a harness is left alone, with what to do about it', async () => {
  const result = await pause(row({ local: false, machine: 'studio' }), { policy, stop: async () => { throw new Error('sent a stop to an old daemon') } })
  assert.equal(result.ok, false)
  assert.match(result.detail, /update Harness there, or pause it on studio/)
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
  const opencode = await pause(row({ engine: 'opencode', resumeVia: null }), { policy })
  assert.equal(opencode.ok, false)
  assert.match(opencode.detail, /only Claude Code and Codex/)
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

test('nothing in this module can delete a harness, and the one pane it may close is provably empty', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/actions.mjs', import.meta.url), 'utf8')
  for (const word of ['kill-session', 'agent_restart', 'unlink', 'rm -rf']) {
    assert.equal(source.includes(word), false, `actions.mjs must not contain ${word}`)
  }
  // The daemon's Stop saves before it stops only on a daemon with agent_resume; on an older one it deletes.
  // So it is sent from exactly one place, and only after the check that the machine answered the probe —
  // the behaviour is tested above with a stop that throws; this pins the shape.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(code.includes('agent_delete'), false, 'the request itself lives in bridge.mjs, as stopAgent')
  assert.equal(code.split('stop(row.machineId').length - 1, 1, 'stopped from one place')
  const onMachine = code.slice(code.indexOf('async function pauseOnMachine'), code.indexOf('export async function pause('))
  assert.ok(onMachine.includes('stop(row.machineId'), 'that place is pauseOnMachine')
  assert.ok(onMachine.indexOf("row.resumeVia !== 'daemon'") < onMachine.indexOf('stop(row.machineId'), 'behind the daemon check')
  // `kill-pane` exists exactly once: closing the empty shell a paused engine leaves behind.
  const uses = source.split("'kill-pane'").length - 1
  assert.equal(uses, 1, 'kill-pane appears once, in closeEmptyShell')
  const inside = source.slice(source.indexOf('async function closeEmptyShell'), source.indexOf('async function pauseViaDaemon'))
  assert.ok(inside.includes("'kill-pane'"), 'and only there')
})

test('the empty-shell check closes a lone shell and nothing else', async () => {
  const run = async (args) => (args[0] === 'display-message' ? '0§§zsh§§' : '')
  const make = (tree) => ({ panes: async () => new Map([['%1', pane({ pid: 100 })]]), processTable: async () => tree })
  assert.equal(await closeEmptyShell('%1', { run, inventory: make(table({ comm: '-zsh' })) }), 'closed')
  assert.equal(await closeEmptyShell('%1', { run, inventory: make(table({ comm: '-zsh', children: [{ pid: 101, comm: 'vim' }] })) }), 'kept', 'somebody is editing a file in it')
  assert.equal(await closeEmptyShell('%1', { run, inventory: make(table({ comm: '/usr/local/bin/claude' })) }), 'kept', 'an engine came back in it')
  const dead = async (args) => (args[0] === 'display-message' ? '1§§zsh§§' : '')
  assert.equal(await closeEmptyShell('%1', { run: dead, inventory: make(table()) }), 'gone')
})

// ── the daemon path ─────────────────────────────────────────────────────────────────────────────────────

const daemonRow = (overrides = {}) => row({ resumeVia: 'daemon', ...overrides })

test('on a daemon with agent_resume, pause waits for the daemon to save it, then closes the empty shell', async () => {
  const sent = []
  const closed = []
  const result = await pause(daemonRow(), {
    policy, wait: nowait, run: fakeTmux().run,
    signals: { send: (pid, signal) => sent.push(signal), alive: () => false },
    confirm: async () => true,
    close: async (pane) => { closed.push(pane); return 'closed' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'daemon')
  assert.deepEqual(sent, ['SIGTERM'], 'SIGTERM, never Ctrl-C')
  assert.deepEqual(closed, ['%1'])
  assert.match(result.detail, /saved by the daemon; its empty shell was closed/)
  assert.equal(result.ticket, undefined, 'no ticket once the daemon holds it')
})

test('a shell somebody is using is left open', async () => {
  const result = await pause(daemonRow(), { policy, wait: nowait, run: fakeTmux().run, signals: gone, confirm: async () => true, close: async () => 'kept' })
  assert.match(result.detail, /still in use, so it was left open/)
})

test('if the daemon never confirms it saved the harness, the conversation id is kept here instead', async () => {
  const result = await pause(daemonRow(), { policy, wait: nowait, run: fakeTmux().run, signals: gone, confirm: async () => false, close: async () => { throw new Error('must not close') } })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'legacy')
  assert.equal(result.ticket.sessionId, 's1-0123456789ab')
  assert.match(result.detail, /did not confirm/)
})

test('the daemon path keeps every guard the old one had', async () => {
  for (const [field, expected] of [['pinned', /pinned/], ['working', /mid-turn/], ['attached', /looking at it/]]) {
    const result = await pause(daemonRow({ [field]: true }), { policy, signals: gone, wait: nowait, confirm: async () => { throw new Error('signalled a protected row') } })
    assert.equal(result.ok, false, field)
    assert.match(result.detail, expected)
  }
  const blocked = await pause(daemonRow(), { policy, run: fakeTmux({ screen: 'Allow command? (y/n)' }).run, signals: { send: () => { throw new Error('signalled') }, alive: () => false }, wait: nowait })
  assert.match(blocked.detail, /waiting for an answer/)
})

test('resume goes through agent_resume with a receipt, and reports the conversation came back', async () => {
  const calls = []
  const result = await resume(daemonRow({ state: 'paused', pane: null }), {
    resumeCall: async (machineId, agentId, { creationId }) => { calls.push({ machineId, agentId, creationId }); return { creationId, state: 'created', resumed: true, agent: { id: agentId } } },
    wait: nowait,
  })
  assert.equal(result.ok, true)
  assert.equal(result.resumed, true)
  assert.match(result.detail, /new pane, with its conversation/)
  assert.equal(calls.length, 1)
  assert.match(calls[0].creationId, /^[0-9a-f-]{36}$/, 'a receipt, so a double click cannot start two engines')
})

test('a resume the daemon has not confirmed is checked again, then reported as unconfirmed — never as success', async () => {
  let checks = 0
  const settles = await resumeViaDaemon(daemonRow({ state: 'paused' }), {
    resumeCall: async () => ({ state: 'unconfirmed' }),
    statusCall: async () => (++checks >= 2 ? { state: 'created', resumed: true } : { state: 'unconfirmed' }),
    list: async () => [], wait: nowait, settleMs: 60_000,
  })
  assert.equal(settles.ok, true)
  const never = await resumeViaDaemon(daemonRow({ state: 'paused' }), {
    resumeCall: async () => ({ state: 'unconfirmed' }), statusCall: async () => ({ state: 'unconfirmed' }), list: async () => [], wait: nowait, settleMs: 0,
  })
  assert.equal(never.ok, false)
  assert.equal(never.pending, true)
  assert.match(never.detail, /not confirmed the conversation yet/)
})

test('the daemon\'s refusals arrive as sentences, not codes', async () => {
  const failed = await resumeViaDaemon(daemonRow({ state: 'paused' }), { resumeCall: async () => ({ state: 'failed', failure: { code: 'RESUME_UNAVAILABLE' } }), wait: nowait })
  assert.equal(failed.ok, false)
  assert.match(failed.detail, /no saved conversation the daemon can resume/)
  const thrown = await resumeViaDaemon(daemonRow({ state: 'paused' }), {
    resumeCall: async () => { const error = new Error('busy'); error.code = 'AGENT_BUSY'; throw error },
    wait: nowait,
  })
  assert.match(thrown.detail, /still running or could not be checked/)
})

test('a saved harness is resumed by the daemon even though it has no pane', async () => {
  const result = await resume(daemonRow({ state: 'paused', pane: null }), { resumeCall: async () => ({ state: 'created', resumed: true }), wait: nowait })
  assert.equal(result.ok, true)
})

// ── a resume the daemon has not answered yet ────────────────────────────────────────────────────────────

const late = () => { throw Object.assign(new Error('The daemon did not answer agent_resume in time.'), { timedOut: true }) }

test('a resume the daemon is still confirming is reported as back once the daemon lists it running', async () => {
  // What happened on a real machine: the engine was back two seconds after the click, the daemon kept
  // confirming the conversation, and the pane said the resume had failed.
  let asked = 0
  const result = await resumeViaDaemon(daemonRow({ state: 'paused', pane: null }), {
    resumeCall: late,
    statusCall: async () => ({ state: 'pending' }),
    list: async () => (++asked >= 2 ? [{ id: 'a1', status: 'active' }] : [{ id: 'a1', status: 'stopped' }]),
    wait: nowait,
  })
  assert.equal(result.ok, true)
  assert.equal(result.resumed, null, 'back, with its conversation not yet confirmed — never claimed')
  assert.match(result.detail, /back in a new pane — the daemon is still confirming its conversation/)
})

test('a late answer is followed up through the receipt, and a refusal found there is reported', async () => {
  const receipts = []
  const result = await resumeViaDaemon(daemonRow({ state: 'paused', pane: null }), {
    resumeCall: late,
    statusCall: async (machineId, creationId) => { receipts.push(creationId); return { state: 'failed', failure: { code: 'RESUME_UNAVAILABLE' } } },
    list: async () => [], wait: nowait, creationId: '00000000-0000-4000-8000-000000000001',
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /no saved conversation the daemon can resume/)
  assert.deepEqual(receipts, ['00000000-0000-4000-8000-000000000001'], 'the same receipt, so no second engine')
})

test('a bridge that never opened is a failure, not a resume in progress', async () => {
  const result = await resumeViaDaemon(daemonRow({ state: 'paused' }), {
    resumeCall: async () => { throw new Error('Could not open the local Harness bridge. Start Harness and try again.') },
    list: async () => { throw new Error('must not wait on a request that never left') },
    wait: nowait,
  })
  assert.equal(result.ok, false)
  assert.equal(result.pending, undefined)
  assert.match(result.detail, /Could not open the local Harness bridge/)
})

// ── another machine ─────────────────────────────────────────────────────────────────────────────────────

const theirs = (overrides = {}) => daemonRow({ local: false, machine: 'M2', machineId: 'm2', pane: null, enginePid: null, ...overrides })

test('another machine\'s harness is paused by its own daemon, and confirmed saved there', async () => {
  const stops = []
  const result = await pause(theirs(), {
    policy, wait: nowait,
    stop: async (machineId, agentId) => { stops.push([machineId, agentId]); return { deleted: true } },
    confirm: async () => true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'daemon')
  assert.deepEqual(stops, [['m2', 'a1']], 'sent to the machine it lives on')
  assert.match(result.detail, /stopped on M2 and saved by its daemon/)
})

test('another machine\'s harness keeps the guards the list can answer', async () => {
  for (const [field, expected] of [['pinned', /pinned/], ['working', /mid-turn/]]) {
    const result = await pauseOnMachine(theirs({ [field]: true }), { policy, wait: nowait, stop: async () => { throw new Error('stopped a protected harness') } })
    assert.equal(result.ok, false, field)
    assert.match(result.detail, expected)
  }
  const unbound = await pauseOnMachine(theirs({ sessionId: null }), { policy, stop: async () => { throw new Error('stopped a harness with nothing to resume') } })
  assert.match(unbound.detail, /nothing to resume/)
  const shell = await pauseOnMachine(theirs({ resumeVia: null, engine: 'opencode' }), { policy, stop: async () => { throw new Error('stopped an engine the daemon cannot resume') } })
  assert.match(shell.detail, /only Claude Code and Codex/)
})

test('a stop that is not confirmed saved is not reported as a pause', async () => {
  const result = await pause(theirs(), { policy, wait: nowait, stop: async () => ({ deleted: true }), confirm: async () => false })
  assert.equal(result.ok, false)
  assert.match(result.detail, /has not listed it as saved yet/)
  const refused = await pause(theirs(), { policy, wait: nowait, stop: async () => { throw Object.assign(new Error('Harness changed while saving its conversation. Try Stop again.'), { detail: 'Harness changed while saving its conversation. Try Stop again.' }) } })
  assert.match(refused.detail, /M2 would not stop it: Harness changed while saving/)
})

test('another machine\'s saved harness is resumed by its daemon; one paused the old way only there', async () => {
  const calls = []
  const result = await resume(theirs({ state: 'paused' }), {
    resumeCall: async (machineId) => { calls.push(machineId); return { state: 'created', resumed: true } }, wait: nowait,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['m2'])
  const old = await resume(theirs({ state: 'paused', resumeVia: 'legacy' }), { resumeCall: async () => { throw new Error('asked the wrong daemon') } })
  assert.equal(old.ok, false)
  assert.match(old.detail, /only M2 can resume it/)
})
