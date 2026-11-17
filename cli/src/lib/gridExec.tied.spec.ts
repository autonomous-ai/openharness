import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./gridExec.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('a grid call', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('grid')
    await scene.endsWithItsProcess(`import { gridExec } from ${MODULE}
void gridExec(['--remote', 'ls'], { processEnv: { ...process.env, HARNESS_GRID_BIN: ${q(fake)} }, timeoutMs: 120_000 })`)
  }, 90_000)
})
