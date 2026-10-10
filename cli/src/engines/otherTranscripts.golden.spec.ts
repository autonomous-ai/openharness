/**
 * What the core makes of the twelve other engines' conversations, recorded from main before their transcript
 * code left the core's static imports (docs/design/2026-10-08-other-engines-out-of-core.md, (o3)). Every case
 * goes through the core's own entries, wired as core/main.ts wires them:
 *
 * - **Live.** `createAttach(...).attachSession` folds what the transcript already holds (what it emits and
 *   announces, where it starts the tail), then `createIngest(...).ingestLine` takes each later line. Every
 *   transcript is read by every file engine, split at its start, its middle and its end. The database engines'
 *   readers start on half of a store, are handed the rest and poll once.
 * - **History and the last turn.** `createHistory(...).sessionGet`, whole, the latest page and each older one,
 *   and a stale cursor; `createLastTurnReader`.
 * - **agy's idle backstop and Cursor's Task hooks**, which close a turn and follow a sub-agent.
 *
 * The inputs are the ones the repository has: the session fixtures in lib/__fixtures__, the stores built from
 * kilo-session.json and hermes-async-delegation.json, and every transcript written out line by line in the
 * engines' normalizer specs, copied into the golden so a later edit of a spec does not move it. A case keeps a
 * hash of everything it produced and the event types in order, so that a difference names the case and the
 * kind of event.
 *
 * Nothing of the host is in it: the clock is pinned, every transcript's modification time is set, the platform,
 * HOME and every engine home are pinned under a throwaway root, Amp's `threads export` is a script of the test's
 * own, and no case's size or cap depends on where the temporary folder is.
 *
 * `RECORD_OTHER_ENGINES_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter how one of
 * these engines' conversations are read, and say so in that change.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/other-transcripts.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OTHER_ENGINES_GOLDEN === '1'
const FILE_ENGINES = ['cursor', 'muse', 'amp', 'grok', 'agy', 'copilot', 'pi', 'commandcode'] as const
type FileEngine = (typeof FILE_ENGINES)[number]
const DB_ENGINES = ['opencode', 'kilo', 'hermes', 'devin'] as const
type DbEngine = (typeof DB_ENGINES)[number]
/** The specs whose transcripts are written out line by line. */
const SPECS = /^engines\/(cursor|muse|amp|grok|agy|copilot|pi|commandcode)\/(normalizer|history)\.spec\.ts$/
/** The moment every case runs at, and every transcript was last written. */
const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const AMP_THREAD = 'T-019fda6e-7992-73eb-b60a-250f8f80beb6'
const IDS: Record<FileEngine | DbEngine, string> = {
  cursor: '0b6f4f2e-6c1a-4c55-9a51-golden000001', muse: 'golden-muse-session', amp: AMP_THREAD, grok: 'golden-grok-session',
  agy: 'golden-agy-session', copilot: 'golden-copilot-session', pi: 'golden-pi-session', commandcode: 'golden-commandcode-session',
  opencode: 'ses_goldenOpencode', kilo: 'ses_goldenKilo', hermes: '20260727_162325_e25264', devin: 'golden-devin',
}

interface Transcript { id: string; lines: string[]; text?: string[] }
interface Golden {
  transcripts: Array<{ id: string; sha256: string; lines?: string[] }>
  /** Per case: a hash of everything it produced, and the event types in order. */
  cases: Record<string, { sha: string; types: string }>
}

const sha = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const typesOf = (events: Array<{ type?: string }>): string => events.map((event) => event.type ?? '?').join(',')

let root = ''
const fixturesDir = join(SRC, 'lib', '__fixtures__')

/** The session fixtures. */
function fixtureTranscripts(): Transcript[] {
  return readdirSync(fixturesDir).filter((name) => /\.jsonl$/.test(name)).sort()
    .map((name) => ({ id: `lib/__fixtures__/${name}`, lines: readFileSync(join(fixturesDir, name), 'utf8').split('\n').filter((line) => line.trim()) }))
}

/**
 * Every transcript a normalizer spec writes out line by line: a list of JSON lines, written as literals or
 * built from the file's constants, stringified object literals, and its one-expression helpers (`user('hi')`,
 * `line({...})`), evaluated without running the spec. A list that cannot be evaluated whole is left out.
 */
