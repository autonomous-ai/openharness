/**
 * The three things Harness Monitor does to a harness — and the guards that stand in front of each one.
 *
 *   pause  ask the engine to leave; the pane, its scrollback and the conversation all stay
 *   resume     type its own resume command into the pane; the conversation comes back
 *
 * There is no third verb. Two earlier ones were cut on purpose: `revive` was `resume` with no difference,
 * and `retire` was `pause` plus one bit that only hid a row — which a list already does, without a state,
 * a mark or a grace window. `systemctl disable` exists because a service would auto-start at boot;
 * nothing auto-starts a harness, so there is nothing to disable.
 *
 * Nothing here deletes anything. There is no verb in this file that removes a tmux session, a registry
 * row or a transcript: an agent Harness Monitor has touched can always be brought back, and the one irreversible
 * action — deleting an agent — stays where it already lives, in the app's own Stop/Delete with its own
 * confirmation. That boundary is the reason this package is safe to point at eighty live sessions.
 *
 * ## Why pausing is lossless
 *
 * An engine's conversation is not in its process; it is in the transcript the engine appends as it goes,
 * and every engine Harness launches has a flag to resume one (`claude --resume`, `codex resume`, …). The
 * daemon already knows those flags and already rebuilds a launch with them — that is what its own
 * Restart does. So pausing needs to do only two things carefully: hold the pane open across the exit
 * (`remain-on-exit`, the same option the daemon arms before a restart), and ask the engine to stop in a
 * way that lets it finish writing (SIGTERM, never SIGKILL unless a person insists).
 *
 * The daemon then sees a pane with no engine on it and keeps the row: "a live pane without a recognized
 * engine is a dormant but still viewable agent" — its words. Paused is a state Harness already has.
 *
 * ## Another machine's harness
 *
 * Signals and panes are local to this computer, but a daemon is not: the local bridge relays to every
 * linked machine. So a harness on another machine is paused by asking ITS daemon to stop it
 * (`agent_delete`, the app's Stop Harness) and resumed with `agent_resume`. On a daemon that has
 * `agent_resume`, stopping saves the conversation before it touches anything, so it is a pause. On an
 * older one it would be a delete — so that request is only ever sent to a machine that answered the
 * `agent_resume` probe (`row.resumeVia === 'daemon'`), and every other remote row stays read-only.
 */

import { randomUUID } from 'node:crypto'
import { listAgents, resumeAgent, resumeStatus, stopAgent } from './bridge.mjs'
import { capture, engineProcess, holdOpen, looksBlocked, paneState, panes, processTable, respawn, runTmux, sendLine } from './panes.mjs'
import { protectionFor } from './policy.mjs'
import { canResume, resumeCommand } from './resume.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Signalling and liveness are injected so the guards can be tested without a real engine to kill.
 *  EPERM counts as alive: the process is there, it just is not ours — which is a refusal, not a death. */
export const realSignals = {
  send: (pid, signal) => process.kill(pid, signal),
  alive: (pid) => {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
  },
}

/** Refuse for a reason a person can act on, rather than doing something surprising. */
function refuse(row, detail) {
  return { ok: false, id: row.id, name: row.name, action: 'pause', refused: true, detail }
}

/**
 * Pause one running harness on this machine, for a daemon without `agent_resume`.
 *
 * The guards, in order, and why each is not negotiable:
 *   remote          pane facts and signals are local to this computer (another machine's harness goes
 *                   through its own daemon, `pauseOnMachine`, and never reaches here)
 *   no pane         nothing to hold open, so nothing to come back to
 *   not running       already paused; saying so beats a second signal at a dead pane
 *   policy          pinned, mid-turn, attached, protected project — `force` is the only way past
 *   open prompt     the pane's last screen looks like a question waiting for an answer (panes.mjs)
 */
