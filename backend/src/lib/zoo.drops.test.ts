import { describe, expect, it, vi } from 'vitest'

// Drop 1 (init) is released 2026-09-27; drop 2 (unix) and drop 3 (tty) are on hold, with no dates. This
// file takes unix off hold the way it will be one day, announced 2026-09-27 and out 2026-10-11 (tty stays
// on hold), and adds a fourth drop that is announced but not yet out, with one common daemon, to pin what
// a draw does on either side of a release date (daemons/README.md, "The draw").
vi.mock('./daemonRoster.g.js', async (original) => {
  const { DAEMON_ROSTER } = await original<typeof import('./daemonRoster.g.js')>()
  const drops = DAEMON_ROSTER.drops.map((d) => (d.id === 'unix' ? { id: 'unix', announce: '2026-09-27', release: '2026-10-11' } : d))
  return {
    DAEMON_ROSTER: {
      ...DAEMON_ROSTER,
      drops: [...drops, { id: 'plan9', announce: '2026-10-01', release: '2026-10-15' }],
      daemons: [...DAEMON_ROSTER.daemons, { id: 'rio', n: 1, drop: 'plan9', rarity: 'common' }],
    },
  }
})
const { DAEMON_ROSTER } = await import('./daemonRoster.g.js')
const { applyZooOps, drawWeights, dropReleased, emptyZoo, releasedDaemons } = await import('./zoo.js')

