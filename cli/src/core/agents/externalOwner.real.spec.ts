import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { externalProcessGeneration } from '../../lib/externalProcessGeneration.js'
import { verifiedForegroundJob } from '../../lib/externalOwnerControl.js'
import { isolatedTmux } from '../../testing/isolatedTmux.js'
import { stopExternalOwner } from './externalOwner.js'

// A headless sleep has no foreground terminal evidence on macOS. Use a private terminal, as the real owner has.
describe.skipIf(process.platform === 'win32' || !binaryOnPath('tmux'))('stopping an external native owner', () => {
  it('stops a verified foreground job outside its child tree without restoring a terminal it no longer owns', async () => {
    const fixture = await isolatedTmux()
    try {
      const pid = Number(await fixture.run('new-session', '-d', '-s', 'external-stop', '-P', '-F', '#{pane_pid}', 'exec sleep 30'))
      const generation = externalProcessGeneration(pid)
      expect(generation).not.toBeNull()
      expect(await verifiedForegroundJob(pid)).toBe(pid)
      // A stopped owner's terminal may already belong to another conversation. It must receive no restoration bytes.
      const tty = join(fixture.root, 'next-terminal')
      writeFileSync(tty, 'the next conversation')
      const owner = { process: { pid, engine: 'claude' as const, tty, record: '/fixture/record' }, generation: generation! }
      expect(await stopExternalOwner(owner, { current: () => true, same: async () => true })).toBe(true)
      expect(readFileSync(tty, 'utf8')).toBe('the next conversation')
    } finally {
      await fixture.close()
    }
  })
})
