/** Data and ports shared by native launch authority and the optional setup process. */
import type { AgentEngine } from '../types.js'
import type { NativeExecutableSnapshot } from './versionData.js'
import type { NativeHookCandidate, NativeHookInput } from './nativeHookWire.js'
import type { NativeTrustInput } from './nativeTrustWire.js'
import type { LaunchSettingsInput, LaunchSettingsCandidate } from './launchSettingsWire.js'
import type { createNativeInstallations } from './nativeInstall.js'

export type NativeProbeKind = 'help' | 'version' | 'versionHelp' | 'runtime'
export interface NativeProbeOutput { code: number; stdout: string; stderr: string }
export interface NativeSetupProbes {
  probe(executable: NativeExecutableSnapshot, kind: NativeProbeKind, environment: Readonly<Record<string, string>>): Promise<NativeProbeOutput | null>
  opencodeMajor(): Promise<number | null>
  hermesKeepsRecord(executable?: { command: string }, environment?: Readonly<Record<string, string>>): Promise<boolean | null>
}
export interface NativeSetup extends NativeSetupProbes {
  /** Optional on an older setup process; absence holds required hook preparation. */
  prepareFiles?(input: NativeHookInput, request: string, current: () => boolean): Promise<NativeHookCandidate | null>
  /** Component-owned optional snapshot. The local commit callback never crosses the process boundary. */
  prepareSettings?(input: LaunchSettingsInput, request: string, current: () => boolean,
    commit?: () => Promise<boolean>): Promise<LaunchSettingsCandidate | null>
  /** Optional: absence preserves the engine's own folder/MCP question. */
  prepareTrust?(input: NativeTrustInput, request: string, current: () => boolean): Promise<NativeHookCandidate | null>
  downloading(engine: AgentEngine): Promise<boolean>
  installations: ReturnType<typeof createNativeInstallations>
}