const regularsOf = (drop: string) => DAEMON_ROSTER.daemons.filter((d) => d.drop === drop && d.rarity !== 'secret').map((d) => d.id)
const REGULARS = regularsOf('init')
const UNIX = regularsOf('unix')
const TTY = regularsOf('tty')
const uid = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24)
const daemon = (id: string) => ({ uid: uid(id), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first' })
const eggOf = (kind: string) => ({ id: 'e', kind, grantedAt: '2026-10-01T00:00:00.000Z' })
const eligible = (zoo: ReturnType<typeof emptyZoo>, at: string, kind = 'turn') =>
  drawWeights(zoo, kind, new Date(at)).filter((w) => w.weight > 0).map((w) => w.id)
/** A small seeded generator, so a run is reproducible. */
function seeded(seed: number) {
  let a = seed >>> 0
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

describe('drops: announced, then released', () => {
  it('ships drop 1 (init) released, announced 14 days before, and drops 2 and 3 (unix, tty) on hold with no dates', async () => {
    const { DAEMON_ROSTER: shipped } = await vi.importActual<typeof import('./daemonRoster.g.js')>('./daemonRoster.g.js')
    expect(shipped.drops).toEqual([
      { id: 'init', announce: '2026-09-13', release: '2026-09-27' },
      { id: 'unix', hold: true },
      { id: 'tty', hold: true },
    ])
    expect(dropReleased(shipped.drops[0], new Date('2026-09-27T00:00:00.000Z'))).toBe(true)
    expect(dropReleased(shipped.drops[0], new Date('2026-09-26T23:59:59.999Z'))).toBe(false)
    expect(dropReleased(shipped.drops[1], new Date('2026-10-11T00:00:00.000Z'))).toBe(false)
    expect(dropReleased(shipped.drops[2], new Date('2026-10-11T00:00:00.000Z'))).toBe(false)
    // Nine regulars and a secret in each.
    expect(REGULARS).toEqual(['tim', 'gnu', 'lynx', 'mutt', 'yak', 'gopher', 'bug', 'tux', 'auk'])
    expect(UNIX).toEqual(['tmux', 'fish', 'ping', 'bat', 'vim', 'zsh', 'biff', 'fzf', 'tldr'])
    expect(TTY).toEqual(['xeyes', 'oneko', 'cowsay', 'fortune', 'rogue', 'sl', 'doctor', 'hack', 'tty'])
    const secretsOf = (drop: string) => shipped.daemons.filter((d) => d.drop === drop && d.rarity === 'secret').map((d) => d.id)
    expect([secretsOf('init'), secretsOf('unix'), secretsOf('tty')]).toEqual([['beastie'], ['grue'], ['lp0']])
  })

  it('never draws drop 2 before 2026-10-11, and adds its regulars to the set that day', () => {
    expect(releasedDaemons(new Date('2026-10-10T23:59:59.999Z')).map((d) => d.drop)).not.toContain('unix')
    expect(eligible(emptyZoo(), '2026-10-10T23:59:59.999Z')).toEqual(REGULARS)
    expect(eligible(emptyZoo(), '2026-10-11T00:00:00.000Z')).toEqual([...REGULARS, ...UNIX])
    // A hatch the day before gives drop 1, whatever the dice say.
    for (let seed = 1; seed <= 200; seed++) {
      const r = applyZooOps({ ...emptyZoo(), eggs: [eggOf('marathon')] }, [{ op: 'zoo.hatch', eggId: 'e' }], seeded(seed), new Date('2026-10-10T23:00:00.000Z'))
      expect(REGULARS).toContain(r.hatched[0].daemonId)
    }
    // Owning all of drop 1 before the release gives drop 1 again; from the release drop 2 joins the draw,
    // and is the only new one: what a run of eight hatches without a new species is owed.
    const allOfDrop1 = { ...emptyZoo(), daemons: REGULARS.map(daemon), eggs: [eggOf('turn')] }
    expect(eligible(allOfDrop1, '2026-10-10T12:00:00.000Z')).toEqual(REGULARS)
    expect(eligible({ ...allOfDrop1, sinceNew: 30 }, '2026-10-10T12:00:00.000Z')).toEqual(REGULARS)
    expect(eligible(allOfDrop1, '2026-10-11T12:00:00.000Z')).toEqual([...REGULARS, ...UNIX])
    expect(eligible({ ...allOfDrop1, sinceNew: 30 }, '2026-10-11T12:00:00.000Z')).toEqual(UNIX)
  })

  it('keeps grue a secret: only from an egg that can hold one, only once released, and the pity finds it', () => {
    expect(eligible(emptyZoo(), '2026-10-12T12:00:00.000Z')).not.toContain('grue')
    expect(eligible(emptyZoo(), '2026-10-12T12:00:00.000Z', 'night')).toEqual(expect.arrayContaining(['beastie', 'grue']))
    expect(eligible(emptyZoo(), '2026-10-10T12:00:00.000Z', 'night')).not.toContain('grue')
    // At a pity of 7 with beastie owned, the next night egg is grue once it is out, and cannot be before.
    const beastieOwned = { ...emptyZoo(), daemons: [daemon('beastie')], pity: 7, eggs: [eggOf('night')] }
    expect(eligible(beastieOwned, '2026-10-11T12:00:00.000Z', 'night')).toEqual(['grue'])
    const after = applyZooOps(beastieOwned, [{ op: 'zoo.hatch', eggId: 'e' }], seeded(3), new Date('2026-10-11T12:00:00.000Z'))
    expect(after.hatched[0].daemonId).toBe('grue')
    const before = applyZooOps(beastieOwned, [{ op: 'zoo.hatch', eggId: 'e' }], seeded(3), new Date('2026-10-10T12:00:00.000Z'))
    expect(REGULARS).toContain(before.hatched[0].daemonId)
  })

  it('never seeds a daemon of a drop that is not out yet', () => {
    const seed = { daemons: [daemon('tim'), daemon('fish'), daemon('grue'), daemon('xeyes')], eggs: [], paired: uid('fish') }
    const early = applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: seed }], seeded(1), new Date('2026-10-10T12:00:00.000Z'))
    expect(early.zoo.daemons.map((d) => d.id)).toEqual(['tim'])
    expect(early.zoo.paired).toBe(early.zoo.daemons[0].uid)
    const late = applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: seed }], seeded(1), new Date('2026-10-11T12:00:00.000Z'))
    expect(late.zoo.daemons.map((d) => d.id)).toEqual(['tim', 'fish'])         // never a secret, never tty (on hold)
    expect(late.zoo.paired).toBe(late.zoo.daemons[1].uid)
  })

  it('never draws a daemon of a drop that is only announced', () => {
    const plan9 = { id: 'plan9', announce: '2026-10-01', release: '2026-10-15' }
    expect(DAEMON_ROSTER.drops).toContainEqual(plan9)
    expect(dropReleased(plan9, new Date('2026-10-14T23:59:59.000Z'))).toBe(false)
    expect(releasedDaemons(new Date('2026-10-10T12:00:00.000Z')).map((d) => d.id)).not.toContain('rio')
    expect(eligible(emptyZoo(), '2026-10-14T12:00:00.000Z')).toEqual([...REGULARS, ...UNIX])
    expect(eligible(emptyZoo(), '2026-10-15T00:00:00.000Z')).toEqual([...REGULARS, ...UNIX, 'rio'])
  })

  it('counts a released drop\'s regulars toward the set the moment it is out', () => {
    // Eight hatches in a row without a new species: a new one is owed, while there is one to give.
    const allReleased = { ...emptyZoo(), daemons: [...REGULARS, ...UNIX].map(daemon), eggs: [eggOf('turn')], sinceNew: 8 }
    // Before the release every released regular is owned, so a draw gives one of them again...
    expect(eligible(allReleased, '2026-10-14T12:00:00.000Z')).toEqual([...REGULARS, ...UNIX])
    const before = applyZooOps(allReleased, [{ op: 'zoo.hatch', eggId: 'e' }], (n) => n - 1, new Date('2026-10-14T12:00:00.000Z'))
    expect([...REGULARS, ...UNIX]).toContain(before.hatched[0].daemonId)
    expect(before.zoo.sinceNew).toBe(9)
    // ...and on release day the new regular is the only one eligible.
    expect(eligible(allReleased, '2026-10-15T12:00:00.000Z')).toEqual(['rio'])
    const after = applyZooOps(allReleased, [{ op: 'zoo.hatch', eggId: 'e' }], (n) => n - 1, new Date('2026-10-15T12:00:00.000Z'))
    expect(after.hatched).toEqual([expect.objectContaining({ eggId: 'e', daemonId: 'rio', id: 'rio', shiny: false })])
    expect(after.zoo.sinceNew).toBe(0)
    // Without the run, it joins the draw beside everything owned.
    expect(eligible({ ...allReleased, sinceNew: 0 }, '2026-10-15T12:00:00.000Z')).toEqual([...REGULARS, ...UNIX, 'rio'])
  })

  it('keeps a drop on hold out while the drops around it come out', () => {
    expect(DAEMON_ROSTER.drops.find((d) => d.id === 'tty')).toEqual({ id: 'tty', hold: true })
    const tty: string[] = DAEMON_ROSTER.daemons.filter((d) => d.drop === 'tty').map((d) => d.id)
    for (const at of ['2026-10-11T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2999-12-31T23:59:59.999Z']) {
      expect(releasedDaemons(new Date(at)).map((d) => d.drop)).not.toContain('tty')
      for (const kind of ['turn', 'night', 'easter']) {
        expect(drawWeights(emptyZoo(), kind, new Date(at)).map((w) => w.id).filter((id) => tty.includes(id)), `${kind} at ${at}`).toEqual([])
      }
    }
    // With every released regular owned and every secret too, a draw gives duplicates, never a held daemon.
    const everyone = { ...emptyZoo(), daemons: [...REGULARS, ...UNIX, 'rio', 'beastie', 'grue'].map(daemon), eggs: [eggOf('night')] }
    expect(eligible(everyone, '2026-10-15T12:00:00.000Z', 'night')).toEqual([...REGULARS, ...UNIX, 'rio'])
  })
})
