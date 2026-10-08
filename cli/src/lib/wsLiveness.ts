/**
 * Liveness for a WebSocket this daemon holds — a DEADLINE ON SILENCE, not "one missed pong".
 *
 * Three sockets used to carry three copies of the same heartbeat, each pinging every 20s and
 * terminating the moment the previous ping had no pong — and counting pongs only. Two failure modes
 * followed, both measured in harness.log as `close 1006`:
 *   - a peer busy streaming data frames whose control-frame pong arrived late lost a working link;
 *   - every macOS DarkWake (Power Nap, ~5–10s of wake) fired the timer with the pre-sleep ping still
 *     unanswered and terminated on the spot, hundreds of times a week, with no chance to recover.
 *
 * Here ANY inbound frame proves the peer — data, its own ping, a pong — and the socket is only given
 * up after `WS_IDLE_DEADLINE_MS` of nothing at all: three pings' worth, the same shape the backend's
 * `trackSocketLiveness` applies from its side (75s there).
 *
 * The deadline is sixty seconds of silence WHILE AWAKE. `performance.now()` does not stop while a Mac
 * sleeps (see `sleepAware.ts`), so a lid closed for an hour used to read as an hour of silence and the
 * first tick after the wake terminated every socket this daemon held — the loopback one to the app
 * included, which had nothing wrong with it. A tick that arrives long after its period is the process
 * waking, not the peer failing: the clock restarts there, the peer is pinged at once, and it gets its
 * three pings after the wake before anyone gives up on it.
 *
 * That restart is forgiveness, and it needed a bound. A late tick is not necessarily a sleep —
 * `sleepAware.ts` says as much — and on a loaded Mac it usually is not. Forgiving every one of them
 * made the app's loopback deadline (40s) unenforceable, so a window that was already gone kept its
 * tile roster for a quarter of an hour; see GENUINE_SLEEP_MS and the wake branch for the measurement
 * and the rule.
 */

import type { WebSocket } from 'ws'
import { sleptFor } from './sleepAware.js'

export const WS_HEARTBEAT_MS = 20_000
export const WS_IDLE_DEADLINE_MS = 60_000
/**
 * A detected "sleep" shorter than this is more likely a throttled timer than a sleeping machine, and
 * is forgiven only once (see the wake branch). Measured over one ~2-day harness.log: 968 detected
 * sleeps reported 24-60s against 80 real ones, every one of them over 600s. A macOS DarkWake (5-10s)
 * never reaches the branch at all, its gap staying under `SLEEP_GAP_FACTOR` periods.
 */
export const GENUINE_SLEEP_MS = 180_000
/** The backend's `trackSocketLiveness` deadline: after this much silence from us it closes the link. */
export const BACKEND_IDLE_DEADLINE_MS = 75_000

export interface LivenessWatch {
  /** Stop pinging and judging. Idempotent; the socket itself is left alone. */
  stop(): void
}

export interface LivenessOptions {
  heartbeatMs?: number
  deadlineMs?: number
  /** Runs on every heartbeat tick the socket survives — for work that rides the same cadence. */
  onTick?: () => void
  /** Announced right before a silent socket is terminated, so a later trace can tell "we gave up"
   *  from "the network did": both close as 1006, and only this one is said out loud first. */
  onIdle?: (idleMs: number) => void
  /** Announced when a tick finds the process has slept through [sleptMs]: the socket is re-probed on
   *  that tick, or — [givingUp] — terminated at once. Two things terminate on a wake: a sleep the far
   *  end cannot have waited through ([peerGivesUpAfterMs]), and a second forgiven sleep with nothing
   *  heard from the peer in between (see the wake branch). */
  onWake?: (sleptMs: number, givingUp: boolean) => void
  /** How long the FAR end puts up with our silence before it hangs up — the backend's own liveness
   *  (75s). A sleep longer than that means the link is already gone at the other end, and waiting a
   *  deadline to find out only delays the redial: such a wake terminates at once. Unset for a peer on
   *  this machine (the app's loopback socket), which slept when we did and is still there. */
  peerGivesUpAfterMs?: number
  /** The clock silence is measured on. Tests only. */
  now?: () => number
}

