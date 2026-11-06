import { describe, expect, it } from 'vitest'
import { throttleHeadReads } from './headReadThrottle.js'
import type { PullRequestReader, PullRequestWatch } from './pullRequestEvents.js'

const PR = 'https://github.com/acme/app/pull/7'
const A = 'a'.repeat(40), B = 'b'.repeat(40)
const watch = (head = A): PullRequestWatch => ({ url: PR, number: 7, state: 'open', draft: false, head, base: 'main', mergeable: true,
  checkRuns: [], checkSuites: [], reviews: [], comments: [] })
function fixture() {
  let now = 0, current: PullRequestWatch | null = watch(), closed = 0
  const reads: string[] = []
  const wrap = throttleHeadReads(() => now)
  const reader = (): PullRequestReader => wrap({
    watch: async url => { reads.push(`watch ${url}`); return current },
    patch: async (url, head, base) => { reads.push(`patch ${url} ${head} ${base}`); return `${head}@${base}` },
    merge: async (url, head, base) => { reads.push(`merge ${url} ${head} ${base}`); return head === B ? A : null },
    botLogin: async () => 'harness[bot]', done: async () => { closed++ },
  })
  return { reader, wrap, reads, setNow: (at: number) => { now = at }, setWatch: (value: PullRequestWatch | null) => { current = value },
    closed: () => closed }
}

describe('on-demand PR head reads', () => {
  it('shares a PR observation across repeated readers for 30 seconds, then reads its new head', async () => {
    const f = fixture()
    expect(await f.reader().watch(PR)).toMatchObject({ head: A })
    f.setWatch(watch(B))
    f.setNow(29_999)
    expect(await f.reader().watch(PR)).toMatchObject({ head: A })
    expect(f.reads).toEqual([`watch ${PR}`])
    f.setNow(30_000)
    expect(await f.reader().watch(PR)).toMatchObject({ head: B })
    expect(f.reads).toEqual([`watch ${PR}`, `watch ${PR}`])
  })

  it('joins in-flight reads even when they take longer than the cooldown', async () => {
    const f = fixture()
    let finish!: (value: PullRequestWatch) => void
    const pending = new Promise<PullRequestWatch>(resolve => { finish = resolve })
    let reads = 0
    const slow = f.wrap({ ...f.reader(), watch: async () => { reads++; return pending } })
    const first = slow.watch(PR)
    f.setNow(60_000)
    const second = slow.watch(PR)
    finish(watch(B))
    expect(await Promise.all([first, second])).toEqual([watch(B), watch(B)])
    expect(reads).toBe(1)
  })

  it('keeps different PRs independent and shares repository spellings', async () => {
    const f = fixture()
    await f.reader().watch(PR)
    await f.reader().watch('https://github.com/ACME/APP/pull/7')
    await f.reader().watch('https://github.com/acme/app/pull/8')
    expect(f.reads).toEqual([`watch ${PR}`, 'watch https://github.com/acme/app/pull/8'])
  })

  it('shares patch and merge reads only for the same PR, head and case-sensitive base', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) {
      const r = f.reader()
      expect(await r.patch(PR, B, 'main')).toBe(`${B}@main`)
      expect(await r.merge(PR, B, 'main')).toBe(A)
    }
    expect(f.reads).toEqual([`patch ${PR} ${B} main`, `merge ${PR} ${B} main`])
    expect(await f.reader().patch(PR, B, 'Main')).toBe(`${B}@Main`)
    expect(await f.reader().patch(PR, A, 'main')).toBe(`${A}@main`)
    expect(await f.reader().patch(`${PR}0`, B, 'main')).toBe(`${B}@main`)
    expect(f.reads).toHaveLength(5)
  })

  it('throttles an unreadable PR too and retries after the window', async () => {
    const f = fixture()
    f.setWatch(null)
    expect(await f.reader().watch(PR)).toBeNull()
    f.setWatch(watch(B))
    expect(await f.reader().watch(PR)).toBeNull()
    expect(f.reads).toHaveLength(1)
    f.setNow(30_000)
    expect(await f.reader().watch(PR)).toMatchObject({ head: B })
    expect(f.reads).toHaveLength(2)
  })

  it('does not replay an older cached head over a newer stored observation', async () => {
    const f = fixture()
    await f.reader().watch(PR)
    f.setNow(1)
    const r = f.wrap(f.reader(), { [PR]: { head: B, base: 'main', patch: null, at: 1 } })
    expect(await r.watch(PR)).toBeNull()
    expect(f.reads).toEqual([`watch ${PR}`])
    f.setWatch(watch(B))
    f.setNow(30_000)
    expect(await r.watch(PR)).toMatchObject({ head: B })
  })

  it('turns a thrown read into a cached failure without skipping reader cleanup', async () => {
    const f = fixture()
    let reads = 0
    const r = f.wrap({ ...f.reader(), watch: async () => { reads++; throw new Error('unavailable') } })
    try {
      expect(await r.watch(PR)).toBeNull()
      expect(await r.watch(PR)).toBeNull()
      expect(reads).toBe(1)
    } finally { await r.done() }
    expect(f.closed()).toBe(1)
  })

  it('evicts old completed observations after 1,000 PRs instead of growing without a bound', async () => {
    const f = fixture()
    for (let i = 1; i <= 1_001; i++) await f.reader().watch(`https://github.com/acme/app/pull/${i}`)
    const before = f.reads.length
    await f.reader().watch('https://github.com/acme/app/pull/1')
    expect(f.reads.length).toBe(before + 1)
    expect(f.reads.at(-1)).toBe('watch https://github.com/acme/app/pull/1')
  })
})
