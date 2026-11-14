import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./gridHandoff.ts', import.meta.url).href)

describe.skipIf(process.platform === 'win32')('the grid sign-in', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('grid')
    await scene.endsWithItsProcess(`import { handOffToGrid } from ${MODULE}
void handOffToGrid('token', { json: true, timeoutMs: 120_000 })`, { env: { HARNESS_GRID_BIN: fake } })
  }, 90_000)
})
