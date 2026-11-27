import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./appModels.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')("the Model Manager's scan", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('node')
    await scene.endsWithItsProcess(`import { scanAppModels } from ${MODULE}
void scanAppModels({ node: ${q(fake)}, packageDir: ${q(scene.dir)}, env: process.env })`)
  }, 90_000)
})
