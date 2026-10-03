/**
 * Bond for a lesson the person approved (daemons/LEARNING.md, "The zoo"; the server side is
 * backend/src/lib/zoo.ts, op `zoo.lesson`). The learner's `credit` hook (pair/learn/propose.ts) calls
 * `credit(lessonId, daemonId)` once per approval; this sends `zoo.lesson { lessonId, daemonId }` through the
 * daemon's signed-in backend path, the same one `zoo.turn` takes (lib/zooTurns.ts).
 *
 * Signed in only. A guest's approval is journaled on this machine (`learned`, pair/sensor.ts) and nothing is
 * sent: a guest's zoo is the desktop's. The server counts a lesson id once, so a send that failed is
 * retried a minute later with the same id, and one that landed but whose answer was lost grows nothing
 * the second time. A 400, 401, 403 or 404 drops it (a report this server will never take — a 404 is a server
 * with daemons off — or signed out). Only while daemons are on (lib/daemonsSwitch.ts).
 */

/** How long a failed credit waits before it is sent again. */
export const ZOO_LESSON_RETRY_MS = 60_000
/** Credits waiting for a successful send, oldest dropped first past this. */
const MAX_PENDING = 64
const LESSON_ID = /^[A-Za-z0-9_-]{1,64}$/
const DAEMON_ID = /^[a-z][a-z0-9-]{0,15}$/

export interface ZooLessonOp { op: 'zoo.lesson'; lessonId: string; daemonId: string }
export type ZooLessonPost = (body: { ops: ZooLessonOp[] }) => Promise<{ status: number; body: Record<string, unknown> }>

export interface ZooLessonReporterDeps {
  /** POST /api/zoo/ops through the daemon's authenticated backend path (proxyBackend in cli.ts). */
  post: ZooLessonPost
  /** Only a signed-in daemon reports. */
  signedIn: () => boolean
  /** Daemons are on (lib/daemonsSwitch.ts). Off, nothing is credited or retried. Absent: on. */
  enabled?: () => boolean
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (line: string) => void
}

export class ZooLessonReporter {
  private pending: ZooLessonOp[] = []
  private timer: unknown = null
  private inFlight: Promise<void> | null = null
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (line: string) => void

  constructor(private readonly deps: ZooLessonReporterDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.log = deps.log ?? ((line) => console.log(line))
  }

  /**
   * An approved lesson, credited to the daemon that found it. False when nothing will be sent: signed
   * out (a guest: the journal is the record) or ids the server would refuse.
   */
  credit(lessonId: string, daemonId: string): boolean {
    if (!this.on() || !this.deps.signedIn() || !LESSON_ID.test(lessonId) || !DAEMON_ID.test(daemonId)) return false
    if (this.pending.some((op) => op.lessonId === lessonId)) return true     // already on its way
    this.pending = [...this.pending, { op: 'zoo.lesson' as const, lessonId, daemonId }].slice(-MAX_PENDING)
    void this.flush()
    return true
  }

  get waiting(): number { return this.pending.length }

  /** Send what waits now. Serialized: a flush while one is in flight runs after it. */
  flush(): Promise<void> {
    const run = (this.inFlight ?? Promise.resolve()).then(() => this.send())
    const tracked: Promise<void> = run.finally(() => { if (this.inFlight === tracked) this.inFlight = null })
    this.inFlight = tracked
    return tracked
  }

  /** Settles once no send is in flight (the one `credit` or a retry started included). */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  stop(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
  }

  /** Daemons went off: nothing waits, nothing is armed. */
  clear(): void {
    this.stop()
    this.pending = []
  }

  private on(): boolean { return this.deps.enabled?.() ?? true }

  private async send(): Promise<void> {
    if (!this.pending.length) return
    if (!this.on() || !this.deps.signedIn()) { this.pending = []; return }
    const ops = [...this.pending]
    let status: number
    let body: Record<string, unknown> = {}
    try {
      const res = await this.deps.post({ ops })
      status = res.status
      body = res.body
    } catch {
      status = 0
    }
    const sent = new Set(ops.map((op) => op.lessonId))
    const names = ops.map((op) => `${op.lessonId} (${op.daemonId})`).join(', ')
    if ((status >= 200 && status < 300) || status === 400 || status === 401 || status === 403 || status === 404) {
      this.pending = this.pending.filter((op) => !sent.has(op.lessonId))
      if (status >= 200 && status < 300) {
        const levelUps = ((body.data as { levelUps?: unknown } | undefined)?.levelUps ?? []) as Array<{ id?: unknown; level?: unknown }>
        const grew = Array.isArray(levelUps) && levelUps.length ? `; ${levelUps.map((l) => `${String(l.id)} reached level ${String(l.level)}`).join(', ')}` : ''
        this.log(`[zoo] credited lesson ${names}${grew}`)
      } else this.log(`[zoo] dropped lesson credit ${names}: ${status}`)
      return
    }
    this.log(`[zoo] could not credit lesson ${names} (${status || 'no answer'}); retrying`)
    if (this.timer === null) this.timer = this.setTimer(() => { this.timer = null; void this.flush() }, ZOO_LESSON_RETRY_MS)
  }
}
