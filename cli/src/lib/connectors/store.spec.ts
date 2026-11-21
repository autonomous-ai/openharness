import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectorsDir } from './store.js'

describe('connectorsDir', () => {
  it('a relative HARNESS_CONNECTIONS_DIR is under the home, as config/env.ts reads every Harness folder', () => {
    expect(connectorsDir({ HARNESS_CONNECTIONS_DIR: 'c', HOME: '/h' })).toBe(join('/h', 'c'))
  })
})
