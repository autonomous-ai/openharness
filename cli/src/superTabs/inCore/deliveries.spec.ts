import { expect, it } from 'vitest'
import { typesWhileBusy } from './deliveries.js'

it('queues the Swarm\'s own chat deliveries while an agent works, and no other maker\'s', () => {
  expect(typesWhileBusy('team:service:superTabs:assignment-1')).toBe(true)
  for (const other of ['team:peer', 'team:service:orchestrator:1', 'wifi:1', 'team:service:superTabsX', '']) expect(typesWhileBusy(other), other).toBe(false)
})
