import { describe, expect, it } from 'vitest'
import { daemonEnvironment } from './daemonEnvironment.js'

describe('a daemon under test', () => {
  it('starts the unit worker outside the host supervisor too', () => {
    expect(Object.keys(process.env).filter(key => key.startsWith('HARNESSD_'))).toEqual([])
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
    expect(daemonEnvironment({ PATH: '/test/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CODEX_THREAD_ID: 't', CLAUDE_CODE_USE_BEDROCK: '1' }, {}))
      .toEqual({ PATH: '/test/bin', CLAUDE_CODE_USE_BEDROCK: '1' })
  })
  it('does not borrow a GitHub login, so a daemon\'s gh cannot act as the developer', () => {
    expect(daemonEnvironment({ PATH: '/b', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd' }, {})).toEqual({ PATH: '/b' })
  })
  it('does not borrow the app the tests run in, so a daemon cannot type into the developer\'s own terminal', () => {
    expect(daemonEnvironment({
      PATH: '/b', ORCA_TERMINAL_HANDLE: 'term_00000000-0000-0000-0000-000000000000', ORCA_PAIRING_CODE: 'p',
      ORCA_AGENT_SESSION_ID: 's', ORCA_FUTURE_SETTING: 'f', TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'app',
      HERDR_PANE_ID: 'h', REX_BLOCK: 'r', ZELLIJ: '0', KITTY_WINDOW_ID: '1', WEZTERM_PANE: '2',
    }, {})).toEqual({ PATH: '/b' })
  })
})
