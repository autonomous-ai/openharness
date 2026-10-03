import { describe, expect, it } from 'vitest'
import {
  applyZooOps, emptyProgress, emptyZoo, parseZoo, zooOpSchema, zooOpsBodySchema, ZOO_LESSON_MEMORY,
  type Zoo, type ZooDaemon, type ZooOp,
} from './zoo.js'
import { DAEMON_ROSTER } from './daemonRoster.g.js'

/** Bond for a lesson the person approved (daemons/LEARNING.md, "The zoo"; README, the `zoo.lesson` op). */

const XP = DAEMON_ROSTER.rules.lessonXp
const uid = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24)
const daemon = (id: string, extra: Partial<ZooDaemon> = {}): ZooDaemon =>
  ({ uid: uid(id), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first', ...extra })
const zooOf = (patch: Partial<Zoo>): Zoo => ({ ...emptyZoo(), ...patch, progress: { ...emptyProgress(), ...(patch.progress ?? {}) } })
const lesson = (lessonId: string, daemonId = 'tim'): ZooOp => ({ op: 'zoo.lesson', lessonId, daemonId })
const apply = (zoo: Zoo, ops: ZooOp[]) => applyZooOps(zoo, ops, () => 0, new Date('2026-09-27T12:00:00.000Z'))
const xpOf = (zoo: Zoo, id: string) => zoo.daemons.find((d) => d.id === id)?.xp

describe('zoo.lesson — bond for a lesson you approved', () => {
  it('is worth rules.lessonXp', () => {
    expect(XP).toBe(25)
  })

  it('grows the daemon that found it, even when another one is paired', () => {
    const zoo = zooOf({ daemons: [daemon('tim'), daemon('gnu')], paired: uid('gnu') })
    const r = apply(zoo, [lesson('3f2a9c1b', 'tim')])
    expect(r.changed).toBe(true)
    expect(xpOf(r.zoo, 'tim')).toBe(XP)
    expect(xpOf(r.zoo, 'gnu')).toBe(0)
    expect(r.zoo.progress.lessons).toEqual(['3f2a9c1b'])
  })

  it('grows the paired individual when it is of the species that found it, else the first of that species', () => {
    const tims = [daemon('tim'), daemon('gnu'), daemon('tim', { uid: uid('tim2') })]
    // The pair brain is the paired individual: a lesson its species found is its own.
    const mine = apply(zooOf({ daemons: tims, paired: uid('tim2') }), [lesson('a1', 'tim')])
    expect(mine.zoo.daemons.map((d) => d.xp)).toEqual([0, 0, XP])
    expect(mine.levelUps).toEqual([])
    // Paired to another species, the lesson goes to the first of the finder's species hatched.
    const other = apply(zooOf({ daemons: tims, paired: uid('gnu') }), [lesson('a1', 'tim')])
    expect(other.zoo.daemons.map((d) => d.xp)).toEqual([XP, 0, 0])
    // A level it reaches names the individual.
    const up = apply(zooOf({ daemons: tims.map((d) => ({ ...d, xp: 30 })), paired: uid('tim2') }), [lesson('a2', 'tim')])
    expect(up.levelUps).toEqual([{ uid: uid('tim2'), id: 'tim', level: 1, version: '0.1' }])
  })

  it('grows the paired daemon when the one that found it is not yours', () => {
    const zoo = zooOf({ daemons: [daemon('gnu')], paired: uid('gnu') })
    const r = apply(zoo, [lesson('a1', 'tim')])
    expect(xpOf(r.zoo, 'gnu')).toBe(XP)
    expect(r.zoo.daemons.map((d) => d.id)).toEqual(['gnu'])
  })

  it('counts a lesson once: a retry of a report that landed grows nothing and writes nothing', () => {
    const zoo = zooOf({ daemons: [daemon('tim')], paired: uid('tim') })
    const once = apply(zoo, [lesson('a1'), lesson('a1')])
    expect(xpOf(once.zoo, 'tim')).toBe(XP)
    const again = apply(once.zoo, [lesson('a1')])
    expect(again.changed).toBe(false)
    expect(xpOf(again.zoo, 'tim')).toBe(XP)
    expect(apply(once.zoo, [lesson('a2')]).zoo.daemons[0]!.xp).toBe(2 * XP)
  })

  it('recomputes level and version and answers the level it reached', () => {
    // 40 xp is level 0; 25 more reaches 50, level 1. At 140, 25 more reaches 150: level 2, version 1.0.
    const low = apply(zooOf({ daemons: [daemon('tim', { xp: 40 })], paired: uid('tim') }), [lesson('a1')])
    expect(low.levelUps).toEqual([{ uid: uid('tim'), id: 'tim', level: 1, version: '0.1' }])
    const high = apply(zooOf({ daemons: [daemon('tim', { xp: 140, bond: 1 })], paired: uid('tim') }), [lesson('a2')])
    expect(high.levelUps).toEqual([{ uid: uid('tim'), id: 'tim', level: 2, version: '1.0' }])
    expect(high.zoo.daemons[0]).toMatchObject({ xp: 165, bond: 2, version: '1.0' })
    expect(apply(zooOf({ daemons: [daemon('tim')], paired: uid('tim') }), [lesson('a3')]).levelUps).toEqual([])
  })

  it('grows nothing, and remembers nothing, with no daemon to grow', () => {
    const r = apply(emptyZoo(), [lesson('a1')])
    expect(r.changed).toBe(false)
    expect(r.zoo.progress.lessons).toEqual([])
    // Hatched later, the same lesson reported again still counts.
    const later = apply(zooOf({ daemons: [daemon('tim')], paired: uid('tim') }), [lesson('a1')])
    expect(xpOf(later.zoo, 'tim')).toBe(XP)
  })

  it(`remembers the last ${ZOO_LESSON_MEMORY} lesson ids`, () => {
    let zoo = zooOf({ daemons: [daemon('tim')], paired: uid('tim') })
    const ids = Array.from({ length: ZOO_LESSON_MEMORY + 4 }, (_, i) => `l${i}`)
    for (let i = 0; i < ids.length; i += 64) zoo = apply(zoo, ids.slice(i, i + 64).map((id) => lesson(id))).zoo
    expect(zoo.progress.lessons).toHaveLength(ZOO_LESSON_MEMORY)
    expect(zoo.progress.lessons[0]).toBe('l4')
    expect(xpOf(zoo, 'tim')).toBe(ids.length * XP)
  })

  it('refuses a malformed report; the ids are short and id-safe', () => {
    expect(zooOpSchema.safeParse(lesson('3f2a9c1b')).success).toBe(true)
    expect(zooOpSchema.safeParse({ op: 'zoo.lesson', lessonId: '', daemonId: 'tim' }).success).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.lesson', lessonId: 'a b', daemonId: 'tim' }).success).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.lesson', lessonId: 'x'.repeat(65), daemonId: 'tim' }).success).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.lesson', lessonId: 'a1', daemonId: 'Tim!' }).success).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.lesson', lessonId: 'a1' }).success).toBe(false)
    expect(zooOpSchema.safeParse({ ...lesson('a1'), xp: 1000 }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: [lesson('a1'), { op: 'zoo.lesson', lessonId: 'a2', daemonId: 'tim', xp: 9 }] }).success).toBe(false)
  })

  it('keeps the remembered ids when a zoo is stored and read back, and never takes a guest\'s', () => {
    const stored = parseZoo({ progress: { lessons: ['a1', 'bad id', 'a1', 'a2', 7] } })
    expect(stored.progress.lessons).toEqual(['a1', 'a2'])
    const guest = { daemons: [daemon('tim')], progress: { turns: 3, lessons: ['g1'] } }
    const seeded = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: guest }])
    expect(seeded.zoo.daemons.map((d) => d.id)).toEqual(['tim'])              // the seed landed
    expect(seeded.zoo.progress.lessons).toEqual([])
  })
})
