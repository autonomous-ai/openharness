import { randomUUID } from 'node:crypto';
import { bridgeUrl, discoverMachines } from './harness.mjs';

/**
 * The viewer's "Wake now": the one thing in this package that may start a sleeping grid, and only on a
 * person's click. It never runs `grid` for it (every `grid` read here carries NO_WAKE) and never makes a
 * credentialed read of its own. It asks the Harness daemon on the controller for ITS explicit wake —
 * `grid_models_list` with `wake: [grid]` over the loopback bridge (03-wire-contract.md) — which makes the
 * one credentialed read, marked `(wake)`, and re-reads without a credential until the grid serves a
 * model or 45 s pass. Here the same question is asked again, without `wake`, until its answer stops
 * saying `waking`.
 *
 * A daemon from before the wake answers the same RPC without `waking` — having read without a
 * credential, as it always does — so an old daemon costs one harmless read and an honest sentence.
 */

/** How often the daemon is asked again while its wake runs. */
export const WAKE_POLL_MS = 3000;
/** When the viewer stops asking: the daemon's own window is 45 s; the rest covers a relayed controller. */
export const WAKE_GIVE_UP_MS = 60_000;
/** How long an ending stands on screen — as long as the daemon keeps its own `wakeOutcome`. */
export const WAKE_OUTCOME_MS = 10 * 60_000;

// The desktop's copy (desktop/lib/widgets/resting_model_words.dart), word for word where it has one.
// Never the word "grid": a section is named as the desktop names it — the account's own is "your
// models", a shared one goes by its name — from the daemon's own answer, never from the viewer's label
// for the grid, which falls back to "Your grid".
export const WAKING = 'Starting up… usually 15–40 s';
const who = section => (section.own === true ? 'your models' : section.name);
const ENDINGS = {
  awake: section => (section.own === true ? 'Your models started' : `${section.name} started`),
  not_started: section => `Couldn't start ${who(section)} right now — it will start on your next message`,
  nobody_serving: () => 'Nobody is serving a model here right now',
};
const UNREACHABLE = "Couldn't reach Harness, so nothing was started — it will start on your next message";
const OUTDATED = 'Update Harness to start it from here — it will start on your next message';
/** The daemon failed to answer before it said anything about this grid. */
const NOT_NOW = "Couldn't start it right now — it will start on your next message";
/** An SSH controller has no daemon to ask, and a daemon that does not list this grid cannot start it. */
export const WAKE_FAILED = "Couldn't start it from here — it will start on your next message";
const LOST = section => `Lost the connection to Harness while starting ${who(section)}`;

/** The machine whose daemon holds the sign-in the viewer reads with: a linked controller by its own id,
 *  this computer by the id Harness Machines gives it. An SSH host has none. */
async function controllerMachineId(controller, discover) {
  if (controller?.transport === 'harness') return controller.machineId;
  if (controller?.transport !== 'local') return null;
  return (await discover()).find(row => row.current)?.machineId ?? null;
}

/** How a section the daemon answered with has ended, or null while its wake is still running. A wake
 *  that showed models leaves no `wakeOutcome`, so models are looked at first. */
function ending(section) {
  if (section?.state === 'waking') return null;
  if (section?.state === 'awake' && Array.isArray(section.models) && section.models.length) return 'awake';
  if (section?.wakeOutcome === 'nobody_serving' || section?.state === 'awake') return 'nobody_serving';
  return 'not_started';
}

/**
 * Wake [grid] (a section name, as `grid ls` prints it) through [controller]'s daemon and settle on how it
 * ended: `{state, message}`, where state is `awake`, `not_started`, `nobody_serving` or `failed` and
 * message is what the page says. Never throws.
 */
export async function daemonWake({ controller, grid, signal, discover = discoverMachines, env = process.env,
  WebSocketImpl = globalThis.WebSocket, pollMs = WAKE_POLL_MS, giveUpMs = WAKE_GIVE_UP_MS }) {
  const failed = message => ({ state: 'failed', message });
  let machineId;
  try { machineId = await controllerMachineId(controller, discover); } catch { return failed(UNREACHABLE); }
  if (!machineId) return failed(controller?.transport === 'local' ? UNREACHABLE : WAKE_FAILED);
  if (!WebSocketImpl || signal?.aborted) return failed(UNREACHABLE);
  let socket;
  try { socket = new WebSocketImpl(bridgeUrl(env)); } catch { return failed(UNREACHABLE); }
  return await new Promise(resolve => {
    // The section that answered `waking`: who every later sentence is about.
    let done = false, waking = null, requestId = null, next;
    const settle = outcome => {
      if (done) return;
      done = true; clearTimeout(next); clearTimeout(giveUp); signal?.removeEventListener('abort', abort);
      try { socket.close(); } catch { /* already closing */ }
      resolve(outcome);
    };
    const ended = state => settle({ state, message: ENDINGS[state](waking) });
    // Once the daemon has said `waking`, the start is its to finish: a lost socket says so, it is not
    // reported as a start that never happened.
    const lost = () => settle(failed(waking ? LOST(waking) : UNREACHABLE));
    const abort = () => lost();
    const ask = wake => {
      requestId = randomUUID();
      socket.send(JSON.stringify({ type: 'grid_models_list', payload: { requestId, rowState: true, ...(wake ? { wake: [grid] } : {}) } }));
    };
    const giveUp = setTimeout(() => (waking ? ended('not_started') : lost()), giveUpMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, relayIsolation: true } })));
    socket.addEventListener('error', lost);
    socket.addEventListener('close', lost);
    socket.addEventListener('message', event => {
      if (done || typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return;
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      const { type, payload = {} } = frame || {};
      if (type === 'connected') {
        // Asked once per connection: a repeated `connected` must not send the wake a second time.
        if (requestId) return;
        if (payload.relayIsolation !== true && payload.transport !== 'local') { settle(failed(OUTDATED)); return; }
        ask(true);
      } else if (type === 'grid_models_list_result' && payload.requestId === requestId) {
        const section = Array.isArray(payload.grids) ? payload.grids.find(g => g?.name === grid) : undefined;
        if (!waking) {
          if (payload.error) { settle(failed(NOT_NOW)); return; }
          if (!Array.isArray(payload.grids)) { settle(failed(OUTDATED)); return; }
          if (!section) { settle(failed(WAKE_FAILED)); return; }
          if (section.state !== 'waking') { settle(failed(OUTDATED)); return; }
          waking = section;
        } else if (!payload.error) {
          const state = ending(section);
          if (state) { ended(state); return; }
        }
        next = setTimeout(() => ask(false), pollMs);
      } else if (!waking && ['error', 'connection_error', 'local_protocol_error', 'machine_link_required'].includes(type)) {
        lost();
      }
    });
  });
}
