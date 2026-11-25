import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'

const { prepare, spawn } = vi.hoisted(() => ({ prepare: vi.fn(), spawn: vi.fn() }))
vi.mock('../lib/nativeProcessImages.js', () => ({ prepareProcessImageHelper: prepare }))
vi.mock('node:child_process', () => ({ spawn }))
const { startDevWatch } = await import('./devWatch.js')

// Never executed: the spawn mock stands for the helper.
const artifact = { schema: 1, sha256: 'a'.repeat(64), size: 64, base64: 'AA==' }
const originalRuntime = env.ADAPTER_RUNTIME_DIR

beforeEach(() => {
  env.ADAPTER_RUNTIME_DIR = '/runtime'
  prepare.mockReset()
  spawn.mockReset()
})
afterEach(() => { env.ADAPTER_RUNTIME_DIR = originalRuntime })

describe('startDevWatch', () => {
  it('starts the helper the build pins, watching, with no environment and no stderr', async () => {
    prepare.mockResolvedValue('/runtime/dev-watch/abc')
    const child = {}
    spawn.mockReturnValue(child)
    await expect(startDevWatch(JSON.stringify(artifact))).resolves.toBe(child)
    expect(prepare).toHaveBeenCalledWith(artifact, '/runtime', 'dev-watch')
    expect(spawn).toHaveBeenCalledWith('/runtime/dev-watch/abc', ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'], env: {} })
  })

  it.each([
    ['bytes it cannot write', JSON.stringify(artifact), null],
    ['a define that is not JSON', 'not json', '/x'],
  ])('says HELPER_UNAVAILABLE for %s, and starts nothing', async (_, source, path) => {
    prepare.mockResolvedValue(path)
    await expect(startDevWatch(source)).rejects.toMatchObject({ code: 'HELPER_UNAVAILABLE' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
