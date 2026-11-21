// Tier A's steps on the ChatGPT app's Codex home: its threads, its sidebar and Codex's names (Task 11 builds it).
import { StepNotBuilt } from '../../types.js'
import type { StepHandler } from '../world.js'

export const codexStoreSteps: { 'codex.write': StepHandler<'codex.write'> } = {
  'codex.write': async () => { throw new StepNotBuilt('codex.write', 'a') },
}
