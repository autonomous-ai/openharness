/**
 * The daemon's shape, checked: master, core, services (cli/AGENTS.md). People and their coding agents
 * build features in parallel on it, and a rule nobody checks is a rule the next change breaks quietly.
 * So the boundaries are tests: a service reaches the core only through `core/api.ts`, the core never
 * reaches into a service, the master holds no feature code, and the two files every change used to land
 * in — `runForeground` and the socket's request switch — remain wiring and transport.
 * Source size is reported for review; dependencies and behavior enforce the architecture.
 *
 * When this fails, the message says where the code belongs. Move it there; do not widen the rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = __dirname

interface Import {
  file: string
  from: string
  typeOnly: boolean
}

/** Every import and re-export in a folder's source (not its tests), and whether it is types only. */
function importsIn(folder: string): Import[] {
  const found: Import[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const statement of source.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          let typeOnly = false
          if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause
            const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null
            typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((element) => element.isTypeOnly)))
          } else {
            typeOnly = statement.isTypeOnly
          }
          found.push({ file: relative(SRC, path), from: statement.moduleSpecifier.text, typeOnly })
        }
      }
    }
  }
  walk(join(SRC, folder))
  return found
}

/** The lines `runForeground` spans in core/main.ts. */
function runForegroundLines(): number {
  const lines = readFileSync(join(SRC, 'core', 'main.ts'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('async function runForeground('))
  const end = lines.findIndex((line, index) => index > start && line === '}')
  return end - start
}

/** The relative modules a source imports for its values: static, re-exported, bare and dynamic; never `import type`. */
function valueImports(path: string, text: string): string[] {
  return importsFor(path, text).map(({ from }) => from)
}

/** `valueImports`, saying which are dynamic (`import('…')`). */
function importsFor(path: string, text: string): Array<{ from: string; dynamic: boolean }> {
  const found: Array<{ from: string; dynamic: boolean }> = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      let typeOnly: boolean
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null
        typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((element) => element.isTypeOnly)))
      } else {
        typeOnly = node.isTypeOnly
      }
      if (!typeOnly) found.push({ from: node.moduleSpecifier.text, dynamic: false })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ from: node.arguments[0].text, dynamic: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
  return found.filter(({ from }) => from.startsWith('.'))
}

/**
 * The one import the core's walk does not follow: the services that run in a process of their own by
 * default, loaded into the core's only when they run there instead (services/inline.ts). Only a dynamic
 * import of it is passed over; a static one would load it in every core, and is walked.
 */
const IN_PROCESS_ONLY = 'services/inline.ts'

/**
 * The code a process started on `entry` runs: every file its imports reach, as each file's lines
 * (docs/design/2026-10-06-core-boundary-next.md, "The target, and its test"). It follows static and
 * dynamic imports under src, `.js` to `.ts` and folders to their index, and leaves out `import type`
 * (types cost nothing at run time), tests, and a dynamic import of `IN_PROCESS_ONLY`.
 */
function closureOf(entry: string): Map<string, number> {
  const lines = new Map<string, number>()
  const pending = [join(SRC, entry)]
  while (pending.length > 0) {
    const path = pending.pop()!
    const file = relative(SRC, path)
    if (lines.has(file)) continue
    const parsed = parsedFile(path)
    lines.set(file, parsed.lines)
    pending.push(...parsed.imports)
  }
  return lines
}

/** Each file read and parsed once, however many walks pass through it. */
const parsed = new Map<string, { lines: number; imports: string[] }>()
function parsedFile(path: string): { lines: number; imports: string[] } {
  const known = parsed.get(path)
  if (known) return known
  const isFile = (candidate: string): boolean => { try { return statSync(candidate).isFile() } catch { return false } }
  const text = readFileSync(path, 'utf8')
  const imports: string[] = []
  for (const { from, dynamic } of importsFor(path, text)) {
    const base = resolve(dirname(path), from)
    const target = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')].find(isFile)
    if (!target || !target.startsWith(SRC + '/') || !target.endsWith('.ts') || /\.(spec|test|e2e)\.ts$/.test(target)) continue
    if (dynamic && relative(SRC, target) === IN_PROCESS_ONLY) continue
    imports.push(target)
  }
  const result = { lines: text.split('\n').length, imports }
  parsed.set(path, result)
  return result
}

