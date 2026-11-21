/**
 * `harness hooks hermes` prints, on the person's own terminal, the entries Harness would add to each Hermes home: the
 * daemon's log names only the command, since the entries name the managed Node, notify.mjs and the person's folders.
 * The home is a throwaway folder, never the person's `~/.hermes`, and the Hermes is the suite's mock.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root = '', home = '', profile = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hooks-command-'))
  home = join(root, '.hermes'); profile = join(home, 'profiles', 'work')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(home, 'config.yaml'), 'model: x\n'); writeFileSync(join(profile, 'config.yaml'), 'model: y\n')
  vi.stubEnv('HERMES_HOME', home)
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.resetModules()
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks() })

/** The entries the installer wrote into [config]: the lines under its managed `hooks:`. */
function written(config: string): string {
  const text = readFileSync(config, 'utf8')
  return text.slice(text.indexOf('hooks:\n') + 'hooks:\n'.length, text.indexOf('\n# machine-adapter: end'))
}

it('prints, for every Hermes home with a config, the exact entries the installer writes there', async () => {
  const { hermesKeepsRecord } = await import('./hermesRecord.js')
  vi.mocked(hermesKeepsRecord).mockResolvedValue(false)
  const { installHermesHooks } = await import('./nativeHooks.js')
  const { hooksCommand } = await import('./hooksCommand.js')
  const lines: string[] = []
  expect(hooksCommand('hermes', 4242, (line) => lines.push(line))).toBe(0)
  expect(await installHermesHooks(4242)).toBe(true)

  const printed = lines.join('\n')
  for (const at of [home, profile]) {
    expect(printed).toContain(`# ${join(at, 'config.yaml')}`)
    expect(written(join(at, 'config.yaml'))).toContain(`--hermes-home '${at}'`)
    expect(printed).toContain(`hooks:\n${written(join(at, 'config.yaml'))}`)
  }
  expect(printed).toContain('terminal:\n  client_env_passthrough: ["HARNESS_PANE", "TMUX_PANE"]')
})

it('prints nothing when no Hermes home has a config', async () => {
  rmSync(home, { recursive: true })
  const { hooksCommand } = await import('./hooksCommand.js')
  const lines: string[] = []
  expect(hooksCommand('hermes', 4242, (line) => lines.push(line))).toBe(0)
  expect(lines).toEqual([])
})

// Harness writes every other engine's hooks itself, so a person has nothing to add by hand for them.
it.each([[undefined], ['claude']])('refuses %s in one line naming the engines it covers', async (engine) => {
  const { hooksCommand } = await import('./hooksCommand.js')
  const lines: string[] = [], errors: string[] = []
  expect(hooksCommand(engine, 4242, (line) => lines.push(line), (line) => errors.push(line))).toBe(1)
  expect(lines).toEqual([])
  expect(errors).toEqual(['Usage: harness hooks hermes   (Harness writes the other engines\' hooks itself)'])
})
