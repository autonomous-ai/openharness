import { describe, expect, it, vi } from 'vitest'
import { ZOO_LESSON_RETRY_MS, ZooLessonReporter, type ZooLessonPost } from './zooLessons.js'

function harness(opts: { signedIn?: boolean; answers?: Array<number | Error>; enabled?: boolean } = {}) {
  let signedIn = opts.signedIn ?? true
  // Daemons on (lib/daemonsSwitch.ts) unless a test says otherwise.
  const enabled = opts.enabled ?? true
  const answers = [...(opts.answers ?? [])]
  const sent: Array<Array<{ lessonId: string; daemonId: string }>> = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const post = vi.fn<ZooLessonPost>(async (body) => {
    sent.push(body.ops.map(({ lessonId, daemonId }) => ({ lessonId, daemonId })))
    const next = answers.shift() ?? 200
    if (next instanceof Error) throw next
    return { status: next, body: next === 200 ? { success: true, data: { levelUps: [{ id: 'tim', level: 1, version: '0.1' }] } } : {} }
  })
  const log: string[] = []
  const reporter = new ZooLessonReporter({
    post, signedIn: () => signedIn, enabled: () => enabled, log: (line) => log.push(line),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {},
  })
  return { reporter, post, sent, timers, log, signOut: () => { signedIn = false } }
}

describe('ZooLessonReporter — bond for an approved lesson', () => {
  it('sends zoo.lesson for the daemon that found it, at once', async () => {
    const h = harness()
    expect(h.reporter.credit('3f2a9c1b', 'tim')).toBe(true)
    await h.reporter.idle()
    expect(h.sent).toEqual([[{ lessonId: '3f2a9c1b', daemonId: 'tim' }]])
    expect(h.post).toHaveBeenCalledWith({ ops: [{ op: 'zoo.lesson', lessonId: '3f2a9c1b', daemonId: 'tim' }] })
    expect(h.reporter.waiting).toBe(0)
    expect(h.log.join('\n')).toContain('tim reached level 1')
  })

  it('sends nothing for a guest: the journal is the record', async () => {
    const h = harness({ signedIn: false })
    expect(h.reporter.credit('3f2a9c1b', 'tim')).toBe(false)
    await h.reporter.idle()
    expect(h.post).not.toHaveBeenCalled()
  })

  it('never sends ids the server would refuse', async () => {
    const h = harness()
    expect(h.reporter.credit('has space', 'tim')).toBe(false)
    expect(h.reporter.credit('a1', 'Tim!')).toBe(false)
    expect(h.reporter.credit('', 'tim')).toBe(false)
    await h.reporter.idle()
    expect(h.post).not.toHaveBeenCalled()
  })

  it('retries a failed send a minute later with the same lesson id, once per lesson', async () => {
    const h = harness({ answers: [502, new Error('offline'), 200] })
    h.reporter.credit('a1', 'tim')
    h.reporter.credit('a1', 'tim')                                  // the same lesson twice is one credit
    await h.reporter.idle()
    expect(h.reporter.waiting).toBe(1)
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]!.ms).toBe(ZOO_LESSON_RETRY_MS)
    h.timers[0]!.fn()
    await h.reporter.idle()
    expect(h.reporter.waiting).toBe(1)
    h.timers[1]!.fn()
    await h.reporter.idle()
    expect(h.reporter.waiting).toBe(0)
    expect(h.sent.flat().every((op) => op.lessonId === 'a1')).toBe(true)
  })

  it('drops a credit the server will never take, or once signed out', async () => {
    const h = harness({ answers: [400] })
    h.reporter.credit('a1', 'tim')
    await h.reporter.idle()
    expect(h.reporter.waiting).toBe(0)
    expect(h.timers).toHaveLength(0)
    const out = harness({ answers: [503] })
    out.reporter.credit('a2', 'tim')
    await out.reporter.idle()
    expect(out.reporter.waiting).toBe(1)
    out.signOut()
    await out.reporter.flush()
    expect(out.reporter.waiting).toBe(0)
    expect(out.sent).toHaveLength(1)
  })

  it('credits nothing while daemons are off, drops a 404, and forgets what waited when they go off', async () => {
    const off = harness({ enabled: false })
    expect(off.reporter.credit('a1', 'tim')).toBe(false)
    await off.reporter.flush()
    expect(off.post).not.toHaveBeenCalled()
    const gone = harness({ answers: [404] })
    gone.reporter.credit('a1', 'tim')
    await gone.reporter.idle()
    expect(gone.reporter.waiting).toBe(0)
    expect(gone.timers).toHaveLength(0)
    const waiting = harness({ answers: [503] })
    waiting.reporter.credit('a2', 'tim')
    await waiting.reporter.idle()
    expect(waiting.reporter.waiting).toBe(1)
    waiting.reporter.clear()
    expect(waiting.reporter.waiting).toBe(0)
  })
})