async function pauseLegacy(row, { policy, force = false, graceMs = 6000, killAfterGrace = false, run = runTmux, restore = true, signals = realSignals, wait = sleep } = {}) {
  if (!row.local) return refuse(row, `${row.machine} is a remote machine — pause it from that computer.`)
  if (!row.pane) return refuse(row, 'no tmux pane; there is nothing to hold open.')
  if (row.state !== 'running') return { ok: true, id: row.id, name: row.name, action: 'pause', already: true, detail: `already ${row.state}` }
  if (!row.enginePid) return refuse(row, 'the engine process could not be identified, so nothing was signalled.')
  // Never stop what cannot be started again. An engine with no known resume flag, or a row whose session
  // id the daemon has not bound yet, has no way back to its conversation — so it stays running.
  if (!canResume(row.engine)) return refuse(row, `Harness Monitor does not know how to resume ${row.engine}, so it will not pause it.`)
  if (!row.sessionId) return refuse(row, 'the daemon has not bound a session to this agent yet, so there would be nothing to resume.')

  if (!force) {
    const protection = protectionFor(row, policy)
    if (protection) return refuse(row, `${protection.why} — pause it with --force if you mean it.`)
    const screen = await capture(row.pane, { lines: 30, run })
    if (looksBlocked(screen)) return refuse(row, 'its pane looks like it is waiting for an answer — read it first, or use --force.')
  }

  // What the window's own setting was, so a pane that falls back to a shell instead of dying leaves the
  // window exactly as it was found. The daemon's restart path makes the same promise.
  let previous = null
  try { previous = (await run(['show-options', '-w', '-t', row.pane, '-v', 'remain-on-exit'])).trim() } catch { previous = null }
  const held = await holdOpen(row.pane, true, { run })
  if (!held) return refuse(row, 'tmux would not hold the pane open, so the engine was left running.')

  try { signals.send(row.enginePid, 'SIGTERM') }
  catch (error) {
    if (previous === 'off' && restore) await holdOpen(row.pane, false, { run })
    return refuse(row, `could not signal the engine (${error?.code ?? 'failed'}).`)
  }

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && signals.alive(row.enginePid)) await wait(200)
  if (signals.alive(row.enginePid)) {
    if (!killAfterGrace) {
      if (previous === 'off' && restore) await holdOpen(row.pane, false, { run })
      return refuse(row, `the engine did not exit within ${Math.round(graceMs / 1000)}s. It is still running, untouched. Use --force to end it.`)
    }
    try { signals.send(row.enginePid, 'SIGKILL') } catch { /* it went on its own */ }
    await wait(400)
  }

  const after = await paneState(row.pane, { run })
  // Dead pane: the launch had no fallback shell, so the hold is what is keeping the scrollback — leave
  // it on. Live pane: the wrapper handed it a shell, so put the window's own setting back.
  if (after && !after.dead && previous === 'off' && restore) await holdOpen(row.pane, false, { run })
  return {
    ok: true,
    id: row.id,
    name: row.name,
    action: 'pause',
    detail: after?.dead ? 'engine stopped, pane held open with its scrollback' : 'engine stopped, pane fell back to a shell',
    freed: row.rssBytes ?? 0,
    paneDead: Boolean(after?.dead),
    // The ticket back. Written to `monitor.json` by the caller, because the daemon RELEASES the engine
    // from its row when the process leaves (`registry.releaseEngine`) — the row survives as a terminal,
    // and its session id does not. Without this, a paused harness would still have its transcript on
    // disk but nothing would know which one to resume.
    ticket: { sessionId: row.sessionId, engine: row.engine, pane: row.pane, cwd: row.cwd, title: row.title ?? row.name },
  }
}

/**
 * Resume one paused harness, conversation and all.
 *
 * Not the daemon's restart request. That was the obvious answer and it is the wrong one: when an engine exits, the
 * daemon releases it from the row and the row survives as a TERMINAL — so restarting it gives you a
 * fresh shell in that pane, which is exactly what it did the first time this was tried against a real
 * paused session (`resumed: false`, and no engine at all afterwards).
 *
 * The right path is the one the daemon documents for this state: type the engine's own resume command
 * into the pane's fallback shell, and let the daemon's adoption loop recognize it. Verified end to end —
 * `claude --resume <id>` into a paused pane brought back the engine, the conversation, the same pane and
 * the same agent id, with the daemon rebinding the session within seconds.
 *
 * `ticket` is what `pause()` returned and the state file kept: the session id the released row forgot.
 */
