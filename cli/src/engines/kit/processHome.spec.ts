/**
 * A process's home from its own environment, by the engine's rule (Hermes's `hermes_constants.py`): only the
 * environment and the platform given, never this process's.
 */
import { expect, it } from 'vitest'
import { homeFromEnvironment, homeIsNamed } from './processHome.js'

const rule = { variable: 'HERMES_HOME', folder: '.hermes', windowsFolder: 'hermes', suffix: 'HERMES_DATA_DIR_SUFFIX' }
const home = (environment: Record<string, string>, platform: NodeJS.Platform = 'linux') => homeFromEnvironment(rule, environment, platform)

it('is the platform default under the process\'s own HOME', () => {
  expect(home({ HOME: '/home/agent' })).toBe('/home/agent/.hermes')
  expect(home({ HOME: '/home/agent', HERMES_DATA_DIR_SUFFIX: '-dev' })).toBe('/home/agent/.hermes-dev')
  expect(home({ HOME: '/h', HERMES_HOME: '   ' })).toBe('/h/.hermes')
  expect(home({ HOME: '/Users/a' }, 'darwin')).toBe('/Users/a/.hermes')
})

it('is HERMES_HOME when it names an absolute folder, expanded from the same environment', () => {
  expect(home({ HOME: '/h', HERMES_HOME: '/data/p/profiles/work/' })).toBe('/data/p/profiles/work')
  expect(home({ HOME: '/h', HERMES_HOME: '~/alt' })).toBe('/h/alt')
  expect(home({ HOME: '/h', HERMES_HOME: '$HOME/x' })).toBe('/h/x')
  expect(home({ HOME: '/h', ROOT: '/r', HERMES_HOME: '${ROOT}/x' })).toBe('/r/x')
})

it('keeps the root folder whole and the suffix as it is', () => {
  expect(home({ HOME: '/h', HERMES_HOME: '/' })).toBe('/')
  expect(home({ HOME: '/h', HERMES_HOME: '~' })).toBe('/h')
  expect(home({ HOME: '/h', HERMES_DATA_DIR_SUFFIX: ' x' })).toBe('/h/.hermes x')
  expect(home({ HERMES_HOME: '/data/p' })).toBe('/data/p')
})

it('is unknown when the environment alone cannot say', () => {
  for (const environment of <Record<string, string>[]>[{}, { HERMES_HOME: '~/x' }, { HOME: '/h', HERMES_HOME: 'relative' }, { HOME: '/h', HERMES_HOME: '$NOPE/x' },
    { HOME: '/h', HERMES_HOME: '/bad\u0000path' }, { HOME: '/h', HERMES_HOME: '/' + 'a'.repeat(4097) }]) expect(home(environment)).toBeUndefined()
})

it('follows Windows\'s rule there', () => {
  expect(home({ USERPROFILE: 'C:\\Users\\a', LOCALAPPDATA: 'D:\\Local' }, 'win32')).toBe('D:\\Local\\hermes')
  expect(home({ USERPROFILE: 'C:\\Users\\a' }, 'win32')).toBe('C:\\Users\\a\\AppData\\Local\\hermes')
  expect(home({ userprofile: 'C:\\Users\\a', Hermes_Home: '%USERPROFILE%\\h' }, 'win32')).toBe('C:\\Users\\a\\h')
  expect(home({ USERPROFILE: 'C:\\Users\\a', HERMES_HOME: 'C:\\' }, 'win32')).toBe('C:\\')
  expect(home({ USERPROFILE: 'C:\\Users\\a', HERMES_HOME: '~\\h\\' }, 'win32')).toBe('C:\\Users\\a\\h')
  expect(home({ HOME: '/h' }, 'win32')).toBeUndefined()
})

it('tells a home the process named from one worked out from HOME', () => {
  expect(homeIsNamed(rule, { HOME: '/h', HERMES_HOME: '/data/p' })).toBe(true)
  expect(homeIsNamed(rule, { HOME: '/h', Hermes_Home: 'C:\\h' })).toBe(true)
  for (const environment of <Record<string, string>[]>[{ HOME: '/h' }, { HOME: '/h', HERMES_HOME: '' }, { HOME: '/h', HERMES_HOME: '   ' }]) expect(homeIsNamed(rule, environment)).toBe(false)
})
