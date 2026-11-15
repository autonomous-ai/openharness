import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { prepareNativeHookFiles } from './nativeSetupFiles.js'

it('renders Claude configuration and Messages bytes without creating native files or claiming installation', async () => {
  const home = join(env.ADAPTER_DATA_DIR, 'candidate-only'), file = join(home, 'settings.json')
  const input = { engine: 'claude' as const, port: 1234,
    environment: { HOME: env.ADAPTER_DATA_DIR, CLAUDE_CONFIG_DIR: home },
    files: [{ file, directory: home, content: '{"model":"keep-me"}', mode: 0o600 },
      { file: join(env.HARNESS_AGENT_MESSAGES_DIR, 'hook.mjs'), directory: env.HARNESS_AGENT_MESSAGES_DIR, content: null, mode: 0o700 }] }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const result = await prepareNativeHookFiles(input, () => true)
    expect(JSON.parse(result!.files[0].content!)).toMatchObject({ model: 'keep-me', hooks: { SessionStart: expect.any(Array) } })
    expect(result!.files[1].content).toContain('Agent Messages')
    expect(existsSync(file)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(await prepareNativeHookFiles(input, () => false)).toBeNull()
    expect(await prepareNativeHookFiles({ ...input, files: [{ ...input.files[0], content: '{broken' }, input.files[1]] }, () => true)).toBeNull()
    expect(existsSync(file)).toBe(false)
  } finally { log.mockRestore() }
})
