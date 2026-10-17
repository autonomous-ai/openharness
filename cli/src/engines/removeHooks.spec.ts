import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { hookContracts } from './hooks.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { OPENCODE_TUI_PLUGIN } from './opencode/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { reviewRecords, withReviewRecords } from './kit/hookReview.js'
import { RULES_HEADER } from './kit/hookSettings.js'
import { nativePluginSource } from './kit/nativePlugin.js'
import { defaultHookTargets, pluginOwned, removeEngineHooks, type HookTargets } from './removeHooks.js'

const OURS = "'/opt/harness/node/bin/node' '/home/u/.harness/cli/notify.mjs' --port 18473 --data-dir '/home/u/.harness/cli/data'"
const values = { port: '18473', credential: '"/home/u/.harness/cli/data/hook-credential"', version: '"0.5.0"' }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function machine(): { root: string; targets: HookTargets } {
  const root = mkdtempSync(join(tmpdir(), 'remove-hooks-'))
  dirs.push(root)
  const at = (...parts: string[]) => join(root, ...parts)
  return {
    root,
    targets: {
      claude: { homes: [at('claude')], allowRules: ['Bash(harness ps:*)'] },
      codex: { homes: [at('codex'), at('codex-profile')] },
      native: [{ ...CURSOR_HOOK_SETTINGS, file: at('cursor', 'hooks.json') }],
      plugins: [{ ...KILO_PLUGIN, file: at('kilo', 'plugin', 'launcher-register.js') }, { ...OPENCODE_TUI_PLUGIN, file: at('opencode', 'plugins', 'launcher-register', 'tui.js') }],
      hermes: { rule: { ...HERMES_HOOK_SETTINGS, home: at('hermes') }, homes: [at('hermes')] },
    },
  }
}
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

describe('removeEngineHooks', () => {
  it('takes Harness out of every engine\'s files and leaves everything else', async () => {
    const { root, targets } = machine()
    write(join(root, 'claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: OURS }] }] }, permissions: { allow: ['Bash(harness ps:*)', 'Bash(ls)'] } }))
    write(join(root, 'codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: OURS }] }] } }))
    write(join(root, 'codex', 'rules', 'harness.rules'), `${RULES_HEADER}prefix_rule(pattern=["harness"], decision="allow")\n`)
    write(join(root, 'codex-profile', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: OURS }] }] } }))
    write(join(root, 'cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: OURS }, { command: '/mine' }] } }))
    write(targets.plugins[0].file, nativePluginSource(targets.plugins[0], values))
    write(targets.plugins[1].file, nativePluginSource(targets.plugins[1], values))
    write(join(root, 'hermes', 'config.yaml'), `model: x\n\n${HERMES_HOOK_SETTINGS.begin}\nhooks:\n  on_session_start:\n    - command: ${JSON.stringify(`${OURS} --engine hermes`)}\n      timeout: 10\n${HERMES_HOOK_SETTINGS.end}\n`)
    write(join(root, 'hermes', 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [{ event: 'on_session_start', command: `${OURS} --engine hermes` }, { event: 'x', command: '/mine' }] }))

    const outcomes = await removeEngineHooks(targets)

    expect(outcomes.filter((o) => o.failed)).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'claude', 'settings.json'), 'utf8'))).toEqual({ hooks: {}, permissions: { allow: ['Bash(ls)'] } })
    expect(JSON.parse(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8'))).toEqual({ hooks: {} })
    expect(existsSync(join(root, 'codex', 'rules', 'harness.rules'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'codex-profile', 'hooks.json'), 'utf8'))).toEqual({ hooks: {} })
    expect(JSON.parse(readFileSync(join(root, 'cursor', 'hooks.json'), 'utf8'))).toEqual({ version: 1, hooks: { stop: [{ command: '/mine' }] } })
    expect(existsSync(targets.plugins[0].file)).toBe(false)
    expect(existsSync(dirname(targets.plugins[1].file)), 'the plugin\'s own folder goes with it').toBe(false)
    expect(readFileSync(join(root, 'hermes', 'config.yaml'), 'utf8')).toBe('model: x\n')
    expect(JSON.parse(readFileSync(join(root, 'hermes', 'shell-hooks-allowlist.json'), 'utf8'))).toEqual({ approvals: [{ event: 'x', command: '/mine' }] })
    expect(outcomes.reduce((n, o) => n + o.removed, 0)).toBe(10)
  })

  it('keeps a plugin somebody else wrote at Harness\'s path', async () => {
    const { targets } = machine()
    write(targets.plugins[0].file, '// my own plugin\n')
    const outcomes = await removeEngineHooks(targets)
    expect(outcomes).toContainEqual({ file: targets.plugins[0].file, removed: 0, kept: 'another author’s file' })
    expect(existsSync(targets.plugins[0].file)).toBe(true)
  })
})

