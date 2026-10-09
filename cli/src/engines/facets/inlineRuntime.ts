import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeContext, RuntimeModelOption } from './runtime.js'
import type { CursorModelTarget } from '../cursor/profileReader.js'
import type { DevinModelTarget } from '../devin/runtimeProfile.js'
import type { HermesModelTarget } from '../hermes/runtimeProfile.js'
import type { CommandcodeModelTarget } from '../commandcode/runtimeProfile.js'
import type { OpencodeModelTarget } from '../opencode/runtimeProfile.js'
import type { KiloModelTarget } from '../kilo/runtimeProfile.js'

/** Optional observations only. State, control waiters and notifications stay with the eager owner. */
export interface InlineRuntimeContext extends RuntimeContext {
  session: RegisteredSession
  refreshConfig(silent?: boolean): void
}
export interface InlineRuntimeReaderBase {
  transcript?(context: InlineRuntimeContext, record: Record<string, unknown>): void
  /** False means this screen must not participate in observation/confirmation. */
  pane?(context: InlineRuntimeContext, text: string): void | false
  /** False means a warm-up or unavailable read, with no state contribution. */
  config?(context: InlineRuntimeContext): Promise<boolean>
  models?(context: InlineRuntimeContext): Promise<RuntimeModelOption[]>
  forget?(sessionId: string): void
}
export type InlineRuntimeReader = InlineRuntimeReaderBase & (
  | { engine: 'cursor'; target(sessionId: string, profileId: string): CursorModelTarget | null }
  | { engine: 'devin'; target(sessionId: string, profileId: string): DevinModelTarget | null }
  | { engine: 'hermes'; target(sessionId: string, profileId: string): HermesModelTarget | null }
  | { engine: 'commandcode'; target(sessionId: string, profileId: string): CommandcodeModelTarget | null }
  | { engine: 'opencode'; catalog(): Promise<OpencodeModelTarget[]> }
  | { engine: 'kilo'; catalog(): Promise<KiloModelTarget[]> }
  | { engine: 'pi' | 'grok' | 'agy' | 'amp' | 'muse' | 'copilot' }
)
