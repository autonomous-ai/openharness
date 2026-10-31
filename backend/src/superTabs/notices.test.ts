import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { agentOnly, forRecipients, NOTICE_READERS } from './model.js'

// Ken, 2026-10-29: notices written for the Lead or an agent showed in the chats people read, one kind at a time (#2177, then
// the idle stop). Every kind the code writes as a message's source is classified in model.ts NOTICE_READERS; this reads the
// code itself, as cli/src/architecture.spec.ts reads its imports, so a new kind with no line there fails here, not in a chat.

const root = dirname(fileURLToPath(import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? sources(join(dir, entry.name))
  : entry.name.endsWith('.ts') && !/\.test(-support)?\.ts$|\.test-d\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [])

/** The kinds `expression` can give a message's source: its object literals' `kind`, through spreads, calls (json,
 *  forRecipients), conditionals, casts and variables (the file's own, or another's module constants: AGENT_ONLY). A string
 *  counts only as a `kind`'s value. */
function kindsOf(expression: ts.Node, declared: (name: string) => ts.Expression[], inKind = false, seen = new Set<ts.Node>()): string[] {
  if (seen.has(expression)) return []
  seen.add(expression)
  const of = (node: ts.Node, kind = inKind) => kindsOf(node, declared, kind, seen)
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
    return of(expression.expression)
  }
  if (ts.isConditionalExpression(expression)) return [...of(expression.whenTrue), ...of(expression.whenFalse)]
  if (ts.isBinaryExpression(expression)) return [...of(expression.left), ...of(expression.right)]
  if (ts.isCallExpression(expression)) return expression.arguments.flatMap(argument => of(argument))
  if (ts.isIdentifier(expression)) return declared(expression.text).flatMap(initializer => of(initializer))
  if (ts.isStringLiteralLike(expression)) return inKind ? [expression.text] : []
  if (!ts.isObjectLiteralExpression(expression)) return []
  return expression.properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) return of(property.expression, false)
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'kind') return of(property.initializer, true)
    return []
  })
}

const add = (map: Map<string, ts.Expression[]>, name: string, initializer: ts.Expression) => map.set(name, [...map.get(name) ?? [], initializer])

/** Every notice kind written as a message's source (a `source` property, or the source argument of commands.ts `message`),
 *  with the files that write it. */
function writtenKinds(): Map<string, string[]> {
  const files = sources(root).map(path => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true))
  const modules = new Map<string, ts.Expression[]>()
  for (const file of files) {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) add(modules, declaration.name.text, declaration.initializer)
      }
    }
  }
  const written = new Map<string, string[]>()
  for (const file of files) {
    const locals = new Map<string, ts.Expression[]>()
    const at: ts.Node[] = []
    const visit = (node: ts.Node) => {
      // A variable, or a parameter's default.
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer) add(locals, node.name.text, node.initializer)
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'source') at.push(node.initializer)
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'source') at.push(node.name)
      // message(conversationId, text, recipients, replyTo, source, ...)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'message' && node.arguments[4]) at.push(node.arguments[4])
      ts.forEachChild(node, visit)
    }
    visit(file)
    const declared = (name: string) => locals.get(name) ?? modules.get(name) ?? []
    for (const kind of new Set(at.flatMap(node => kindsOf(node, declared)))) written.set(kind, [...written.get(kind) ?? [], relative(root, file.fileName)])
  }
  return written
}

describe('the notices the Swarm writes into a chat', () => {
  const written = writtenKinds()

  it('finds the notices it is known to write, so a change in how they are written cannot empty this check', () => {
    expect([...written.keys()]).toEqual(expect.arrayContaining(['system', 'instructions', 'agent-only', 'idle', 'review-failed', 'work-lost', 'terminal-alert', 'native', 'ship']))
  })

  it('classifies every kind it writes, and only those', () => {
    const unclassified = [...written].filter(([kind]) => !Object.hasOwn(NOTICE_READERS, kind)).map(([kind, files]) => `${kind} (${files.join(', ')})`)
    expect(unclassified, 'add each to NOTICE_READERS in model.ts: who reads it?').toEqual([])
    // A kind no longer written keeps its readers for the rows stored before: the server's idle stop (project instructions,
    // phase 4) told only the Lead.
    const retired = ['idle-stop']
    expect(Object.keys(NOTICE_READERS).filter(kind => !written.has(kind) && !retired.includes(kind))).toEqual([])
    expect(retired.filter(kind => written.has(kind))).toEqual([])
  })

  it('shows people a notice of theirs, and one for an agent only while it reaches none', () => {
    expect(agentOnly({ kind: 'system' }, ['lead'])).toBe(false)
    expect(agentOnly({ kind: 'terminal-alert' }, ['lead'])).toBe(false)
    expect(agentOnly({ kind: 'start-timeout' }, ['lead'])).toBe(false)
    for (const kind of ['idle-stop', 'work-stalled', 'overlap']) {
      expect(agentOnly({ kind }, ['lead'])).toBe(true)
      expect(agentOnly({ kind }, [])).toBe(false)
    }
    expect(agentOnly({ kind: 'agent-only' }, [])).toBe(true)
    // A row of a kind people read can still be its recipients' alone; a kind no code knows (stored by a newer server) shows.
    expect(agentOnly(forRecipients({ kind: 'system' }), [])).toBe(true)
    expect(agentOnly({ kind: 'from-a-newer-server' }, ['lead'])).toBe(false)
    expect(agentOnly(undefined, [])).toBe(false)
  })
})
