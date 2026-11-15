import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as hooks from './nativeHookSetup.js'
import { prepareNativeHookFiles } from '../services/nativeSetupFiles.js'
import type { NativeHookInput, NativeHookCandidate } from './kit/nativeHookWire.js'
import type { NativeHookOptions } from './kit/nativeLocations.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'native-hook-setup-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : null
const installers = {
  claude: (port: number, options: NativeHookOptions) => hooks.installClaudeHooks(port, join(root, '.claude'), options),
  codex: (port: number, options: NativeHookOptions) => hooks.installCodexHooks(port, undefined, options), grok: hooks.installGrokHooks, agy: hooks.installAgyHooks,
  copilot: hooks.installCopilotHooks, cursor: hooks.installCursorHooks, commandcode: hooks.installCommandCodeHooks,
  devin: hooks.installDevinHooks, amp: hooks.installAmpPlugin, kilo: hooks.installKiloPlugin, pi: hooks.installPiExtension,
  opencode: (port: number, options: NativeHookOptions) => hooks.installOpencodePlugin(port, undefined, options),
  hermes: (port: number, options: NativeHookOptions) => hooks.installHermesHooks(port, join(root, '.hermes'), options),
}

it.each(Object.entries(installers))('publishes %s only after isolated rendering returns complete bounded bytes', async (_engine, install) => {
  let captured: NativeHookInput | undefined, rendered: NativeHookCandidate | null = null
  const setup = { opencodeMajor: async () => 1, hermesKeepsRecord: async () => false,
    prepareFiles: async (input: NativeHookInput, _request: string, current: () => boolean) => {
      captured = input
      const before = input.files.map(file => read(file.file))
      rendered = await prepareNativeHookFiles(input, current)
      expect(input.files.map(file => read(file.file))).toEqual(before)
      return rendered
    },
  }
  expect(await install(1234, { environment: { HOME: root }, setup })).toBe(true)
  expect(captured).toBeDefined()
  expect(rendered).not.toBeNull()
  expect(captured!.files.map(file => read(file.file))).toEqual(rendered!.files.map(file => file.content))
})

it('holds every hook family when the optional setup capability is unavailable', async () => {
  for (const install of Object.values(installers)) {
    expect(await install(1234, { environment: { HOME: root },
      setup: { opencodeMajor: async () => 1, hermesKeepsRecord: async () => false } })).toBe(false)
  }
  expect(existsSync(join(root, '.claude'))).toBe(false)
})