function specTranscripts(): Transcript[] {
  const found: Transcript[] = []
  const NONE = Symbol('none')
  type Env = Map<string, unknown>
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      const file = relative(SRC, path)
      if (!SPECS.test(file)) continue
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const constants: Env = new Map()
      const helpers = new Map<string, ts.ArrowFunction>()
      const lookup = (name: string, env: Env): unknown => env.has(name) ? env.get(name) : constants.has(name) ? constants.get(name) : NONE
      const evaluate = (node: ts.Node, env: Env = new Map(), depth = 0): unknown => {
        if (depth > 20) return NONE
        const again = (child: ts.Node): unknown => evaluate(child, env, depth + 1)
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return again(node.expression)
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
        if (ts.isNumericLiteral(node)) return Number(node.text)
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text)
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false
        if (node.kind === ts.SyntaxKind.NullKeyword) return null
        if (ts.isIdentifier(node)) return node.text === 'undefined' ? undefined : lookup(node.text, env)
        if (ts.isTemplateExpression(node)) {
          let out = node.head.text
          for (const span of node.templateSpans) {
            const value = again(span.expression)
            if (typeof value !== 'string' && typeof value !== 'number') return NONE
            out += String(value) + span.literal.text
          }
          return out
        }
        if (ts.isArrayLiteralExpression(node)) {
          const values: unknown[] = []
          for (const element of node.elements) {
            if (ts.isSpreadElement(element)) {
              const spread = again(element.expression)
              if (!Array.isArray(spread)) return NONE
              values.push(...spread)
            } else {
              const value = again(element)
              if (value === NONE) return NONE
              values.push(value)
            }
          }
          return values
        }
        if (ts.isObjectLiteralExpression(node)) {
          const out: Record<string, unknown> = {}
          for (const property of node.properties) {
            if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) {
              const value = again(property.initializer)
              if (value === NONE) return NONE
              out[property.name.text] = value
            } else if (ts.isShorthandPropertyAssignment(property)) {
              const value = lookup(property.name.text, env)
              if (value === NONE) return NONE
              out[property.name.text] = value
            } else if (ts.isSpreadAssignment(property)) {
              const value = again(property.expression)
              if (!value || typeof value !== 'object' || Array.isArray(value)) return NONE
              Object.assign(out, value)
            } else return NONE
          }
          return out
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText()
          const args = node.arguments.map((arg) => ts.isSpreadElement(arg) ? NONE : again(arg))
          if (args.includes(NONE)) return NONE
          if (callee === 'JSON.stringify' && args.length === 1) return JSON.stringify(args[0])
          const helper = helpers.get(callee)
          if (!helper || ts.isBlock(helper.body)) return NONE
          const scope: Env = new Map()
          helper.parameters.forEach((parameter, i) => {
            if (!ts.isIdentifier(parameter.name)) return
            if (parameter.dotDotDotToken) scope.set(parameter.name.text, args.slice(i))
            else scope.set(parameter.name.text, i < args.length ? args[i] : parameter.initializer ? evaluate(parameter.initializer, scope, depth + 1) : undefined)
          })
          return evaluate(helper.body, scope, depth + 1)
        }
        return NONE
      }
      // Constants and helpers wherever they are declared, in order: a test's own are as good an input as a file's.
      const declare = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          if (ts.isArrowFunction(node.initializer)) helpers.set(node.name.text, node.initializer)
          else if (!constants.has(node.name.text)) {
            const value = evaluate(node.initializer)
            if (value !== NONE) constants.set(node.name.text, value)
          }
        }
        ts.forEachChild(node, declare)
      }
      declare(source)
      const visit = (node: ts.Node): void => {
        if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2) {
          const lines = evaluate(node)
          if (Array.isArray(lines) && lines.length >= 2 && lines.every((line) => {
            if (typeof line !== 'string') return false
            try { const parsed = JSON.parse(line) as unknown; return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) } catch { return false }
          })) found.push({ id: `${file}#${sha(lines).slice(0, 12)}`, lines: lines as string[] })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  walk(join(SRC, 'engines'))
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** A registered session of `engine`, its transcript at `transcriptPath`. */
const sessionOf = (engine: string, transcriptPath: string | null): RegisteredSession => ({
  agentId: `golden-agent-${engine}`, sessionId: IDS[engine as FileEngine], engine, active: true, registeredAt: NOW - 60_000, boundAt: NOW - 60_000,
  touchedAt: NOW - 30_000, transcriptPath, projectDir: 'golden-project', cwd: '/work/golden-project', runtimes: [], processIdentity: null,
} as unknown as RegisteredSession)

