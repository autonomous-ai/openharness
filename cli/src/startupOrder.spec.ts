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

/** The source with comments blanked, so a name mentioned in prose is not read as a reference.
 *  Strings are left alone on purpose: blanking them needs a tokenizer to survive the backticks and
 *  regex literals this file is full of, and a word inside a string cannot match a local's name. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
}

/** The object literal passed to `name(`, by brace balance. */
function callArgument(source: string, name: string): { body: string; at: number } {
  const at = source.indexOf(`await ${name}({`)
  expect(at, `${name} is still called as \`await ${name}({\` in cli.ts`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return { body: source.slice(at, i + 1), at }
  }
  throw new Error(`unbalanced braces after ${name}(`)
}

/** Every call whose dependencies run DURING start-up, before `runForeground` has finished its body. */
const STARTUP_CALLS = ['repairClaudeCwd', 'restoreAgents']

describe('cli.ts start-up order', () => {
  it.each(STARTUP_CALLS)('every local %s reaches is initialised before it runs', (name) => {
    const source = code(SOURCE)
    const { body, at } = callArgument(source, name)
    // Locals of `runForeground` are the two-space-indented declarations; anything else is a module
    // constant, an import, or a nested scope, none of which can be in a dead zone here.
    const declaredAt = new Map<string, number>()
    for (const match of source.matchAll(/^ {2}(?:const|let) ([A-Za-z_$][\w$]*)\s*[:=]/gm)) {
      if (!declaredAt.has(match[1])) declaredAt.set(match[1], match.index)
    }
    // A name the closures declare themselves shadows anything outside them, however late that is.
    const own = new Set([...body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]))
    // `entry.agentId` names a property, not the `const agentId` three thousand lines down; the same
    // goes for every other member access in these closures.
    const referenced = body.replace(/\.\s*[A-Za-z_$][\w$]*/g, '')
    const late = [...new Set(referenced.match(/[A-Za-z_$][\w$]*/g) ?? [])]
      .filter(used => !own.has(used) && (declaredAt.get(used) ?? -1) > at)
      .sort()
    expect(late, `declare these above the \`${name}\` call — see this file’s header`).toEqual([])
  })
})
