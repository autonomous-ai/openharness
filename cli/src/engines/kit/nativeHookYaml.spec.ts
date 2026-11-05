import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HERMES_HOOK_SETTINGS } from '../hermes/contract.js'
import { installNativeYamlHooks } from './nativeHookYaml.js'

// A home's preparation can be held before it starts, so the homes finish in the order a test chooses.
const gate = vi.hoisted(() => ({
  before: undefined as undefined | ((files: readonly string[]) => Promise<void>),
  after: undefined as undefined | ((files: readonly string[]) => void),
}))
vi.mock('./nativeHookFiles.js', async original => {
  const actual = await original<typeof import('./nativeHookFiles.js')>()
  return { ...actual, runHookPreparation: async (...args: Parameters<typeof actual.runHookPreparation>) => {
    await gate.before?.(args[0])
    try { return await actual.runHookPreparation(...args) } finally { gate.after?.(args[0]) }
  } }
})

let root: string, home: string, profile: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-yaml-')))
  home = join(root, 'hermes'); profile = join(home, 'profiles', 'work')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(home, 'config.yaml'), 'model: x\n'); writeFileSync(join(profile, 'config.yaml'), 'model: y\n')
})
afterEach(() => { gate.before = undefined; gate.after = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

/** The default home starts only once the profile is done, as it happened on a busy CI shard. */
function profileFirst(): void {
  let done!: () => void
  const profileDone = new Promise<void>(resolve => { done = resolve })
  gate.before = async files => { if (files[0] === join(home, 'config.yaml')) await profileDone }
  gate.after = files => { if (files[0] === join(profile, 'config.yaml')) done() }
}

describe('a large settings file', () => {
  const rule = () => ({ ...HERMES_HOOK_SETTINGS, home })
  const command = (at: string) => `node /fixture/notify.mjs --port 4242 --data-dir /fixture/data --hermes-home ${at} --engine hermes`
  const lines = (count: number) => Array.from({ length: count }, (_, at) => `key_${at}: value # a note`).join('\n') + '\n'
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(join(profile, 'config.yaml'), 'model: y\n')
  })

  it('takes the hooks when it is as long as Hermes\'s own, which held every Hermes agent', async () => {
    writeFileSync(join(home, 'config.yaml'), lines(6_000))
    expect(await installNativeYamlHooks(rule(), command)).toBe(true)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain(`--hermes-home ${home}`)
  })

  it('still refuses one past the limit, and leaves it as it is', async () => {
    const huge = lines(40_000)
    writeFileSync(join(home, 'config.yaml'), huge)
    expect(await installNativeYamlHooks(rule(), command)).toBe(false)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(huge)
  })
})

it('says what each home did in the homes\' order, whichever home finishes first', async () => {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
  const rule = { ...HERMES_HOOK_SETTINGS, home }
  const command = (at: string) => `node /fixture/notify.mjs --port 4242 --data-dir /fixture/data --hermes-home ${at} --engine hermes`

  profileFirst()
  expect(await installNativeYamlHooks(rule, command)).toBe(true)
  expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain(`--hermes-home ${home}`)
  expect(readFileSync(join(profile, 'config.yaml'), 'utf8')).toContain(`--hermes-home ${profile}`)
  expect(lines).toEqual([
    `[hooks] installed Hermes session hooks → ${join(home, 'config.yaml')}`,
    '[hooks] (takes effect on the next hermes session start)',
    `[hooks] installed Hermes session hooks → ${join(profile, 'config.yaml')}`,
    '[hooks] (takes effect on the next hermes session start)',
  ])

  lines.length = 0
  profileFirst()
  expect(await installNativeYamlHooks(rule, command)).toBe(true)
  expect(lines).toEqual(['[hooks] Hermes session hooks already installed', '[hooks] Hermes session hooks already installed (work)'])
})
