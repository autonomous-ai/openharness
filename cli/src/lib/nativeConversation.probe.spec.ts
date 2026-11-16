import { afterEach, expect, it, vi } from 'vitest'
const ownership = vi.hoisted(() => vi.fn())
vi.mock('./engineBin.js', async original => ({ ...await original<typeof import('./engineBin.js')>(), agentCommandOwnershipSnapshotAsync: ownership }))
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { nativeConversationFixture } from '../testing/nativeConversationEvidence.js'
import { nativeProcessFiles } from './nativeConversation.js'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const sources = () => nativeConversationFixture(async () => [], async () => [
 { pid: 42, parentPid: 1, executable: 'node', args: 'node /fixture/codex.js' },
 { pid: 43, parentPid: 42, executable: 'codex', args: 'codex' },
])
it('ends the caller wait at its remaining native evidence budget without cancelling shared ownership work', async () => {
 vi.useFakeTimers()
 let finish!: (value: never) => void
 ownership.mockReturnValue(new Promise(resolve => { finish = resolve }))
 const budget = new NativeEvidenceBudget()
 vi.spyOn(budget, 'remaining').mockReturnValue(25)
 let failure: unknown
 void nativeProcessFiles('codex', 42, { budget, sources: sources() }).catch(error => { failure = error })
 await vi.advanceTimersByTimeAsync(25)
 expect(failure).toBeInstanceOf(IdentityReadUnavailable)
 expect(String(failure)).toContain('deadline')
 expect(ownership).toHaveBeenCalledTimes(1)
 finish({} as never)
 await vi.advanceTimersByTimeAsync(0)
})
it('keeps failed executable ownership as unavailable native evidence', async () => {
 ownership.mockRejectedValue(new Error('ENGINE_LOOKUP_TIMEOUT'))
 await expect(nativeProcessFiles('codex', 42, { sources: sources() })).rejects.toBeInstanceOf(IdentityReadUnavailable)
})