describe('pluginOwned', () => {
  it('reads ownership from the generated first line, which names no argument', () => {
    const source = nativePluginSource(KILO_PLUGIN, values)
    expect(source.slice(0, source.indexOf('\n'))).not.toContain('18473')
    expect(pluginOwned(KILO_PLUGIN)(source)).toBe(true)
    expect(pluginOwned(KILO_PLUGIN)(source.replace('Kilo', 'Mine'))).toBe(false)
  })
})

describe('defaultHookTargets', () => {
  it('adds every adopted home and every profile a harness was started with', () => {
    const data = mkdtempSync(join(tmpdir(), 'targets-'))
    dirs.push(data)
    writeFileSync(join(data, 'registry.json'), JSON.stringify([{ codexHome: '/p/codex-a' }, { codexHome: '/p/codex-a', hermesHome: '/p/hermes-b' }, { codexHome: 'relative' }]))
    const targets = defaultHookTargets(data, () => ({ claude: ['/moved/claude'], codex: ['/moved/codex'] }))
    expect(targets.claude.homes.slice(1)).toEqual(['/moved/claude'])
    expect(targets.codex.homes.slice(1)).toEqual(['/moved/codex', '/p/codex-a'])
    expect(targets.hermes.homes).toContain('/p/hermes-b')
    expect(defaultHookTargets(data, () => { throw new Error('locked') }).unread).toBe('locked')
  })
})

describe('Codex\'s review records', () => {
  const record = hookContracts.codex.settings.reviewed!
  /** A Codex home with Harness's hook and the person's, and the records Harness's hook is reviewed under. */
  function codexHome(targets: HookTargets, root: string) {
    targets.codex.homes = [join(root, 'codex')]
    const settings = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: OURS, timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: '/mine' }] }] } }
    write(join(root, 'codex', 'hooks.json'), JSON.stringify(settings))
    const settingsFile = join(realpathSync(join(root, 'codex')), 'hooks.json')
    const ours = reviewRecords(record, settingsFile, settings)
    expect(ours.size).toBe(1)
    const [[key, hash]] = [...ours]
    return { ours, key, hash, settingsFile, config: join(root, 'codex', 'config.toml') }
  }

  it('go with Harness\'s Codex hooks, and every other byte of config.toml stays', async () => {
    const { root, targets } = machine()
    const { ours, settingsFile, config } = codexHome(targets, root)
    const theirs = `# my settings\nmodel = "o3"\n\n[hooks.state]\n\n[hooks.state.${JSON.stringify(`${settingsFile}:stop:0:0`)}]\ntrusted_hash = "sha256:mine"\n\n[projects."/work"]\ntrust_level = "trusted"\n`
    write(config, withReviewRecords(theirs, record, ours) as string)
    expect(readFileSync(config, 'utf8')).not.toBe(theirs)

    const outcomes = await removeEngineHooks(targets)

    expect(outcomes).toContainEqual({ file: config, removed: 1 })
    expect(readFileSync(config, 'utf8')).toBe(theirs)
    expect(JSON.parse(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/mine' }] }] } })
  })

  it('takes a record out from between the person\'s tables', async () => {
    const { root, targets } = machine()
    const { key, hash, config } = codexHome(targets, root)
    write(config, `model = "o3"\n\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n\n[projects."/work"]\ntrust_level = "trusted"\n`)
    await removeEngineHooks(targets)
    expect(readFileSync(config, 'utf8')).toBe('model = "o3"\n\n[projects."/work"]\ntrust_level = "trusted"\n')
  })

  it('keeps a record that holds another hash, or more than the hash', async () => {
    const { root, targets } = machine()
    const { key, hash, config } = codexHome(targets, root)
    const text = `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "sha256:other"\n`
    write(config, text)
    await removeEngineHooks(targets)
    expect(readFileSync(config, 'utf8')).toBe(text)

    codexHome(targets, root)
    const more = `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\nenabled = false\n`
    write(config, more)
    await removeEngineHooks(targets)
    expect(readFileSync(config, 'utf8')).toBe(more)
  })

  it('keeps the records while Harness\'s hooks could not be taken out', async () => {
    const { root, targets } = machine()
    const { ours, config } = codexHome(targets, root)
    const text = withReviewRecords('', record, ours) as string
    write(config, text)
    chmodSync(join(root, 'codex', 'hooks.json'), 0o444)
    const outcomes = await removeEngineHooks(targets)
    expect(outcomes).toContainEqual(expect.objectContaining({ file: join(root, 'codex', 'hooks.json'), removed: 0, failed: expect.any(String) }))
    expect(readFileSync(config, 'utf8')).toBe(text)
  })
})