async function resumeLegacy(row, { ticket = null, run = runTmux, waitMs = 25_000, wait = sleep, inventory = { panes, processTable } } = {}) {
  const no = (detail) => ({ ok: false, id: row.id, name: row.name, action: 'resume', refused: true, detail })
  if (!row.local) return no(`${row.machine} is a remote machine — resume it from that computer.`)
  if (row.state === 'running') return { ok: true, id: row.id, name: row.name, action: 'resume', already: true, detail: 'already running' }
  if (!row.pane) return no('its pane is gone; there is nothing to resume into. Open it from the app instead.')

  const engine = row.engine && row.engine !== 'terminal' ? row.engine : ticket?.engine
  const sessionId = row.sessionId || ticket?.sessionId
  if (!engine) return no('nothing recorded which engine this was, so Harness Monitor will not guess.')
  if (!sessionId) return no('no session id was recorded for this harness, so its conversation cannot be named. Open it from the app and resume there.')

  let command
  try { command = resumeCommand(engine, sessionId) } catch (error) { return no(error.message) }

  // A dead pane has no shell to type into: give it its default command back first. `respawn-pane -k`
  // keeps the pane and its id, which is what keeps the agent row pointing at the same place.
  const before = await paneState(row.pane, { run })
  if (before?.dead) {
    try { await respawn(row.pane, { run }) } catch { return no('tmux would not respawn the pane, so nothing was typed into it.') }
    await wait(700)
  }
  // remain-on-exit is the daemon's own default for an agent pane: off, so a real exit disposes of it.
  await holdOpen(row.pane, false, { run })

  try { await sendLine(row.pane, command, { run }) } catch (error) { return no(`could not type into the pane: ${error.message}`) }

  // Watch for the engine to actually appear. A resume that silently failed must not report success —
  // the pane would be sitting at a shell prompt with an error above it.
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await wait(1000)
    const paneRows = await inventory.panes({ run })
    const table = await inventory.processTable()
    const found = engineProcess(paneRows.get(row.pane), table, engine)
    if (found.engineAlive) {
      return {
        ok: true, id: row.id, name: row.name, action: 'resume', resumed: true, enginePid: found.pid,
        detail: `${engine} is back in the same pane, resuming its conversation`,
      }
    }
  }
  return { ok: false, id: row.id, name: row.name, action: 'resume', detail: `typed \`${command}\` into its pane, but ${engine} did not come up within ${Math.round(waitMs / 1000)}s — look at the pane.` }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The daemon path: what a harness does on a daemon that has `agent_resume`.

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', '-zsh', '-bash'])

/** Has the daemon saved this harness? It lists it as `status: 'stopped'` under the same id once it has. */
async function savedByDaemon(row, { list = listAgents, wait = sleep, withinMs = 15_000 } = {}) {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    try {
      const agents = await list(row.machineId, { timeoutMs: 6000 })
      if (agents.some((agent) => agent.id === row.id && agent.status === 'stopped')) return true
    } catch { /* one missed poll is not an answer */ }
    await wait(1000)
  }
  return false
}

/**
 * Close the shell a paused engine left behind — but only that, and only when it is provably empty.
 *
 * When an engine exits, the daemon saves the harness and keeps the pane as a NEW terminal agent, so its shell
 * survives. After a pause that shell is the launch wrapper's fallback, a few seconds old, that nobody has typed
 * into — and resume opens a fresh pane anyway. Left alone, every pause would add an empty Terminal tile to the
 * app. It is closed only if the pane's process tree is exactly one shell: anything else running there is
 * somebody's, and stays.
 */
async function closeEmptyShell(pane, { run = runTmux, inventory = { panes, processTable } } = {}) {
  const state = await paneState(pane, { run })
  if (!state || state.dead) return 'gone'
  const [paneRows, table] = await Promise.all([inventory.panes({ run }), inventory.processTable()])
  const info = paneRows.get(pane)
  const root = info?.pid ? table.byPid.get(info.pid) : null
  const kids = info?.pid ? (table.children.get(info.pid) ?? []) : []
  const isShell = root && SHELLS.has(root.comm.split('/').pop())
  if (!isShell || kids.length) return 'kept'
  try { await run(['kill-pane', '-t', pane]); return 'closed' } catch { return 'kept' }
}

/**
 * Pause on a daemon with `agent_resume`: SIGTERM the engine, wait for the daemon to confirm it saved the
 * harness, then close the empty shell left behind.
 *
 * If the daemon confirms, it holds the conversation and nothing is recorded here. If it does not confirm
 * within the window, the result carries the conversation id as a `ticket` for the caller to keep, so a
 * harness is never left with no record of which conversation it had.
 */
