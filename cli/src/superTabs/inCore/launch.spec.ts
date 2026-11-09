import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SWARM_LAUNCH } from './launch.js'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

it('lets a start ask for the three role kinds and two skill modes, and nothing else', () => {
  // The wire's older values (lead, dev, review) are read into kinds before this check (core/agents/launches.ts roleFromWire).
  for (const role of ['coordinator', 'agent', 'buddy']) expect(SWARM_LAUNCH.role(role), role).toBe(true)
  for (const role of ['lead', 'dev', 'review', 'builder', '', 7, null, undefined]) expect(SWARM_LAUNCH.role(role), String(role)).toBe(false)
  for (const mode of ['default', 'orchestration']) expect(SWARM_LAUNCH.mode(mode), mode).toBe(true)
  for (const mode of ['light', 7, null]) expect(SWARM_LAUNCH.mode(mode), String(mode)).toBe(false)
})

// Swarm v4: no skill file and no launch line; the engine starts plain and reads only the repo's own files.
it('tells the engine nothing at launch', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'swarm-launch-'))
  folders.push(cwd)
  const { instructions } = SWARM_LAUNCH.prepare(cwd, { role: 'agent', fallback: 'review', key: 'harness-claude-1' })
  expect(instructions).toBe('')
  expect(() => SWARM_LAUNCH.prepare(cwd, { role: 'agent', fallback: 'review', key: '' })).toThrow('A Swarm skill needs a role and session key')
})
