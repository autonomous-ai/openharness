import { parse } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { startEnvFile } from './startEnvFile.js'

describe('the env file of a daemon a test starts through harness start', () => {
  it('holds the harness\'s settings a start would leave out, and no other variable', () => {
    const env = { PATH: '/t/bin', HOME: '/t/home', ZDOTDIR: '/t/home', GRID_HOME: '/t/home/.grid', USERPROFILE: '/t/home',
      TEMP: '/t/tmp', ANALYTICS_ENABLED: 'false', HARNESS_GRID_BIN: '', SENTINEL_TOKEN: 's' }
    const text = startEnvFile(env, ['PATH', 'HOME', 'ZDOTDIR', 'GRID_HOME', 'USERPROFILE', 'TEMP', 'ANALYTICS_ENABLED', 'HARNESS_GRID_BIN'],
      { E2E_FROM_ENV_FILE: 'reaches-the-pane' }, 'darwin')
    // Not PATH, HOME, ZDOTDIR, GRID_HOME or HARNESS_GRID_BIN: a start keeps them. Not SENTINEL_TOKEN: a test's own, never the harness's.
    expect(parse(text)).toEqual({ USERPROFILE: '/t/home', TEMP: '/t/tmp', ANALYTICS_ENABLED: 'false', E2E_FROM_ENV_FILE: 'reaches-the-pane' })
    // On Windows a start keeps them all: only the test's own lines.
    expect(parse(startEnvFile(env, ['USERPROFILE'], { E2E_FROM_ENV_FILE: 'x' }, 'win32'))).toEqual({ E2E_FROM_ENV_FILE: 'x' })
  })
  it('refuses a value an env file cannot hold as written, by the variable\'s name', () => {
    expect(() => startEnvFile({ TEMP: "/t/it's" }, ['TEMP'], {}, 'linux')).toThrow(/TEMP/)
    expect(() => startEnvFile({}, [], { E2E_TWO_LINES: 'a\nb' }, 'linux')).toThrow(/E2E_TWO_LINES/)
  })
})
