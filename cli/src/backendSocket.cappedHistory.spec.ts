// `session_get` for an engine with no pages of its own reads its transcript from the end, bounded
// (lib/transcriptTail.ts `tailFileCapped`): a transcript past the cap shows its newest history, and every
// reply says so. A real file over the cap is 64 MB; the reader is made to cut short instead.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Transcripts are only served from the engines' own folders, pointed at throwaway ones before the
// config is read.
const roots = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/capped-history-${process.pid}-${Date.now()}`
  process.env.MUSE_HOME = `${base}/muse`
  process.env.PI_HOME = `${base}/pi`
  return { base, muse: `${base}/muse/sessions`, pi: `${base}/pi/agent/sessions` }
})
const reader = vi.hoisted(() => ({ cut: false }))
vi.mock('./lib/transcriptTail.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/transcriptTail.js')>()
  return {
    ...real,
    tailFileCapped: vi.fn(async (path: string, maxBytes?: number) => {
      const read = await real.tailFileCapped(path, maxBytes)
      return reader.cut ? { lines: read.lines.slice(-2), truncated: true } : read
    }),
  }
})

import { BackendSocket } from './backendSocket.js'
import { registry } from './lib/registry.js'

afterAll(() => rmSync(roots.base, { recursive: true, force: true }))

describe('session_get past the cap, for an engine without pages', () => {
  let socket: BackendSocket
  let frames: Array<{ type: string; payload: Record<string, any> }>
  const agents: string[] = []
  let pane = 8800
  let requests = 0

  beforeEach(() => {
    socket = new BackendSocket('fixture')
    frames = []
    socket.registerLocalClient('local:capped', { sendFrame: (frame) => { frames.push(frame as never); return true }, sendBinary: () => true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    reader.cut = false
    for (const agentId of agents.splice(0)) registry.removeAgent(agentId)
    await socket.stop()
    vi.restoreAllMocks()
  })

  const bind = (engine: 'muse' | 'pi', root: string, write: (file: string) => void): string => {
    const dir = join(root, `capped-${++pane}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    write(file)
    const paneId = `%${pane}`
    agents.push(registry.openPendingAgent({ engine, runtimes: [{ backend: 'tmux', paneId }], cwd: dir })!.agentId)
    const sessionId = `${engine}-capped-${pane}`
    registry.register({ engine, sessionId, transcriptPath: file, tmuxPane: paneId, cwd: dir })
    expect(registry.resolve(sessionId)?.transcriptPath, 'bound to the transcript under test').toBe(file)
    return sessionId
  }
  const ask = async (payload: Record<string, unknown>): Promise<Record<string, any>> => {
    const requestId = `c${++requests}`
    await (socket as any).dispatchDown({ type: 'session_get', payload: { requestId, ...payload } }, 'local:capped', 'local')
    return frames.find((frame) => frame.type === 'session_get_result' && frame.payload.requestId === requestId)!.payload
  }

  it('says so in the whole read and the whole page, and leaves a transcript under the cap as it was', async () => {
    const fixture = fileURLToPath(new URL('./lib/__fixtures__/muse-session.jsonl', import.meta.url))
    const sessionId = bind('muse', roots.muse, (file) => copyFileSync(fixture, file))
    const whole = await ask({ sessionId })
    expect(whole.truncated).toBeUndefined()
    reader.cut = true
    const cut = await ask({ sessionId })
    expect(cut).toMatchObject({ id: sessionId, engine: 'muse', truncated: true })
    expect(cut.events.length).toBeLessThan(whole.events.length)
    expect(await ask({ sessionId, limit: 50 })).toMatchObject({ truncated: true, hasMore: false })
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[backend\] session_get .*: the transcript is over 64 MB · its oldest history is not shown$/))
  })

  it('says so in a window and in a stale cursor\'s answer', async () => {
    const sessionId = bind('pi', roots.pi, (file) => writeFileSync(file, Array.from({ length: 6 }, (_, i) => JSON.stringify({ type: 'message', id: `m${i}` })).join('\n') + '\n'))
    reader.cut = true
    expect(await ask({ sessionId, limit: 10 })).toMatchObject({ engine: 'pi', truncated: true })
    expect(await ask({ sessionId, limit: 10, before: 'no-such-cursor' })).toMatchObject({ staleCursor: true, truncated: true })
  })
})
