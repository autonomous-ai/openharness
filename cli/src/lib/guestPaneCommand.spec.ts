import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUEST_LAUNCH_ENGINES, GUEST_PANE_BOOTSTRAP, guestPaneCommand } from './guestPaneCommand.js'

const account = { user: 'hg_0123456789ab', home: '/Users/Shared/HarnessGuests/hg_0123456789ab', workspace: '/Users/Shared/HarnessGuests/hg_0123456789ab/work' }
const relay = 'http://127.0.0.1:41234'

describe('a guest\'s pane', () => {
  it('runs Claude Code as the guest, on the owner\'s subscription through the relay, with the token only in the environment', () => {
    const { argv, env } = guestPaneCommand({ account, engine: 'claude', relayUrl: relay, token: 'guest-token', bypassPermission: true, lang: 'vi_VN.UTF-8' })
    expect(argv.slice(0, 8)).toEqual(['/bin/sh', '-c', GUEST_PANE_BOOTSTRAP, 'harness-guest', '/usr/local/libexec/harness/guest-helper', account.user, account.workspace, 'claude'])
    expect(argv.slice(8)).toEqual(['sudo', '-n', '/usr/local/libexec/harness/guest-helper', 'run', account.user, '--cwd', account.workspace,
      '--pass', 'TERM', '--pass', 'COLORTERM', '--pass', 'LANG', '--pass', 'ANTHROPIC_BASE_URL', '--pass', 'ANTHROPIC_AUTH_TOKEN',
      '--', 'claude', '--dangerously-skip-permissions'])
    expect(argv.join(' ')).not.toContain('guest-token')
    expect(env).toEqual({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'vi_VN.UTF-8',
      ANTHROPIC_BASE_URL: `${relay}/claude`, ANTHROPIC_AUTH_TOKEN: 'guest-token' })
  })

  it('runs Codex on the relay\'s provider, asking before each command when the guest wants it to', () => {
    const { argv, env } = guestPaneCommand({ account, engine: 'codex', relayUrl: relay, token: 'guest-token', bypassPermission: false, helperPath: '/opt/helper' })
    const engine = argv.slice(argv.indexOf('--') + 1)
    expect(engine[0]).toBe('codex')
    expect(engine).toContain(`model_providers.harness_owner.base_url="${relay}/codex"`)
    expect(engine).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv[4]).toBe('/opt/helper')
    expect(env).toEqual({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', HARNESS_RELAY_TOKEN: 'guest-token' })
    expect(guestPaneCommand({ account, engine: 'codex', relayUrl: relay, token: 't', bypassPermission: true }).argv.at(-1)).toBe('--dangerously-bypass-approvals-and-sandbox')
  })

  it('starts on the guest\'s first message, which no option can be read from', () => {
    const tail = (prompt: string, engine: 'claude' | 'codex' = 'claude') =>
      guestPaneCommand({ account, engine, relayUrl: relay, token: 't', bypassPermission: false, prompt }).argv.slice(-2)
    expect(tail('Fix the tests')).toEqual(['claude', 'Fix the tests'])
    expect(tail('Fix the tests', 'codex')).toEqual(['model_providers.harness_owner.supports_websockets=false', 'Fix the tests'])
    expect(tail('--settings /tmp/x')).toEqual(['--', '--settings /tmp/x'])
  })

  it('starts in a folder the owner shares when it is given one, which the helper checks again', () => {
    const { argv } = guestPaneCommand({ account, engine: 'claude', relayUrl: relay, token: 't', bypassPermission: false, cwd: '/Users/dee/docs' })
    expect(argv[6]).toBe('/Users/dee/docs')
    expect(argv.slice(argv.indexOf('run'), argv.indexOf('run') + 4)).toEqual(['run', account.user, '--cwd', '/Users/dee/docs'])
  })

  it('takes the engine\'s own flags for the mode the guest chose, in place of all or nothing', () => {
    const { argv } = guestPaneCommand({ account, engine: 'claude', relayUrl: relay, token: 't', bypassPermission: true,
      permissionFlags: ['--permission-mode', 'auto'], prompt: 'hi' })
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['claude', '--permission-mode', 'auto', 'hi'])
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it('is for the engines whose subscription the relay spends', () => {
    expect(GUEST_LAUNCH_ENGINES).toEqual(['claude', 'codex'])
  })
})

// The bootstrap runs for real, with a fake `sudo` on PATH that logs what it is asked and answers whether the
// guest has the engine as the test says.
describe('the pane\'s first moments', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function run(has: boolean, installs = true): { log: string[]; out: string; code: number } {
    const dir = mkdtempSync(join(tmpdir(), 'guest-pane-'))
    dirs.push(dir)
    const log = join(dir, 'log')
    writeFileSync(join(dir, 'sudo'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$3" in',
      `  run) case "$*" in *"command -v"*) exit ${has ? 0 : 1} ;; esac; exit 0 ;;`,
      `  install) exit ${installs ? 0 : 1} ;;`,
      'esac',
    ].join('\n'))
    chmodSync(join(dir, 'sudo'), 0o755)
    let out = '', code = 0
    try {
      out = execFileSync('/bin/sh', ['-c', GUEST_PANE_BOOTSTRAP, 'harness-guest', '/helper', 'hg_0123456789ab', '/work', 'claude',
        'sudo', '-n', '/helper', 'run', 'hg_0123456789ab', '--cwd', '/work', '--', 'claude'], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' })
    } catch (error) {
      const failed = error as { status: number; stdout: string }
      code = failed.status
      out = failed.stdout
    }
    return { log: readFileSync(log, 'utf8').trim().split('\n'), out, code }
  }

  it('hands straight over when the guest has the engine', () => {
    const { log, code } = run(true)
    expect(code).toBe(0)
    expect(log).toEqual([
      '-n /helper run hg_0123456789ab --cwd /work -- /bin/sh -c command -v "$0" >/dev/null claude',
      '-n /helper run hg_0123456789ab --cwd /work -- claude',
    ])
  })

  it('installs it for the guest first, in front of them', () => {
    const { log, code } = run(false)
    expect(code).toBe(0)
    expect(log.slice(1)).toEqual(['-n /helper install hg_0123456789ab claude', '-n /helper run hg_0123456789ab --cwd /work -- claude'])
  })

  it('says so and stops when the install fails', () => {
    const { log, out, code } = run(false, false)
    expect(code).toBe(1)
    expect(out).toContain('Could not install claude.')
    expect(log.at(-1)).toBe('-n /helper install hg_0123456789ab claude')
  })
})