type Core = Awaited<ReturnType<typeof loadCore>>
async function loadCore() {
  const { createAttach } = await import('../core/transcripts/attach.js')
  const { createIngest } = await import('../core/transcripts/ingest.js')
  const { createHistory } = await import('../core/transcripts/history.js')
  const { createLastTurnReader } = await import('../core/transcripts/lastTurn.js')
  const { createSessionNormalizers } = await import('../core/transcripts/normalizers.js')
  const { createAgyBackstop } = await import('../core/turns/agyBackstop.js')
  const { createCursorTaskHooks } = await import('../core/engines/cursorTasks.js')
  return { createAttach, createIngest, createHistory, createLastTurnReader, createSessionNormalizers, createAgyBackstop, createCursorTaskHooks }
}

const dbs = () => ({ opencode: join(root, 'db', 'opencode.db'), kilo: join(root, 'db', 'kilo.db'), devin: join(root, 'db', 'devin.db') })
const hermesDb = async (): Promise<string> => join(root, 'db', 'hermes.db')

/** The core's live path for one session: attach, then each later line through ingest. */
function livePath(core: Core, session: RegisteredSession, pane: string | null) {
  const normalizers = core.createSessionNormalizers()
  const out: unknown[] = []
  const events: Array<{ type?: string }> = []
  const emit = (sessionId: string, emitted: Array<{ type?: string }>, opts?: unknown): void => {
    out.push(['emit', sessionId, emitted, opts ?? null]); events.push(...emitted)
  }
  const announceTurnAborted = (...args: unknown[]): void => { out.push(['aborted', ...args]) }
  const attach = core.createAttach({
    setInterpretationHold: () => false, announceSession: () => {},
    liveFor: () => undefined,
    resolve: () => session,
    terminalGone: async () => false,
    normalizers,
    watcher: {
      removeSession: async () => {}, pollSession: async () => {},
      addSession: async (s, options) => { out.push(['tail', s.sessionId, options ?? null]) },
      hold: async () => null,
      tails: () => false,
    },
    cursorDiscovery: { add: async (sessionId) => { out.push(['cursor discovery', sessionId]) } },
    device: () => undefined,
    runtimeProfiles: {
      transcriptFields: () => [], beginHydrate: () => ({ ingest: () => {}, commit: () => {} }), hydrate: () => {},
      ingestConfig: async () => {}, ingestPane: () => false,
      capturePane: async () => pane,
    } as never,
    captureTerminal: async () => pane,
    emit: emit as never,
    announceTurnAborted,
    questionWatcher: { start: (sessionId) => { out.push(['question watch', sessionId]) } },
    terminalLabel: () => 'tmux:%0',
    dbs: dbs(),
    devinHome: join(root, 'devin'),
    hermesDb,
    concurrency: 1,
    settled: (sessionId) => { out.push(['settled', sessionId]) },
  })
  const ingest = core.createIngest({
    liveFor: () => undefined,
    has: () => true,
    bySession: () => session,
    tokenUsage: { changed: () => {} },
    device: () => undefined,
    runtimeProfiles: { ingest: () => {} } as never,
    normalizers,
    announceTurnAborted,
    emit: emit as never,
    attachSession: async () => true,
  })
  return { normalizers, out, events, attach, ingest }
}

const record: Golden['cases'] = {}
let golden: Golden

async function check(key: string, produced: { out: unknown[]; events: Array<{ type?: string }> }): Promise<void> {
  // Paths under the throwaway root are named by it, never by where it is.
  const entry = { sha: sha(JSON.stringify(produced.out).split(root).join('<root>')).slice(0, 20), types: typesOf(produced.events) }
  record[key] = entry
  if (!RECORD) expect({ key, ...entry }).toEqual({ key, ...golden.cases[key] })
}

