/**
 * The line a session starts with, and `runStart` as the plugin's SessionStart hook runs it: Harness's own dial skill
 * looked for in throwaway agent homes, the hook's input handed as stdin. The person's ~/.claude and ~/.codex are never
 * touched.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DIAL_SKILL, DIAL_SKILL_DESCRIPTION, skillsFolderOf, writeSkill } from '../devices/dialSkill.js'
import { DIAL_START_LINE, ownSkillIn, runStart, startOutput } from './start.js'

const LINE = 'The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, run `harness device notify "[the ask]" --suggest "[your pick]" --waiting` (or `--proceeding` when you go on). Not for finished work or progress. The dial skill has the rest.'
/** The skill 0.6.58 wrote, with its marker line: homes still hold it. */
const OLD_SKILL = '---\nname: dial\ndescription: older\n# Written by Harness. Turn off the agent in Harness Device to remove it.\n---\n\nOlder.\n'
/** A person's own dial skill: no marker line. */
const PERSONS = '---\nname: dial\ndescription: mine\n---\n\nMine.\n'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'start-'))
  cleanup.push(dir)
  return dir
}

/** [text] at the dial skill's path in [home]. */
function skillIn(home: string, text: string): void {
  mkdirSync(join(home, 'skills', 'dial'), { recursive: true })
  writeFileSync(join(home, 'skills', 'dial', 'SKILL.md'), text)
}

async function* chunks(...parts: string[]): AsyncIterable<string> {
  yield* parts
}

describe('the line', () => {
  it('the line is the spec\'s, word for word', () => {
    expect(DIAL_START_LINE).toBe(LINE)
  })

  it('the line is at most 300 characters of printable ASCII on one line, with the command, both flags and the moment', () => {
    expect(DIAL_START_LINE.length).toBeLessThanOrEqual(300)
    expect(DIAL_START_LINE).toMatch(/^[\x20-\x7e]+$/)
    for (const part of ['harness device notify', '--suggest', '--waiting', '--proceeding', 'leaves them something to decide, answer or do']) {
      expect(DIAL_START_LINE).toContain(part)
    }
    expect(DIAL_START_LINE).not.toMatch(/[<>]/)
  })

  it('the line and the dial skill\'s description agree: the same command, flags and moment', () => {
    for (const part of ['harness device notify "[the ask', '--suggest "[your pick]"', '--waiting', '--proceeding', 'decide, answer or do', 'Not for finished work or progress.']) {
      expect(DIAL_SKILL_DESCRIPTION).toContain(part)
      expect(DIAL_START_LINE).toContain(part)
    }
  })

  it('startOutput is the SessionStart JSON on one line', () => {
    expect(startOutput()).not.toContain('\n')
    expect(JSON.parse(startOutput())).toStrictEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: DIAL_START_LINE } })
  })
})

