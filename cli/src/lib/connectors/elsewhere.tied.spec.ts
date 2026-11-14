import { describe, it } from 'vitest'
import { tiedScene } from '../../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./elsewhere.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('an engine\'s connector read', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('claude')
    await scene.endsWithItsProcess(`import { elsewhere } from ${MODULE}
void elsewhere({ binary: (name) => name === 'claude' ? ${q(fake)} : null })`)
  }, 90_000)
})
