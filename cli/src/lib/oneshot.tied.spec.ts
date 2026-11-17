import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'

const MODULE = JSON.stringify(new URL('./oneshot.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('a one-shot worker', () => {
  it.each([
    ['claude', 'CLAUDE_PATH'],
    ['codex', 'CODEX_PATH'],
    ['cursor', 'CURSOR_PATH'],
    ['opencode', 'OPENCODE_PATH'],
    ['kilo', 'KILO_PATH'],
    ['pi', 'PI_PATH'],
    ['commandcode', 'COMMANDCODE_PATH'],
    ['grok', 'GROK_PATH'],
  ])('%s ends when the process that started it is killed', async (engine, variable) => {
    const scene = tiedScene()
    const fake = scene.program('engine', { withChild: true })
    const options = `{ prompt: 'p', cwd: ${q(scene.dir)}, timeoutMs: 120_000 }`
    const call = engine === 'grok' ? `void runGrokOneShot(${options}).catch(() => {})` : `void runRouterOneShot(${q(engine)}, ${options}).catch(() => {})`
    await scene.endsWithItsProcess(`import { runGrokOneShot, runRouterOneShot } from ${MODULE}\n${call}`, { env: { [variable]: fake }, count: 2 })
  }, 90_000)
})
