/**
 * A fake core as the Swarm's service holds it (superTabs/ownAgents.ts): its own closes and reopens of its agents beside
 * what the core offers every service, any of them replaced through `over` as in `fakeCore`.
 */
import type { SwarmCore } from '../superTabs/ownAgents.js'
import { fakeCore } from './fakeCore.js'

type Overrides = NonNullable<Parameters<typeof fakeCore>[0]> & { agents?: Partial<SwarmCore['agents']> }

export const fakeSwarmCore = (over: Overrides = {}): SwarmCore => fakeCore(over) as SwarmCore
