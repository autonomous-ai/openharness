/** The usage service alone owns transcript/SQLite reads and private checkpoints. */
import { AgentTokenUsageCache } from '../lib/agentTokenUsage.js'
import { usageSnapshot, usageTarget, validUsage, validUsageTarget } from '../lib/agentUsageWire.js'

export function createAgentUsage(...args: ConstructorParameters<typeof AgentTokenUsageCache>) {
  const cache = new AgentTokenUsageCache(...args)
  return {
    async read(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!validUsageTarget(payload.target)) return { error: 'INVALID_USAGE_TARGET' }
      const target = usageTarget(payload.target)
      const reading = await cache.read(target).then(value => ({ value }), () => null)
      if (!reading) return { error: 'USAGE_UNAVAILABLE' }
      const { value } = reading
      return validUsage(value) ? { target, value: usageSnapshot(value) } : { error: 'INVALID_USAGE_READING' }
    },
    stop: () => cache.dispose(),
  }
}
