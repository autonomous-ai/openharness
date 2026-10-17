import { describe, expect, it } from 'vitest'
import { infoBlockFooter } from './infoBlockFooter.js'

describe('the status block\'s last line', () => {
  it('says how to stop a daemon that runs, and how to start one that is stopped', () => {
    for (const running of ['● running · backend connected', '● started · this computer only (not signed in)', '● starting · restart 1', '◍ restarting its core · restart 2']) {
      expect(infoBlockFooter(running), running).toBe('  running in background · stop with: harness stop')
    }
    // It said "running in background" under a stopped daemon (B5.12 on the VM).
    expect(infoBlockFooter('○ stopped')).toBe('  start with: harness start')
    expect(infoBlockFooter('◌ out of reach · a sandbox keeps this shell from Harness; run harness status outside it')).toBeNull()
  })
})