let core: Core
let transcripts: Transcript[] = []
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'other-transcripts-golden-')))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  // The database readers' polls are made by hand, once: their own interval never fires.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW })
  const home = join(root, 'home')
  const amp = join(root, 'bin', 'amp')
  mkdirSync(join(root, 'bin'), { recursive: true })
  // Amp's own store, as `amp threads export` answers for the one thread the fixture holds, and nothing else.
  writeFileSync(amp, `#!/bin/sh\nif [ "$3" = "${AMP_THREAD}" ]; then cat ${JSON.stringify(join(fixturesDir, 'amp-thread-export.json'))}; else exit 1; fi\n`, { mode: 0o755 })
  const env: Record<string, string | undefined> = {
    HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), ADAPTER_DATA_DIR: join(root, 'data'),
    CURSOR_HOME: join(home, '.cursor'), CURSOR_CONFIG_DIR: undefined, CURSOR_DATA_DIR: undefined, DEVIN_HOME: join(root, 'devin'),
    HERMES_HOME: join(home, '.hermes'), AMP_PATH: amp, TZ: 'UTC',
  }
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  for (const dir of ['data', 'db', 'devin', 'files', join('home', '.cursor')]) mkdirSync(join(root, dir), { recursive: true })
  vi.resetModules()
  core = await loadCore()
  golden = RECORD ? { transcripts: [], cases: {} } : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
  if (RECORD) {
    const unique = new Map<string, Transcript & { spec: boolean }>()
    for (const one of [...fixtureTranscripts().map((t) => ({ ...t, spec: false })), ...specTranscripts().map((t) => ({ ...t, spec: true }))]) {
      const key = sha(one.lines)
      if (!unique.has(key)) unique.set(key, one)
    }
    transcripts = [...unique.values()]
    golden.transcripts = [...unique.values()].map(({ id, lines, spec }) => ({ id, sha256: sha(lines), ...(spec ? { lines } : {}) }))
  } else {
    // A fixture is read where it is; one that changed since the recording is an input changed, not a reading.
    const fixtures = new Map(fixtureTranscripts().map((t) => [t.id, t.lines]))
    transcripts = golden.transcripts.map(({ id, sha256, lines }) => {
      const found = lines ?? fixtures.get(id) ?? []
      expect(sha(found), `${id} changed since the golden was recorded`).toBe(sha256)
      return { id, lines: found }
    })
  }
})

afterAll(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) rmSync(root, { recursive: true, force: true })
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify({ ...golden, cases: record }, null, 1) + '\n')
})

/** Writes `lines` as a transcript, last written at NOW. */
function transcriptFile(name: string, lines: string[]): string {
  const path = join(root, 'files', `${name}.jsonl`)
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''))
  utimesSync(path, NOW / 1000, NOW / 1000)
  return path
}

const splits = (n: number): number[] => [...new Set([0, Math.ceil(n / 2), n])]