/** Start watching an OPEN socket. Call once the handshake is done — the clock starts now. */
export function watchSocketLiveness(ws: WebSocket, opts: LivenessOptions = {}): LivenessWatch {
  const deadlineMs = opts.deadlineMs ?? WS_IDLE_DEADLINE_MS
  const heartbeatMs = opts.heartbeatMs ?? WS_HEARTBEAT_MS
  const now = opts.now ?? (() => performance.now())
  let lastAliveAt = now()
  let lastTickAt = lastAliveAt
  /** A sleep was forgiven and the peer has not been heard from since. See the wake branch. */
  let forgaveWithoutProof = false
  const markAlive = (): void => { lastAliveAt = now(); forgaveWithoutProof = false }
  ws.on('pong', markAlive)
  ws.on('ping', markAlive) // the peer's own liveness ping — a proof that costs nothing
  ws.on('message', markAlive) // data flowing is the strongest proof there is
  // Judging ends with the verdict: the socket's own 'close' is what the owner cleans up on, and a
  // watch that kept firing after its terminate would only terminate a dead socket again.
  const stop = (): void => { clearInterval(timer) }
  const giveUp = (): void => {
    stop()
    try { ws.terminate() } catch { /* ignore */ }
  }
  // Belt and suspenders for an owner that forgets: `ws.ping()` on a closed socket does not throw
  // (it is silently dropped), so an unstopped watch would tick against a corpse forever.
  ws.once('close', stop)
  const timer = setInterval(() => {
    const at = now()
    const slept = sleptFor(at - lastTickAt, heartbeatMs)
    lastTickAt = at
    if (slept > 0) {
      // Back from sleep: nothing was said because nobody here was listening. Ask now, and give the
      // peer a whole deadline of awake time to answer.
      const hungUp = opts.peerGivesUpAfterMs !== undefined && slept >= opts.peerGivesUpAfterMs
      // Forgiving EVERY detected sleep is what made the loopback socket's 40s deadline unenforceable:
      // on a throttled machine the detector fires constantly (see GENUINE_SLEEP_MS) and each firing
      // erased the silence, so terminations logged `no traffic for 912-995s`, 276 times in one log,
      // each closing every terminal stream on the connection. One pass is enough — a peer still there
      // answers the re-probe below, which clears the flag and earns it another. A sleep long enough to
      // be unambiguous is ALWAYS forgiven, so a real lid-close cannot be read as a throttled tick
      // (2026-09-28, the incident this whole file exists for).
      const forgive = !forgaveWithoutProof || slept >= GENUINE_SLEEP_MS
      opts.onWake?.(slept, hungUp || !forgive)
      if (hungUp || !forgive) { giveUp(); return }
      // Set BEFORE the ping so the spec's synchronous pong can clear it; on a real socket the pong
      // arrives a round trip later, through the poll phase, and clears it either way. An unambiguous
      // sleep hands the pass back with it, so the peer gets a whole deadline of AWAKE time however
      // late the following tick runs — the promise at the top of this file. Without that, a throttled
      // tick landing right after a wake (the most throttled moment there is) terminated a healthy
      // loopback socket with no grace at all, which is the 2026-09-28 class again.
      //
      // The alternative is `lastAliveAt += slept`: donate only the sleep and let the awake share of
      // every gap still count, which needs no flag and no constant. `terminalStreamManager.ts`
      // `expireLeases` does exactly that, and is right to — its timeout is six of its sweep periods,
      // so it keeps five periods of post-wake grace. Here `deadlineMs` is TWO heartbeats for the
      // loopback socket, so the same shape would leave a single ping after a wake instead of the three
      // this file promises. Hence the flag. What it costs: two genuine sleeps SHORTER than
      // GENUINE_SLEEP_MS, back to back, with the first one's pong never read, still terminate a
      // healthy socket — narrow, and the only hole left in the mechanism.
      forgaveWithoutProof = slept < GENUINE_SLEEP_MS
      lastAliveAt = at
      try { ws.ping() } catch { giveUp() }
      return
    }
    const idleMs = at - lastAliveAt
    if (idleMs >= deadlineMs) {
      opts.onIdle?.(idleMs)
      giveUp()
      return
    }
    // A ping that cannot even be written means the socket is already gone under us.
    try { ws.ping() } catch { giveUp(); return }
    opts.onTick?.()
  }, heartbeatMs)
  timer.unref?.()
  return { stop }
}
