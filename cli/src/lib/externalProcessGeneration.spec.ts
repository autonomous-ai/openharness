import { expect, it, vi } from 'vitest'
import { externalProcessGeneration } from './externalProcessGeneration.js'
import { processStartMarker } from './processLiveness.js'
vi.mock('./processLiveness.js', () => ({ processStartMarker: vi.fn() }))
it('normalizes OS incarnation markers without using the host clock or timezone', () => {
  for (const [marker, expected] of [
    ['linux:1234', 'linux:1234'], ['ps-c:Thu Oct  8 10:00:00 2026', 'ps:1791453600000'],
    ['ps-c:unreadable', null], ['old marker', null], [null, null],
  ]) {
    vi.mocked(processStartMarker).mockReturnValue(marker)
    expect(externalProcessGeneration(7)).toBe(expected)
  }
})
