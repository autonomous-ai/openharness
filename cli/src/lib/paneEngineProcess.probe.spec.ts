import { expect, it, vi } from 'vitest'
const lookup = vi.hoisted(() => vi.fn())
vi.mock('./engineBin.js', async original => ({ ...await original<typeof import('./engineBin.js')>(), agentCommandOwnershipSnapshotAsync: lookup }))
import { lookupPaneEngineProcess } from './paneEngineProcess.js'
it('keeps a live pane unknown when executable discovery times out', async () => {
 lookup.mockRejectedValue(new Error('ENGINE_LOOKUP_TIMEOUT'))
 const result = await lookupPaneEngineProcess({ rootProcess: async () => 10 }, { backend: 'tmux', paneId: '%1' }, 'codex', async () => [
  { pid: 10, parentPid: 1, executable: 'codex', args: 'codex', startMarker: 'w:1' },
 ])
 expect(result).toEqual({ ok: false, unknown: true, reason: 'ENGINE_LOOKUP_UNAVAILABLE: executable ownership could not be read' })
})
