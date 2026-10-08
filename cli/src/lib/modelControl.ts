import type { ModelControlCheck, ModelControlInput } from '../engines/facets/modelControl.js'
import type { RegisteredSession } from './registry.js'

/** Bound before the controller's first await. No worker owns the transaction or its input lease. */
export interface ModelControlSession {
  validate(check: Omit<ModelControlCheck, 'session' | 'catalog'>): Promise<void>
  apply(input: Omit<ModelControlInput, 'session' | 'catalog'>): Promise<void>
}
export type ModelControlFor = (session: RegisteredSession) => ModelControlSession | undefined
