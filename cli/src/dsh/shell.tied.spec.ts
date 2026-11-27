import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./shell.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('a DSH command', () => {
  it.each(['a viewer server', 'a setup or a doctor'])('ends when the process that started it is killed: %s', async (which) => {
    const scene = tiedScene()
    const fake = scene.program('viewer', { withChild: true })
    const call = which === 'a viewer server'
      ? `spawnDshCommand(${q(`'${fake}'`)}, { cwd: ${q(scene.dir)} })`
      : `void runDshCommand(${q(`'${fake}'`)}, { cwd: ${q(scene.dir)}, timeoutMs: 120_000 })`
    await scene.endsWithItsProcess(`import { runDshCommand, spawnDshCommand } from ${MODULE}\n${call}`, { env: { SHELL: '/bin/sh' }, count: 2 })
  }, 90_000)
})
