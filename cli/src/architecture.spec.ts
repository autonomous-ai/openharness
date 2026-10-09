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
import { OTHER_ENGINES } from './engines/inProcess.js'

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
 * The files whose `import()`s the core's walk does not follow: the loader of the other twelve engines' code,
 * which the core loads in its own process only once one of their sessions needs it
 * (docs/design/2026-10-08-other-engines-out-of-core.md). An `import()` of their code anywhere else is followed.
 */
const LAZY_LOADERS = new Set(['engines/inProcess.ts'])

/**
 * The code a process started on `entry` runs: every file its imports reach, as each file's lines
 * (docs/design/2026-10-06-core-boundary-next.md, "The target, and its test"). It follows static and
 * dynamic imports under src, `.js` to `.ts` and folders to their index, and leaves out `import type`
 * (types cost nothing at run time), tests, a dynamic import of `IN_PROCESS_ONLY`, and the `import()`s written
 * in `LAZY_LOADERS`.
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

/** Whether the walk follows an import of `target` written in `importer`: every one but an `import()` of
 *  `IN_PROCESS_ONLY`, or one written in a lazy loader. */
function followed(importer: string, target: string, dynamic: boolean): boolean {
  return !dynamic || (target !== IN_PROCESS_ONLY && !LAZY_LOADERS.has(importer))
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
    if (!followed(relative(SRC, path), relative(SRC, target), dynamic)) continue
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

/** Claude Code's and Codex's declared contracts that core reads in line: what a launch's, discovery's or session
 *  repair's closure may reach of the two engines. */
const LAUNCH_CONTRACTS = new Set(['engines/claude/launch.ts', 'engines/codex/launch.ts'])
const SESSION_STORES = new Set(['engines/claude/sessionStore.ts', 'engines/codex/sessionStore.ts'])
const DECLARED = new Set(['engines/claude/hookContract.ts', 'engines/codex/hookContract.ts', 'engines/claude/discoveryContract.ts',
  'engines/codex/discoveryContract.ts', ...SESSION_STORES])

/** What is not the core's, by path: each goes to a service or its own process, in the plan's order. */
const EDGE: RegExp[] = [
  /^engines\/(claude|codex)\/(screen|composer|activity|stoppedGoal|modelControl|modelPicker|questionControl|submission|nativeControl)\.ts$/,
  // Claude Code's and Codex's hooks are declared data (hookContract.ts) that the kit applies in core: no hook code
  // of theirs is the core's, and none runs in a worker either (docs/design/2026-10-08-engine-hooks.md).
  /^engines\/(claude|codex)\/(hooks|installHooks)\.ts$/,
  // Their launch specifics are declared data too (launch.ts): Codex's startup probe and retry and its own-login
  // provider are the kit's, in core, and never a worker's (docs/design/2026-10-08-engine-launch.md).
  /^engines\/codex\/ownLoginProvider\.ts$/, /^lib\/codexStartupRetry\.ts$/,
  // So is their launch preparation: folder trust and the resume repair are declared, and the kit applies them.
  /^engines\/codex\/portableHistory\.ts$/, /^lib\/claudeTrust\.ts$/,
  // And what discovery reads off their processes and transcripts (discoveryContract.ts, applied by the kit).
  /^lib\/(claudeProject|codexHomeProbe)\.ts$/,
  /^lib\/(askQuestion|runtimeProfileController|composerScreen|teamWriteHold|messageHold|terminalActivity|codexTurnRecovery)\.ts$/,
  /^engines\/(screens|modelControls|questionControls|submissions|nativeControls)\.ts$/,
  // Claude Code's and Codex's reading of their composer: shared by the two, loaded only by their workers.
  /^engines\/kit\/nativeSubmission\.ts$/,
  // A worker's request handlers, the submission readers' among them, run in the engine's own process.
  /^engines\/worker\/\w+Requests\.ts$/,
  // The pilot reader implementations and their host are never loaded by supervised core.
  /^engines\/(worker\/process|transcripts|(claude|codex)\/(transcript|\w+ReaderProcess))\.ts$/,
  // Nor their transcripts' normalizers, Codex's rollout and sub-agent readers, or what replays their history: their
  // readers' and live parsers', in their workers. Core reads only what they declare: adoption, activity and
  // their stores (docs/design/2026-10-08-engine-launch.md, (c5)). Search's normalizer table is search's.
  /^engines\/(claude|codex)\/(normalize|normalizer|subagent|subagentStats|rollout|lastTurn|live|attach)\.ts$/,
  /^lib\/(normalize|transcriptReader)\.ts$/, /^lib\/sessionSearch\/externals\/(claude|codex)\.ts$/,
  /^engines\/(runtime|(claude|codex)\/runtimeProfile)\.ts$/, /^lib\/runtimeProfile\.ts$/,
  /^gateway\//, /^lib\/e2ee\//, /^cable\//, /^device\//, /^lib\/autonomous-device\//, /^sharing\//, /^teams\//, /^orchestrator\//, /^services\//,
  /^lib\/grid(Attach|Credentials|Derive|Ensure|Envelope|Exec|FleetRpc|Handoff|Install|McpUrl|Models|ModelsPayload|Picture|Presence|Reader|Target|Wake)\.ts$/,
  /^lib\/localModels\.ts$/,
  // The grid and saved-API launch builders are models': the core asks it for a launch (ModelsPort.gridLaunch) and keeps
  // only the wire it checks one with and the lists every launch reads (lib/gridLaunchWire.ts), so a launch on the
  // engine's own login loads none of them (docs/design/2026-10-08-launch-port.md, (L1)).
  /^lib\/(gridLaunch|gridWebMcp|apiModels)\.ts$/,
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
  // Package execution belongs to the Store; core retains the installed index and launch contracts.
  /^dsh\/(catalog|install|update|updates|registry|wire|service|lock|builtins|viewer|viewerLedger|verdict|artifacts|runtime|materialize|shell)\.ts$/,
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
const CORE_MAY_REACH: Record<string, string> = {}

/** The other twelve engines' own files: their folders but for the data they declare, their search readers, and the
 *  shared files that hold only their code. */
const OTHERS = `(${OTHER_ENGINES.join('|')})`
const THEIRS: RegExp[] = [
  new RegExp(`^engines/${OTHERS}/(?!contract\\.ts$)`),
  new RegExp(`^lib/sessionSearch/externals/${OTHERS}\\.ts$`),
  /^lib\/(hooks|questionPane|legacyScreen|legacyPane|hermesHome|databaseHistory)\.ts$/,
]
const theirs = (file: string): boolean => THEIRS.some((pattern) => pattern.test(file))

/**
 * The other engines' files the core's process still loads, each with the sub-batch of the plan that takes it out
 * (docs/design/2026-10-08-other-engines-out-of-core.md, section 5). The list only shrinks: an entry no longer
 * reached fails the test, so remove it with the move that ends it. Empty, the core loads none of their code.
 */
const OTHER_ENGINES_CORE_MAY_REACH: Record<string, string> = {}

/** Core's entries for each facet, and the sub-batch after which they reach none of the other engines' files. */
const FACETS_FREE_OF_THEM: Array<[string, string]> = [
  ['core/engines/screens.ts', '(o1)'],
  ['lib/questionController.ts', '(o1)'],
  // The live path, history and the last turn; and the core's own files that once held their code: Cursor's
  // Task hooks, built from its code on first use, agy's backstop, and the database engines' history.
  ['core/transcripts/ingest.ts', '(o3)'],
  ['core/transcripts/attach.ts', '(o3)'],
  ['core/transcripts/history.ts', '(o3)'],
  ['core/transcripts/lastTurn.ts', '(o3)'],
  ['core/transcripts/databaseHistory.ts', '(o3)'],
  ['core/engines/cursorTasks.ts', '(o3)'],
  ['core/turns/agyBackstop.ts', '(o3)'],
  // What the core reads of their model and effort, and how a switch of theirs would be driven.
  ['lib/runtimeProfileManager.ts', '(o4)'],
  ['lib/runtimeControl.ts', '(o4)'],
  // Where their conversations are: the registry's layouts and Cursor's homes, declared; bind's finders and
  // repair's readers, loaded; Cursor's discovery and its queued Tasks, built on first use; Hermes's store.
  ['lib/registry.ts', '(o6)'],
  ['core/agents/bind.ts', '(o6)'],
  ['lib/sessionRepair.ts', '(o6)'],
  ['core/engines/cursorDiscovery.ts', '(o6)'],
  ['core/agents/forget.ts', '(o6)'],
  ['core/turns/turnHooks.ts', '(o6)'],
  ['engines/kit/notifyHooks.ts', '(o6)'],
  ['lib/sessionCheckpoint.ts', '(o6)'],
  ['lib/purgeAgentService.ts', '(o6)'],
  // Hermes's admission and homes, declared and read by the kit; its home probe, loaded for a Hermes process.
  ['hookServer.ts', '(o6)'],
  ['core/engines/hooks.ts', '(o6)'],
  ['lib/terminalAgentDiscovery.ts', '(o6)'],
  // The launches: OpenCode's v2 rule declared, its version probe and session-model writer loaded for OpenCode.
  ['core/agents/create.ts', '(o6)'],
  ['core/agents/fork.ts', '(o6)'],
  ['core/agents/launches.ts', '(o6)'],
  ['core/agents/retarget.ts', '(o6)'],
  ['core/agents/restart.ts', '(o6)'],
  ['lib/launchOverrides.ts', '(o6)'],
  ['lib/engineLaunch.ts', '(o6)'],
  ['lib/gridLaunch.ts', '(o6)'],
  ['lib/subscriptionModel.ts', '(o6)'],
  // Adoption: the other engines' readers, each loaded on the first scan or question that needs it.
  ['lib/sessionSearch/externals/index.ts', '(o5)'],
  ['lib/sessionSearch/external.ts', '(o5)'],
  ['core/agents/adopt.ts', '(o5)'],
]

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

  it('screen, submission and native-control brokers and input authority do not load the engines\' native code', () => {
    for (const entry of ['core/input.ts', 'core/questions.ts', 'core/engines/screens.ts', 'core/engines/screenTransport.ts',
      'core/deviceInput.ts', 'lib/sessionInput.ts', 'core/engines/submissions.ts', 'core/engines/submissionTransport.ts',
      'core/engines/nativeControls.ts', 'core/turns/activity.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file)), entry).toEqual([])
    }
  })

  it('hook installation, admission, transcript correction and turn closing load the engines\' declared hook contracts alone', () => {
    const contracts = new Set(['engines/claude/hookContract.ts', 'engines/codex/hookContract.ts'])
    for (const entry of ['engines/hooks.ts', 'engines/kit/hookSettings.ts', 'engines/kit/hookRules.ts', 'engines/kit/stopHook.ts',
      'core/turns/turnHooks.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file) && !contracts.has(file)), entry).toEqual([])
    }
    expect([...closureOf('engines/hooks.ts').keys()].filter(file => contracts.has(file)).sort()).toEqual([...contracts].sort())
  })

  it('discovery loads the engines\' declared contracts alone', () => {
    // The pass and what it reads off a process, the grid's model, the start-up repair, and the registry.
    for (const entry of ['lib/tmux.ts', 'lib/terminalAgentDiscovery.ts', 'lib/gridAssignment.ts', 'lib/cwdRepair.ts', 'lib/registry.ts',
      'engines/discoveries.ts', 'engines/kit/processFacts.ts', 'engines/kit/projectFolder.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file) && !DECLARED.has(file) && !LAUNCH_CONTRACTS.has(file)), entry).toEqual([])
    }
    expect([...closureOf('engines/discoveries.ts').keys()].filter(file => /^engines\/(claude|codex)\//.test(file)).sort())
      .toEqual(['engines/claude/discoveryContract.ts', 'engines/codex/discoveryContract.ts'])
  })

  it('the registry\'s load, session repair, resume capture and the handoff load the engines\' declared session stores alone', () => {
    // Binding a session, finding it by its id, by its process or by a scan, and putting back a parent's: session
    // control, with no engine worker and none of the two engines' code (docs/design/2026-10-08-engine-launch.md, (c4)).
    const theirs = (entry: string): string[] => [...closureOf(entry).keys()]
      .filter(file => /^engines\/(claude|codex)\//.test(file) && !DECLARED.has(file) && !LAUNCH_CONTRACTS.has(file))
    // Pi's session reader, which session repair names Pi's folders with, streams lines (lib/transcriptLines.ts) and no
    // longer loads the readers of the two engines' transcripts ((c5)).
    for (const entry of ['lib/registry.ts', 'lib/handoffDiscovery.ts', 'lib/engineHomes.ts', 'engines/sessionFiles.ts',
      'engines/sessionStoreContracts.ts', 'engines/kit/sessionRecords.ts', 'engines/kit/continuation.ts',
      'lib/sessionRepair.ts', 'lib/captureResumeIdentity.ts', 'engines/sessionStores.ts', 'core/agents/bind.ts']) {
      expect(theirs(entry), entry).toEqual([])
    }
    // The stores alone, and what Codex's shares with its launch and hook contracts (the rollout layout, the child rule).
    expect([...closureOf('engines/sessionStoreContracts.ts').keys()].filter(file => /^engines\/(claude|codex)\//.test(file)).sort())
      .toEqual(['engines/claude/sessionStore.ts', 'engines/codex/hookContract.ts', 'engines/codex/launch.ts', 'engines/codex/sessionStore.ts'])
    // The kit's mechanics know no engine at all.
    for (const entry of ['engines/kit/sessionRecords.ts', 'engines/kit/continuation.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file)), entry).toEqual([])
    }
  })

  it('adoption, activity, pages, history and the last turn load the engines\' declarations alone, never their normalizers', () => {
    // Which conversations are on this machine and which process holds one (taking one over stops that process),
    // an agent's latest activity, a thread's pages and line count, and core's history and recap reads
    // (docs/design/2026-10-08-engine-launch.md, (c5)). Their replays are their readers', in their workers.
    const adoption = new Set(['engines/claude/adoption.ts', 'engines/codex/adoption.ts'])
    const declared = new Set([...DECLARED, ...LAUNCH_CONTRACTS, ...adoption])
    const theirs = (entry: string): string[] => [...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file) && !declared.has(file))
    for (const entry of ['engines/adoptions.ts', 'engines/kit/adoption.ts', 'lib/transcriptActivity.ts', 'lib/transcriptPages.ts',
      'lib/transcriptLines.ts', 'core/transcripts/history.ts', 'core/transcripts/lastTurn.ts', 'lib/agentFrame.ts',
      'lib/sessionSearch/external.ts']) {
      expect(theirs(entry), entry).toEqual([])
    }
    // Adoption's composition reads the two declarations (and, through the process table, the discovery contracts).
    expect([...closureOf('engines/adoptions.ts').keys()].filter(file => adoption.has(file)).sort()).toEqual([...adoption].sort())
    // The pager, the line streamer and the paged history know no engine at all: each engine's reader hands the pager
    // its rules. The kit's adoption names none either; it reads the process table (lib/tmux.ts) to match an owner.
    for (const entry of ['lib/transcriptPages.ts', 'lib/transcriptLines.ts', 'engines/kit/history.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(?!kit\/|facets\/|types\.ts$)/.test(file)), entry).toEqual([])
    }
    expect(parsedFile(join(SRC, 'engines/kit/adoption.ts')).imports.map(path => relative(SRC, path)).filter(file => /^engines\/(?!kit\/|facets\/)/.test(file))).toEqual([])
    // Core's adoption reaches none of the two engines' code: Devin's reader, which replays its store with Claude
    // Code's normalizer, is loaded with Devin's code ((o5)).
    expect(theirs('lib/sessionSearch/externals/index.ts')).toEqual([])
  })

  it('building a launch loads the engines\' declared launch contracts alone', () => {
    const contracts = new Set(['engines/claude/launch.ts', 'engines/codex/launch.ts'])
    // The builders: the argv and its script, a relaunch's overrides, a harness's flags. The homes they launch in
    // are read with the session stores' declarations (lib/engineHomes.ts), data as well.
    for (const entry of ['lib/engineLaunch.ts', 'lib/launchOverrides.ts', 'engines/launches.ts', 'engines/kit/launchArgs.ts',
      'engines/kit/launchStartup.ts', 'dsh/adapters.ts', 'engines/launchPrep.ts', 'engines/kit/folderTrust.ts',
      'engines/kit/resumeRepair.ts', 'dsh/runtime.ts', 'lib/apiInstructions.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file) && !contracts.has(file)
        && !SESSION_STORES.has(file) && file !== 'engines/codex/hookContract.ts'), entry).toEqual([])
    }
    expect([...closureOf('lib/engineLaunch.ts').keys()].filter(file => contracts.has(file)).sort()).toEqual([...contracts].sort())
    // The launches themselves reach the registry too, whose hook admission reads the hook contracts and whose
    // load-time repair reads the declared session stores. Nothing else of the two.
    const declared = new Set([...contracts, ...DECLARED])
    for (const entry of ['core/agents/create.ts', 'core/agents/fork.ts', 'core/agents/restart.ts', 'core/agents/swap.ts',
      'core/agents/launch.ts', 'core/agents/launches.ts', 'lib/resumeAgentService.ts']) {
      expect([...closureOf(entry).keys()].filter(file => /^engines\/(claude|codex)\//.test(file) && !declared.has(file)), entry).toEqual([])
    }
  })

  it('the core loads the other engines\' code only through engines/inProcess.ts, but for the files still listed', () => {
    const closure = closureOf('core/main.ts')
    const reached = [...closure.keys()].filter(theirs).sort()
    expect(reached.filter((file) => !OTHER_ENGINES_CORE_MAY_REACH[file]), 'Load their code through engines/inProcess.ts (loadEngine), or declare what the core needs of it in engines/<name>/contract.ts.').toEqual([])
    expect(Object.keys(OTHER_ENGINES_CORE_MAY_REACH).filter((file) => !closure.has(file)), 'No longer loaded by the core: remove it from OTHER_ENGINES_CORE_MAY_REACH').toEqual([])
    for (const [entry, batch] of FACETS_FREE_OF_THEM) {
      expect([...closureOf(entry).keys()].filter(theirs), `${entry}, free of their code since ${batch}`).toEqual([])
    }
    // (o2) The start's hook step loads the other engines' installers through the loader; since (o6) it reaches none
    // of their code at all (above).
    expect(closureOf('core/engines/hooks.ts').has('lib/hooks.ts'), 'core/engines/hooks.ts loads lib/hooks.ts through engines/inProcess.ts').toBe(false)
    // What an engine declares is data the kit reads: its own walk reaches the kit, the engines' types and the
    // environment, and nothing of any engine's code.
    const contracts = [...closure.keys()].filter((file) => /^engines\/\w+\/contract\.ts$/.test(file))
    expect(contracts.length).toBeGreaterThan(0)
    const environment = new Set(closureOf('config/env.ts').keys())
    for (const contract of contracts) {
      expect([...closureOf(contract).keys()].filter((file) => file !== contract && !environment.has(file) && !/^engines\/(kit\/|types\.ts$)/.test(file)), contract).toEqual([])
    }
  }, WALK_TIMEOUT_MS)

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
    // The other engines' code: an `import()` of it is passed over in engines/inProcess.ts alone, and followed
    // anywhere else, as is a static import of it from the loader.
    expect(importsFor('engines/inProcess.ts', readFileSync(join(SRC, 'engines', 'inProcess.ts'), 'utf8'))).toContainEqual({ from: '../lib/legacyScreen.js', dynamic: true })
    expect(closureOf('engines/inProcess.ts').has('lib/legacyScreen.ts')).toBe(false)
    expect(followed('engines/inProcess.ts', 'lib/legacyScreen.ts', true)).toBe(false)
    expect(followed('core/main.ts', 'lib/legacyScreen.ts', true)).toBe(true)
    expect(followed('engines/inProcess.ts', 'lib/legacyScreen.ts', false)).toBe(true)
    expect(followed('core/main.ts', IN_PROCESS_ONLY, true)).toBe(false)
    for (const exception of Object.keys(SERVICE_MAY_IMPORT)) {
      const [file, from] = exception.split(' → ')
      expect(services.some((found) => found.file === file && found.from === from), `${exception} is no longer needed: remove it`).toBe(true)
    }
  }, WALK_TIMEOUT_MS)
})
