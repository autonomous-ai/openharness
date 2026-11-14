import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./claudeSignIn.ts', import.meta.url).href)

describe.skipIf(process.platform === 'win32')("an engine's login", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    scene.program('claude')
    await scene.endsWithItsProcess(`import { startEngineLogin } from ${MODULE}
startEngineLogin('claude')`, { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  }, 90_000)
})