describe('the other engines\' conversations, through the core', () => {
  it('has inputs', () => {
    expect(transcripts.length).toBeGreaterThan(20)
    expect(transcripts.filter((t) => t.id.startsWith('engines/')).length).toBeGreaterThan(10)
  })

  for (const engine of FILE_ENGINES) {
    it(`${engine}: every transcript, live from each split, then history and the last turn`, async () => {
      for (const transcript of transcripts) {
        for (const at of splits(transcript.lines.length)) {
          const path = transcriptFile(`${engine}-live`, transcript.lines.slice(0, at))
          const session = sessionOf(engine, path)
          const live = livePath(core, session, null)
          await live.attach.attachSession(session)
          for (const text of transcript.lines.slice(at)) {
            live.out.push(['line'])
            const events = live.ingest.ingestLine({ sessionId: session.sessionId, engine, text } as never) ?? []
            live.out.push(['ingested', events]); live.events.push(...events)
          }
          live.normalizers.stopPollers()
          await check(`${engine} live: ${transcript.id} @${at}/${transcript.lines.length}`, live)
        }
        // Lines for a session whose normalizer the line path makes itself (none attached under this id; another of
        // the engine's sessions was).
        {
          const session = { ...sessionOf(engine, null), sessionId: `${IDS[engine]}-unattached` } as RegisteredSession
          const live = livePath(core, session, null)
          await live.attach.attachSession(sessionOf(engine, null))
          live.out.length = 0
          live.events.length = 0
          for (const text of transcript.lines) {
            const events = live.ingest.ingestLine({ sessionId: session.sessionId, engine, text } as never) ?? []
            live.out.push(['ingested', events]); live.events.push(...events)
          }
          await check(`${engine} lines alone: ${transcript.id}`, live)
        }
        const path = transcriptFile(`${engine}-history`, transcript.lines)
        const session = sessionOf(engine, path)
        const history = core.createHistory({
          resolve: () => session, stopped: () => [], pages: { lineCount: async () => transcript.lines.length } as never,
          readerFor: () => undefined, dbs: dbs(), hermesDb,
        })
        const out: unknown[] = []
        const events: Array<{ type?: string }> = []
        const ask = async (payload: Record<string, unknown>) => {
          const reply = await history.sessionGet({ sessionId: session.sessionId, ...payload })
          out.push(reply); events.push(...((reply.events as Array<{ type?: string }>) ?? []), { type: '|' })
          return reply
        }
        await ask({})
        let page = await ask({ limit: 3 })
        for (let pages = 0; page.hasMore && typeof page.oldestCursor === 'string' && pages < 100; pages++) page = await ask({ limit: 3, before: page.oldestCursor })
        await ask({ limit: 3, before: 'a-stale-cursor' })
        out.push(['sessions', await history.sessionsList({ agentId: session.agentId })])
        out.push(['last turn', await core.createLastTurnReader({ bySession: () => session, readerFor: () => undefined, dbs: dbs(), hermesDb })(session.sessionId)])
        await check(`${engine} history: ${transcript.id}`, { out, events })
      }
    }, 120_000)
  }

  it('agy: an open turn closed at attach by an idle pane, and by the backstop', async () => {
    for (const transcript of transcripts) {
      const path = transcriptFile('agy-idle', transcript.lines)
      const session = sessionOf('agy', path)
      const live = livePath(core, session, '? for shortcuts')
      await live.attach.attachSession(session)
      live.normalizers.stopPollers()
      // The backstop: a check of the pane, once, with no wait.
      const backstop = core.createAgyBackstop({
        agyNormalizers: live.normalizers.agyNormalizers, bySession: () => session,
        captureTerminal: async () => '? for shortcuts', drain: async () => {}, emit: (sessionId, events) => { live.out.push(['backstop', sessionId, events]); live.events.push(...events) },
      })
      const busy = livePath(core, session, null)
      await busy.attach.attachSession(session)
      const second = core.createAgyBackstop({
        agyNormalizers: busy.normalizers.agyNormalizers, bySession: () => session,
        captureTerminal: async () => '? for shortcuts', drain: async () => {}, emit: (sessionId, events) => { live.out.push(['backstop', sessionId, events]); live.events.push(...events) },
      })
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'], now: NOW })
      try {
        backstop.armAgyIdleWatch(session.sessionId)
        second.armAgyIdleWatch(session.sessionId)
        await vi.advanceTimersByTimeAsync(15_000)
        backstop.clearAgyIdleWatch(session.sessionId)
        second.clearAgyIdleWatch(session.sessionId)
      } finally { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW }) }
      await check(`agy idle: ${transcript.id}`, live)
    }
  }, 120_000)

  it('cursor: a Task hook queued behind the transcript, and the sub-agent it starts', async () => {
    for (const transcript of transcripts) {
      const path = transcriptFile('cursor-task', transcript.lines)
      const session = sessionOf('cursor', path)
      const live = livePath(core, session, null)
      await live.attach.attachSession(session)
      const tasks = core.createCursorTaskHooks({
        emitSessionEvents: (sessionId, events) => { live.out.push(['task', sessionId, events]); live.events.push(...events) },
        watcher: { pollSession: async () => {} },
        registry: { bySession: () => session, resolve: () => session } as never,
        cursorNormalizers: live.normalizers.cursorNormalizers,
      })
      tasks.onCursorTaskStart(session.sessionId, 'toolu_golden', { description: 'Count the files', prompt: 'count them', subagent_type: 'explore' })
      await tasks.cursorTaskHooks.wait(session.sessionId)
      tasks.cursorSubagents.stop()
      await check(`cursor task: ${transcript.id}`, live)
    }
  }, 120_000)

  for (const engine of DB_ENGINES) {
    it(`${engine}: a store read live from half of it, polled once, then history and the last turn`, async () => {
      const { messages, write } = await store(engine)
      for (const at of splits(messages.length)) {
        write(messages.slice(0, at))
        const session = sessionOf(engine, null)
        const live = livePath(core, session, null)
        await live.attach.attachSession(session)
        write(messages)
        const readers = { opencode: live.normalizers.opencodeReaders, kilo: live.normalizers.kiloReaders, hermes: live.normalizers.hermesReaders, devin: live.normalizers.devinReaders }[engine]
        await (readers.get(session.sessionId) as unknown as { tick(): Promise<void> } | undefined)?.tick()
        live.normalizers.stopPollers()
        await check(`${engine} live: @${at}/${messages.length}`, live)
      }
      write(messages)
      const session = sessionOf(engine, null)
      const history = core.createHistory({ resolve: () => session, stopped: () => [], pages: { lineCount: async () => 0 } as never, readerFor: () => undefined, dbs: dbs(), hermesDb })
      const out: unknown[] = []
      const events: Array<{ type?: string }> = []
      const ask = async (payload: Record<string, unknown>) => {
        const reply = await history.sessionGet({ sessionId: session.sessionId, ...payload })
        out.push(reply); events.push(...((reply.events as Array<{ type?: string }>) ?? []), { type: '|' })
        return reply
      }
      await ask({})
      let page = await ask({ limit: 2 })
      for (let pages = 0; page.hasMore && typeof page.oldestCursor === 'string' && pages < 100; pages++) page = await ask({ limit: 2, before: page.oldestCursor })
      await ask({ limit: 2, before: 'a-stale-cursor' })
      out.push(['last turn', await core.createLastTurnReader({ bySession: () => session, readerFor: () => undefined, dbs: dbs(), hermesDb })(session.sessionId)])
      await check(`${engine} history`, { out, events })
    }, 120_000)
  }

  it('has a recorded outcome for every case, and no other', () => {
    if (RECORD) return
    expect(Object.keys(record).sort()).toEqual(Object.keys(golden.cases).sort())
  })
})

