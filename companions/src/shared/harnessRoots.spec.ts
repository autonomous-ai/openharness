/**
 * Harness's two roots as the companions find them: the CLI's rule (cli/src/config/harnessHome.ts), written again
 * here because the package ships alone. Each case passes its platform and existence check, so it runs anywhere.
 */
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessRoots } from './harnessRoots.js'

const XDG = { data: '/h/.local/share/harness', state: '/h/.local/state/harness' }
/** A computer with [paths] there, as folders or files: the existence check and the file check. */
const on = (...paths: string[]) => [(path: string) => paths.includes(path), (path: string) => paths.includes(path)] as const
/** The file that makes a data root Harness's (cli/src/config/harnessHome.ts). */
const marker = (dataRoot: string) => `${dataRoot}/.harness-root`

describe('harnessRoots', () => {
  it('fresh: neither folder exists → the XDG roots', () => {
    expect(harnessRoots('/h', {}, 'linux', ...on())).toEqual(XDG)
  })

  it('legacy only → both roots are ~/.harness', () => {
    expect(harnessRoots('/h', {}, 'linux', ...on('/h/.harness'))).toEqual({ data: '/h/.harness', state: '/h/.harness' })
  })

  it('the data root holds the marker → XDG, whatever is at ~/.harness', () => {
    expect(harnessRoots('/h', {}, 'linux', ...on('/h/.harness', XDG.data, marker(XDG.data)))).toEqual(XDG)
  })

  it('a data root without the marker beside ~/.harness → ~/.harness', () => {
    expect(harnessRoots('/h', {}, 'linux', ...on('/h/.harness', XDG.data))).toEqual({ data: '/h/.harness', state: '/h/.harness' })
  })

  it('an XDG variable that is unset, empty or relative is ignored', () => {
    for (const value of [undefined, '', 'share']) {
      expect(harnessRoots('/h', { XDG_DATA_HOME: value, XDG_STATE_HOME: value }, 'linux', ...on())).toEqual(XDG)
    }
  })

  it('absolute XDG variables name the roots, and the data one\'s marker is what is looked for', () => {
    const env = { XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' }
    expect(harnessRoots('/h', env, 'linux', ...on())).toEqual({ data: '/d/harness', state: '/s/harness' })
    expect(harnessRoots('/h', env, 'linux', ...on('/h/.harness', marker('/d/harness')))).toEqual({ data: '/d/harness', state: '/s/harness' })
    expect(harnessRoots('/h', env, 'linux', ...on('/h/.harness', marker(XDG.data)))).toEqual({ data: '/h/.harness', state: '/h/.harness' })
  })

  it('on disk the marker is a file, as the installers, Desktop and hn look for it: a folder of its name is none', () => {
    const home = mkdtempSync(join(tmpdir(), 'companion-roots-'))
    try {
      const data = posix.join(home, '.local', 'share', 'harness'), legacy = posix.join(home, '.harness')
      mkdirSync(legacy)
      mkdirSync(marker(data), { recursive: true })
      expect(harnessRoots(home, {}, 'linux')).toEqual({ data: legacy, state: legacy })
      rmdirSync(marker(data))
      writeFileSync(marker(data), '1\n')
      expect(harnessRoots(home, {}, 'linux')).toEqual({ data, state: posix.join(home, '.local', 'state', 'harness') })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('macOS and Windows never run the rule', () => {
    const exists = () => { throw new Error('looked') }
    expect(harnessRoots('/Users/me', {}, 'darwin', exists)).toEqual({ data: '/Users/me/.harness', state: '/Users/me/.harness' })
    expect(harnessRoots('C:\\Users\\me', {}, 'win32', exists)).toEqual({ data: 'C:\\Users\\me\\.harness', state: 'C:\\Users\\me\\.harness' })
  })
})
