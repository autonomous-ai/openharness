/**
 * Harness's two roots as the companions find them: the CLI's rule (cli/src/config/harnessHome.ts), written again
 * here because the package ships alone. Each case passes its platform and existence check, so it runs anywhere.
 */
import { describe, expect, it } from 'vitest'
import { harnessRoots } from './harnessRoots.js'

const XDG = { data: '/h/.local/share/harness', state: '/h/.local/state/harness' }
const existing = (...paths: string[]) => (path: string) => paths.includes(path)

describe('harnessRoots', () => {
  it('fresh: neither folder exists → the XDG roots', () => {
    expect(harnessRoots('/h', {}, 'linux', existing())).toEqual(XDG)
  })

  it('legacy only → both roots are ~/.harness', () => {
    expect(harnessRoots('/h', {}, 'linux', existing('/h/.harness'))).toEqual({ data: '/h/.harness', state: '/h/.harness' })
  })

  it('the data root exists → XDG, whatever is at ~/.harness', () => {
    expect(harnessRoots('/h', {}, 'linux', existing('/h/.harness', XDG.data))).toEqual(XDG)
  })

  it('an XDG variable that is unset, empty or relative is ignored', () => {
    for (const value of [undefined, '', 'share']) {
      expect(harnessRoots('/h', { XDG_DATA_HOME: value, XDG_STATE_HOME: value }, 'linux', existing())).toEqual(XDG)
    }
  })

  it('absolute XDG variables name the roots, and the data one is what is looked for', () => {
    const env = { XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' }
    expect(harnessRoots('/h', env, 'linux', existing())).toEqual({ data: '/d/harness', state: '/s/harness' })
    expect(harnessRoots('/h', env, 'linux', existing('/h/.harness', '/d/harness'))).toEqual({ data: '/d/harness', state: '/s/harness' })
  })

  it('macOS and Windows never run the rule', () => {
    const exists = () => { throw new Error('looked') }
    expect(harnessRoots('/Users/me', {}, 'darwin', exists)).toEqual({ data: '/Users/me/.harness', state: '/Users/me/.harness' })
    expect(harnessRoots('C:\\Users\\me', {}, 'win32', exists)).toEqual({ data: 'C:\\Users\\me\\.harness', state: 'C:\\Users\\me\\.harness' })
  })
})
