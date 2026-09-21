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
 */

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
 * Pause one running harness.
 *
 * The guards, in order, and why each is not negotiable:
 *   remote          pane facts and signals are local to this computer; a remote row is read-only here
 *   no pane         nothing to hold open, so nothing to come back to
 *   not running       already paused; saying so beats a second signal at a dead pane
 *   policy          pinned, mid-turn, attached, protected project — `force` is the only way past
 *   open prompt     the pane's last screen looks like a question waiting for an answer (panes.mjs)
 */
export async function pause(row, { policy, force = false, graceMs = 6000, killAfterGrace = false, run = runTmux, restore = true, signals = realSignals, wait = sleep } = {}) {
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
 * Not `agent_restart`. That was the obvious answer and it is the wrong one: when an engine exits, the
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
export async function resume(row, { ticket = null, run = runTmux, waitMs = 25_000, wait = sleep, inventory = { panes, processTable } } = {}) {
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