async function pauseViaDaemon(row, { policy, force = false, graceMs = 6000, killAfterGrace = false, run = runTmux, signals = realSignals, wait = sleep, confirm = savedByDaemon, close = closeEmptyShell } = {}) {
  if (!force) {
    const protection = protectionFor(row, policy)
    if (protection) return refuse(row, `${protection.why} — pause it with --force if you mean it.`)
    const screen = await capture(row.pane, { lines: 30, run })
    if (looksBlocked(screen)) return refuse(row, 'its pane looks like it is waiting for an answer — read it first, or use --force.')
  }
  const ticket = { sessionId: row.sessionId, engine: row.engine, pane: row.pane, cwd: row.cwd, title: row.title ?? row.name }

  try { signals.send(row.enginePid, 'SIGTERM') }
  catch (error) { return refuse(row, `could not signal the engine (${error?.code ?? 'failed'}).`) }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && signals.alive(row.enginePid)) await wait(200)
  if (signals.alive(row.enginePid)) {
    if (!killAfterGrace) return refuse(row, `the engine did not exit within ${Math.round(graceMs / 1000)}s. It is still running, untouched. Use --force to end it.`)
    try { signals.send(row.enginePid, 'SIGKILL') } catch { /* it went on its own */ }
    await wait(400)
  }

  const saved = await confirm(row, { wait })
  if (!saved) {
    return {
      ok: true, id: row.id, name: row.name, action: 'pause', freed: row.rssBytes ?? 0, via: 'legacy', ticket,
      detail: 'engine stopped, but the daemon did not confirm it saved the harness — its conversation id is recorded here instead',
    }
  }
  const shell = await close(row.pane, { run })
  return {
    ok: true, id: row.id, name: row.name, action: 'pause', freed: row.rssBytes ?? 0, via: 'daemon', savedByDaemon: true,
    detail: shell === 'closed' ? 'engine stopped and saved by the daemon; its empty shell was closed'
      : shell === 'kept' ? 'engine stopped and saved by the daemon; its pane is still in use, so it was left open'
        : 'engine stopped and saved by the daemon',
  }
}

/** Plain sentences for the daemon's refusals, which otherwise arrive as codes. */
const RESUME_FAILURES = {
  RESUME_UNAVAILABLE: 'there is no saved conversation the daemon can resume for it',
  AGENT_BUSY: 'its previous process is still running or could not be checked — wait a moment and try again',
  AGENT_NOT_FOUND: 'the daemon no longer has this harness saved',
  AGENT_CHANGED: 'it changed while opening — select it again',
  UNSUPPORTED_ON_REMOTE: 'resume runs on the machine the harness lives on',
}

function resumeFailure(code, detail) {
  return RESUME_FAILURES[code] ?? (detail || code || 'the daemon could not resume it')
}

/** The daemon's answer, when it is a final one: the conversation came back, or it was refused. */
function answered(base, reply) {
  if (reply?.state === 'created' || (reply?.state === undefined && reply?.agent)) {
    const resumed = reply.resumed !== false
    return { ...base, ok: true, resumed, via: 'daemon', detail: resumed ? 'back in a new pane, with its conversation' : 'back in a new pane, but the daemon says WITHOUT its conversation' }
  }
  if (reply?.state === 'failed') {
    return { ...base, ok: false, code: reply.failure?.code ?? null, detail: resumeFailure(reply.failure?.code, reply.failure?.detail) }
  }
  return null
}

/** Is the harness running again? The daemon's own list says so, whatever became of the reply. */
async function isBack(row, list) {
  try {
    const agents = await list(row.machineId, { timeoutMs: 6000 })
    return agents.some((agent) => agent.id === row.id && agent.status === 'active')
  } catch { return false }
}

/**
 * Resume through the daemon: `agent_resume` with a receipt, so a double click or a lost reply can never start
 * two engines.
 *
 * The daemon replies only once it has CONFIRMED the conversation — it waits for the new engine's first hook,
 * for up to ten minutes. The engine itself is usually back in two seconds. Waiting for the reply is what made
 * a resume that worked read as "The daemon did not answer agent_resume in time", with the harness running in
 * its new pane the whole while. So the reply gets `replyMs`; after that the receipt (`agent_create_status`)
 * and the daemon's list are asked instead, and a harness the list shows running is reported as back — with
 * its conversation not yet confirmed, which is what the daemon itself would say. Nothing is ever reported as
 * resumed that the daemon does not show running.
 */
async function resumeViaDaemon(row, { resumeCall = resumeAgent, statusCall = resumeStatus, list = listAgents, wait = sleep, replyMs = 20_000, settleMs = 45_000, creationId = randomUUID() } = {}) {
  const base = { id: row.id, name: row.name, action: 'resume' }
  let reply = null
  try { reply = await resumeCall(row.machineId, row.id, { creationId, replyMs }) }
  catch (error) {
    // No answer yet is not a refusal: the receipt says what happened. Anything else — a refusal with the
    // daemon's code, a bridge that never opened — is.
    if (!error?.timedOut) return { ...base, ok: false, code: error?.code ?? null, detail: resumeFailure(error?.code, error?.detail ?? error?.message) }
  }

  const deadline = Date.now() + settleMs
  for (;;) {
    const outcome = answered(base, reply)
    if (outcome) return outcome
    if (await isBack(row, list)) {
      return { ...base, ok: true, resumed: null, via: 'daemon', detail: 'back in a new pane — the daemon is still confirming its conversation' }
    }
    if (Date.now() >= deadline) break
    await wait(2000)
    try { reply = await statusCall(row.machineId, creationId) } catch { /* keep the last answer */ }
  }
  return { ...base, ok: false, pending: true, detail: 'started, but the daemon has not confirmed the conversation yet — look at its pane, then select it again' }
}

