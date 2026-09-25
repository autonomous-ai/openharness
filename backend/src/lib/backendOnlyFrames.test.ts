import { describe, expect, it } from 'vitest'
import { isBackendOnlyDownType } from './backendOnlyFrames.js'

describe('isBackendOnlyDownType', () => {
  it('refuses the backend\'s own control frames from any client socket', () => {
    for (const type of ['machine_meta', 'machine_revoked', 'desk_changed', 'machines_changed', '__clients', '__billing_suspended']) {
      expect(isBackendOnlyDownType(type), type).toBe(true)
    }
  })
  it('lets client frames through', () => {
    for (const type of ['message', 'agents_list', 'e2e_hello', 'terminal_input', 'machine_select']) {
      expect(isBackendOnlyDownType(type), type).toBe(false)
    }
    expect(isBackendOnlyDownType(undefined)).toBe(false)
  })
})
