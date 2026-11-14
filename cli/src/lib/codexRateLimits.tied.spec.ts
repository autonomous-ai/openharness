import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./codexRateLimits.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('the rate-limit read\'s Codex', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('codex', { withChild: true })
    await scene.endsWithItsProcess(`import { readCodexRateLimits } from ${MODULE}
void readCodexRateLimits({ codexPath: ${q(fake)}, timeoutMs: 120_000 })`, { count: 2 })
  }, 90_000)
})
