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
})
