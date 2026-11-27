import { expect, it, vi } from 'vitest'
const lookup = vi.hoisted(() => vi.fn())
vi.mock('./engineBin.js', async original => ({ ...await original<typeof import('./engineBin.js')>(), agentCommandOwnershipSnapshotAsync: lookup }))
import { lookupPaneEngineProcess } from './paneEngineProcess.js'
const lookupCodexPane = () => lookupPaneEngineProcess({ rootProcess: async () => 10 }, { backend: 'tmux', paneId: '%1' }, 'codex', async () => [
 { pid: 10, parentPid: 1, executable: 'codex', args: 'codex', startMarker: 'w:1' },
])
it('keeps a live pane unknown when executable discovery times out, and names the kind', async () => {
 lookup.mockRejectedValue(Object.assign(new Error('ENGINE_LOOKUP_TIMEOUT'), { code: 'ENGINE_LOOKUP_TIMEOUT' }))
 expect(await lookupCodexPane()).toEqual({ ok: false, unknown: true, reason: 'ENGINE_LOOKUP_UNAVAILABLE: executable ownership could not be read (ENGINE_LOOKUP_TIMEOUT)' })
})
it('names the failure by its kind only, never the path its message quotes', async () => {
 lookup.mockRejectedValue(Object.assign(new Error("ENOENT: no such file or directory, scandir '/Users/sentinel-person'"), { code: 'ENOENT' }))
 const result = await lookupCodexPane()
 expect(result).toEqual({ ok: false, unknown: true, reason: 'ENGINE_LOOKUP_UNAVAILABLE: executable ownership could not be read (ENOENT)' })
 expect(JSON.stringify(result)).not.toContain('sentinel-person')
})
