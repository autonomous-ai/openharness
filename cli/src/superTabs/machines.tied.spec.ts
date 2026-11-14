import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./machines.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')("the Swarm's quiet git", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    scene.program('git', { withChild: true })
    await scene.endsWithItsProcess(`import { createQuietGit } from ${MODULE}
void createQuietGit(120_000)(${q(scene.dir)}, ['status'])`, { env: { PATH: `${scene.dir}:${process.env.PATH}` }, count: 2 })
  }, 90_000)
})
