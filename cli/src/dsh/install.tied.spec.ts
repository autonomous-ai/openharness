import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./install.ts', import.meta.url).href)

describe.skipIf(process.platform === 'win32')("a Store package's git", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    scene.program('git')
    await scene.endsWithItsProcess(`import { cloneInstall } from ${MODULE}
void cloneInstall('https://example.invalid/acme/thing.git', undefined, undefined, undefined, [])`,
      { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  }, 90_000)
})
