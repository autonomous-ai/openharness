import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `runForeground` is one very long function, and the restore pass runs in the MIDDLE of it:
 * `restoreAgents` rebuilds every pane whose tmux session died while the daemon was down, calling the
 * deps it was handed — `buildLaunch`, `createPane`, `respawn` — before start-up has reached the rest
 * of the body. A `const` those deps close over but that is declared further down is still in its
 * temporal dead zone then, and the daemon dies on boot:
 *
 *   Failed to start adapter: ReferenceError: Cannot access 'p4' before initialization
 *       at Object.buildLaunch (cli.js:1472:7962)
 *       at async restoreAgents (cli.js:728:2238)
 *       at async runForeground
 *
 * Nothing else catches it: the types are fine, every unit test passes, and the crash only appears on
 * a machine that has a pane to restore (openharness, v0.3.5 on a person's Mac — the daemon would not
 * start at all, twice in a row, until they removed the registry). So the order is asserted here, on
 * the source, rather than left to whoever next adds a helper below the restore block.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'core', 'main.ts'), 'utf-8')
/** The CLI, which starts the core for `harness __run` (coreProcess.ts, then core/main.ts `runCore`). */
const CLI_SOURCE = readFileSync(join(import.meta.dirname, 'cli.ts'), 'utf-8')
/** The one start of the core's process, from cli.ts, cli.js and the lean bundle alike. */
const CORE_PROCESS_SOURCE = readFileSync(join(import.meta.dirname, 'coreProcess.ts'), 'utf-8')

/** `runForeground`'s own body. Other functions are indented the same way; their locals are not ours. */
function runForegroundBody(source: string): { text: string; from: number } {
  const from = source.indexOf('async function runForeground(')
  expect(from, 'core/main.ts still defines runForeground').toBeGreaterThan(-1)
  const end = source.indexOf('\n}\n', from)
  return { text: source.slice(from, end < 0 ? source.length : end), from }
}

/** Where each local of `runForeground` is initialised, by absolute index into the source. */
function localsOf(source: string): Map<string, number> {
  const { text, from } = runForegroundBody(source)
  const declaredAt = new Map<string, number>()
  for (const match of text.matchAll(/^ {2}(?:const|let) ([A-Za-z_$][\w$]*)\s*[:=]/gm)) {
    if (!declaredAt.has(match[1])) declaredAt.set(match[1], from + match.index)
  }
  return declaredAt
}

/** Identifiers a block REFERENCES: member names and the block's own declarations are not references. */
function referencedIn(body: string): string[] {
  const own = new Set([...body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]))
  const outer = body.replace(/\.\s*[A-Za-z_$][\w$]*/g, '')
  return [...new Set(outer.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter(name => !own.has(name))
}

/** The source with comments blanked, so a name mentioned in prose is not read as a reference.
 *  Strings are left alone on purpose: blanking them needs a tokenizer to survive the backticks and
 *  regex literals this file is full of, and a word inside a string cannot match a local's name. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
}

/** The object literal passed to `call`, by brace balance. */
function callArgument(source: string, call: string): { body: string; at: number } {
  const at = source.indexOf(call)
  expect(at, `core/main.ts still contains \`${call}\``).toBeGreaterThan(-1)
  let depth = 0
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return { body: source.slice(at, i + 1), at }
  }
  throw new Error(`unbalanced braces after ${call}`)
}

/** A call and its arguments, by parenthesis balance: what it is handed, whatever brackets they use. */
function callArguments(source: string, call: string): { text: string; at: number } {
  const at = source.indexOf(call)
  expect(at, `core/main.ts still contains \`${call}\``).toBeGreaterThan(-1)
  let depth = 0
  for (let i = at + call.length - 1; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return { text: source.slice(at, i + 1), at }
  }
  throw new Error(`unbalanced parentheses after ${call}`)
}

/** Every call whose dependencies run DURING start-up, before `runForeground` has finished its body. */
const STARTUP_CALLS = ['await repairClaudeCwd({', 'await restoreAgents({']

/** What the prologue is allowed to do before the master's update is listened for: nothing that can throw. */
const PROLOGUE_CALLS = new Set(['installTimestampedConsole'])
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'function'])

