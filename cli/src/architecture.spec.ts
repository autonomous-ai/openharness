/**
 * The daemon's shape, checked: master, core, services (cli/AGENTS.md). People and their coding agents
 * build features in parallel on it, and a rule nobody checks is a rule the next change breaks quietly.
 * So the boundaries are tests: a service reaches the core only through `core/api.ts`, the core never
 * reaches into a service, the master holds no feature code, and the two files every change used to land
 * in — `runForeground` and the socket's request switch — may not grow back.
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

/**
 * The most each may grow to: its size when it last shrank, and a little room for wiring. Lower a budget
 * when you move code out; raising one needs a reason a reviewer agrees with, and the usual one is wrong:
 * the code belongs in a module or a service.
 *
 * RUN_FOREGROUND_BUDGET went up from 2,572 on 5 October, when the socket's request cases moved into core
 * modules: binding each of them is the wiring this function is for. backendSocket.ts lost 615 lines in
 * those moves, and runForeground gained 28. Down to 2,380 on 6 October (step 11), at 2,346: a core on its
 * own hands an update to a master, which judges it, and no longer spawns, judges and rolls back a core.
 *
 * BACKEND_SOCKET_BUDGET came down again on 6 October (step 7): the Model Manager's grid commands, the grid
 * name it worked out and the model lists it built moved to the models service, 1,457 → 1,391 lines.
 *
 * Lowered to 2,230 the same day (step 9, D1): the dial's host, its window bridges and the fleet left
 * runForeground for the devices' own service (services/devices.ts), 2,375 lines to 2,213. Then 2,240 (step 9,
 * D2): the devices' link to their own process and its routes, as every service there has, 2,213 to 2,232.
 * Then 2,230 (step 9, D3): the Wi-Fi device's wiring went with them (core/wifi.ts, core/wifiAgents.ts),
 * 2,232 lines to 2,227, though its link to the devices' process came in.
 */
const RUN_FOREGROUND_BUDGET = 2_230
/** Lowered from 2,180 when the relay and its E2EE left the socket for the gateway (step 10, R1: 1,440).
 *  The Wi-Fi device's relay came back to it in R2, beside the device service it answers for, over the
 *  gateway's sessions (lib/autonomous-device/overGateway.ts): 1,460. Models' grid commands, grid name and
 *  lists left it for the models service (step 7): 1,391. Then 1,200 when the Devices tab's requests
 *  became the devices' own (step 9, D1), 1,207 → 1,194. Then 1,195 when the Wi-Fi device's relay left
 *  it for the devices' process (step 9, D3): the socket hands its sessions' events on (core/wifi.ts). */
const BACKEND_SOCKET_BUDGET = 1_195

/** Exceptions, each with its reason. Keep this short. */
const SERVICE_MAY_IMPORT: Record<string, string> = {
  // The search process builds, in its own process, the core API search runs on; this reader is a pure
  // function of a session row, the same one the core hands search through CoreApi.
  'services/searchProcess.ts → ../core/transcripts/databaseHistory.js': 'the core API search runs on, built in its own process',
  // A pure function of a session row. Move it out of registry.ts when workspaces leaves the core's process.
  'services/workspaces.ts → ../lib/registry.js': 'sessionDisplayTitle, a pure helper',
}

