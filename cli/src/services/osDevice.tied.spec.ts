import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./osDevice.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')("gh's device sign-in", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('gh')
    await scene.endsWithItsProcess(`import { githubDeviceSignIn } from ${MODULE}
githubDeviceSignIn(${q(fake)})`)
  }, 90_000)
})
