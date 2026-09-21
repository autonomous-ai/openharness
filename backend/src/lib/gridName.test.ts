import { describe, expect, it } from 'vitest'
import { harnessGridName } from './gridName.js'

/**
 * The NAME only. The route's referee (a conditional `updateMany`) is a database property and is
 * covered where the other Prisma paths are; what is worth pinning here is the string itself, because
 * it is what a grid gets called forever — the stored value is authoritative and this formula runs
 * once.
 */
describe('harnessGridName', () => {
  const ID = '68c1f4a2b3d4e5f601234567'

  it('is the email local-part, a dash, and eight hex of the account id', () => {
    expect(harnessGridName('anhthuychaucfc@gmail.com', ID)).toMatch(/^anhthuychaucfc-[0-9a-f]{8}$/)
  })

  it('is stable for one account and different for another', () => {
    const mine = harnessGridName('sam@example.com', ID)
    expect(harnessGridName('sam@example.com', ID)).toBe(mine)
    // The case the email prefix alone cannot cover: same local-part, different person. Grid names
    // are globally unique, so these two must not collide.
    expect(harnessGridName('sam@other.test', '68c1f4a2b3d4e5f60fedcba9')).not.toBe(mine)
  })

  it('reduces a local-part to what the grid CLI would slugify it to anyway', () => {
    // `gridProviderId` in the harness CLI maps [^a-z0-9]+ → '-', so doing it here means the stored
    // name and the sent name are the same string.
    expect(harnessGridName('First.Last+tag@example.com', ID)).toMatch(/^first-last-tag-[0-9a-f]{8}$/)
  })

  it('never produces a name that is only a suffix', () => {
    // A local-part of pure punctuation reduces to nothing; `user` is better than `-7f3a91c4`.
    expect(harnessGridName('...@example.com', ID)).toMatch(/^user-[0-9a-f]{8}$/)
    expect(harnessGridName('@example.com', ID)).toMatch(/^user-[0-9a-f]{8}$/)
  })

  it('bounds the local-part and never ends it on a dash', () => {
    const long = 'a'.repeat(80)
    const name = harnessGridName(`${long}@example.com`, ID)
    expect(name.length).toBeLessThanOrEqual(32 + 1 + 8)
    // A 32-char cut can land mid-dash-run; a trailing dash before the suffix would read as a typo.
    expect(name).not.toContain('--')
    expect(harnessGridName(`${'b'.repeat(31)}.tail@example.com`, ID)).not.toContain('--')
  })
})
