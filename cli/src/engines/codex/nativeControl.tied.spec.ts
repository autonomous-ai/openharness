import { describe, it } from 'vitest'
import { tiedScene } from '../../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./nativeControl.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('the Codex control proxy', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('codex')
    await scene.endsWithItsProcess(`import { connectCodexControl } from ${MODULE}
void connectCodexControl(${q(scene.dir)}).catch(() => {})`, { env: { CODEX_PATH: fake } })
  }, 90_000)
})
