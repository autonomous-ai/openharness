import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeCatalogModel, RuntimeContext, RuntimeModelOption } from './runtime.js'
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
/** Their transcripts' records are read in the other engines' worker, which hands the core only what each says of the
 *  profile (facets/runtime.ts `ProfileEvidence`): a reader here reads the pane and the configuration. */
export interface InlineRuntimeReaderBase {
  /** False means this screen must not participate in observation/confirmation. */
  pane?(context: InlineRuntimeContext, text: string): void | false
  /** False means a warm-up or unavailable read, with no state contribution. */
  config?(context: InlineRuntimeContext): Promise<boolean>
  modelCatalog?(session: RegisteredSession): Promise<RuntimeCatalogModel[]>
  models?(context: InlineRuntimeContext): Promise<RuntimeModelOption[]>
  /** Whether a pick from [models] can be driven into this session's pane; none can where this is absent. */
  supportsControl?(session: RegisteredSession): boolean
  forget?(sessionId: string): void
}
export type InlineRuntimeReader = InlineRuntimeReaderBase & (
  | { engine: 'cursor'; target(sessionId: string, profileId: string): CursorModelTarget | null }
  | { engine: 'devin'; target(sessionId: string, profileId: string): DevinModelTarget | null }
  | { engine: 'hermes'; target(sessionId: string, profileId: string): HermesModelTarget | null }
  | { engine: 'commandcode'; target(sessionId: string, profileId: string): CommandcodeModelTarget | null }
  | { engine: 'opencode'; catalog(cwd?: string | null): Promise<OpencodeModelTarget[]> }
  | { engine: 'kilo'; catalog(): Promise<KiloModelTarget[]> }
  | { engine: 'pi' | 'grok' | 'agy' | 'amp' | 'muse' | 'copilot' | 'omp' | 'openclaw' }
)
