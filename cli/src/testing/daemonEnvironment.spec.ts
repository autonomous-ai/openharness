import { readFileSync } from 'node:fs'
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
    // Every name the hook reads to name that app, from the hook itself: a hint added there is dropped here too.
    const literal = /const HOST_HINTS = \[([^\]]*)\]/.exec(readFileSync(new URL('../../hook/notify.mjs', import.meta.url), 'utf8'))?.[1]
    expect(literal, 'HOST_HINTS in hook/notify.mjs').toBeDefined()
    const hints = Object.fromEntries([...literal!.matchAll(/'([^']+)'/g)].map(([, name], i) => [name, `hint-${i}`]))
    expect(Object.keys(hints)).toContain('ORCA_TERMINAL_HANDLE')
    expect(daemonEnvironment({ PATH: '/b', ...hints, ORCA_PAIRING_CODE: 'p', ORCA_FUTURE_SETTING: 'f' }, {})).toEqual({ PATH: '/b' })
  })
})
