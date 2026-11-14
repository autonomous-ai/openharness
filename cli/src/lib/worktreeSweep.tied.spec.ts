import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./worktreeSweep.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')("a worktree's git", () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    scene.program('git')
    await scene.endsWithItsProcess(`import { git } from ${MODULE}
void git(${q(scene.dir)}, ['status']).catch(() => {})`, { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  }, 90_000)
})
