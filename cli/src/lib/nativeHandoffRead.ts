/** The edge reader retains the exact descriptor and finite version that authorized its content. */
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { AgentEngine } from '../engines/types.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
import { NativeFiles } from '../engines/kit/nativeFiles.js'
import { nativeFileKey, verifyNativePathFacts, type NativePathFact } from '../engines/kit/nativePaths.js'
import { nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { readSessionTurns, type ReadOptions, type TurnSource } from './sessionSearch/sessionTurns.js'
import { nativeContentVersion, type NativeHandoffRead } from './handoffAuthority.js'

export async function readNativeHandoff(source: TurnSource, ownerAgentId: string, profile: string | undefined, cwd: string | null,
  options: ReadOptions,
): Promise<{ turns: Awaited<ReturnType<typeof readSessionTurns>>; witness: NativeHandoffRead }> {
  let handle: FileHandle | undefined
  try {
    const engine = source.engine as AgentEngine, path = source.transcriptPath!
    const proof = controlTranscriptEvidence(engine, source.sessionId, path, profile, cwd)
    const files = new NativeFiles(); files.locate(path)
    const location = files.file(proof.path)!
    const route: NativePathFact[] = files.paths.snapshot()
    handle = await open(location.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)
      || nativeFileKey(before) !== nativeFileKey(location.info)
      || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) {
      return nativeUnavailable('the opened conversation has a different identity, owner or type')
    }
    proof.verify(nativeFileKey(before)); verifyNativePathFacts(route)
    const version = nativeContentVersion(before)
    const turns = await readSessionTurns({ ...source, transcriptPath: location.path }, { ...options, handle, end: Number(before.size) })
    if (nativeContentVersion(await handle.stat({ bigint: true })) !== version) {
      return nativeUnavailable('the conversation changed during its handoff read')
    }
    proof.verify(nativeFileKey(before)); verifyNativePathFacts(route)
    if (nativeContentVersion(await handle.stat({ bigint: true })) !== version) {
      return nativeUnavailable('the conversation changed during final handoff verification')
    }
    return { turns, witness: { ownerAgentId, engine, sessionId: source.sessionId, path, readPath: location.path,
      profile, cwd, fileKey: nativeFileKey(before), version, route } }
  } catch (error) {
    if ((error as { code?: string })?.code === 'IDENTITY_UNAVAILABLE' || (error as { code?: string })?.code === 'DEADLINE') throw error
    return nativeUnavailable('the native conversation could not be read for handoff')
  } finally {
    if (handle) { try { await handle.close() } catch { nativeUnavailable('the native conversation descriptor could not be closed') } }
  }
}
