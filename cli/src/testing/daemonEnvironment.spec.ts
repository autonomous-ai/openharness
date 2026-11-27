import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { daemonEnvironment } from './daemonEnvironment.js'

describe('a daemon under test', () => {
  it('starts the unit worker outside the host supervisor too', () => {
    expect(Object.keys(process.env).filter(key => key.startsWith('HARNESSD_'))).toEqual([])
  })
  it('inherits only what it needs to run, and nothing else the shell names', () => {
    const needed = {
      PATH: '/test/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LC_CTYPE: 'UTF-8', LC_MESSAGES: 'C', TERM: 'xterm-256color',
      SHELL: '/bin/zsh', USER: 'tester', LOGNAME: 'tester', TZ: 'UTC', CI: 'true',
    }
    expect(daemonEnvironment({
      ...needed,
      // Made up, every one: the kinds of name the audit found (docs/plans/2026-11-15-e2e-daemon-isolation-design.md).
      FAKE_SECRET_TOKEN: 'fake-secret', HARNESS_CONNECTIONS_DIR: '/fake/connections', XDG_DATA_HOME: '/fake/share',
      SSH_AUTH_SOCK: '/fake/agent.sock', OPENAI_API_KEY: 'fake-key', HOME: '/fake/home', TMPDIR: '/fake/tmp',
      TMUX_TMPDIR: '/fake/tmux', NODE_OPTIONS: '--require /fake/hook.cjs', VITEST: 'true',
    }, {})).toEqual(needed)
  })
  it('keeps what Windows needs to start a child, however the shell spells it', () => {
    // cmd and PowerShell hand a child SystemRoot, ComSpec, windir and Path; Git Bash hands it SYSTEMROOT, COMSPEC and WINDIR.
    const cmd = { Path: 'C:\\test\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE', windir: 'C:\\Windows' }
    const bash = { PATH: '/c/test/bin', SYSTEMROOT: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE', WINDIR: 'C:\\Windows' }
    expect(daemonEnvironment({ ...cmd, USERPROFILE: 'C:\\Users\\fake', LOCALAPPDATA: 'C:\\Users\\fake\\AppData\\Local', Fake_Secret_Token: 'fake-secret' }, {})).toEqual(cmd)
    expect(daemonEnvironment({ ...bash, USERPROFILE: 'C:\\Users\\fake', APPDATA: 'C:\\Users\\fake\\AppData\\Roaming' }, {})).toEqual(bash)
  })
  it('lets what the harness or a test sets win, on the list or not, empty or not', () => {
    expect(daemonEnvironment({ PATH: '/host/bin', LANG: 'C.UTF-8', HARNESS_GRID_BIN: '/host/grid' },
      { PATH: '/test/bin', HOME: '/test/home', HARNESS_GRID_BIN: '', HARNESS_CONNECTIONS_DIR: '/test/connections' }))
      .toEqual({ PATH: '/test/bin', LANG: 'C.UTF-8', HOME: '/test/home', HARNESS_GRID_BIN: '', HARNESS_CONNECTIONS_DIR: '/test/connections' })
  })
  it('does not borrow the host supervisor, credentials, service subset or injected faults', () => {
    expect(daemonEnvironment({
      PATH: '/test/bin', HOME: '/host', HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: 'host-token',
      HARNESSD_SERVICES: 'search,workspaces', HARNESSD_SERVICE_PROCESSES: 'search,workspaces',
      HARNESSD_TEST_FAULTS: 'core.stall:10', HARNESSD_FUTURE_SETTING: 'host',
    }, { HOME: '/test/home', HARNESSD_SERVICES: 'edge' })).toEqual({
      PATH: '/test/bin', HOME: '/test/home', HARNESSD_SERVICES: 'edge',
    })
  })
  it('does not borrow the session of an agent running the tests', () => {
    expect(daemonEnvironment({
      PATH: '/test/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't', CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_HOST_SESSION_ID: 'local_1',
    }, {})).toEqual({ PATH: '/test/bin' })
  })
  it('does not borrow a GitHub login, so a daemon\'s gh cannot act as the developer', () => {
    expect(daemonEnvironment({ PATH: '/b', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd' }, {})).toEqual({ PATH: '/b' })
  })
  it('does not borrow the app the tests run in, so a daemon cannot type into the developer\'s own terminal', () => {
    // Every name the hook reads to name that app, from the hook itself: a hint added there is dropped here too.
    const literal = /const HOST_HINTS = \[([^\]]*)\]/.exec(readFileSync(new URL('../../hook/notify.mjs', import.meta.url), 'utf8'))?.[1]
    expect(literal, 'HOST_HINTS in hook/notify.mjs').toBeDefined()
    const hints = Object.fromEntries([...literal!.matchAll(/'([^']+)'/g)].map(([, name], i) => [name, `hint-${i}`]))
    expect(Object.keys(hints)).toContain('ORCA_TERMINAL_HANDLE')
    expect(daemonEnvironment({ PATH: '/b', ...hints, ORCA_PAIRING_CODE: 'p', ORCA_FUTURE_SETTING: 'f' }, {})).toEqual({ PATH: '/b' })
  })
})
