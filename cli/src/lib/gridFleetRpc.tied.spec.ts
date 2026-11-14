import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./gridFleetRpc.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('a grid fleet command', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('grid')
    await scene.endsWithItsProcess(`import { GridFleetRpc } from ${MODULE}
void new GridFleetRpc({ ...process.env, HARNESS_GRID_BIN: ${q(fake)} }).run('owner', 'job', { args: ['--remote', 'join', '--serve'], timeoutMs: 120_000 })`)
  }, 90_000)
})