/**
 * The core's process: what `harness __run` loads, walked from its entry (core/main.ts). The plan's
 * target is 61,000 lines, with nothing from an edge folder in it (docs/design/2026-10-06-core-boundary-next.md).
 * Each step that moves code out of the core's process lowers this to the new number in the same change,
 * so the core cannot grow back; a change that must grow it says why here.
 *
 * Measured at 105,714 lines in 450 files on 6 October, when runForeground moved out of cli.ts (step 1),
 * against 114,622 in 488 walked from cli.ts: the CLI's own commands left the core's process.
 *
 * Grew by 54 the same day for three Linux bugs in the core's own launch and hook paths, found by the
 * end-to-end suite's first Linux runs (#843): zsh's new-user menu kept out of an agent's pane
 * (lib/engineLaunch.ts), a hook's ancestry read as it arrives (core/engines/hooks.ts), and a relaunch
 * that must stay up to count (core/agents/swap.ts).
 *
 * Grew by 58 for the turn a blocking Stop hook continues (a Claude /goal loop): it is the turn lifecycle,
 * which only the core's transcript normalizer and Stop-hook fallback can keep.
 *
 * Then at 102,019 in 430 with #893's shell launch (step 5), from 106,006 in 451: search, the viewers, workspaces, usage, the
 * monitor and the project readers run in processes of their own, and their code is loaded into the
 * core's only when they run there instead (services/inline.ts). Then at 101,896 in 430 (step 6): the
 * Store runs beside the viewers.
 *
 * Grew to 102,524 in 433 (step 10, R1), from 101,896 in 430: the relay and its E2EE left the socket for
 * the gateway (gateway/gateway.ts, gateway/upstream.ts) behind the two interfaces it speaks to the core
 * through (`GatewayPort`, `GatewayEvents` in core/api.ts), still in the core's process. The socket lost
 * 742 lines; the gateway's 1,193 and the interfaces' 110 are loaded until R2 runs the gateway in a process
 * of its own, which takes them, the E2EE manager and the P2P channels out of the core's process.
 *
 * Then at 95,689 in 420 (step 10, R2), from 102,524 in 433: the gateway runs in a process of its own (gateway/gatewayProcess.ts),
 * and the core loads it only to run it in its own process instead (services/inline.ts). With it went the
 * E2EE manager, the backend link, P2P and STUN, the windows' relay pool, the trust group and the device
 * key log. What of lib/e2ee the core still loads is the fleet's lane (R3) and Share's own crypto (step 8).
 *
 * Grew by 67 to 95,757 in 420 for the daemon's periodic CPU, measured on harnessd-core 0.3.58/0.3.59: the
 * dial scan runs `ioreg` (~150 ms of CPU every 2 s, about 7.5% of a core) only when /dev/cu.* changes
 * (cable/serial.ts, +31, with one confirming scan after each change or phantom port, since devfs and the
 * IORegistry do not change together); a deleted executable already found by `lsof -d txt` (~18 ms every
 * 5 s, about 0.4%) is not asked about again every 5 s (lib/tmux.ts and lib/nativeProcessImages.ts,
 * +32); and an unchanged registry.json is not rewritten every 5 s (about 720 writes an hour) because
 * its keys were in another order (lib/registry.ts, +4). The dial's part leaves with step 9 (the devices
 * process).
 */