/** Walking the whole CLI parses some 500 files: seconds on a busy machine, not the default five. */
const WALK_TIMEOUT_MS = 60_000

/** Exceptions, each with its reason. Keep this short. */
const SERVICE_MAY_IMPORT: Record<string, string> = {
  // A pure function of a session row. Move it out of registry.ts when workspaces leaves the core's process.
  'services/workspaces.ts → ../lib/registry.js': 'sessionDisplayTitle, a pure helper',
}

/** What is not the core's, by path: each goes to a service or its own process, in the plan's order. */
const EDGE: RegExp[] = [
  /^engines\/(claude|codex)\/(screen|composer|activity|stoppedGoal|modelControl|modelPicker)\.ts$/,
  /^lib\/(askQuestion|runtimeProfileController|composerScreen|teamWriteHold|messageHold|terminalActivity|codexTurnRecovery)\.ts$/,
  /^engines\/(screens|modelControls)\.ts$/,
  // The pilot reader implementations and their host are never loaded by supervised core.
  /^engines\/(worker\/process|transcripts|(claude|codex)\/(transcript|\w+ReaderProcess))\.ts$/,
  /^engines\/(runtime|(claude|codex)\/runtimeProfile)\.ts$/, /^lib\/runtimeProfile\.ts$/,
  /^gateway\//, /^lib\/e2ee\//, /^cable\//, /^device\//, /^lib\/autonomous-device\//, /^sharing\//, /^teams\//, /^orchestrator\//, /^services\//,
  /^lib\/grid(Attach|Credentials|Derive|Ensure|Envelope|Exec|FleetRpc|Handoff|Install|McpUrl|Models|ModelsPayload|Picture|Presence|Reader|Target|Wake)\.ts$/,
  /^lib\/localModels\.ts$/,
  // The change-agent handoff reads and redacts history and runs git: the edge host owns that work.
  /^lib\/agentHandoff\.ts$/,
  // The relay's own parts, the gateway's alone: the windows' sessions to other machines, P2P and STUN, the
  // remote viewers' proxy, and the shaping of what goes up the link.
  /^lib\/(remoteRelay|terminalP2p|stunSelect|remoteViewerProxy|deviceRecentTrim|commanderReplay)\.ts$/,
  // The viewers' own: a viewer served to a client over its connection, and the stream it runs on.
  /^lib\/(viewerForwarder|interactiveViewer|viewerWire)\.ts$/,
  // The recaps' own parts: the mirror that cuts each turn's recap and card, and the notification policy it
  // shares with the questions the core tells it of (services/recaps.ts).
  /^lib\/(commander|agentNotifications)\.ts$/,
  // The Store's and the viewers' parts of dsh; the launch path (installed, manifest, launch, runtime, …) is the core's.
  /^dsh\/(catalog|install|update|updates|registry|wire|service|lock|builtins|viewer|viewerLedger|verdict|artifacts)\.ts$/,
  // Search's index; the readers of other engines' sessions (external.ts, externals/) are the core's, for adoption.
  /^lib\/sessionSearch\/(?!external\.ts$|externals\/)/,
  // Downloading builds: the updater's, in a process the master runs (services/updaterProcess.ts). The core
  // never downloads a build.
  /^lib\/(selfUpdate|runtimeInstall)\.ts$/, /^tui\/(update|install)\.ts$/,
]

/**
 * The edge files the core's process still loads, each with the step of the plan that takes it out. The
 * list only shrinks: an entry no longer reached fails the test, so remove it with the move that ends it.
 */
const CORE_MAY_REACH: Record<string, string> = {
}

