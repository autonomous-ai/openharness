import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./viewer.ts', import.meta.url).href)

describe.skipIf(process.platform === 'win32')("the shared viewer's Chrome", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('chrome')
    await scene.endsWithItsProcess(`import { ViewerCapture } from ${MODULE}
void new ViewerCapture().start('http://127.0.0.1:9/').catch(() => {})`, { env: { HARNESS_VIEWER_BROWSER: fake } })
  }, 90_000)
})
