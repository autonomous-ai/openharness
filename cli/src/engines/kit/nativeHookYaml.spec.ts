import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HERMES_HOOK_SETTINGS } from '../hermes/contract.js'
import { editPassthrough, installNativeYamlHooks, removeNativeYamlHooks } from './nativeHookYaml.js'

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

  // Hermes writes config.yaml with CRLF on Windows (measured 2026-11-09, DESKTOP-0TFH0OJ). Every line then ends with
  // `\r`, so an exact match on our own marker missed: the block read as somebody else's `hooks:` and was reported foreign
  // at every launch, the session was never registered, and the harness sat on "confirm native hooks" for ever.
  it('recognises its own block in a file Windows wrote with CRLF, and does not report it foreign', async () => {
    writeFileSync(join(profile, 'config.yaml'), 'model: y\r\n')
    expect(await installNativeYamlHooks(rule(), command)).toBe(true)
    const installed = readFileSync(join(home, 'config.yaml'), 'utf8')
    // Rewrite the whole file the way Hermes would: the same text, every line CRLF.
    writeFileSync(join(home, 'config.yaml'), installed.replaceAll('\n', '\r\n'))
    const errors: string[] = []
    vi.mocked(console.error).mockImplementation((line: unknown) => { errors.push(String(line)) })
    expect(await installNativeYamlHooks(rule(), command)).toBe(true)
    expect(errors.filter((line) => line.includes('has its own `hooks:` block'))).toEqual([])
    // One block, not two: a second pass recognised and replaced the first.
    const after = readFileSync(join(home, 'config.yaml'), 'utf8')
    expect(after.split('machine-adapter: session discovery').length - 1).toBe(1)
    expect(after).toContain(`--hermes-home ${home}`)
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
  // Hermes' own configs have a `terminal:` section, which takes the pane names without a word.
  writeFileSync(join(home, 'config.yaml'), 'model: x\nterminal:\n  backend: local\n')
  writeFileSync(join(profile, 'config.yaml'), 'model: y\nterminal:\n  backend: local\n')

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

// Hermes 0.22+ runs every session's hooks in one shared gateway, so a hook names the gateway's pane. Each client's
// listed environment is frozen with its session (terminal.client_env_passthrough), which is how a hook's session is
// traced back to its pane. These are the lists Harness edits for that, in the person's own file.
describe('the pane names in Hermes\' terminal.client_env_passthrough', () => {
  const spec = HERMES_HOOK_SETTINGS.passthrough
  const ours = '["HARNESS_PANE", "TMUX_PANE"]'

  it('fills the empty list Hermes writes, keeping its comment (DESKTOP-0TFH0OJ\'s line)', () => {
    const text = 'terminal:\n  backend: local\n  client_env_passthrough: []  # e.g. ["GEM_HOME", "POETRY_HOME"]\n  timeout: 180\n'
    expect(editPassthrough(text, spec)).toBe(
      `terminal:\n  backend: local\n  client_env_passthrough: ${ours}  # e.g. ["GEM_HOME", "POETRY_HOME"]\n  timeout: 180\n`)
  })

  it('keeps the person\'s own names first, and adds only what is missing', () => {
    expect(editPassthrough('terminal:\n  client_env_passthrough: ["GEM_HOME", "TMUX_PANE"]\n', spec))
      .toBe('terminal:\n  client_env_passthrough: ["GEM_HOME", "TMUX_PANE", "HARNESS_PANE"]\n')
  })

  it('leaves a list that has them byte for byte', () => {
    const text = `terminal:\n  client_env_passthrough: ${ours}\n`
    expect(editPassthrough(text, spec)).toBe(text)
  })

  it('adds item lines to a block list, at its own indentation', () => {
    expect(editPassthrough('terminal:\n  client_env_passthrough:\n    - GEM_HOME\n  timeout: 180\n', spec))
      .toBe('terminal:\n  client_env_passthrough:\n    - GEM_HOME\n    - "HARNESS_PANE"\n    - "TMUX_PANE"\n  timeout: 180\n')
  })

  it('makes the key the section\'s first line when there is none (an older Hermes\' config)', () => {
    expect(editPassthrough('model: x\nterminal:\n  backend: local\n', spec))
      .toBe(`model: x\nterminal:\n  client_env_passthrough: ${ours}\n  backend: local\n`)
  })

  it('gives `key:` with nothing after it a list', () => {
    expect(editPassthrough('terminal:\n  client_env_passthrough:\n  backend: local\n', spec))
      .toBe(`terminal:\n  client_env_passthrough: ${ours}\n  backend: local\n`)
  })

  it('keeps a CRLF file CRLF', () => {
    expect(editPassthrough('terminal:\r\n  backend: local\r\n', spec))
      .toBe(`terminal:\r\n  client_env_passthrough: ${ours}\r\n  backend: local\r\n`)
  })

  it('edits nothing it cannot read as a list of names', () => {
    expect(editPassthrough('model: x\n', spec)).toBeNull()
    expect(editPassthrough('terminal: {backend: local}\n', spec)).toBeNull()
    expect(editPassthrough('terminal:\n  client_env_passthrough: GEM_HOME\n', spec)).toBeNull()
    expect(editPassthrough('terminal:\n  client_env_passthrough: [1, 2]\n', spec)).toBeNull()
  })

  it('takes out only its own names on removal', () => {
    expect(editPassthrough('terminal:\n  client_env_passthrough: ["GEM_HOME", "HARNESS_PANE", "TMUX_PANE"]  # mine\n', spec, true))
      .toBe('terminal:\n  client_env_passthrough: ["GEM_HOME"]  # mine\n')
    expect(editPassthrough('terminal:\n  client_env_passthrough:\n    - HARNESS_PANE\n    - GEM_HOME\n    - TMUX_PANE\n  timeout: 1\n', spec, true))
      .toBe('terminal:\n  client_env_passthrough:\n    - GEM_HOME\n  timeout: 1\n')
    expect(editPassthrough('terminal:\n  client_env_passthrough:\n    - HARNESS_PANE\n    - TMUX_PANE\n  timeout: 1\n', spec, true))
      .toBe('terminal:\n  client_env_passthrough: []\n  timeout: 1\n')
    const without = 'terminal:\n  backend: local\n'
    expect(editPassthrough(without, spec, true)).toBe(without)
  })

  it('installs the names with the hooks, says so when there is no list, and uninstall takes them out', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
    const rule = { ...HERMES_HOOK_SETTINGS, home }
    const command = (at: string) => `node /fixture/notify.mjs --port 4242 --data-dir /fixture/data --hermes-home ${at} --engine hermes`
    writeFileSync(join(home, 'config.yaml'), 'model: x\nterminal:\n  client_env_passthrough: ["GEM_HOME"]\n')
    expect(await installNativeYamlHooks(rule, command, home)).toBe(true)
    const installed = readFileSync(join(home, 'config.yaml'), 'utf8')
    expect(installed).toContain('client_env_passthrough: ["GEM_HOME", "HARNESS_PANE", "TMUX_PANE"]')
    expect(installed).toContain('--engine hermes')

    await removeNativeYamlHooks(rule, [home])
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('model: x\nterminal:\n  client_env_passthrough: ["GEM_HOME"]\n')

    lines.length = 0
    expect(await installNativeYamlHooks(rule, command, profile)).toBe(true)
    expect(lines[0]).toBe(`[hooks] ${join(profile, 'config.yaml')} has no terminal.client_env_passthrough list to add Harness's pane names to:`
      + ' sessions from a shared Hermes gateway (Hermes 0.22+) will not bind to their harness')
  })
})