//
// Connected TUI shells added a literal-argv launch port and shell service (#893, 160 loaded lines); moving
// the search filename out of its CLI command removed 188, so that change lowered the closure by 28.
//
// Then at 95,340 in 416 (step 10, R3), from 95,757 in 420: the fleet's lane seals through the gateway, so
// the session crypto it ran in the core's process (lib/e2ee/relayClient.ts and what it loads) is the
// gateway's alone, and the Share relay (sharing/relay.ts) runs in the gateway with the relay's other sockets.
// What a service in its own process may ask of the account (core/accountQueries.ts) is the 41 lines added.
//
// Then at 95,374 in 417 (step 11), from 95,380: a core on its own hands an update to a master on the new
// build, which judges it, instead of spawning a core and judging it itself. Not the 180 lines the plan
// counted on: a core still runs without a master when an older release's own handoff started it.
//
// Then at 89,632 in 401 (step 7), from 95,374 in 417: models runs in a process of its own, the Jev catalog's
// 97 lines (#888) with it, and the core reaches grid only through its port (core/modelsLink.ts), keeping
// which `grid` a pane runs (lib/gridBinary.ts), how a frame reads a grid's note (lib/gridAnnotation.ts) and
// the launchers (lib/launchers.ts).
//
// Then at 89,761 in 402 (step 8, its first change), from 89,632 in 401: delivered turns (core/deliveries.ts), the one way the Wi-Fi
// device, the teams and the orchestrator write a turn and hear of it, which lets the latter two run in
// processes of their own. Its lines are added here, ahead of the moves that take the teams and the
// orchestrator out of this process.
//
// Then at 89,443 in 402, from 89,796 in 402: the orchestrator is an experiment, in a process of its own
// started only once it is on (services/orchestratorProcess.ts); its 640 lines leave. What stays is what any
// experiment acts on the core through (core/experiments.ts, core/experimentQueries.ts) and what the core
// keeps of the orchestrator (core/orchestratorLink.ts): 290 lines.
//
// Then at 88,080 in 392, from 89,443 in 402: Tab collaboration and teams are an experiment, in the teams'
// process beside the prompt scopes (services/collaborationProcess.ts), started only once on; the team
// service, its mailbox, the tab channels and their wire (1,700 lines) leave. What stays: the team write hold
// the core reads a pane with as it writes a team's turn, now lib/teamWriteHold.ts, and what the core keeps of
// the teams' process (core/teamsLink.ts: which deliveries may be written, the scopes' own questions) and of
// the account's notices (core/experiments.ts).
//
// Then at 87,476 in 387, from 88,083 in 392: Share is an experiment, in a process of its own started only
// once on (services/sharingProcess.ts), holding no credential: the owner, its stores, its crypto and the
// identity store it signed with leave. Its welcomes are signed by the gateway (gateway/observerKey.ts), and
// its observers' terminals are read by the core's read-only stream manager (core/terminalWatch.ts), which
// stays with what the core keeps of Share (core/sharingLink.ts).
//
// Grew to 87,941 in 389 (step 9, D1), from 87,476 in 387: the devices behind a port of their own, still in
// the core's process (services/devices.ts, services/devicesGuard.ts, the port and its `CoreApi` members in
// core/api.ts). runForeground lost their wiring and the pane writer lock came into the core
// (core/deviceInput.ts). D2 runs the devices in a process of their own, which takes them out: the dial,
// the window bridges, the fleet's router and lane, and the voice router, about 10,000 lines.
//
// Then at 77,669 in 358 (step 9, D2), from 87,941 in 389: the devices run in a process of their own
// (services/devicesProcess.ts; the core's side is core/devicesLink.ts), and the core loads their code only
// to run them in its process instead (services/inline.ts). With them went the dial (cable/), the window
// bridges, the fleet's router and its lane to the owner's other machines, and the voice router with its
// engine worker pool, and the E2EE code the fleet read the linked machines with (lib/e2ee/machinePeers.ts).
//
// Then at 75,746 in 345 (step 9, D3), from 77,669 in 358: the Wi-Fi device's service, its relay, its
// receipts and streams and its Store preparations run with the dials (services/wifi.ts, in the devices'
// process; the core's side is core/wifi.ts and core/wifiLink.ts), and with them went the Store's installs
// and catalog, which only the device's preparations reached from the core.
//
// Then at 75,456 in 344, from 75,746 in 345: the web dashboard (webui.ts, `GET /`, its log tail and stop
// button, and its port in `e2e_status`) is deleted. Nothing opened it: no app, website, script or the
// backend, and the web client that linked to it retired with the browser setup links (#348).
//
// Grew by 37 to 75,493 in 344, from 75,456, for the notice that the connection a routed request came over closed
// (core/serviceHost.ts, core/serviceLinks.ts, the socket's close paths), held requests for an experiment
// still starting included: what lets a service keep work per connection and stop it when its asker goes,
// which held the command bar's two doors in the core (step 4).
const CORE_CLOSURE_BUDGET = 75_590