describe('ownSkillIn', () => {
  it('is true for Harness\'s skill in the home', () => {
    const home = folder()
    expect(writeSkill(skillsFolderOf(home, true)!)).toBe('written')
    expect(ownSkillIn(home)).toBe(true)
  })

  it('is true for an older release\'s text, by its marker line', () => {
    const home = folder()
    skillIn(home, OLD_SKILL)
    expect(ownSkillIn(home)).toBe(true)
  })

  // An Orca profile's skills/ links to ~/.claude/skills.
  it.skipIf(process.platform === 'win32')('is true through a skills/ that links to another home\'s folder', () => {
    const other = folder()
    skillIn(other, DIAL_SKILL)
    const home = folder()
    symlinkSync(join(other, 'skills'), join(home, 'skills'))
    expect(ownSkillIn(home)).toBe(true)
  })

  it.each<[string, (home: string) => void]>([
    ['no skills/', () => {}],
    ['no dial/', (home) => mkdirSync(join(home, 'skills'))],
    ['the person\'s own SKILL.md without the marker', (home) => skillIn(home, PERSONS)],
    ['the skill as CRLF', (home) => skillIn(home, DIAL_SKILL.replaceAll('\n', '\r\n'))],
    ['skills a file', (home) => writeFileSync(join(home, 'skills'), 'not a folder')],
    ['a skill in another home only', () => skillIn(folder(), DIAL_SKILL)],
  ])('is false: %s', (_name, arrange) => {
    const home = folder()
    arrange(home)
    expect(ownSkillIn(home)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('is false for a link at dial/SKILL.md to Harness\'s text', () => {
    const other = folder()
    skillIn(other, DIAL_SKILL)
    const home = folder()
    mkdirSync(join(home, 'skills', 'dial'), { recursive: true })
    symlinkSync(join(other, 'skills', 'dial', 'SKILL.md'), join(home, 'skills', 'dial', 'SKILL.md'))
    expect(ownSkillIn(home)).toBe(false)
  })
})

describe('runStart', () => {
  const project = () => folder()
  const START_INPUT = (cwd: string) => ({ session_id: 's-1', hook_event_name: 'SessionStart', source: 'startup', cwd })

  async function start(stdin: AsyncIterable<string>, options: { dataDir?: string; acts?: () => boolean; out?: (line: string) => void } = {}) {
    const out: string[] = []
    const code = await runStart({
      stdin, dataDir: options.dataDir ?? folder(), acts: options.acts ?? (() => true),
      out: options.out ?? ((line) => { out.push(line) }),
    })
    return { code, out }
  }

  it('prints the line once when the plugin acts', async () => {
    expect(await start(chunks(JSON.stringify(START_INPUT(project()))))).toEqual({ code: 0, out: [startOutput()] })
  })

  it('prints nothing when the plugin does not act', async () => {
    expect(await start(chunks(JSON.stringify(START_INPUT(project()))), { acts: () => false })).toEqual({ code: 0, out: [] })
  })

  it('prints nothing and returns 0 when acts throws', async () => {
    expect(await start(chunks(JSON.stringify(START_INPUT(project()))), { acts: () => { throw new Error('unreadable') } }))
      .toEqual({ code: 0, out: [] })
  })

  it('returns 0 when out throws', async () => {
    expect(await start(chunks(JSON.stringify(START_INPUT(project()))), { out: () => { throw new Error('EPIPE') } }))
      .toEqual({ code: 0, out: [] })
  })

  // Harness's own one-shots (the voice router, the window names) run in the data folder.
  it.each<[string, (dataDir: string) => string]>([
    ['the data folder itself', (dataDir) => dataDir],
    ['the voice router\'s one-shots', (dataDir) => join(dataDir, 'voice-route-scratch')],
    ['the window names\' one-shots', (dataDir) => join(dataDir, 'window-names-scratch')],
  ])('prints nothing for a session in %s', async (_name, cwdOf) => {
    const dataDir = folder()
    expect(await start(chunks(JSON.stringify(START_INPUT(cwdOf(dataDir)))), { dataDir })).toEqual({ code: 0, out: [] })
  })

  it('prints the line for a folder beside the data folder whose name starts with it', async () => {
    const dataDir = folder()
    expect(await start(chunks(JSON.stringify(START_INPUT(`${dataDir}-other`))), { dataDir })).toEqual({ code: 0, out: [startOutput()] })
  })

  it.each<[string, () => AsyncIterable<string>]>([
    ['not JSON', () => chunks('{"cwd":')],
    ['a JSON array', () => chunks(JSON.stringify([START_INPUT('/repo')]))],
    ['an object without cwd', () => chunks(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))],
    ['a cwd that is not a string', () => chunks(JSON.stringify({ hook_event_name: 'SessionStart', cwd: 7 }))],
    ['over 256 KiB', () => chunks(JSON.stringify({ ...START_INPUT('/repo'), pad: 'x'.repeat(256 * 1024) }))],
  ])('prints nothing for input that is %s', async (_name, stdin) => {
    expect(await start(stdin())).toEqual({ code: 0, out: [] })
  })
})

// The eval runs the variant against a fake harness, so its answer must be this command's output byte for byte.
describe('the eval', () => {
  const V3 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'dial-skill', 'flow', 'v3')

  it('the eval\'s Part 4 variant answers exactly what this command prints', () => {
    const answers = JSON.parse(readFileSync(join(V3, 'harness-answers.json'), 'utf8')) as { argv: string[], stdout?: string, stderr?: string, code?: number }[]
    expect(answers.filter((answer) => answer.argv.join(' ') === 'device claude start'))
      .toEqual([{ argv: ['device', 'claude', 'start'], stdout: `${startOutput()}\n` }])
    const hooks = JSON.parse(readFileSync(join(V3, 'hooks.json'), 'utf8')) as Record<string, { matcher: string, hooks: { command: string }[] }[]>
    expect(hooks.SessionStart).toHaveLength(1)
    expect(hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact')
    expect(hooks.SessionStart[0].hooks.map((hook) => hook.command)).toEqual(['harness device claude start'])
  })
})
