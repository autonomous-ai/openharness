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
const SOURCE = readFileSync(join(import.meta.dirname, 'cli.ts'), 'utf-8')

/** `runForeground`'s own body. Other functions are indented the same way; their locals are not ours. */
function runForegroundBody(source: string): { text: string; from: number } {
  const from = source.indexOf('async function runForeground(')
  expect(from, 'cli.ts still defines runForeground').toBeGreaterThan(-1)
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
  expect(at, `cli.ts still contains \`${call}\``).toBeGreaterThan(-1)
  let depth = 0
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return { body: source.slice(at, i + 1), at }
  }
  throw new Error(`unbalanced braces after ${call}`)
}

/** Every call whose dependencies run DURING start-up, before `runForeground` has finished its body. */
const STARTUP_CALLS = ['await repairClaudeCwd({', 'await restoreAgents({', 'startSelfUpdater({']

/** What the prologue is allowed to do before the updater is running: nothing that can throw. */
const PROLOGUE_CALLS = new Set([
  'installTimestampedConsole', 'startSelfUpdater', 'statSync', 'join', 'String', 'Number', 'Date',
  'withSpawnLock', 'describeSpawnLockOwner',
])
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'function'])

describe('cli.ts start-up order', () => {
  it.each(STARTUP_CALLS)('every local `%s` reaches is initialised before it runs', (name) => {
    const source = code(SOURCE)
    const { body, at } = callArgument(source, name)
    const declaredAt = localsOf(source)
    const late = referencedIn(body).filter(used => (declaredAt.get(used) ?? -1) > at).sort()
    expect(late, `declare these above the \`${name}\` call — see this file’s header`).toEqual([])
  })

  // ── The invariant the whole safe-boot design rests on ───────────────────────────────────────────
  // A daemon that cannot finish starting can only be fixed by its own updater, and the updater can
  // only run if start-up reached it. So it goes first, and everything that can throw or hang goes
  // after. These three say so in the order they are worth reading.

  it('starts the updater before anything that can throw or hang', () => {
    const source = code(SOURCE)
    const updater = source.indexOf('startSelfUpdater({')
    expect(updater, 'cli.ts still starts the self-updater').toBeGreaterThan(-1)
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
      expect(at, `\`${risky}\` must come after startSelfUpdater({ — a crash there would strand the machine`)
        .toBeGreaterThan(updater)
    }
  })

  it('keeps the prologue itself incapable of throwing', () => {
    // Stronger than listing today's hazards: this is what catches the NEXT line somebody adds on top.
    const source = code(SOURCE)
    const from = source.indexOf('async function runForeground(')
    const to = source.indexOf('startSelfUpdater({')
    const prologue = source.slice(source.indexOf('{', from), to)
    expect(prologue.includes('\n  await '), 'no await may precede the updater — a hang there is unrecoverable').toBe(false)
    expect(/\n\s*throw /.test(prologue), 'no throw may precede the updater').toBe(false)
    const called = [...prologue.replace(/\.\s*[A-Za-z_$][\w$]*\s*\(/g, ' ').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
      .map(match => match[1])
      .filter(name => !KEYWORDS.has(name))
    expect([...new Set(called.filter(name => !PROLOGUE_CALLS.has(name)))].sort(),
      'only calls that cannot fail belong above the updater; move this below it, or add it to PROLOGUE_CALLS with a reason')
      .toEqual([])
  })

  it('only swaps in the full restart handler once everything it tears down exists', () => {
    // `bootHandoff` hands the machine over without finishing start-up; `restartForUpdate` tears down
    // two dozen subsystems and may only be armed after every one of them is built.
    const source = code(SOURCE)
    const flip = source.indexOf('daemonBoot.applyStagedUpdate = ')
    expect(flip, 'the handoff handler is still swapped in cli.ts').toBeGreaterThan(-1)
    const { body } = callArgument(source, 'const restartForUpdate = ')
    const declaredAt = localsOf(source)
    const late = referencedIn(body).filter(used => (declaredAt.get(used) ?? -1) > flip).sort()
    expect(late, 'these are torn down by restartForUpdate but declared after it is armed').toEqual([])
  })

  it('the daemon arm survives its own start-up failure', () => {
    const source = code(SOURCE)
    const arm = source.slice(source.indexOf("case '__run'"), source.indexOf("case '__run'") + 400)
    expect(arm).toContain('catch(enterSafeMode)')
    expect(arm, 'a daemon that exits here can never be updated').not.toContain('catch(onError)')
  })
})