describe('the core\'s start-up order (core/main.ts)', () => {
  it.each(STARTUP_CALLS)('every local `%s` reaches is initialised before it runs', (name) => {
    const source = code(SOURCE)
    const { body, at } = callArgument(source, name)
    const declaredAt = localsOf(source)
    const late = referencedIn(body).filter(used => (declaredAt.get(used) ?? -1) > at).sort()
    expect(late, `declare these above the \`${name}\` call — see this file’s header`).toEqual([])
  })

  // ── The invariant the whole safe-boot design rests on ───────────────────────────────────────────
  // A daemon that cannot finish starting is fixed by the build the master's updater stages, and leaves for
  // it only if start-up got as far as listening for the master's request. So that goes first, and
  // everything that can throw or hang goes after. These three say so in the order they are worth reading.

  it('listens for the master\'s update before anything that can throw or hang, and runs no updater itself', () => {
    const source = code(SOURCE)
    const updater = source.indexOf('coreLink.onUpdate(')
    expect(updater, 'core/main.ts still listens for the master\'s update').toBeGreaterThan(-1)
    // The updater is the master's, in its own process (services/updaterProcess.ts): the core downloads no build.
    expect(source).not.toMatch(/startSelfUpdater\(|startTuiUpdater\(/)
    for (const risky of [
      'requireTmuxAvailable(',      // throws outright when tmux is missing
      'await startHookServer(',     // EADDRINUSE on a fixed port with no fallback
      'installSessionHooks(',       // 13 vendor settings files, any of which can be unreadable
      'await restoreAgents({',      // tmux, the registry, and the closures a bad edit puts in a dead zone
      'await agentReconciler.start(',
      'loadCursorPendingTasks(',    // a file lock that can hang, not just throw
    ]) {
      const at = source.indexOf(risky)
      if (at < 0) continue // renamed or gone; the TDZ lint above still covers what remains
      expect(at, `\`${risky}\` must come after coreLink.onUpdate( — a crash there would strand the machine`)
        .toBeGreaterThan(updater)
    }
  })

  it('keeps the prologue itself incapable of throwing', () => {
    // Stronger than listing today's hazards: this is what catches the NEXT line somebody adds on top.
    const source = code(SOURCE)
    const from = source.indexOf('async function runForeground(')
    const to = source.indexOf('coreLink.onUpdate(')
    const prologue = source.slice(source.indexOf('{', from), to)
    expect(prologue.includes('\n  await '), 'no await may precede the update — a hang there is unrecoverable').toBe(false)
    expect(/\n\s*throw /.test(prologue), 'no throw may precede the update').toBe(false)
    const called = [...prologue.replace(/\.\s*[A-Za-z_$][\w$]*\s*\(/g, ' ').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
      .map(match => match[1])
      .filter(name => !KEYWORDS.has(name))
    expect([...new Set(called.filter(name => !PROLOGUE_CALLS.has(name)))].sort(),
      'only calls that cannot fail belong above the update; move this below it, or add it to PROLOGUE_CALLS with a reason')
      .toEqual([])
  })

  it('only swaps in the full restart handler once everything it tears down exists', () => {
    // `bootHandoff` hands the machine over without finishing start-up; the full handoff
    // (core/updateHandoff.ts) tears down two dozen subsystems, handed to it here as its teardown, and may
    // only be armed after every one of them is built.
    const source = code(SOURCE)
    const flip = source.indexOf('daemonBoot.applyStagedUpdate = ')
    expect(flip, 'the handoff handler is still swapped in core/main.ts').toBeGreaterThan(-1)
    expect(callArguments(source, 'updateHandoff.restartForUpdate(').at, 'the handler is the one it swaps in').toBeGreaterThan(flip)
    // Its teardown, which a core with no master hands over with too: built just before the swap.
    const body = callArguments(source, 'const updateTeardown = (')
    const teardown = { text: source.slice(body.at, source.indexOf('\n  ]\n', body.at)), at: body.at }
    expect(teardown.at).toBeLessThan(flip)
    const declaredAt = localsOf(source)
    const late = referencedIn(teardown.text).filter(used => (declaredAt.get(used) ?? -1) > teardown.at).sort()
    expect(late, 'these are torn down by the update handoff but declared after it is armed').toEqual([])
    // What it tears down is all there is to it: the handoff module reaches nothing of runForeground's.
    expect(referencedIn(teardown.text)).toEqual(expect.arrayContaining(['registry', 'hookServer', 'localWsServer', 'backend', 'watcher']))
  })

  it('the daemon arm survives its own start-up failure', () => {
    // The whole arm, to its break: a fixed window read past it as the arm grew a line (the stall fault).
    const cli = code(CLI_SOURCE)
    const start = cli.indexOf("case '__run'")
    const arm = cli.slice(start, cli.indexOf('break', start))
    expect(arm, 'cli.ts starts the core through its process\'s start').toContain('startCoreProcess(')
    expect(arm, 'a daemon that exits here can never be updated').not.toContain('catch(onError)')
    // That start, which entry.ts and the lean bundle's core entry call too, runs the core's entry.
    const processStart = code(CORE_PROCESS_SOURCE)
    expect(processStart, 'coreProcess.ts starts the core through its entry').toContain('runCore(')
    expect(processStart, 'a daemon that exits here can never be updated').not.toContain('catch(onError)')
    // The entry it calls: what the arm did before the core had one of its own.
    const source = code(SOURCE)
    const from = source.indexOf('export function runCore(')
    const entry = source.slice(from, source.indexOf('\n}\n', from))
    expect(entry).toContain('catch(enterSafeMode)')
    expect(entry, 'a daemon that exits here can never be updated').not.toContain('catch(onError)')
  })
})

// ── The request gate ──────────────────────────────────────────────────────────────────────────────
// Requests that arrive while the core is starting wait (`BackendSocket.holdRequests`) and are answered
// in order once start-up is done (`openRequests`). Moving the code that binds the handlers into
// modules (the core boundary, docs/design/2026-10-03-harnessd.md) must keep these exactly.

/** Every place `runForeground` binds a handler on the socket: a property, an owner command, a setter. */
const BINDING = /\bbackend\.(?:ownerCommands\.)?(?:[A-Za-z_$][\w$]*\s*=(?!=)|set[A-Z][\w$]*\()/g

/** The test-only hold the end-to-end harness uses for a start-up that hangs after binding. */
const TEST_HOLD = "if (process.env.HARNESSD_TEST_HOLD_READY === '1') await new Promise<never>(() => {})"

describe('the core\'s request gate (core/main.ts)', () => {
  const source = code(SOURCE)
  const { text, from } = runForegroundBody(source)
  const at = (needle: string, after = from): number => {
    const index = source.indexOf(needle, after)
    expect(index, `runForeground still contains \`${needle}\``).toBeGreaterThan(-1)
    return index
  }
  const opened = at('\n  backend.openRequests()')

  it('holds requests from the moment the socket exists', () => {
    const constructed = at('const backend = new BackendSocket(')
    const held = at('backend.holdRequests()', constructed)
    const between = source.slice(source.indexOf('\n', source.indexOf('\n  })', constructed) + 1), held)
    // Only the reference other code reads the socket through may come between them; nothing that yields.
    expect(between.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['backendRef = backend'])
  })

  it('binds every handler before requests are answered', () => {
    const bindings = [...text.matchAll(BINDING)]
    expect(bindings.length, 'the socket is still wired up in runForeground').toBeGreaterThan(40)
    const late = bindings.filter((binding) => from + binding.index > opened).map((binding) => binding[0])
    expect(late, 'a handler bound after openRequests misses the requests held until then').toEqual([])
  })

  it('binds what restore publishes before restore runs, outside the gate', () => {
    // `publishStoppedAgent` reads these while restoring agents and in the first reconcile, and those
    // frames go out whether or not requests are open.
    const restore = at('await restoreAgents({')
    for (const provider of ['activityFrameProvider', 'runtimeProfileProvider', 'dshFrameProvider']) {
      expect(at(`backend.${provider} =`), `backend.${provider} must be bound before restoreAgents`).toBeLessThan(restore)
    }
  })

  it('never yields between dialing the backend and answering requests', () => {
    // The relay callbacks (onRevoked, onBusy, onMachineMeta) are bound after `connect()`. That is safe
    // only while nothing in between lets the socket's first frames run.
    const dialed = at('backend.connect()')
    const yields = source.slice(dialed, opened).split('\n')
      .filter((line) => /^ {2}\S/.test(line) && /\bawait\b/.test(line) && line.trim() !== TEST_HOLD)
    expect(yields, 'bind the relay callbacks before connect() first').toEqual([])
  })

  it('opens the gate, tells the master it is ready, then says so — last', () => {
    const ready = at('coreLink.ready()', opened)
    const logged = at("console.log('[cli] ready')", ready)
    const tail = source.slice(opened, from + text.length).split('\n').map((line) => line.trim()).filter(Boolean)
    expect(tail).toEqual(['backend.openRequests()', 'daemonBoot.openRequests = null', 'coreLink.ready()', "console.log('[cli] ready')"])
    expect(logged).toBeGreaterThan(ready)
  })
})
