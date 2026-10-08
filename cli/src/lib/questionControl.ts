import type { QuestionStep } from '../engines/facets/questionControl.js'
import type { RegisteredSession } from './registry.js'

/** Bound once for the complete answer, before any screen read or terminal write. */
export interface QuestionControlSession { apply(step: QuestionStep): Promise<boolean> }
export type QuestionControlFor = (session: RegisteredSession) => QuestionControlSession | undefined
