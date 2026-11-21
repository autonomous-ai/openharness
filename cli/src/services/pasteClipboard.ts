/** One bounded clipboard reservation across panes and worker replacement. Core owns final input. */
import { errorKind } from '../lib/log.js'
import type { PasteClipboardRequest, PasteClipboardResult } from '../core/api.js'
import { openPreparedPaste, PasteArtifactCleanupUnconfirmed } from '../lib/pasteArtifact.js'
import { isWsl, startClipboardOwner, type ClipboardOwner } from './pasteClipboardNative.js'
import { createClipboardReservation, type ClipboardClaim, type ClipboardReservation } from './pasteClipboardReservation.js'

type Job = { request: PasteClipboardRequest; resolve(result: PasteClipboardResult): void; timer: ReturnType<typeof setTimeout>;
  owner?: ClipboardOwner; lease?: ClipboardClaim; claiming: boolean; leaseSettled: boolean; releasing?: Promise<void>;
  cancelled: boolean; released: boolean; inputSettled: boolean; abandoned: boolean; ready: boolean; written: boolean; settled: boolean;
  done: Promise<void>; finish(): void }
const failed = (reason: string): PasteClipboardResult => ({ state: 'failed', reason })

export function createPasteClipboard(dataDir: string, deps: {
  open?: typeof openPreparedPaste; start?: typeof startClipboardOwner
  busy?: (connection: string) => { total: number; connection: number }
  reservation?: ClipboardReservation; log?: (code: string) => void
} = {}) {
  const jobs = new Map<string, Job>(), waiting: Job[] = []
  const reservation = deps.reservation ?? createClipboardReservation(dataDir)
  const log = deps.log ?? ((code) => console.warn(`[paste] ${code}`))
  let current: Job | undefined, stopped = false
  const settle = (job: Job): void => {
    if (job.claiming) return
    if (job.lease && !job.leaseSettled && !job.releasing) {
      if ((job.inputSettled && (job.written || job.settled) || job.ready && !job.written && job.settled) && (!job.cancelled || job.settled)) {
        job.releasing = job.lease.release().catch((caughtFailure) => { log(('PASTE_CLIPBOARD_RELEASE_FAILED') + ' · ' + errorKind(caughtFailure)) }).then(() => {
          job.leaseSettled = true; settle(job)
        })
      } else if (job.abandoned && job.written) {
        // Core may still have input in flight. The durable marker takes over ownership; never unlink it on worker loss.
        job.leaseSettled = true
      }
    }
    if (!job.leaseSettled) return
    if (current === job && job.ready && (job.released || !job.written)
      && (job.settled || job.written && !job.cancelled)) current = undefined
    if (job.settled && (job.released || !job.written)) {
      clearTimeout(job.timer); jobs.delete(job.request.generation); job.finish()
    }
    pump()
  }
  const cancelJob = (job: Job, abandoned = false): void => {
    job.cancelled = true; job.abandoned ||= abandoned; job.released ||= abandoned
    job.resolve(failed('PASTE_CANCELLED'))
    if (job.owner) job.owner.cancel()
    else if (!job.claiming) {
      const index = waiting.indexOf(job)
      if (index >= 0) waiting.splice(index, 1)
      job.ready = true; job.settled = true
    }
    settle(job)
  }
  const pump = (): void => {
    if (stopped || current) return
    const job = waiting.shift()
    if (!job) return
    current = job; job.claiming = true; job.leaseSettled = false
    void reservation.claim(job.request.corePid ?? process.pid, job.request.generation).then((lease) => {
      job.claiming = false
      if (!lease) {
        job.ready = true; job.settled = true; job.leaseSettled = true
        job.resolve({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_HELD' }); settle(job); return
      }
      job.lease = lease
      if (job.cancelled) { job.ready = true; job.settled = true; settle(job); return }
      try {
        const file = (deps.open ?? openPreparedPaste)(job.request.generation, job.request.artifact, dataDir, 8 * 1024 * 1024)
        job.owner = (deps.start ?? startClipboardOwner)(file)
      } catch (error) {
        if (error instanceof PasteArtifactCleanupUnconfirmed) {
          log(`PASTE_FILE_CLOSE_FAILED · ${errorKind(error)}`)
          job.owner = { ready: Promise.resolve(failed('PASTE_FILE_CLOSE_FAILED')), settled: new Promise<void>(() => {}), cancel() {} }
        } else {
          job.ready = true; job.settled = true; job.resolve(failed('PASTE_INVALID_ARTIFACT')); settle(job); return
        }
      }
      void job.owner.ready.then((result) => {
        job.ready = true; job.written = result.state === 'written'
        job.resolve(job.cancelled ? failed('PASTE_CANCELLED') : result); settle(job)
      })
      void job.owner.settled.then(() => { job.settled = true; settle(job) })
    }).catch((error: unknown) => {
      job.claiming = false; job.ready = true; job.settled = true; job.leaseSettled = true
      const reason = error instanceof Error && /^PASTE_[A-Z_]{1,40}$/.test(error.message) ? error.message : 'PASTE_CLIPBOARD_RESERVATION_FAILED'
      log(`PASTE_CLIPBOARD_RESERVATION_FAILED · ${errorKind(error)}`); job.resolve(failed(reason)); settle(job)
    })
  }
  return {
    prepare(request: PasteClipboardRequest): Promise<PasteClipboardResult> {
      if (stopped) return Promise.resolve(failed('PASTE_UNAVAILABLE'))
      // These platforms use the established path fallback. They need neither a clipboard lease nor a process probe.
      if (!deps.start && (process.platform === 'win32' || process.platform === 'linux' && isWsl())) {
        return Promise.resolve({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_UNAVAILABLE' })
      }
      if (jobs.has(request.generation)) return Promise.resolve(failed('PASTE_CLIPBOARD_BUSY'))
      const busy = deps.busy?.(request.connection) ?? { total: 0, connection: 0 }
      if (jobs.size + busy.total >= 32 || [...jobs.values()].filter((job) => job.request.connection === request.connection).length + busy.connection >= 4) {
        return Promise.resolve(failed('PASTE_CAPACITY'))
      }
      return new Promise((resolve) => {
        let finish!: () => void
        const done = new Promise<void>((resolveDone) => { finish = resolveDone })
        const job: Job = { request, resolve, claiming: false, leaseSettled: true, cancelled: false, released: false,
          inputSettled: false, abandoned: false, ready: false, written: false, settled: false, done, finish,
          timer: setTimeout(() => { job.resolve(failed('PASTE_CLIPBOARD_TIMEOUT')); cancelJob(job) }, 30_000) }
        job.timer.unref(); jobs.set(request.generation, job); waiting.push(job); pump()
      })
    },
    usage(connection: string) {
      return { total: jobs.size, connection: [...jobs.values()].filter((job) => job.request.connection === connection).length }
    },
    release(generation: string, corePid = process.pid): Promise<void> {
      const job = jobs.get(generation)
      if (!job) return reservation.release(corePid, generation).catch((caughtFailure) => { log(('PASTE_CLIPBOARD_RELEASE_FAILED') + ' · ' + errorKind(caughtFailure)) })
      if ((job.request.corePid ?? process.pid) !== corePid) return Promise.resolve()
      job.released = true; job.inputSettled = true
      if (!job.ready) cancelJob(job)
      else {
        // A delivered Linux owner serves the clipboard until replacement, still charged and tied to this worker.
        if (job.written && !job.cancelled) clearTimeout(job.timer)
        settle(job)
      }
      return job.releasing ?? Promise.resolve()
    },
    cancel(generation: string | null) {
      if (generation === null) for (const job of [...jobs.values()]) cancelJob(job, true)
      else { const job = jobs.get(generation); if (job) cancelJob(job) }
    },
    async stop() {
      stopped = true
      const ending = [...jobs.values()]
      for (const job of ending) cancelJob(job, true)
      await Promise.all(ending.map((job) => job.done))
    },
  }
}
