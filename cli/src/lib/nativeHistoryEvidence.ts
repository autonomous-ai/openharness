/** Native file deletion has the same identity bar as control, but can intentionally remove a workspace. */
import { basename, dirname, isAbsolute, join } from 'node:path'
import { lstatSync, type BigIntStats } from 'node:fs'
import { controlTranscriptEvidence, savedTranscriptEvidence } from '../engines/transcriptBindings.js'
import { PI_CONTROL_IDENTITY } from '../engines/pi/contract.js'
import { NativeFiles } from '../engines/kit/nativeFiles.js'
import { nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { nativeFileKey } from '../engines/kit/nativePaths.js'
import type { AgentEngine } from '../engines/types.js'

export type NativeHistoryFile = { path: string; dev: bigint; ino: bigint; bytes: number; verify(): void }
type RemovedWorktree = { path: string; dev: number; ino: number }
export interface NativeHistoryProof {
  path: string
  verify(openedFileKey?: string): void
  /** Prepare before removal; invoke its completion only after the reviewed worktree was removed. */
  prepareWorkspaceRemoval?(worktree: RemovedWorktree): () => void
}

/** The canonical pathname and its exact file identity come from the same verified route. */
export function nativeHistoryFile(path: string): NativeHistoryFile {
  let leaf: BigIntStats
  try { leaf = lstatSync(path, { bigint: true }) }
  catch { return nativeUnavailable('the native conversation could not be inspected') }
  const files = new NativeFiles(), target = files.file(path)!, info = target.info
  if (!leaf.isFile() || leaf.nlink !== 1n || info.nlink !== 1n || nativeFileKey(leaf) !== nativeFileKey(info)) {
    return nativeUnavailable('the native conversation is not a private regular file')
  }
  files.verify(path)
  return { path: target.path, dev: info.dev, ino: info.ino,
    bytes: Number.isFinite(Number(info.blocks)) ? Number(info.blocks) * 512 : Number(info.size),
    verify: () => files.verify(path) }
}

export function nativeHistoryEvidence(engine: AgentEngine, id: string, path: string,
  profile?: string, cwd?: string | null,
): NativeHistoryProof {
  if (engine !== 'pi') return controlTranscriptEvidence(engine, id, path, profile, cwd)
  if (!cwd || !isAbsolute(cwd)) return nativeUnavailable('the reviewed conversation workspace is unavailable')
  let removed: { path: string; verifyAncestors(): void } | undefined
  const read = (previousOpeningCwd?: string) => {
    const proof = savedTranscriptEvidence(engine, id, path, profile), files = new NativeFiles()
    if (!proof.path) return nativeUnavailable('the saved conversation file is unavailable')
    const head = files.opening(proof.path, PI_CONTROL_IDENTITY)
    if (head.fileKey !== proof.fileKey || head.id !== id || head.delegated) {
      return nativeUnavailable('the reviewed conversation opening changed identity')
    }
    const expected = files.locate(cwd, true), actual = files.locate(head.cwd, true)
    if (expected || actual) {
      if (!expected?.info.isDirectory() || !actual?.info.isDirectory()
        || nativeFileKey(expected.info) !== nativeFileKey(actual.info)) return nativeUnavailable('the reviewed conversation workspace does not match')
    } else if (previousOpeningCwd !== undefined) {
      if (head.cwd !== previousOpeningCwd) return nativeUnavailable('the removed conversation workspace changed')
    } else {
      // A new explicit review may clean up history after its workspace was removed. It requires
      // a proven absent leaf under an owned, present parent; a dangling alias is not that proof.
      if (head.cwd !== cwd) return nativeUnavailable('the absent conversation workspace cannot be matched')
      const parent = files.locate(dirname(cwd), true)
      if (!parent?.info.isDirectory() || !files.paths.absentLeaf(join(parent.path, basename(cwd)))
        || process.getuid && parent.info.uid !== BigInt(process.getuid())) {
        return nativeUnavailable('the conversation workspace is not a proven absent leaf')
      }
    }
    files.verify(proof.path); proof.verify()
    return { path: proof.path, fileKey: proof.fileKey, workspaceKey: expected ? nativeFileKey(expected.info) : null,
      openingCwd: head.cwd }
  }
  const before = read()
  const verify = (openedFileKey?: string) => {
    const after = read(removed ? before.openingCwd : undefined)
    if (after.path !== before.path || after.fileKey !== before.fileKey || after.openingCwd !== before.openingCwd
      || openedFileKey !== undefined && openedFileKey !== before.fileKey) return nativeUnavailable('the reviewed native history was replaced')
    if (!removed) {
      if (after.workspaceKey !== before.workspaceKey) return nativeUnavailable('the reviewed conversation workspace was replaced')
      return
    }
    const files = new NativeFiles()
    if (after.workspaceKey !== null || files.locate(removed.path, true) || !files.paths.absentLeaf(removed.path)) {
      return nativeUnavailable('the removed worktree was recreated or cannot be confirmed absent')
    }
    files.verify(); removed.verifyAncestors()
  }
  return { path: before.path, verify, prepareWorkspaceRemoval(worktree) {
    verify()
    const files = new NativeFiles(), root = files.locate(worktree.path)!, workspace = files.locate(cwd)!
    files.locate(before.openingCwd)
    if (!root.info.isDirectory() || nativeFileKey(root.info) !== `${worktree.dev}:${worktree.ino}`
      || nativeFileKey(workspace.info) !== before.workspaceKey
      || nativeFileKey(workspace.info) !== nativeFileKey(root.info) && !files.paths.within(workspace.path, [root.info])) {
      return nativeUnavailable('the reviewed worktree does not own the conversation workspace')
    }
    files.verify()
    const permission = { path: root.path, verifyAncestors: files.paths.retainOutside(root.path) }
    return () => { removed = permission; verify() }
  } }
}
