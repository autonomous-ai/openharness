/**
 * The Swarm's chat messages, as the core writes them into an agent (core/input.ts `typesWhileBusy`): queued in the
 * engine's own input while the agent works, where the engine takes them (Claude Code and Codex), instead of waiting for
 * idle as Agent Messages' do. Under the same draft and dialog checks, behind the pane's writer lock.
 */
const SWARM_DELIVERY = 'team:service:superTabs:'

export const typesWhileBusy = (deliveryId: string): boolean => deliveryId.startsWith(SWARM_DELIVERY)
