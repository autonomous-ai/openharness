import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./computerUse.ts', import.meta.url).href)

describe.skipIf(process.platform === 'win32')('opencode reload', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    scene.program('opencode')
    await scene.endsWithItsProcess(`import { machineOpencode } from ${MODULE}
machineOpencode().reload()`, { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  }, 90_000)
})