describe('homes Harness does not open', () => {
  it('on Windows, reports a home on a network share or a device path and never opens it', async () => {
    const { targets } = machine()
    const share = '\\\\server\\share'
    const outcomes = await removeEngineHooks({
      claude: { homes: [`${share}\\claude`], allowRules: [] },
      codex: { homes: ['//server/share/codex'] },
      native: [{ ...CURSOR_HOOK_SETTINGS, file: '\\\\?\\C:\\cursor\\hooks.json' }],
      plugins: [{ ...KILO_PLUGIN, file: `${share}\\kilo\\launcher-register.js` }],
      hermes: { rule: targets.hermes.rule, homes: [`${share}\\hermes`] },
    }, 'win32')
    expect(outcomes.map((o) => o.file)).toEqual([
      join(`${share}\\claude`, 'settings.json'), join('//server/share/codex', 'hooks.json'), '\\\\?\\C:\\cursor\\hooks.json',
      `${share}\\kilo\\launcher-register.js`, join(`${share}\\hermes`, 'config.yaml'),
    ])
    for (const outcome of outcomes) expect(outcome).toMatchObject({ removed: 0, failed: 'the path is a network share or a device path, which Harness does not open on Windows' })
  })
})

describe('Command Code\'s profile folder', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  })

  it('is looked in too, as Command Code reads its settings there whatever COMMANDCODE_HOME says', async () => {
    const { root, targets } = machine()
    const profile = join(root, 'profile')
    mkdirSync(profile)
    process.env.HOME = profile
    process.env.USERPROFILE = profile
    const settings = join(profile, '.commandcode', 'settings.json')
    const native = defaultHookTargets(join(root, 'data'), () => ({ claude: [], codex: [] })).native
    expect(native.map((rule) => rule.file)).toEqual(expect.arrayContaining([COMMANDCODE_HOOK_SETTINGS.file, settings]))
    expect(native.filter((rule) => rule.file === settings)).toEqual([{ ...COMMANDCODE_HOOK_SETTINGS, file: settings }])

    write(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: OURS }] }, { hooks: [{ type: 'command', command: '/mine' }] }] } }))
    const outcomes = await removeEngineHooks({ ...targets, claude: { homes: [], allowRules: [] }, codex: { homes: [] }, plugins: [], hermes: { ...targets.hermes, homes: [] }, native: native.filter((rule) => rule.file === settings) })
    expect(outcomes).toEqual([{ file: settings, removed: 1 }])
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: '/mine' }] }] } })
  })

  it('is looked in once when COMMANDCODE_HOME is that folder', () => {
    const home = dirname(dirname(COMMANDCODE_HOOK_SETTINGS.file))
    process.env.HOME = home
    process.env.USERPROFILE = home
    const native = defaultHookTargets(join(machine().root, 'data'), () => ({ claude: [], codex: [] })).native
    expect(native.filter((rule) => rule.file === COMMANDCODE_HOOK_SETTINGS.file)).toHaveLength(1)
    expect(native).toHaveLength(6)
  })
})
