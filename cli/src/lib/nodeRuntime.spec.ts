import { describe, expect, it } from 'vitest'

import { nodeMajorOf } from './nodeRuntime.js'

describe('nodeMajorOf', () => {
  it('reads the runtime folder', () => {
    expect(nodeMajorOf('/Users/a/.harness/runtime/node-v24.22.2-darwin-arm64/bin/node')).toBe(24)
    expect(nodeMajorOf('C:\\Users\\a\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe')).toBe(22)
    expect(nodeMajorOf('/home/a/.harness/runtime/node-v22.23.2-linux-x64/libexec/harnessd/harnessd')).toBe(22)
    expect(nodeMajorOf('/usr/local/bin/node')).toBeNull()
  })
})
