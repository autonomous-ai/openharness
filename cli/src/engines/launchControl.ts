/** Eager native launch control. Importing it neither probes a binary nor reads or writes a store. */
import { opencodeBinAsync } from '../lib/engineBin.js'
import { sqliteReadAll } from '../lib/sqliteRead.js'
import { OPENCODE_SESSION_MODEL, OPENCODE_V2_TURN } from './opencode/contract.js'
import type { NativeExecutableSnapshot } from './kit/versionData.js'
import { createSessionModelControl, type NativeApiRun, type NativeModelResult, type NativeSessionModel, type NativeModelAuthority } from './kit/nativeSessionModel.js'
export { isOpencodeV2 } from './opencode/contract.js'

/** Whether OpenCode 2 session [sessionId] is in a turn, read from [dbPath] (`OPENCODE_V2_TURN`). Null when
 *  the store cannot be read. */
export async function opencodeV2TurnOpen(dbPath: string, sessionId: string): Promise<boolean | null> {
  if (!OPENCODE_SESSION_MODEL.id.test(sessionId)) return null
  const result = await sqliteReadAll(dbPath, OPENCODE_V2_TURN.sql, [sessionId])
  if (!result.ok) return null
  return result.rows[0]?.type === OPENCODE_V2_TURN.opens
}

export interface OpencodeLaunchSnapshot extends NativeExecutableSnapshot { major: number }

export type OpencodeSessionModel = NativeSessionModel
export type SetOpencodeSessionModelResult = NativeModelResult
export type OpencodeApiRun = NativeApiRun
const model = createSessionModelControl(OPENCODE_SESSION_MODEL, opencodeBinAsync)
export const opencodeModelFromArgv = model.modelFromArgv
export const parseOpencodeModelId = model.parseModelId
export const setOpencodeSessionModel = model.setSessionModel
export const switchOpencodeSessionModel = model.switchSessionModel
export function applyOpencodeSessionModel(
  input: { opencodeMajor: number | null | undefined; dbPath: string; sessionId: string; model: NativeSessionModel; cwd?: string; checkCatalog?: boolean },
  deps: { run?: NativeApiRun; retryDelayMs?: number } & NativeModelAuthority = {},
): Promise<NativeModelResult> { return model.applySessionModel({ ...input, major: input.opencodeMajor }, deps) }