/** A database engine's store, written from the repository's own records of it. */
async function store(engine: DbEngine): Promise<{ messages: unknown[]; write: (messages: unknown[]) => void }> {
  // As lib/sqliteBuiltin.ts reaches it: this Node's types predate the module.
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void }
  }
  const path = engine === 'hermes' ? await hermesDb() : dbs()[engine]
  const fresh = (schema: string) => {
    rmSync(path, { force: true })
    const db = new DatabaseSync(path)
    db.exec(schema)
    return db
  }
  const id = IDS[engine]
  if (engine === 'opencode' || engine === 'kilo') {
    // Kilo is OpenCode's fork and keeps the same store: the measured Kilo session fills both.
    const messages = JSON.parse(readFileSync(join(fixturesDir, 'kilo-session.json'), 'utf8')) as Array<{ id: string; timeCreated: number; data: unknown; parts: Array<{ id: string; data: unknown }> }>
    return {
      messages,
      write: (some) => {
        const db = fresh('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
          + 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);')
        for (const m of some as typeof messages) {
          db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(m.id, id, m.timeCreated, JSON.stringify(m.data))
          m.parts.forEach((p, i) => db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(p.id, m.id, id, m.timeCreated + i, JSON.stringify(p.data)))
        }
        db.close()
      },
    }
  }
  if (engine === 'hermes') {
    const messages = JSON.parse(readFileSync(join(fixturesDir, 'hermes-async-delegation.json'), 'utf8')) as Array<Record<string, unknown>>
    return {
      messages,
      write: (some) => {
        const db = fresh('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,'
          + ' tool_calls TEXT, tool_name TEXT, finish_reason TEXT, reasoning TEXT, timestamp REAL);'
          + 'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL);')
        for (const m of some as typeof messages) {
          const text = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value)
          db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(m.id as number, id, text(m.role), text(m.content), text(m.toolCallId),
            text(m.toolCalls), text(m.toolName), text(m.finishReason), text(m.reasoning), m.id as number)
        }
        db.close()
      },
    }
  }
  // Devin's rows as its reader spec writes them: a turn with a tool call and its result, a re-persisted user
  // row, a system row, and a turn that stops.
  const messages = [
    { message_id: 'm-user', role: 'user', content: 'count the files', metadata: { created_at: '2026-07-28T06:38:21.000000Z' } },
    { message_id: 'm-user', role: 'user', content: 'count the files', metadata: { created_at: '2026-07-28T06:38:21.000000Z' } },
    { message_id: 'm-sys', role: 'system', content: 'You are Devin' },
    { message_id: 'm-call', role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls | wc -l"}' } }], metadata: { finish_reason: 'tool_calls' } },
    { message_id: 'm-result', role: 'tool', tool_call_id: 'call-1', content: '12' },
    { message_id: 'm-answer', role: 'assistant', content: 'There are 12 files.', metadata: { finish_reason: 'stop' } },
    { message_id: 'm-user-2', role: 'user', content: 'and folders?', metadata: { created_at: '2026-07-28T06:39:02.000000Z' } },
  ]
  return {
    messages,
    write: (some) => {
      const db = fresh(`CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
        parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);`)
      some.forEach((m, node) => db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, 0)').run(id, node, JSON.stringify(m)))
      db.close()
    },
  }
}
