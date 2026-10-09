import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hooks } from '../codex/hookContract.js'
import { installHookSettings } from './hookSettings.js'
import { recordReviewed, reviewHash, reviewRecords, withReviewRecords } from './hookReview.js'

const record = hooks.settings.reviewed!
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const home = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-review-')))
  roots.push(root)
  return root
}

// What `codex app-server` `hooks/list` of codex-cli 0.162.0 reported as `currentHash` for a hooks.json with
// these two blocks (2026-10-09). Harness's hash must be Codex's, or Codex asks about the hooks anyway.
const COMMAND = "'/opt/harness/runtime/node' '/home/person/.harness/cli/hook/notify.mjs' 18473 codex"
const CODEX_0_162 = {
  session_start: 'sha256:7d719f8e2849620d0d2d81085877e79793c61d8b46ee15cc6251d2e0c69a1b41',
  user_prompt_submit: 'sha256:2aeba9ad1676fa3124e519bbcbb7602380bae087ba5345ce604bb12f5bb76199',
}

describe('Harness’s own Codex hooks, recorded as reviewed', () => {
  it('hashes a hook exactly as codex-cli 0.162.0 does', () => {
    expect(reviewHash(record, 'SessionStart', 'startup|resume|clear|compact', { command: COMMAND, timeout: 5 })).toBe(CODEX_0_162.session_start)
    // Codex ignores a UserPromptSubmit matcher, so it is not part of the hash either.
    expect(reviewHash(record, 'UserPromptSubmit', 'anything', { command: COMMAND, timeout: 5 })).toBe(CODEX_0_162.user_prompt_submit)
    expect(reviewHash(record, 'UserPromptSubmit', undefined, { command: COMMAND })).not.toBe(CODEX_0_162.user_prompt_submit)
    expect(reviewHash(record, 'UserPromptSubmit', undefined, { command: COMMAND })).toBe(reviewHash(record, 'UserPromptSubmit', undefined, { command: COMMAND, timeout: 600 }))
  })

  it('keys only Harness’s blocks, at their place in the file, past the person’s own', () => {
    const settings = { hooks: {
      SessionStart: [{ matcher: 'mine', hooks: [{ type: 'command', command: 'echo theirs' }] }, { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: COMMAND }] }],
    } }
    expect([...reviewRecords(record, '/home/person/.codex/hooks.json', settings)]).toEqual([
      ['/home/person/.codex/hooks.json:session_start:1:0', CODEX_0_162.session_start],
      ['/home/person/.codex/hooks.json:user_prompt_submit:0:0', CODEX_0_162.user_prompt_submit],
    ])
  })

  it('installs the hooks and records them, so Codex runs them without asking; a second start changes nothing', () => {
    const codexHome = home()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    const installed = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    for (const [key, hash] of reviewRecords(record, join(codexHome, 'hooks.json'), installed)) {
      expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`)
    }
    expect(lstatSync(join(codexHome, 'config.toml')).mode & 0o777).toBe(0o600)
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(config)
  })

  it('records them for hooks an earlier start installed, and again when Harness’s command changes', () => {
    const codexHome = home()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6"\n')
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    const first = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(first.startsWith('model = "gpt-6"\n\n[hooks.state.')).toBe(true)
    // Another port: another command, so another hash, in the same tables.
    installHookSettings('codex', hooks.settings, 18999, codexHome)
    const second = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(second.match(/^\[hooks\.state\./gm)).toHaveLength(2)
    expect(second).not.toBe(first)
    const installed = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    for (const [, hash] of reviewRecords(record, join(codexHome, 'hooks.json'), installed)) expect(second).toContain(hash)
  })

  it('keeps what Codex wrote itself: its empty table, the person’s other records, a record already right', () => {
    const records = new Map([['/h/hooks.json:session_start:0:0', 'sha256:new']])
    const codex = '[hooks.state]\n\n[hooks.state."/h/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:theirs"\n'
    expect(withReviewRecords(codex, record, records)).toBe(`${codex}\n[hooks.state."/h/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:new"\n`)
    const stale = '[hooks.state."/h/hooks.json:session_start:0:0"]\nenabled = true\ntrusted_hash = "sha256:old"\n\n[other]\nx = 1\n'
    expect(withReviewRecords(stale, record, records)).toBe(stale.replace('sha256:old', 'sha256:new'))
    expect(withReviewRecords(stale.replace('sha256:old', 'sha256:new'), record, records)).toBe('unchanged')
    const noHash = "[hooks.state.'/h/hooks.json:session_start:0:0']\nenabled = true\n"
    expect(withReviewRecords(noHash, record, records)).toBe("[hooks.state.'/h/hooks.json:session_start:0:0']\ntrusted_hash = \"sha256:new\"\nenabled = true\n")
  })

  it('reads a config’s structure past what only looks like it: strings, CRLF, comments', () => {
    const records = new Map([['/h/hooks.json:session_start:0:0', 'sha256:new']])
    const prompt = 'instructions = """\n[hooks.state."/h/hooks.json:session_start:0:0"]\ntrusted_hash = "x"\n"""\n'
    expect(withReviewRecords(prompt, record, records)).toBe(`${prompt}\n[hooks.state."/h/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:new"\n`)
    const crlf = '[hooks.state."/h/hooks.json:session_start:0:0"] # Codex\r\ntrusted_hash = "sha256:old" # was\r\n'
    expect(withReviewRecords(crlf, record, records)).toBe(crlf.replace('sha256:old', 'sha256:new'))
  })

  it('records what hooks.json holds on disk: a block of the person’s before Harness’s, another timeout', () => {
    const codexHome = home()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    const installed = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    // Harness's block first, the person's added after it, and a timeout of their own: current, so not rewritten.
    installed.hooks.UserPromptSubmit = [{ hooks: [{ ...installed.hooks.UserPromptSubmit[0].hooks[0], timeout: 30 }] }, { hooks: [{ type: 'command', command: 'echo theirs' }] }]
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(installed))
    rmSync(join(codexHome, 'config.toml'))
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toBe(JSON.stringify(installed))
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    const hook = installed.hooks.UserPromptSubmit[0].hooks[0]
    expect(config).toContain(`[hooks.state.${JSON.stringify(`${codexHome}/hooks.json:user_prompt_submit:0:0`)}]\ntrusted_hash = ${JSON.stringify(reviewHash(record, 'UserPromptSubmit', undefined, hook))}\n`)
    expect(config).not.toContain('user_prompt_submit:1:0')
  })

  it('records nothing for hooks that never reached the file', () => {
    const codexHome = home()
    writeFileSync(join(codexHome, 'hooks.json'), '[]\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    recordReviewed(record, codexHome, join(codexHome, 'hooks.json'))
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false)
  })

  it('leaves a config alone that defines the table in a form an appended table could collide with', () => {
    const records = new Map([['/h/hooks.json:session_start:0:0', 'sha256:new']])
    for (const text of [
      'hooks = { state = {} }\n',
      'hooks.state."/h/hooks.json:session_start:0:0".trusted_hash = "x"\n',
      '[hooks]\nstate = {}\n',
      '[hooks.state]\n"/h/hooks.json:session_start:0:0" = { trusted_hash = "x" }\n',
      '[hooks.state."/h/hooks.json:session_start:0:0"]\nx = 1\n\n[hooks.state."/h/hooks.json:session_start:0:0"]\ny = 1\n',
      // Spelled with quotes, it is the same table.
      '["hooks"]\nstate = {}\n',
      '"hooks" = {}\n',
      '[hooks."state"."/h/hooks.json:session_start:0:0"]\nx = 1\n\n[hooks.state."/h/hooks.json:session_start:0:0"]\ny = 1\n',
      // A line of an array is not a header: the root key after it is still in the root table.
      'paths = [\n["a"]\n]\nhooks = {}\n',
      '\uFEFFhooks = {}\n',
      // A record this does not read: a second key beside it would not parse.
      '[hooks.state."/h/hooks.json:session_start:0:0"]\ntrusted_hash = """sha256:old"""\n',
    ]) expect(withReviewRecords(text, record, records), text).toBe('unsafe')
    const codexHome = home()
    writeFileSync(join(codexHome, 'config.toml'), '[hooks]\nstate = {}\n')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe('[hooks]\nstate = {}\n')
    expect(log.mock.calls.flat().join('\n')).toContain('defines hooks.state in a form Harness does not edit')
  })

  it('keys a symlinked hooks.json by its own name in CODEX_HOME, not its target, as Codex does', () => {
    const codexHome = home()
    const dotfiles = home()
    writeFileSync(join(dotfiles, 'hooks.json'), '{}\n')
    symlinkSync(join(dotfiles, 'hooks.json'), join(codexHome, 'hooks.json'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installHookSettings('codex', hooks.settings, 18473, codexHome)
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(config).toContain(`[hooks.state.${JSON.stringify(`${codexHome}/hooks.json:session_start:0:0`)}]`)
    expect(config).not.toContain(dotfiles)
  })

  it('keys by the real path of a symlinked CODEX_HOME, as Codex does, and writes through a symlinked config', () => {
    const real = home()
    const link = `${real}-link`
    symlinkSync(real, link)
    roots.push(link)
    const dotfiles = home()
    writeFileSync(join(dotfiles, 'config.toml'), 'model = "gpt-6"\n')
    symlinkSync(join(dotfiles, 'config.toml'), join(real, 'config.toml'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    installHookSettings('codex', hooks.settings, 18473, link)
    expect(lstatSync(join(real, 'config.toml')).isSymbolicLink()).toBe(true)
    const config = readFileSync(join(dotfiles, 'config.toml'), 'utf8')
    expect(config).toContain(`[hooks.state.${JSON.stringify(`${real}/hooks.json:session_start:0:0`)}]`)
    expect(config).not.toContain(link)
  })

  it('never throws: an unreadable settings path is a hook Codex asks about, as before', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => recordReviewed(record, '/nonexistent-home', '/nonexistent-home/hooks.json')).not.toThrow()
    expect(error).toHaveBeenCalled()
  })
})
