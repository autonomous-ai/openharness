import { expect, it } from 'vitest'
import { machineShareGrant, nextMachineShareGrants } from './machineSharePolicy.js'

it('keeps continuing grants while rotating a removed and restored email or domain', () => {
  const first = { id: 'share', emails: ['a@team.test', 'b@team.test'], domain: 'team.test', grantVersions: null }
  const a = machineShareGrant(first, 'a@team.test'), b = machineShareGrant(first, 'b@team.test')
  const domain = machineShareGrant(first, 'c@team.test')
  const same = { ...first, grantVersions: nextMachineShareGrants(first, first.emails, first.domain) }
  expect(machineShareGrant(same, 'a@team.test')).toBe(a)
  expect(machineShareGrant(same, 'c@team.test')).toBe(domain)
  const removed = { ...same, emails: ['b@team.test'], domain: null, grantVersions: nextMachineShareGrants(same, ['b@team.test'], null) }
  expect(machineShareGrant(removed, 'a@team.test')).toBeNull()
  const restored = { ...first, grantVersions: nextMachineShareGrants(removed, first.emails, first.domain) }
  expect(machineShareGrant(restored, 'a@team.test')).not.toBe(a)
  expect(machineShareGrant(restored, 'b@team.test')).toBe(b)
  expect(machineShareGrant(restored, 'c@team.test')).not.toBe(domain)
  expect(nextMachineShareGrants(null, ['a@team.test'], null)).toHaveProperty('email:a@team.test')
})
