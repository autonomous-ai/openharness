import { describe, expect, it } from 'vitest'
import { SWARM_TOOLS_SKILL } from './swarmTools.js'
import { CHEAP_FIRST_HELP, ROUTE_KIND_HELP } from '../superTabs/routeCheapFirst.js'

describe('SWARM_TOOLS_SKILL', () => {
  it('describes the commands and no workflow', () => {
    expect(SWARM_TOOLS_SKILL.startsWith('---\nname: swarm-tools\n')).toBe(true)
    for (const part of ['post GROUP', '--to AGENT', 'instructions', 'work.status', 'route GROUP', '## Reactions']) {
      expect(SWARM_TOOLS_SKILL).toContain(part)
    }
    expect(SWARM_TOOLS_SKILL).not.toMatch(/\b(Product Manager|Builder|Reviewer|Engineer|Tester|Lead)\b/)
    expect(SWARM_TOOLS_SKILL).not.toMatch(/never merge|your own work|only you/i)
    expect(Buffer.byteLength(SWARM_TOOLS_SKILL)).toBeLessThan(24 * 1024)
  })
  // Project instructions, phase 4: the server refuses only facts and access, routing rules live in the instructions, and
  // agents change the instructions instead of rules or skill sets.
  it('describes the commands the server accepts now', () => {
    expect(SWARM_TOOLS_SKILL).not.toMatch(/Refused to some agents|route first|hard rules|rated 3|rule\.set|project\.skills/)
    for (const part of ['post GROUP', '--to AGENT', 'instructions', 'instructions.save']) expect(SWARM_TOOLS_SKILL).toContain(part)
  })
  // Final review: what the skill says the server does must be what it does.
  const lineOf = (needle: string) => SWARM_TOOLS_SKILL.split('\n').find(line => line.includes(needle)) ?? ''
  it('says which kinds of work may go to the grid, from the same text as the route\'s help', () => {
    expect(SWARM_TOOLS_SKILL).toContain(`"kind":"${ROUTE_KIND_HELP}"`)
    expect(SWARM_TOOLS_SKILL).toContain(CHEAP_FIRST_HELP)
    expect(SWARM_TOOLS_SKILL).not.toContain('leaves out only')
  })
  it('has the reviewing agent named with --to, since a review status tells only the group\'s coordinator', () => {
    expect(SWARM_TOOLS_SKILL).not.toContain('so it is told when that work is ready for review')
    expect(lineOf('`reviewOf` naming')).toMatch(/--to/)
  })
  it('tells an older Swarm\'s answer from a passing failure, and a stale save from one that hands text back', () => {
    expect(lineOf('INSTRUCTIONS_UNAVAILABLE')).toMatch(/no project instructions yet/)
    expect(lineOf('INSTRUCTIONS_UNAVAILABLE')).toMatch(/try again/i)
    expect(lineOf('INSTRUCTIONS_STALE')).not.toMatch(/hands back/)
    expect(lineOf('INSTRUCTIONS_STALE')).toMatch(/read `instructions` again/)
  })
  it('says who may save the instructions and keep notes, as the server allows', () => {
    expect(lineOf('"type":"instructions.save"')).toMatch(/only the project's coordinator/)
    expect(lineOf('"type":"note.add"')).toMatch(/only the project's coordinator/i)
    expect(lineOf('"type":"note.remove"')).toMatch(/coordinator/)
  })
})
