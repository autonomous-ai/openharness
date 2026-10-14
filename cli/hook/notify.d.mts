import type { RegisteredSession } from '../src/lib/registry.js'
export type NativeNotifyRuntime = Pick<RegisteredSession, 'agentId' | 'engine' | 'active' | 'processIdentity' | 'runtimes' | 'primaryRuntimeKey'>
export interface NativeNotifyContext {
  input: Record<string, unknown>
  event: string
  port: number
  tmuxPane: string
  dataDir: string
  credential: string
  id: string
  firedAt: number
  callerPid: number
  timeoutMs: number
  runtime?: NativeNotifyRuntime
}
export function runNotify(options: {
  nativeCursor(context: NativeNotifyContext): Promise<void>
  captureNativeRuntime(dataDir: string, pane: string): NativeNotifyRuntime | undefined
}): Promise<void>