describe('the daemon\'s shape', () => {
  it('a service reaches the core only through core/api.ts: never a core module, the registry, cli.ts or the socket', () => {
    const wrong = importsIn('services').filter(({ file, from, typeOnly }) => {
      if (SERVICE_MAY_IMPORT[`${file} → ${from}`]) return false
      if (/(^|\/)core\//.test(from)) return from !== '../core/api.js'
      if (/(^|\/)(cli|backendSocket|localWsServer)\.js$/.test(from)) return true
      if (/(^|\/)lib\/registry\.js$/.test(from)) return !typeOnly
      return false
    }).map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'A service may use the core only through CoreApi (src/core/api.ts). If CoreApi lacks it, add it there in its own change (src/services/AGENTS.md).').toEqual([])
  })

  it('the core never reaches into a service, cli.ts or the socket, but for types', () => {
    // core/main.ts is the composition root: it builds the socket and starts the services, so it is the one
    // core file that imports them. Which of their files the core's process loads is the closure's test
    // (below), file by file. It never imports cli.ts: that would put the CLI back into the core.
    const wrong = importsIn('core').filter(({ file, from, typeOnly }) =>
      (file === 'core/main.ts' ? /(^|\/)cli\.js$/.test(from)
        : /(^|\/)services\//.test(from) || (/(^|\/)(cli|backendSocket|localWsServer)\.js$/.test(from) && !typeOnly)))
      .map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'The core calls services only through CorePorts, and is handed the socket\'s pieces as dependencies (src/core/AGENTS.md).').toEqual([])
  })

  it('live transcript coordination depends on engine contracts, with neutral folding mechanics', () => {
    const owners = new Set(['core/transcripts/attach.ts', 'core/transcripts/ingest.ts', 'core/transcripts/normalizers.ts'])
    const wrong = importsIn('core').filter(({ file, from, typeOnly }) => owners.has(file) && !typeOnly
      && (/engines\/(claude|codex)\//.test(from) || /lib\/normalize\.js$/.test(from) || /engines\/live\.js$/.test(from)))
    expect(wrong, 'Inject the live facet; do not construct or edit an engine parser in core.').toEqual([])
    for (const entry of ['lib/attachTranscript.ts', 'engines/kit/events.ts', 'engines/kit/transcriptFold.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file)), entry).toEqual([])
    }
  })

  it('runtime profile authority and wire values load contracts without vendor profile implementations', () => {
    for (const entry of ['core/engines/runtimeSessions.ts', 'core/engines/runtimeProfiles.ts',
      'core/engines/runtimeTransport.ts', 'lib/runtimeProfileWire.ts', 'lib/runtimeProfileManager.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file)), entry).toEqual([])
      expect(closureOf(entry).has('lib/runtimeProfile.ts'), entry).toBe(false)
    }
  })

  it('screen transport and input authority do not load native screen implementations', () => {
    for (const entry of ['core/input.ts', 'core/questions.ts', 'core/engines/screens.ts', 'core/engines/screenTransport.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file)), entry).toEqual([])
    }
  })

  it('the gateway reaches the core only through core/api.ts: never a core module, the registry, cli.ts or the socket', () => {
    // It speaks to the core through GatewayPort and GatewayEvents alone, so that it can run in a process of
    // its own (step 10, R2) without taking any of the core with it.
    const wrong = importsIn('gateway').filter(({ from, typeOnly }) => {
      if (/(^|\/)core\//.test(from)) return from !== '../core/api.js' || !typeOnly
      if (/(^|\/)(cli|backendSocket|localWsServer)\.js$/.test(from)) return true
      return /(^|\/)lib\/registry\.js$/.test(from)
    }).map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'The gateway is the relay, not the core: what it needs of the core is an event in GatewayEvents (src/core/api.ts).').toEqual([])
    expect(importsIn('gateway').some(({ from, typeOnly }) => from === '../core/api.js' && typeOnly)).toBe(true)
  })

  it('the master holds no feature code: Node itself, its own folder, and the log trimmer', () => {
    const wrong = importsIn('harnessd').filter(({ from }) => !from.startsWith('node:') && !from.startsWith('./') && from !== '../lib/log.js')
      .map(({ file, from }) => `${file} imports ${from}`)
    expect(wrong, 'The master is the one process that must not fail: no feature code in it (src/harnessd/AGENTS.md).').toEqual([])
  })

  it('the core\'s process loads no edge file but those listed, and reports source size for review', () => {
    const closure = closureOf('core/main.ts')
    const lines = [...closure.values()].reduce((sum, count) => sum + count, 0)
    // The October 6 TUI merge exposed the problem with the old line caps: a safe shell-return fix
    // failed despite adding no dependency. Report size, but gate actual boundaries below. Runtime
    // cost belongs to e2e/perf.e2e.ts; crash and hang isolation to e2e/serviceProcesses.e2e.ts.
    console.info('[architecture] source size (informational):', JSON.stringify({
      coreClosureLines: lines,
      coreClosureFiles: closure.size,
      runForegroundLines: runForegroundLines(),
      backendSocketLines: readFileSync(join(SRC, 'backendSocket.ts'), 'utf8').split('\n').length,
    }))
    const edge = [...closure.keys()].filter((file) => EDGE.some((pattern) => pattern.test(file))).sort()
    expect(edge.filter((file) => !CORE_MAY_REACH[file]), 'The core reaches a service only through its link and manifest (core/api.ts), never its code: import it from the service, not the core.').toEqual([])
    expect(Object.keys(CORE_MAY_REACH).filter((file) => !closure.has(file)), 'No longer loaded by the core: remove it from CORE_MAY_REACH').toEqual([])
  }, WALK_TIMEOUT_MS)

  it('finds what it checks: imports of every kind, in every folder', () => {
    const services = importsIn('services')
    expect(services.some(({ from, typeOnly }) => from === '../core/api.js' && typeOnly)).toBe(true)
    expect(services.some(({ from, typeOnly }) => from === '../core/api.js' && !typeOnly)).toBe(true)
    expect(importsIn('core').some(({ from, typeOnly }) => /backendSocket\.js$/.test(from) && typeOnly)).toBe(true)
    expect(importsIn('harnessd').some(({ from }) => from.startsWith('node:'))).toBe(true)
    expect(runForegroundLines()).toBeGreaterThan(0)
    // Every kind of import the closure follows, and the one it does not.
    const imports = valueImports('example.ts', [
      "import type { A } from './a.js'", "import { type B } from './b.js'", "import { C, type D } from './c.js'",
      "export { E } from './e.js'", "export type { F } from './f.js'", "import './g.js'",
      "const h = async () => import('./h.js')", "import { readFileSync } from 'node:fs'",
    ].join('\n'))
    expect(imports).toEqual(['./c.js', './e.js', './g.js', './h.js'])
    // The bundle's entry reaches the CLI only through a dynamic import (entry.ts), and the core's entry its own modules.
    expect(closureOf('entry.ts').has('cli.ts')).toBe(true)
    expect(closureOf('core/main.ts').has('core/api.ts')).toBe(true)
    expect(closureOf('core/main.ts').has('cli.ts')).toBe(false)
    // The core loads the services' own code only when they run in its process: imported dynamically, and
    // only from its entry, the import is not followed. Any other import of it is.
    const main = importsFor('core/main.ts', readFileSync(join(SRC, 'core', 'main.ts'), 'utf8')).filter(({ from }) => from === '../services/inline.js')
    expect(main).toEqual([{ from: '../services/inline.js', dynamic: true }])
    expect(closureOf('core/main.ts').has(IN_PROCESS_ONLY)).toBe(false)
    expect(importsFor('example.ts', "import { startSearch } from './services/inline.js'")).toEqual([{ from: './services/inline.js', dynamic: false }])
    for (const exception of Object.keys(SERVICE_MAY_IMPORT)) {
      const [file, from] = exception.split(' → ')
      expect(services.some((found) => found.file === file && found.from === from), `${exception} is no longer needed: remove it`).toBe(true)
    }
  }, WALK_TIMEOUT_MS)
})