/**
 * Pause a harness on another machine: ask ITS daemon to stop it, then wait for that daemon to list it as
 * saved. Only sent to a machine whose daemon answered the `agent_resume` probe — see the header for why.
 *
 * Its pane cannot be read from here, so the guards are the ones the fleet list can answer: pinned, a turn
 * in the last minute and a half, a protected project. `force` gets past them, as it does locally.
 */
async function pauseOnMachine(row, { policy, force = false, stop = stopAgent, confirm = savedByDaemon, wait = sleep } = {}) {
  if (!row.sessionId) return refuse(row, 'no conversation is bound to it yet, so there would be nothing to resume.')
  if (row.resumeVia === 'legacy') return refuse(row, `the Harness on ${row.machine} cannot save a harness for resuming yet — update Harness there, or pause it on ${row.machine}.`)
  if (row.resumeVia !== 'daemon') return refuse(row, `the daemon can resume only Claude Code and Codex, so a ${row.engine} harness stays running.`)
  if (!force) {
    const protection = protectionFor(row, policy)
    if (protection) return refuse(row, `${protection.why} — pause it with --force if you mean it.`)
  }
  const base = { id: row.id, name: row.name, action: 'pause' }
  try { await stop(row.machineId, row.id) }
  catch (error) { return { ...base, ok: false, detail: `${row.machine} would not stop it: ${error?.detail ?? error?.message ?? 'no reason given'}` } }
  if (!await confirm(row, { wait })) {
    return { ...base, ok: false, detail: `${row.machine} stopped it, but has not listed it as saved yet — refresh in a moment, and resume it there if it does not appear.` }
  }
  return { ...base, ok: true, freed: row.rssBytes ?? 0, via: 'daemon', savedByDaemon: true, detail: `stopped on ${row.machine} and saved by its daemon` }
}

/**
 * Pause one running harness. Which way depends on how it would come back (`row.resumeVia`, decided in
 * inventory.mjs): through the daemon for Claude Code and Codex on a daemon with `agent_resume`, through this
 * package's own typed resume only on a daemon without it. A harness with no way back is refused, never paused.
 * A harness on another machine is paused by that machine's daemon.
 */
export async function pause(row, options = {}) {
  if (row.state !== 'running') return { ok: true, id: row.id, name: row.name, action: 'pause', already: true, detail: `already ${row.state}` }
  if (!row.local) return pauseOnMachine(row, options)
  if (!row.pane) return refuse(row, 'no tmux pane; there is nothing to stop.')
  if (!row.enginePid) return refuse(row, 'the engine process could not be identified, so nothing was signalled.')
  if (!row.sessionId) return refuse(row, 'no conversation is bound to it yet, so there would be nothing to resume.')
  if (row.resumeVia === 'daemon') return pauseViaDaemon(row, options)
  if (row.resumeVia === 'legacy') return pauseLegacy(row, options)
  return refuse(row, `this daemon can resume only Claude Code and Codex, so a ${row.engine} harness stays running.`)
}

/** Resume one paused harness, the way it was saved: by the daemon — this machine's or the one it lives on —
 *  or, for a harness paused before the daemon could save one, by typing its resume command into the pane it
 *  left behind, which only works on the machine that pane is on. */
export async function resume(row, options = {}) {
  if (row.state === 'running') return { ok: true, id: row.id, name: row.name, action: 'resume', already: true, detail: 'already running' }
  if (!row.local && row.resumeVia === 'legacy') {
    return { ok: false, id: row.id, name: row.name, action: 'resume', refused: true, detail: `it was paused on ${row.machine} before its daemon could save it, so only ${row.machine} can resume it.` }
  }
  if (row.resumeVia === 'daemon') return resumeViaDaemon(row, options)
  if (row.resumeVia === 'legacy') return resumeLegacy(row, options)
  return { ok: false, id: row.id, name: row.name, action: 'resume', refused: true, detail: 'there is no saved conversation to resume for it' }
}

export { pauseViaDaemon, pauseOnMachine, resumeViaDaemon, closeEmptyShell, savedByDaemon }
