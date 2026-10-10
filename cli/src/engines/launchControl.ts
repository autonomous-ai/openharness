/** Eager native launch control. Importing it neither probes a binary nor reads or writes a store. */
import { opencodeBinAsync } from '../lib/engineBin.js'
import { OPENCODE_SESSION_MODEL, OPENCODE_VERSION } from './opencode/contract.js'
import { majorVersion, nativeVersionProbe, parseMajor, type VersionProbe } from './kit/nativeVersion.js'
import { createSessionModelControl, type NativeApiRun, type NativeModelResult, type NativeSessionModel, type NativeModelAuthority } from './kit/nativeSessionModel.js'
export { isOpencodeV2 } from './opencode/contract.js'

export type OpencodeVersionProbe = VersionProbe
const versionMemo = new Map<string, number | null>()
export const parseOpencodeMajor = (output: string): number | null => parseMajor(OPENCODE_VERSION, output)
export async function opencodeMajorVersion(probe?: VersionProbe, memo = versionMemo): Promise<number | null> {
  if (!probe) {
    const binary = await opencodeBinAsync()
    probe = nativeVersionProbe(OPENCODE_VERSION, () => binary)
  }
  return majorVersion(OPENCODE_VERSION, probe, memo)
}

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
