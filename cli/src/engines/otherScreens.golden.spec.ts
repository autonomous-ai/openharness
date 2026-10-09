/**
 * How the core reads a pane of the twelve engines besides Claude Code and Codex, and of the terminal, and the keys
 * it answers their dialogs with: recorded from main before their readers left the core's static imports
 * (docs/design/2026-10-08-other-engines-out-of-core.md, (o1)). Every engine reads every capture, so a reader that
 * starts to see another engine's dialog fails here as surely as one that stops seeing its own.
 *
 * The reading goes through the core's own entry, `createScreens(…).read`, wired for these engines as
 * `core/main.ts` wires it. The captures are the ones the repository has: the pane fixtures in lib/__fixtures__
 * (the files, and the screens takeoverScreens.ts and rewindPickers.ts build) and every pane written out whole in
 * the specs of the dialog, pane and input readers. Those are copied into the golden as recorded, so that a
 * later edit of a spec does not move it; a fixture file is pinned by its hash. Reading a pane is text work alone:
 * no platform, home, path, clock or file mode is in it, so the golden is the same on every host.
 *
 * `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter how one of
 * these engines' panes are read or answered, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createScreens } from '../core/engines/screens.js'
import type { QuestionRow, ScreenReading } from './facets/screen.js'
import type { AgentEngine } from './types.js'
import type { RegisteredSession } from '../lib/registry.js'
import { rowKeys } from '../lib/questionController.js'
import { engineLoaded, inProcessScreen } from './inProcess.js'
import * as takeoverScreens from '../lib/__fixtures__/takeoverScreens.js'
import * as rewindPickers from '../lib/__fixtures__/rewindPickers.js'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-screens.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const ENGINES = ['opencode', 'cursor', 'kilo', 'devin', 'hermes', 'amp', 'agy', 'grok', 'copilot', 'commandcode', 'muse', 'pi', 'terminal'] as const satisfies readonly AgentEngine[]
/** The specs whose panes are written out whole, as literals: dialogs, pane states, input and close checks. */
const SPECS = /^(lib\/askQuestion[\w.]*|engines\/\w+\/askQuestion|lib\/questionController|lib\/runtimeProfileController|engines\/pi\/runtimeProfile|lib\/closeAgentService|lib\/sessionInput|lib\/runtimeActivity)\.spec\.ts$/
const NO_CAPTURE = '(no capture)'

