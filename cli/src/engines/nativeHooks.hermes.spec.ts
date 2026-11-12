/**
 * Which Hermes home keeps Harness's hook (spec §4): a Hermes v0.21.6+ keeps a terminal record and is followed from it,
 * so its homes lose the hook; an older or unknown one, and a home set to the TUI, keep today's hook byte for byte. No
 * spec runs a real `hermes` or reads the person's `~/.hermes`: the version is the suite's mock, set per case, and the
 * home is a throwaway folder.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'

const PERSON = 'model: anthropic/claude\nterminal:\n  client_env_passthrough: ["MY_VAR"]\n'
const TUI = 'display:\n  interface: tui\n'

let root = '', home = '', config = '', allowlist = '', fresh = '', profileConfig = '', WITH_BLOCK = ''
let logs: string[] = [], warns: string[] = []
let installHermesHooks: typeof import('./nativeHooks.js').installHermesHooks
let hermesRecordSeen: typeof import('./nativeHooks.js').hermesRecordSeen
let hermesKeepsRecord: typeof import('./hermesRecord.js').hermesKeepsRecord
let rememberRecordHome: typeof import('./hermesRecord.js').rememberRecordHome

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hermes-hooks-'))
  home = join(root, '.hermes'); mkdirSync(home)
  config = join(home, 'config.yaml'); allowlist = join(home, 'shell-hooks-allowlist.json')
  fresh = join(root, 'fresh'); profileConfig = join(home, 'profiles', 'work', 'config.yaml')
  vi.stubEnv('HERMES_HOME', home)
  logs = []; warns = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // Loaded afresh, as lib/hooks.spec.ts loads its installers, for this case's HERMES_HOME and nothing said yet. The
  // suite's mock first: imported alongside the installer that imports it too, the installer was handed the real module.
  // The mock outlives the reset, so it and what it remembers start again here.
  vi.resetModules()
  const record = await import('./hermesRecord.js')
  ;({ hermesKeepsRecord, rememberRecordHome } = record)
  ;({ installHermesHooks, hermesRecordSeen } = await import('./nativeHooks.js'))
  record.forgetHermesRecord(); vi.mocked(hermesKeepsRecord).mockReset()
  // What an older Hermes's home holds once Harness installed its hook.
  writeFileSync(config, PERSON); await installHermesHooks(18473)
  WITH_BLOCK = readFileSync(config, 'utf8')
  rmSync(config); rmSync(allowlist)
  vi.mocked(hermesKeepsRecord).mockClear(); logs.length = 0
})
afterEach(() => {
  chmodSync(home, 0o755)
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs(); vi.restoreAllMocks()
})

/** What installHermesHooks answers for [text] when the Hermes is older. */
async function olderInstallOf(text: string): Promise<boolean> {
  writeFileSync(config, text)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(false)
  return installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } })
}

it('leaves a v0.21.6+ home without Harness\'s hooks, as the person wrote it', async () => {
  writeFileSync(config, PERSON); await installHermesHooks(18473) // older: installed, as today
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  expect(await installHermesHooks(18473)).toBe(true)
  expect(readFileSync(config, 'utf8')).toBe(PERSON)
  expect(JSON.parse(readFileSync(allowlist, 'utf8')).approvals).toEqual([])
  // config.yaml and the allowlist.
  expect(logs.filter((line) => line.startsWith("[hooks] removed Harness's Hermes hooks → "))).toHaveLength(2)
  logs.length = 0; expect(await installHermesHooks(18473)).toBe(true); expect(logs).toEqual([])
})

it('writes nothing into a v0.21.6+ launch\'s home, not even its first config', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  expect(await installHermesHooks(18473, fresh, { environment: { HOME: root, HERMES_HOME: fresh }, executable: { command: '/bin/hermes' } })).toBe(true)
  expect(existsSync(join(fresh, 'config.yaml'))).toBe(false)
  expect(hermesKeepsRecord).toHaveBeenCalledWith({ command: '/bin/hermes' }, { HOME: root, HERMES_HOME: fresh })
  expect(warns).toEqual([])
})

it('keeps an older Hermes\'s hook, and an unknown one\'s', async () => {
  for (const keeps of [false, null]) {
    vi.mocked(hermesKeepsRecord).mockResolvedValue(keeps); writeFileSync(config, PERSON)
    expect(await installHermesHooks(18473)).toBe(true); expect(readFileSync(config, 'utf8')).toContain('--engine hermes')
  }
})

it('takes a home seen keeping a record for v0.21.6+ while the version is unknown', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(null); rememberRecordHome(home); writeFileSync(config, WITH_BLOCK)
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } })).toBe(true)
  expect(readFileSync(config, 'utf8')).not.toContain(HERMES_HOOK_SETTINGS.begin)
})

