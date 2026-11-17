import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { tiedScene } from '../../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./providerMove.ts', import.meta.url).href)
const q = JSON.stringify

const move = (codex: string, toGrid: boolean) => `import { moveCodexConversation } from ${MODULE}
void moveCodexConversation({ sessionId: 's', toGrid: ${toGrid}, args: [], argv: (args) => [${q(codex)}, ...args], env: process.env }).catch(() => {})`

describe.skipIf(process.platform === 'win32')('a provider move\'s Codex', () => {
  it('its app-server ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    // It never answers initialize, so the move waits on it while the stand-in is killed.
    const fake = scene.program('codex')
    await scene.endsWithItsProcess(move(fake, true))
  }, 90_000)

  it('its catalog read ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    // The app-server answers as providerMove.spec.ts's does and logs nothing, so the one pid logged is the catalog read's.
    const fake = join(scene.dir, 'codex')
    writeFileSync(fake, `#!${process.execPath}
const { appendFileSync } = require('node:fs')
if (process.argv[2] === 'debug') {
  appendFileSync(${q(scene.log)}, process.pid + '\\n')
  setInterval(() => {}, 1 << 30)
} else require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  console.log(JSON.stringify({ id: m.id, result: m.method === 'model/list' ? { data: [{ model: 'own-model', isDefault: true }] } : {} }))
})
`, { mode: 0o755 })
    await scene.endsWithItsProcess(move(fake, false))
  }, 90_000)
})