/** What is not the core's, by path: each goes to a service or its own process, in the plan's order. */
const EDGE: RegExp[] = [
  /^gateway\//, /^lib\/e2ee\//, /^cable\//, /^device\//, /^lib\/autonomous-device\//, /^sharing\//, /^teams\//, /^orchestrator\//, /^services\//,
  /^lib\/grid(Attach|Credentials|Derive|Ensure|Exec|FleetRpc|Handoff|Install|McpUrl|Models|ModelsPayload|Picture|Presence|Reader|Target|Wake)\.ts$/,
  /^lib\/localModels\.ts$/,
  // The relay's own parts, the gateway's alone: the windows' sessions to other machines, P2P and STUN, the
  // remote viewers' proxy, and the shaping of what goes up the link.
  /^lib\/(remoteRelay|terminalP2p|stunSelect|remoteViewerProxy|deviceRecentTrim|commanderReplay)\.ts$/,
  // The Store's and the viewers' parts of dsh; the launch path (installed, manifest, launch, runtime, …) is the core's.
  /^dsh\/(catalog|install|update|updates|registry|wire|service|lock|builtins|viewer|viewerLedger|verdict|artifacts)\.ts$/,
  // Search's index; the readers of other engines' sessions (external.ts, externals/) are the core's, for adoption.
  /^lib\/sessionSearch\/(?!external\.ts$|externals\/)/,
]

/**
 * The edge files the core's process still loads, each with the step of the plan that takes it out. The
 * list only shrinks: an entry no longer reached fails the test, so remove it with the move that ends it.
 */
const CORE_MAY_REACH: Record<string, string> = {
  'device/machineList.ts': 'the account\'s machine list, which /api/machines answers from and the trust group reads: with the account proxies (step 10)',
  'dsh/builtins.ts': 'the bundled harnesses are put in place by the core\'s start, which cli.js carries them for anyway; in the Store\'s lean process they cost a second copy (core/main.ts)',
  'dsh/lock.ts': 'with dsh/builtins.ts',
  'dsh/registry.ts': 'with dsh/builtins.ts, which checks the bundled harnesses against the catalog\'s entries',
  'dsh/updates.ts': 'with dsh/builtins.ts',
  'lib/autonomous-device/localApi.ts': 'the hook server\'s routes for `harness device`, which the core serves: the pairings they answer are the gateway\'s, the receipts the Wi-Fi device\'s service\'s',
  'lib/sessionSearch/sessionTurns.ts': 'the handoff (lib/agentHandoff.ts), in the edge host once CoreApi gives it the stopped agents, recaps and discovery it reads',
  'lib/sessionSearch/transcript.ts': 'the readers of other engines\' sessions keep this helper: it moves beside them, out of search\'s folder',
  'lib/sessionSearch/turns.ts': 'the handoff (lib/agentHandoff.ts), in the edge host once CoreApi gives it the stopped agents, recaps and discovery it reads',
  'services/shell.ts': 'shell setup and launch receipts, in the edge host; only the argv launch stays in the core (#893)',
  'sharing/viewer.ts': 'the windows\' interactive viewers capture with it (lib/interactiveViewer.ts): headless Chrome belongs with the viewers\' process (plan, "Sharing")',
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

  it('runForeground and the socket\'s request switch do not grow back', () => {
    const runForeground = runForegroundLines()
    const backendSocket = readFileSync(join(SRC, 'backendSocket.ts'), 'utf8').split('\n').length
    expect(runForeground, `runForeground is ${runForeground} lines, over its ${RUN_FOREGROUND_BUDGET}: it wires modules together. Put behaviour in a core module (src/core/) or a service (src/services/).`).toBeLessThanOrEqual(RUN_FOREGROUND_BUDGET)
    expect(backendSocket, `backendSocket.ts is ${backendSocket} lines, over its ${BACKEND_SOCKET_BUDGET}: it is transport. A request's handler is one call into a module or a service.`).toBeLessThanOrEqual(BACKEND_SOCKET_BUDGET)
  })

  it('the core\'s process loads no more than its budget, and no edge file but those listed', () => {
    const closure = closureOf('core/main.ts')
    const lines = [...closure.values()].reduce((sum, count) => sum + count, 0)
    expect(lines, `The core's process loads ${lines} lines in ${closure.size} files, over its ${CORE_CLOSURE_BUDGET}. Put the new code in a service (src/services/AGENTS.md), or lower what it replaces.`).toBeLessThanOrEqual(CORE_CLOSURE_BUDGET)
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
    expect(runForegroundLines()).toBeGreaterThan(1_000)
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
