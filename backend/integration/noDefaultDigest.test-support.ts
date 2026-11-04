// Setup of the Super Tab integration runner (vitest.super-tabs.config.ts): a project's default morning digest stays off.
// It is due from 08:00 to 09:00 Vietnam time (digest.ts), so on the real clock every Lead's poll in that hour got one more
// message, and tests that count them failed daily, whatever the pull request (superTabDigestHour.test.ts). A digest a test
// sets with project.digest still comes; a test about the default calls wantDefaultDigest() and sets its own clock.
import { beforeEach, vi } from 'vitest'
import { ledProject, type SwarmProject } from '../src/superTabs/projects.js'

const wanted = vi.hoisted(() => ({ default: false }))
export const wantDefaultDigest = (): void => { wanted.default = true }
beforeEach(() => { wanted.default = false })

const off = (project: SwarmProject) => !project.digest && !wanted.default

vi.mock('../src/superTabs/digest.js', async original => {
  const real = await original<typeof import('../src/superTabs/digest.js')>()
  return {
    ...real,
    digestDue: (...args: Parameters<typeof real.digestDue>) => off(args[0]) ? null : real.digestDue(...args),
    digestRequest: (...args: Parameters<typeof real.digestRequest>) => {
      const project = ledProject(args[0], args[1].id)
      return project && off(project) ? null : real.digestRequest(...args)
    },
  }
})
