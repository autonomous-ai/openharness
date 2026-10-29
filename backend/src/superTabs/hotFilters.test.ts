import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Roadmap Phase 3 (database optimization, 2026-10-29): Prisma sends `in`, `notIn` and `has*` filters as $expr, which the
// planner bounds by an index's first field alone. On 28 Oct such reads on deliveries, native contexts and route decisions
// scanned 50 M documents for 220 k returned. Hot Swarm reads go through the named-index helpers instead (parts/indexed.ts
// readBy, invitedSwarms.ts, pageReads.ts, swarmRows.ts) with a plan test. This test finds every Prisma call on a hot Swarm
// collection whose filter uses one of those operators. The ones there were when it was written are allowed
// (hotFilters.allowed.json) and that list may only shrink: a new one fails here. It reads source, not types: a filter a
// helper function builds and returns (parts/load.ts `or`) is not followed.

/** The Prisma delegates of the Swarm collections every poll reads. */
const HOT = new Set(['superTab', 'superTabSessionScope', 'superTabMessage', 'superTabMention', 'superTabReaction', 'superTabReadMark', 'superTabDecision',
  'superTabAttachment', 'superTabOperation', 'superTabNativeContext', 'superTabDelivery', 'superTabRun', 'superTabAttempt', 'superTabRouteDecision',
  'superTabStopReceipt', 'superTabTerminalRequest', 'swarmHead', 'swarmMember', 'swarmGroup', 'swarmAgent', 'swarmMachine', 'swarmStart', 'swarmProgress'])
/** `delegate(tx, kind)` (parts/write.ts) stands for any Swarm part collection. */
const PART_DELEGATE = 'delegate'
const METHODS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany',
  'deleteMany', 'update', 'delete', 'upsert'])
const OPERATORS = new Set(['in', 'notIn', 'has', 'hasSome', 'hasEvery'])

export interface HotFilter { file: string; line: number; call: string; operator: string }

const nameOf = (name: ts.PropertyName | ts.MemberName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : undefined

/** The hot collection a call's receiver is, if any: `x.swarmGroup`, or `delegate(tx, kind)`. */
function hotReceiver(receiver: ts.Expression): string | undefined {
  const inner = unwrap(receiver)
  if (ts.isPropertyAccessExpression(inner) && HOT.has(inner.name.text)) return inner.name.text
  if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === PART_DELEGATE) return 'part'
  return undefined
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
    || ts.isTypeAssertionExpression(node)) node = node.expression
  return node
}

/** The initializer of the nearest `const`/`let` named `name` declared before `at` in a scope that holds `at`. */
function declared(name: string, at: ts.Node): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    let found: ts.Expression | undefined
    const visit = (node: ts.Node) => {
      if (node.pos > at.pos) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && node.end <= at.pos) found = node.initializer
      // A nested function's own declarations are not in scope here.
      if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) return
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(scope, visit)
    if (found) return found
  }
  return undefined
}

/** Every filter operator `node` holds, following object literals, spreads, conditionals and local constants. */
function operatorsIn(node: ts.Expression, seen = new Set<ts.Node>()): Array<{ operator: string; node: ts.Node }> {
  const expr = unwrap(node)
  if (seen.has(expr)) return []
  seen.add(expr)
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.flatMap(property => {
      if (ts.isPropertyAssignment(property)) {
        const name = nameOf(property.name)
        return [...name && OPERATORS.has(name) ? [{ operator: name, node: property }] : [], ...operatorsIn(property.initializer, seen)]
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = declared(property.name.text, property)
        return value ? operatorsIn(value, seen) : []
      }
      if (ts.isSpreadAssignment(property)) return operatorsIn(property.expression, seen)
      return []
    })
  }
  if (ts.isConditionalExpression(expr)) return [...operatorsIn(expr.whenTrue, seen), ...operatorsIn(expr.whenFalse, seen)]
  if (ts.isBinaryExpression(expr)) return [...operatorsIn(expr.left, seen), ...operatorsIn(expr.right, seen)]
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.flatMap(element => ts.isSpreadElement(element) ? operatorsIn(element.expression, seen) : operatorsIn(element, seen))
  if (ts.isIdentifier(expr)) {
    const value = declared(expr.text, expr)
    return value ? operatorsIn(value, seen) : []
  }
  return []
}

