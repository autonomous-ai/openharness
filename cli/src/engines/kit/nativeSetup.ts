/** Data and ports shared by native launch authority and the optional setup process. */
import type { AgentEngine } from '../types.js'
import type { NativeExecutableSnapshot } from './versionData.js'
import type { createNativeInstallations } from './nativeInstall.js'

export type NativeProbeKind = 'help' | 'version' | 'versionHelp' | 'runtime'
export interface NativeProbeOutput { code: number; stdout: string; stderr: string }
export interface NativeSetupProbes {
  probe(executable: NativeExecutableSnapshot, kind: NativeProbeKind, environment: Readonly<Record<string, string>>): Promise<NativeProbeOutput | null>
  opencodeMajor(): Promise<number | null>
  hermesKeepsRecord(executable?: { command: string }, environment?: Readonly<Record<string, string>>): Promise<boolean | null>
}
export interface NativeSetup extends NativeSetupProbes {
  downloading(engine: AgentEngine): Promise<boolean>
  installations: ReturnType<typeof createNativeInstallations>
}
