// Tier A's step of speaking to the dial (Task 14 builds it).
import { StepNotBuilt } from '../../types.js'
import type { StepHandler } from '../world.js'

export const voiceSteps: { voice: StepHandler<'voice'> } = {
  voice: async () => { throw new StepNotBuilt('voice', 'a') },
}
