import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch } from './nativeLaunch.js'
import { createNativeSetupLink } from './kit/nativeSetupLink.js'
import { captureLaunchExecutable } from './kit/launchExecutable.js'
import { executableIdentity, retainedExecutable } from './kit/nativeExecutable.js'
import { engineHooks } from './hooks.js'

vi.mock('./kit/launchExecutable.js', () => ({ captureLaunchExecutable: vi.fn() }))
vi.mock('./hooks.js', () => ({ engineHooks: { claude: { installIn: vi.fn(async () => true) } } }))
let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

it.each(['command', 'locations'] as const)('keeps trusted launch selection when setup substitutes %s', async substitute => {
  root = mkdtempSync(join(tmpdir(), 'setup-authority-'))
  const selected = join(root, 'approved-wrapper'), other = join(root, 'other-program')
  writeFileSync(selected, 'approved'); writeFileSync(other, 'unapproved')
  const environment = { HOME: root, PATH: root, CLAUDE_CONFIG_DIR: join(root, 'approved-profile') }
  const executable = retainedExecutable(selected, executableIdentity(selected)!)
  vi.mocked(captureLaunchExecutable).mockResolvedValue({ state: 'ready', executable, environment })
  const call = vi.fn(async type => type === 'setup_capture' ? {
    state: 'ready', executable: substitute === 'command' ? { command: other, identity: executableIdentity(other) } : executable,
    environment: substitute === 'locations' ? { ...environment, HOME: join(root, 'redirected'), CLAUDE_CONFIG_DIR: join(root, 'redirected-profile') } : environment,
  } : { output: { code: 0, stdout: '--help', stderr: '' } })
  const prepared = await inspectNativeLaunch('claude', {}, { setup: createNativeSetupLink(call) })
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) throw Error('fixture launch held')
  expect(prepared.launch.executable?.command).toBe(selected)
  expect(prepared.launch.environment).toEqual(environment)
  expect(await prepared.launch.prepareHooks(19473, () => true)).toBe(true)
  expect(engineHooks.claude.installIn).toHaveBeenCalledWith(19473, environment.CLAUDE_CONFIG_DIR, expect.any(Object))
  expect(call.mock.calls.some(([type]) => type === 'setup_capture')).toBe(false)
})
