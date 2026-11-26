import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIAL_SKILL_DESCRIPTION } from '../../src/devices/dialSkill.js'
import { AGENT_CONFIG, claudeArgs, type AgentConfig } from './lib/agents.js'
import { matchesProbe, PROBE_PROMPT, probeArgs, probeFailure, probeListing, readListing, type Listing, type Probe } from './lib/probe.js'
import { loadScenarios, type Condition } from './lib/scenarios.js'
import { RUN_RESERVE_USD } from './lib/spend.js'
import type { StagedSkill } from './lib/stage.js'

const CROWD_SKILLS = { 'release-notes': 'Use when writing release notes: "what changed" first.', 'sql-style': 'Use when writing SQL.' }
const STAGED: StagedSkill[] = [
  ...Object.entries(CROWD_SKILLS).map(([name, description]) => ({ name, description })),
  { name: 'dial', description: DIAL_SKILL_DESCRIPTION },
]
const BUNDLED = '- update-config: Use this skill to configure the Claude Code harness via settings.json.'
const RULES = '# Team engineering rules'
// What a crash or a model would print: a machine path and model text, neither of which may reach a probe row.
const LEAK = 'I read /Users/someone/secret-project and decided'

let root: string
let profile: string
let crowd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dial-skill-probe-'))
  profile = join(root, 'profile')
  mkdirSync(join(profile, 'projects'), { recursive: true })
  crowd = join(root, 'crowd')
  mkdirSync(crowd)
  writeFileSync(join(crowd, 'instructions.md'), `${RULES}\n\nKeep functions small.\n`)
  for (const [name, description] of Object.entries(CROWD_SKILLS)) {
    mkdirSync(join(crowd, 'skills', name), { recursive: true })
    writeFileSync(join(crowd, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nSteps.\n`)
  }
  mkdirSync(join(root, 'runs'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** A saved transcript in the shape Claude Code writes it: the listing is an attachment event. */
function transcript(...listings: { content: string; isInitial: boolean }[]): string {
  const events = [
    { type: 'user', message: { role: 'user', content: 'Hi' } },
    ...listings.map(({ content, isInitial }) => ({
      type: 'attachment',
      attachment: { type: 'skill_listing', content, names: content.split('\n').map((l) => l.slice(2).split(':')[0]), skillCount: content.split('\n').length, isInitial },
    })),
  ]
  return events.map((e) => `${JSON.stringify(e)}\n`).join('')
}

function lines(dial: string | null, cut: string[] = []): string {
  return [
    BUNDLED,
    ...Object.entries(CROWD_SKILLS).map(([name, description]) => (cut.includes(name) ? `- ${name}` : `- ${name}: ${description}`)),
    ...(dial === null ? [] : [dial]),
  ].join('\n')
}

describe('readListing', () => {
  it.each([
    ['full', `- dial: ${DIAL_SKILL_DESCRIPTION}`],
    ['name-only', '- dial'],
    ['cut', `- dial: ${DIAL_SKILL_DESCRIPTION.slice(0, 40)}…`],
    ['absent', null],
  ] as const)('finds the dial %s', (dial, line) => {
    expect(readListing(transcript({ content: lines(line), isInitial: true }), STAGED)?.dial).toBe(dial)
  })

  it('counts the staged crowd skills listed without their full description', () => {
    const content = lines(`- dial: ${DIAL_SKILL_DESCRIPTION}`, ['release-notes', 'sql-style'])

    expect(readListing(transcript({ content, isInitial: true }), STAGED)).toMatchObject({ dial: 'full', cut: 2, skills: 4 })
  })

  it("takes the listing's length", () => {
    const content = lines(`- dial: ${DIAL_SKILL_DESCRIPTION}`)

    expect(readListing(transcript({ content, isInitial: true }), STAGED)).toEqual({ dial: 'full', skills: 4, cut: 0, chars: content.length })
  })

  it('reads the first initial listing, not a later one', () => {
    const text = transcript({ content: lines('- dial'), isInitial: true }, { content: lines(`- dial: ${DIAL_SKILL_DESCRIPTION}`), isInitial: true })

    expect(readListing(text, STAGED)?.dial).toBe('name-only')
  })

  it('reads null with no initial listing', () => {
    expect(readListing(transcript({ content: lines('- dial'), isInitial: false }), STAGED)).toBeNull()
    expect(readListing('', STAGED)).toBeNull()
  })
})

describe('probeFailure', () => {
  const listing = (over: Partial<Listing> = {}): Listing => ({ dial: 'full', skills: 40, cut: 0, chars: 19_000, ...over })
  const probe = (l: Listing | null, instructions: boolean | null): Omit<Probe, 'failure'> => ({
    condition: 'crowd', at: '2026-11-26T00:00:00.000Z', listing: l, instructions, skills: [], claude_version: '2.1.332', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 },
  })

  it.each([
    ['clean, the dial full, no project instructions given', 'clean', true, listing({ chars: 25_000 }), false, null],
    ['crowd, the dial full, CLAUDE.md given', 'crowd', true, listing(), true, null],
    ['crowd at 20,000 characters', 'crowd', true, listing({ chars: 20_000 }), true, null],
    ['name-only, the dial by name', 'name-only', true, listing({ dial: 'name-only' }), true, null],
    ['--no-skill, no dial', 'crowd', false, listing({ dial: 'absent' }), true, null],
    ['clean, the dial by name', 'clean', true, listing({ dial: 'name-only' }), false, 'dial name-only, expected full'],
    ['crowd, the dial cut', 'crowd', true, listing({ dial: 'cut' }), true, 'dial cut, expected full'],
    ['name-only, the dial full', 'name-only', true, listing(), true, 'dial full, expected name-only'],
    ['--no-skill, the dial listed', 'clean', false, listing(), false, 'dial full, expected absent'],
    ['crowd skills cut', 'crowd', true, listing({ cut: 3 }), true, '3 crowd skills cut'],
    ['one crowd skill cut', 'crowd', true, listing({ cut: 1 }), true, '1 crowd skill cut'],
    ['a crowd listing over 20,000', 'name-only', true, listing({ dial: 'name-only', chars: 20_001 }), true, 'listing over 20,000 characters'],
    ['CLAUDE.md not given', 'crowd', true, listing(), false, 'CLAUDE.md not given'],
    ['project instructions given in clean', 'clean', true, listing(), true, 'project instructions given'],
    ['no listing', 'clean', true, null, null, 'no skill listing'],
  ] as const)('%s', (_, condition, skill, l, instructions, failure) => {
    expect(probeFailure(probe(l, instructions), condition, skill)).toBe(failure)
  })
})

describe('probeArgs', () => {
  it("saves the session and stops after one turn, and is otherwise a run's arguments", () => {
    const st = { root, origin: null, condition: 'name-only' as Condition }
    const run = claudeArgs(AGENT_CONFIG, st, PROBE_PROMPT)

    const probe = probeArgs(AGENT_CONFIG, st)

    expect(probe).not.toContain('--no-session-persistence')
    expect(probe[probe.indexOf('--max-turns') + 1]).toBe('1')
    expect(probe).toEqual(run.filter((a) => a !== '--no-session-persistence').map((a, i, all) => (all[i - 1] === '--max-turns' ? '1' : a)))
  })
})

describe('probeListing', () => {
  const scenario = () => loadScenarios().find((s) => s.id === 'fix-off-by-one')!
  const marker = () => join(root, 'transcript-written')

  /** A `claude` that lists the staged skills as Claude Code does (the dial by name alone under the name-only
   *  override), saves the transcript under the profile, prints an init, then does `tail`. */
  function fakeClaude(tail: string): string {
    const file = join(root, 'claude')
    writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
if (argv.length === 0) process.exit(0)
const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
const lines = [${JSON.stringify(BUNDLED)}]
const names = ['update-config']
const skills = path.join(process.cwd(), '.claude', 'skills')
for (const name of fs.existsSync(skills) ? fs.readdirSync(skills).sort() : []) {
  const description = JSON.parse(/^description: (.*)$/m.exec(fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8'))[1])
  lines.push(settings.skillOverrides?.[name] === 'name-only' ? '- ' + name : '- ' + name + ': ' + description)
  names.push(name)
}
const id = '0b5c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3'
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(folder, { recursive: true })
const listing = { type: 'attachment', attachment: { type: 'skill_listing', content: lines.join('\\n'), names, skillCount: names.length, isInitial: true } }
fs.writeFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: argv[1] } }) + '\\n' + JSON.stringify(listing) + '\\n')
fs.writeFileSync(${JSON.stringify(marker())}, '')
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n')
emit({ type: 'system', subtype: 'init', session_id: id, skills: names, claude_code_version: '2.1.332' })
const rules = fs.existsSync('CLAUDE.md') ? fs.readFileSync('CLAUDE.md', 'utf8').split('\\n')[0] : 'NONE'
${tail}
`)
    chmodSync(file, 0o755)
    // macOS checks a new executable on its first exec, which must not eat into a short time-out.
    execFileSync(file)
    return file
  }

  const ANSWER = `emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: rules }] } })
emit({ type: 'result', subtype: 'success', is_error: false, result: rules, usage: { input_tokens: 9, output_tokens: 4 } })`

  function config(claudeBin: string, timeoutMs = 10_000): AgentConfig {
    return { ...AGENT_CONFIG, claudeBin, timeoutMs }
  }

  const sessionFolders = () => readdirSync(join(profile, 'projects'))

  it.each([
    ['clean', { dial: 'full', skills: 2 }, false],
    ['crowd', { dial: 'full', skills: 4, cut: 0 }, true],
    ['name-only', { dial: 'name-only', skills: 4, cut: 0 }, true],
  ] as const)('%s: returns the listing, the CLAUDE.md answer and the init, and leaves no session folder in the profile', async (condition, listing, instructions) => {
    const probe = await probeListing(scenario(), condition, { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(ANSWER)))

    expect(probe).toMatchObject({
      condition, listing, instructions, claude_version: '2.1.332', model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 4 }, failure: null,
    })
    expect(probe.skills).toContain('update-config')
    expect(Number.isNaN(Date.parse(probe.at))).toBe(false)
    expect(existsSync(marker())).toBe(true)
    expect(sessionFolders()).toEqual([])
  })

  it('fails a probe whose model does not quote the staged CLAUDE.md', async () => {
    const tail = ANSWER.replaceAll('text: rules', "text: 'NONE'").replace('result: rules', "result: 'NONE'")

    const probe = await probeListing(scenario(), 'crowd', { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(tail)))

    expect(probe).toMatchObject({ instructions: false, failure: 'CLAUDE.md not given' })
  })

  it('fails a clean probe whose model answers anything but NONE, as it was given project instructions from elsewhere', async () => {
    const tail = ANSWER.replaceAll('text: rules', "text: '# My own rules'").replace('result: rules', "result: '# My own rules'")

    const probe = await probeListing(scenario(), 'clean', { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(tail)))

    expect(probe).toMatchObject({ instructions: true, failure: 'project instructions given' })
  })

  it('removes the session folder when claude fails after writing it, and records error, never the message', async () => {
    const tail = `process.stderr.write(${JSON.stringify(LEAK)} + ' ' + process.cwd() + '\\n'); process.exitCode = 1`

    const probe = await probeListing(scenario(), 'crowd', { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(tail)))

    expect(probe.failure).toBe('error')
    expect(existsSync(marker())).toBe(true)
    expect(sessionFolders()).toEqual([])
    expect(JSON.stringify(probe)).not.toContain(root)
    expect(JSON.stringify(probe)).not.toContain('secret-project')
  })

  it('removes the session folder when it times out, and records timeout, never the message', async () => {
    const tail = `emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: ${JSON.stringify(LEAK)} }] } })
setTimeout(() => {}, 600_000)`

    const probe = await probeListing(scenario(), 'crowd', { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(tail), 3_000))

    expect(probe.failure).toBe('timeout')
    // Cut before its result event, its output is a floor: it is charged its reserve.
    expect(probe.cut_usd).toBe(RUN_RESERVE_USD)
    expect(existsSync(marker())).toBe(true)
    expect(sessionFolders()).toEqual([])
    expect(JSON.stringify(probe)).not.toContain('secret-project')
  })

  it('records error, keeping the model and usage it was billed, when the saved transcript cannot be read', async () => {
    // A folder where the transcript should be: reading it fails with EISDIR, whose message names the profile.
    const tail = `fs.rmSync(path.join(folder, id + '.jsonl'))
fs.mkdirSync(path.join(folder, id + '.jsonl'))
${ANSWER}`

    const probe = await probeListing(scenario(), 'crowd', { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(tail)))

    expect(probe).toMatchObject({ failure: 'error', model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 4 } })
    expect(sessionFolders()).toEqual([])
    expect(JSON.stringify(probe)).not.toContain(root)
  })

  it('throws account_limited with the usage at the account limit, and still removes the session folder', async () => {
    const tail = `emit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 6pm", usage: { input_tokens: 5, output_tokens: 1 } })
process.exitCode = 1`

    const error = await probeListing(scenario(), 'crowd', { skill: true, crowd, base: join(root, 'runs') }, config(fakeClaude(tail))).catch((e: unknown) => e)

    expect(error).toMatchObject({ failure_class: 'account_limited', usage: { input_tokens: 5, output_tokens: 1 } })
    expect(sessionFolders()).toEqual([])
  })

  it('refuses to probe in the default ~/.claude, running nothing', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(homedir(), '.claude'))
    const bin = fakeClaude(ANSWER)

    await expect(probeListing(scenario(), 'clean', { skill: true, crowd, base: join(root, 'runs') }, config(bin))).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
    expect(existsSync(marker())).toBe(false)
  })
})

describe('matchesProbe', () => {
  const probe = { skills: ['update-config', 'dial', 'sql-style'], claude_version: '2.1.332' }

  it('matches the same skills in another order and the same version', () => {
    expect(matchesProbe({ session_id: 'a', skills: ['dial', 'sql-style', 'update-config'], claude_version: '2.1.332' }, probe)).toBe(true)
  })

  it('does not match another version, one skill more, or no init', () => {
    expect(matchesProbe({ session_id: 'a', skills: probe.skills, claude_version: '2.1.333' }, probe)).toBe(false)
    expect(matchesProbe({ session_id: 'a', skills: [...probe.skills, 'extra'], claude_version: '2.1.332' }, probe)).toBe(false)
    expect(matchesProbe(undefined, probe)).toBe(false)
  })
})
