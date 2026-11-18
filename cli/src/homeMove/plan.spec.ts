import { describe, expect, it } from 'vitest'
import { HARNESS_ENTRIES } from '../config/harnessHome.js'
import { movedPath, planMove } from './plan.js'

const DATA = '/h/.local/share/harness'
const STATE = '/h/.local/state/harness'
const ROOT = { data: DATA, state: STATE }

describe('the move\'s plan', () => {
  it('each entry goes to the root its label names', () => {
    const names = Object.keys(HARNESS_ENTRIES)
    const plan = planMove('/h', {}, names)
    expect(plan).toMatchObject({ home: '/h', legacy: '/h/.harness', data: DATA, state: STATE })
    expect(plan.entries).toHaveLength(26)
    for (const [name, kind] of Object.entries(HARNESS_ENTRIES)) {
      expect(plan.entries.find((entry) => entry.name === name)).toEqual({
        name, kind, known: true, from: `/h/.harness/${name}`, staged: `${ROOT[kind]}.moving/${name}`, to: `${ROOT[kind]}/${name}`,
      })
    }
  })

  it('an entry the table does not know goes to data', () => {
    expect(planMove('/h', {}, ['scratch']).entries).toEqual([
      { name: 'scratch', kind: 'data', known: false, from: '/h/.harness/scratch', staged: `${DATA}.moving/scratch`, to: `${DATA}/scratch` },
    ])
  })

  it('the move\'s own files are not entries', () => {
    // .move-before holds the previous bytes of the files the move rewrites, and .move-old what a copy across filesystems
    // kept, until the finish drops them.
    expect(planMove('/h', {}, ['.move.json', '.move-before', '.move-old', 'cli', 'home-move.json']).entries.map((entry) => entry.name)).toEqual(['cli'])
  })

  it('movedPath maps <legacy>/runtime/x to <state>/runtime/x, <legacy>/cli/data to <data>/cli/data, and leaves /usr/bin/node alone', () => {
    const plan = planMove('/h', {}, [])
    expect(movedPath(plan, '/h/.harness/runtime/x')).toBe(`${STATE}/runtime/x`)
    expect(movedPath(plan, '/h/.harness/cli/data')).toBe(`${DATA}/cli/data`)
    expect(movedPath(plan, '/usr/bin/node')).toBe('/usr/bin/node')
  })

  it('custom XDG folders', () => {
    const plan = planMove('/h', { XDG_DATA_HOME: '/disk/data', XDG_STATE_HOME: '/disk/state' }, ['auth', 'logs'])
    expect(plan).toMatchObject({ data: '/disk/data/harness', state: '/disk/state/harness' })
    expect(plan.entries.map(({ staged, to }) => ({ staged, to }))).toEqual([
      { staged: '/disk/data/harness.moving/auth', to: '/disk/data/harness/auth' },
      { staged: '/disk/state/harness.moving/logs', to: '/disk/state/harness/logs' },
    ])
    expect(movedPath(plan, '/h/.harness/logs/a.log')).toBe('/disk/state/harness/logs/a.log')
  })
})