interface Input { id: string; sha256: string; text?: string }
interface Golden {
  inputs: Input[]
  /** Each distinct reading once, by its hash. */
  readings: Record<string, ScreenReading | null>
  /** Per input, per engine: the reading's hash. */
  screens: Record<string, Record<string, string>>
  /** Per input, per engine whose reading has rows: the keys each row is answered with. */
  keys: Record<string, Record<string, string[][]>>
  /** Every fixture file painted under every other, as a pane keeps an answered dialog above the live one: per
   *  pair, one hash of every engine's reading and keys. */
  pairs: Record<string, string>
  /** `rowKeys` for rows no capture has: every walk, for every engine. */
  synthetic: Record<string, string[][]>
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const short = (value: unknown): string => sha256(JSON.stringify(value)).slice(0, 16)

/** The captures in the repository's fixtures: each file, and each screen a fixture module builds. */
function fixtureInputs(): Array<{ id: string; text: string }> {
  const dir = join(SRC, 'lib', '__fixtures__')
  const files = readdirSync(dir).filter((name) => /^(permission|question)-[\w-]+\.txt$/.test(name)).sort()
  return [
    ...files.map((name) => ({ id: `lib/__fixtures__/${name}`, text: readFileSync(join(dir, name), 'utf8') })),
    ...Object.entries({ takeoverScreens, rewindPickers }).flatMap(([module, values]) => Object.entries(values)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string').sort(([a], [b]) => a.localeCompare(b))
      .map(([name, text]) => ({ id: `lib/__fixtures__/${module}.ts#${name}`, text }))),
  ]
}

/** Every pane written out whole in a spec: a multi-line string, or a list of literal lines joined with `\n`. */
function specInputs(): Array<{ id: string; text: string }> {
  const found: Array<{ id: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== '__fixtures__') walk(path); continue }
      const file = relative(SRC, path)
      if (!SPECS.test(file)) continue
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const literal = (node: ts.Node): string | null => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
      const visit = (node: ts.Node): void => {
        let text: string | null = null
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join'
          && ts.isArrayLiteralExpression(node.expression.expression) && node.arguments.length === 1 && literal(node.arguments[0]) === '\n') {
          const lines = node.expression.expression.elements.map(literal)
          if (lines.length > 1 && lines.every((line) => line !== null)) text = lines.join('\n')
        } else {
          text = literal(node)
        }
        if (text !== null && text.split('\n').length > 2) found.push({ id: `${file}#${sha256(text).slice(0, 12)}`, text })
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  walk(SRC)
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** A session of `engine`, bound, as the registry resolves it for the read's fence. */
const sessionOf = (engine: AgentEngine) => ({ agentId: `golden-${engine}`, sessionId: `golden-${engine}-session`, engine, active: true,
  registeredAt: 1, boundAt: 1, transcriptPath: null, runtimes: [], processIdentity: null }) as unknown as RegisteredSession

/** The core's pane read, as core/main.ts wires it for an engine whose screen no worker reads: through the loader. */
const screens = createScreens({
  handles: () => false,
  transport: { read: async () => { throw new Error('these engines have no worker') } },
  resolve: (agentId) => sessionOf(agentId.replace(/^golden-/, '') as AgentEngine),
  inline: (engine, capture) => inProcessScreen(engine, capture),
})

type Readings = Pick<Golden, 'readings' | 'screens' | 'keys'>
async function record(inputs: Array<{ id: string; text: string | null }>): Promise<Readings> {
  const out: Readings = { readings: {}, screens: {}, keys: {} }
  for (const { id, text } of inputs) {
    out.screens[id] = {}
    for (const engine of ENGINES) {
      const reading = await screens.read(sessionOf(engine), text)
      const hash = short(reading)
      out.readings[hash] = reading
      out.screens[id][engine] = hash
      const question = reading?.question
      if (question?.kind === 'question' && question.rows.length) {
        (out.keys[id] ??= {})[engine] = question.rows.map((row) => rowKeys(engine, row))
      }
    }
  }
  return out
}

/** Rows no capture has: every walk, for every engine, so a declared walk is pinned for each. */
const SYNTHETIC_ROWS: QuestionRow[] = ['1', '2', '3'].flatMap((number) => [undefined, 'down', 'right'].map((walk) => ({
  number, label: `Row ${number}`, checked: false, ...(walk ? { walk: walk as QuestionRow['walk'] } : {}),
})))
const syntheticKeys = (): Record<string, string[][]> => Object.fromEntries(ENGINES.map((engine) => [engine, SYNTHETIC_ROWS.map((row) => rowKeys(engine, row))]))

/** Each ordered pair of fixture files, the first painted above the second: what every engine reads of it. */
async function pairs(): Promise<Record<string, string>> {
  const files = fixtureInputs().filter(({ id }) => id.endsWith('.txt'))
  const out: Record<string, string> = {}
  for (const above of files) {
    for (const below of files) {
      if (above === below) continue
      const name = (id: string) => id.replace(/^lib\/__fixtures__\/|\.txt$/g, '')
      const id = `${name(above.id)}+${name(below.id)}`
      const read = await record([{ id, text: [above.text, below.text].join('\n') }])
      out[id] = short(Object.fromEntries(ENGINES.map((engine) => [engine, [read.readings[read.screens[id][engine]], read.keys[id]?.[engine] ?? null]])))
    }
  }
  return out
}

describe('the other engines\' screens, read through the core', () => {
  // Pinned, so that nothing of the host can reach a reading unnoticed: recorded on macOS, CI runs Linux, and
  // the previous batch's golden failed there on a platform-dependent string. GOLDEN_PLATFORM checks another.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: process.env.GOLDEN_PLATFORM ?? 'linux' })
    for (const [name, value] of Object.entries({ HOME: '/home/golden', TMPDIR: '/tmp/golden', TZ: 'UTC', LANG: 'C', LC_ALL: 'C', COLUMNS: '80' })) vi.stubEnv(name, value)
  })
  afterAll(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs() })

  it('reads every capture as main did, for every engine, and answers each row with the same keys', async () => {
    // Nothing has loaded their readers yet: the reads below load them, through the loader, as the core does.
    expect(engineLoaded('screens')).toBeUndefined()
    if (RECORD) {
      const unique = new Map<string, { id: string; text: string; spec: boolean }>()
      for (const input of [...fixtureInputs().map((one) => ({ ...one, spec: false })), ...specInputs().map((one) => ({ ...one, spec: true }))]) {
        const hash = sha256(input.text)
        if (!unique.has(hash)) unique.set(hash, input)
      }
      const inputs = [...unique.values()]
      const recorded = await record([{ id: NO_CAPTURE, text: null }, ...inputs])
      const golden: Golden = {
        inputs: inputs.map(({ id, text, spec }) => ({ id, sha256: sha256(text), ...(spec ? { text } : {}) })),
        ...recorded,
        pairs: await pairs(),
        synthetic: syntheticKeys(),
      }
      writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n')
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
    // The fixtures are read where they are; one that changed since the recording is an input changed, not a
    // reading: record the golden again in the change that edits it.
    const fixtures = new Map(fixtureInputs().map(({ id, text }) => [id, text]))
    const inputs = golden.inputs.map(({ id, sha256: hash, text }) => {
      const found = text ?? fixtures.get(id) ?? null
      expect(found === null ? null : sha256(found), `${id} changed since the golden was recorded`).toBe(hash)
      return { id, text: found }
    })
    expect(inputs.length).toBeGreaterThan(100)
    const now = await record([{ id: NO_CAPTURE, text: null }, ...inputs])
    expect(engineLoaded('screens')).toHaveProperty('legacyScreen')
    for (const id of [NO_CAPTURE, ...golden.inputs.map((input) => input.id)]) {
      const readings = (screens: Record<string, string>, table: Record<string, ScreenReading | null>) =>
        Object.fromEntries(Object.entries(screens).map(([engine, hash]) => [engine, table[hash]]))
      expect({ id, readings: readings(now.screens[id], now.readings) }).toEqual({ id, readings: readings(golden.screens[id], golden.readings) })
      expect({ id, keys: now.keys[id] }).toEqual({ id, keys: golden.keys[id] })
    }
    expect(syntheticKeys()).toEqual(golden.synthetic)
    const now2 = await pairs()
    expect(Object.keys(now2)).toEqual(Object.keys(golden.pairs))
    expect(Object.entries(now2).filter(([id, hash]) => golden.pairs[id] !== hash).map(([id]) => id), 'pairs read differently').toEqual([])
  }, 60_000)
})