/** The hot filters of one source file. */
export function hotFilters(file: string, source: string): HotFilter[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: HotFilter[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && METHODS.has(node.expression.name.text)) {
      const model = hotReceiver(node.expression.expression)
      const args = node.arguments[0] && unwrap(node.arguments[0])
      if (model && args) {
        // Only what selects rows: `where`, or the arguments themselves when they are built elsewhere.
        const where = ts.isObjectLiteralExpression(args)
          ? args.properties.flatMap(p => ts.isPropertyAssignment(p) && nameOf(p.name) === 'where' ? [p.initializer]
            : ts.isShorthandPropertyAssignment(p) && p.name.text === 'where' ? [p.name] : ts.isSpreadAssignment(p) ? [p.expression] : [])
          : [args]
        for (const filter of where) {
          for (const { operator, node: at } of operatorsIn(filter)) {
            found.push({ file, line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1, call: `${model}.${node.expression.name.text}`, operator })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const ROOT = join(import.meta.dirname, '..', '..')
const ALLOWED = join(import.meta.dirname, 'hotFilters.allowed.json')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') && !/\.test(-support)?\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

/** Uses by `file call` (file relative to backend/), counted. */
function counted(filters: HotFilter[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const filter of filters) {
    const key = `${filter.file} ${filter.call}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

describe('no new Prisma in/has filter on a hot Swarm collection', () => {
  it('finds them through where, spreads, conditionals and local constants, and only on hot collections', () => {
    const found = hotFilters('fixture.ts', `
      const assignmentId = { in: ids }
      const open = cond ? { status: { in: OPEN } } : {}
      await tx.superTabDelivery.updateMany({ where: { tabId, assignmentId }, data: { status: 'cancelled' } })
      await db.swarmGroup.findMany({ where: { tabId, ...open, OR: [{ agentIds: { has: agentId } }] } })
      await delegate(tx, kind).findMany({ where: { tabId: { in: tabIds } } })
      await db.machine.findMany({ where: { machineId: { in: ids } } })
      await db.swarmGroup.updateMany({ where: { tabId }, data: { agentIds: { set: [] } } })
      await readBy(tx, 'SwarmGroup', 'agents', [{ $match: { tabId, agentIds: agentId } }])
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([
      ['superTabDelivery.updateMany', 'in'], ['swarmGroup.findMany', 'in'], ['swarmGroup.findMany', 'has'], ['part.findMany', 'in']])
  })

  it('allows only the uses already listed, and the list only shrinks', () => {
    const current = counted(sources(join(ROOT, 'src')).flatMap(path => hotFilters(relative(ROOT, path), readFileSync(path, 'utf8'))))
    if (process.env.UPDATE_HOT_FILTERS) writeFileSync(ALLOWED, `${JSON.stringify(current, null, 2)}\n`)
    const allowed = JSON.parse(readFileSync(ALLOWED, 'utf8')) as Record<string, number>
    const added = Object.entries(current).filter(([key, count]) => count > (allowed[key] ?? 0))
      .map(([key, count]) => `${key}: ${count} (allowed ${allowed[key] ?? 0})`)
    expect(added, 'A Prisma in/has filter on a hot Swarm collection is sent as $expr, which no index bounds. Read through a named index (parts/indexed.ts readBy) with a plan test instead.').toEqual([])
    const fewer = Object.entries(allowed).filter(([key, count]) => count > (current[key] ?? 0)).map(([key, count]) => `${key}: ${current[key] ?? 0} (listed ${count})`)
    expect(fewer, 'Fewer uses than listed: lower them in hotFilters.allowed.json (UPDATE_HOT_FILTERS=1 rewrites it).').toEqual([])
  })
})
