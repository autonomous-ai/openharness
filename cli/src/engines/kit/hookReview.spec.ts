import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hooks } from '../codex/hookContract.js'
import { installHookSettings } from './hookSettings.js'
import { recordReviewed, reviewHash, reviewRecords, withoutReviewRecords, withReviewRecords } from './hookReview.js'

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
// The four hashes `hooks/list` of codex-cli 0.169.0 reported for the same command, each block as Harness writes it
// (docs/plans/2026-11-16-hook-driven-agent-status-facts-codex.md §1, 2026-11-17). 0.169.0 lists the two above unchanged.
const CODEX_0_169 = {
  stop: 'sha256:51ccf08c5abb298e3640ad1aa2a6d97a1e4c9aa50bf54769012a5f48e9819103',
  permission_request: 'sha256:dea5f4e595e43e7116728901dbcbd71915be5be2b4159916d43d06d125ebe833',
  pre_tool_use: 'sha256:6759b736f953bcb9cc9a47f366def174a2a3bf0394cc456d07494d3700dfc852',
  // Codex lists it with timeoutSec 3: it caps Interrupt at 3 s and hashes the capped value.
  interrupt: 'sha256:6168570fe3ae52db10c67e1abfa5d8743900a146979b56191e5c9a7e5f737d72',
}