it('asks no version of a computer with no Hermes config, or on Windows', async () => {
  await installHermesHooks(18473); expect(hermesKeepsRecord).not.toHaveBeenCalled()
  writeFileSync(config, PERSON); await installHermesHooks(18473, undefined, undefined, 'win32'); expect(hermesKeepsRecord).not.toHaveBeenCalled()
})

it.skipIf(process.getuid?.() === 0)('says once that it could not remove a hook, and does not hold the launch', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true); writeFileSync(config, WITH_BLOCK); chmodSync(home, 0o555)
  expect(await installHermesHooks(18473)).toBe(true); expect(await installHermesHooks(18473)).toBe(true)
  expect(warns.filter((line) => line.startsWith("[hooks] could not remove Harness's Hermes hooks from "))).toHaveLength(1)
})

it('leaves a home whose config or approvals list is a link, and says so once', async () => {
  // A sandbox controls its home: a link there would aim the edit at another file, the host's own Hermes config among
  // them, whose Hermes may still need the hook.
  const host = join(root, 'host')
  mkdirSync(host)
  writeFileSync(join(host, 'config.yaml'), WITH_BLOCK)
  symlinkSync(join(host, 'config.yaml'), config)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  expect(await installHermesHooks(18473)).toBe(true)
  expect(await installHermesHooks(18473)).toBe(true)
  expect(readFileSync(join(host, 'config.yaml'), 'utf8')).toBe(WITH_BLOCK)
  expect(lstatSync(config).isSymbolicLink()).toBe(true)
  expect(warns).toEqual([`[hooks] could not remove Harness's Hermes hooks from ${config} · the file is a symbolic link`])

  // The approvals list beside a config of its own: the home is left as it is, and a record seen there changes nothing.
  rmSync(config); writeFileSync(config, PERSON)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(false); await installHermesHooks(18473) // older: installed, as today
  const installed = readFileSync(config, 'utf8'), approvals = readFileSync(allowlist, 'utf8')
  renameSync(allowlist, join(host, 'shell-hooks-allowlist.json')); symlinkSync(join(host, 'shell-hooks-allowlist.json'), allowlist)
  warns.length = 0
  await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).toBe(installed)
  expect(readFileSync(join(host, 'shell-hooks-allowlist.json'), 'utf8')).toBe(approvals)
  expect(warns).toEqual([`[hooks] could not remove Harness's Hermes hooks from ${allowlist} · the file is a symbolic link`])
})

it('removes the hooks of a home the first time a record is seen there', async () => {
  writeFileSync(config, WITH_BLOCK); await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).not.toContain(HERMES_HOOK_SETTINGS.begin)
  writeFileSync(config, WITH_BLOCK); await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin) // once per home
})

it('keeps the hook of a home set to the TUI, byte for byte, and removes it from the CLI home beside it', async () => {
  mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
  writeFileSync(config, PERSON + TUI); writeFileSync(profileConfig, PERSON)
  await installHermesHooks(18473) // older: both installed, as today
  const older = readFileSync(config, 'utf8')
  expect(readFileSync(profileConfig, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true)
  writeFileSync(config, PERSON + TUI)
  expect(await installHermesHooks(18473)).toBe(true)
  expect(readFileSync(config, 'utf8')).toBe(older) // the hook an older Hermes gets
  expect(readFileSync(profileConfig, 'utf8')).toBe(PERSON)
})

it('keeps a TUI launch\'s hook, and answers what its install answers', async () => {
  vi.mocked(hermesKeepsRecord).mockResolvedValue(true); writeFileSync(config, PERSON + TUI)
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home }, executable: { command: '/bin/hermes' } })).toBe(true)
  expect(readFileSync(config, 'utf8')).toContain('--engine hermes')
  // The person's own hooks: mapping, which today's install leaves and reports.
  const own = PERSON + TUI + 'hooks:\n  on_session_start: []\n'
  writeFileSync(config, own)
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } })).toBe(await olderInstallOf(own))
})

it('leaves a TUI home\'s hook when a record is seen there, and when its version is unknown', async () => {
  writeFileSync(config, WITH_BLOCK + TUI); await hermesRecordSeen(home)
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
  vi.mocked(hermesKeepsRecord).mockResolvedValue(null) // unknown, in a home seen keeping a record
  expect(await installHermesHooks(18473, home, { environment: { HOME: root, HERMES_HOME: home } })).toBe(true)
  expect(readFileSync(config, 'utf8')).toContain(HERMES_HOOK_SETTINGS.begin)
})