describe('Harness’s own Codex hooks, recorded as reviewed', () => {
  it('hashes each new hook exactly as the targeted Codex does', () => {
    expect(reviewHash(record, 'Stop', undefined, { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.stop)
    expect(reviewHash(record, 'PermissionRequest', undefined, { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.permission_request)
    expect(reviewHash(record, 'PreToolUse', 'request_user_input', { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.pre_tool_use)
    // Codex keeps PreToolUse's matcher in the hash.
    expect(reviewHash(record, 'PreToolUse', 'other', { command: COMMAND, timeout: 5 })).not.toBe(CODEX_0_169.pre_tool_use)
    expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND, timeout: 3 })).toBe(CODEX_0_169.interrupt)
  })

  it('hashes an Interrupt hook at the 1-3 s Codex clamps it to, whatever timeout the file names', () => {
    // A person's own timeout: Codex lists 3 s, so the record must hold the 3 s hash or Codex asks at every start.
    expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND, timeout: 5 })).toBe(CODEX_0_169.interrupt)
    expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND, timeout: 30 })).toBe(CODEX_0_169.interrupt)
    // None named: Codex lists 1 s, not the 600 s of every other event.
    expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND })).toBe(reviewHash(record, 'Interrupt', undefined, { command: COMMAND, timeout: 1 }))
    expect(reviewHash(record, 'Interrupt', undefined, { command: COMMAND })).not.toBe(CODEX_0_169.interrupt)
  })

  it('installs every declared event, Interrupt with a 3 s timeout, and records each as reviewed with the hash the targeted Codex lists', async () => {
    const codexHome = home(), file = join(codexHome, 'hooks.json')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installHookSettings('codex', hooks.settings, 19473, codexHome)).toBe(true)
    const installed = JSON.parse(readFileSync(file, 'utf8'))
    const listed: Record<string, string> = { ...CODEX_0_162, ...CODEX_0_169 }
    const notify = Object.entries(record.events).filter(([event]) => event !== 'PostToolUse')
    expect(notify.map(([event]) => event)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'PreToolUse', 'Interrupt'])
    for (const [event, label] of notify) {
      const [block] = installed.hooks[event]
      expect(block.hooks[0].timeout, event).toBe(event === 'Interrupt' ? 3 : 5)
      // The block as written, run by the command Codex listed: Codex's own hash.
      expect(reviewHash(record, event, block.matcher, { ...block.hooks[0], command: COMMAND }), event).toBe(listed[label])
    }
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    const records = reviewRecords(record, file, installed)
    // notify.mjs's six, and Agent Messages' one.
    expect([...records.keys()].map((key) => key.slice(file.length))).toEqual([':session_start:0:0', ':user_prompt_submit:0:0', ':stop:0:0',
      ':permission_request:0:0', ':pre_tool_use:0:0', ':interrupt:0:0', ':post_tool_use:0:0'])
    for (const [key, hash] of records) expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`)
    expect(records.get(`${file}:interrupt:0:0`)).toBe(reviewHash(record, 'Interrupt', undefined, { command: installed.hooks.Interrupt[0].hooks[0].command, timeout: 3 }))
  })

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
      Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }, { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }],
    } }
    expect([...reviewRecords(record, '/home/person/.codex/hooks.json', settings)]).toEqual([
      ['/home/person/.codex/hooks.json:session_start:1:0', CODEX_0_162.session_start],
      ['/home/person/.codex/hooks.json:user_prompt_submit:0:0', CODEX_0_162.user_prompt_submit],
      ['/home/person/.codex/hooks.json:stop:1:0', CODEX_0_169.stop],
    ])
  })

  it('installs the hooks and records them, so Codex runs them without asking; a second start changes nothing', async () => {
    const codexHome = home()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    const installed = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    for (const [key, hash] of reviewRecords(record, join(codexHome, 'hooks.json'), installed)) {
      expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`)
    }
    expect(lstatSync(join(codexHome, 'config.toml')).mode & 0o777).toBe(0o600)
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(config)
  })

  it('records them for hooks an earlier start installed, and again when Harness’s command changes', async () => {
    const codexHome = home()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6"\n')
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    const first = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(first.startsWith('model = "gpt-6"\n\n[hooks.state.')).toBe(true)
    // Another port: another command, so another hash, in the same tables.
    await installHookSettings('codex', hooks.settings, 18999, codexHome)
    const second = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    // Agent Messages' block makes seven: notify.mjs's six, and its one. No other: the shell guard is gone.
    expect(second.match(/^\[hooks\.state\./gm)).toHaveLength(7)
    expect(second).not.toContain('session-flags')
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

  it('records what hooks.json holds on disk: a block of the person’s before Harness’s, another timeout', async () => {
    const codexHome = home()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    const installed = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    // Harness's block first, the person's added after it, and a timeout of their own: current, so not rewritten.
    installed.hooks.UserPromptSubmit = [{ hooks: [{ ...installed.hooks.UserPromptSubmit[0].hooks[0], timeout: 30 }] }, { hooks: [{ type: 'command', command: 'echo theirs' }] }]
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(installed))
    rmSync(join(codexHome, 'config.toml'))
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toBe(JSON.stringify(installed))
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    const hook = installed.hooks.UserPromptSubmit[0].hooks[0]
    expect(config).toContain(`[hooks.state.${JSON.stringify(`${codexHome}/hooks.json:user_prompt_submit:0:0`)}]\ntrusted_hash = ${JSON.stringify(reviewHash(record, 'UserPromptSubmit', undefined, hook))}\n`)
    expect(config).not.toContain('user_prompt_submit:1:0')
  })

  it('Codex: the review record of a pruned hook goes with it, and the others stay', async () => {
    const codexHome = home(), file = join(codexHome, 'hooks.json'), configFile = join(codexHome, 'config.toml')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // A release that installed SubagentStop too (Codex's label: subagent_stop). Its label stays among the reviewed
    // events, so its records can be found.
    const reviewed = { ...record, events: { ...record.events, SubagentStop: 'subagent_stop' } }
    const later = { ...hooks.settings, reviewed }
    expect(await installHookSettings('codex', { ...later, events: [...later.events, { event: 'SubagentStop' }] }, 19473, codexHome)).toBe(true)
    const installed = JSON.parse(readFileSync(file, 'utf8'))
    const theirs = { hooks: [{ type: 'command', command: 'echo theirs' }] }
    installed.hooks.SubagentStop.push(theirs)
    writeFileSync(file, JSON.stringify(installed))
    const theirRecord = `[hooks.state.${JSON.stringify(`${file}:subagent_stop:1:0`)}]\ntrusted_hash = "sha256:theirs"\n`
    writeFileSync(configFile, `${readFileSync(configFile, 'utf8')}\n${theirRecord}`)
    expect(readFileSync(configFile, 'utf8')).toContain(`${file}:subagent_stop:0:0`)
    expect(await installHookSettings('codex', later, 19473, codexHome)).toBe(true)
    const now = JSON.parse(readFileSync(file, 'utf8'))
    expect(now.hooks.SubagentStop).toEqual([theirs])
    const config = readFileSync(configFile, 'utf8')
    expect(config).not.toContain(`${file}:subagent_stop:0:0`)
    expect(config).toContain(theirRecord)
    const records = reviewRecords(reviewed, file, now)
    expect([...records.keys()].map((key) => key.slice(file.length))).toEqual([':session_start:0:0', ':user_prompt_submit:0:0', ':stop:0:0',
      ':permission_request:0:0', ':pre_tool_use:0:0', ':interrupt:0:0', ':post_tool_use:0:0'])
    for (const [key, hash] of records) expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`)
    expect(config.match(/^\[hooks\.state\./gm)).toHaveLength(8)
  })

  it('records nothing for hooks that never reached the file', async () => {
    const codexHome = home()
    writeFileSync(join(codexHome, 'hooks.json'), '[]\n')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await recordReviewed(record, codexHome, join(codexHome, 'hooks.json'))
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false)
  })

  it('leaves a config alone that defines the table in a form an appended table could collide with', async () => {
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await installHookSettings('codex', hooks.settings, 19473, codexHome)).toBe(false)
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe('[hooks]\nstate = {}\n')
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false)
    expect(error).toHaveBeenCalledWith(hooks.settings.messages.failed, 'HookPreparationHeld')
  })

  it('keys a symlinked hooks.json by its own name in CODEX_HOME, not its target, as Codex does', async () => {
    const codexHome = home()
    const dotfiles = home()
    writeFileSync(join(dotfiles, 'hooks.json'), '{}\n')
    symlinkSync(join(dotfiles, 'hooks.json'), join(codexHome, 'hooks.json'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await installHookSettings('codex', hooks.settings, 19473, codexHome)
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(config).toContain(`[hooks.state.${JSON.stringify(`${codexHome}/hooks.json:session_start:0:0`)}]`)
    expect(config).not.toContain(dotfiles)
  })

  it('keys by the real path of a symlinked CODEX_HOME, as Codex does, and writes through a symlinked config', async () => {
    const real = home()
    const link = `${real}-link`
    symlinkSync(real, link)
    roots.push(link)
    const dotfiles = home()
    writeFileSync(join(dotfiles, 'config.toml'), 'model = "gpt-6"\n')
    symlinkSync(join(dotfiles, 'config.toml'), join(real, 'config.toml'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await installHookSettings('codex', hooks.settings, 19473, link)
    expect(lstatSync(join(real, 'config.toml')).isSymbolicLink()).toBe(true)
    const config = readFileSync(join(dotfiles, 'config.toml'), 'utf8')
    expect(config).toContain(`[hooks.state.${JSON.stringify(`${real}/hooks.json:session_start:0:0`)}]`)
    expect(config).not.toContain(link)
  })

  it('never throws: an unreadable settings path is a hook Codex asks about, as before', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await recordReviewed(record, '/nonexistent-home', '/nonexistent-home/hooks.json')).toBe(false)
    expect(error).toHaveBeenCalled()
  })
})

describe('Harness’s review records, taken out for harness uninstall', () => {
  const map = new Map([['/h/hooks.json:session_start:0:0', 'sha256:ours']])
  const records = (key: string, hash: string) => map.get(key) === hash
  const ours = '[hooks.state."/h/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:ours"\n'

  it('takes out the table Harness appended, leaving the text as it was before it', () => {
    const before = 'model = "o3"\r\n[hooks.state]\n'
    const after = withReviewRecords(before, record, map) as string
    expect(withoutReviewRecords(after, record, records)).toEqual({ text: before.replace(/\s*$/, '\n'), removed: 1 })
    expect(withoutReviewRecords(ours, record, records)).toEqual({ text: '', removed: 1 })
  })

  it('reads a single-quoted key and spaced dots as the same table, and leaves a header inside a string', () => {
    const spaced = "[ hooks . state . '/h/hooks.json:session_start:0:0' ]\ntrusted_hash = 'sha256:ours'\n\n[x]\ny = 1\n"
    expect(withoutReviewRecords(spaced, record, records)).toEqual({ text: '[x]\ny = 1\n', removed: 1 })
    const quoted = `note = """\n${ours}"""\n`
    expect(withoutReviewRecords(quoted, record, records)).toEqual({ text: quoted, removed: 0 })
  })

  it('keeps a record with a comment, another field or another hash, and another hook’s', () => {
    for (const text of [
      ours.replace('\n', ' # mine\n'),
      `${ours}enabled = false\n`,
      ours.replace('sha256:ours', 'sha256:theirs'),
      ours.replace(':0:0', ':1:0'),
    ]) expect(withoutReviewRecords(text, record, records)).toEqual({ text, removed: 0 })
  })
})
