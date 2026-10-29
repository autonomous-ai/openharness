import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Roadmap Phase 3 (database optimization, 2026-10-29): Prisma sends `in`, `notIn` and `has*` filters as $expr, which the
// planner bounds by an index's first field alone. On 28 Oct such reads on deliveries, native contexts and route decisions
// scanned 50 M documents for 220 k returned. Hot Swarm reads go through the named-index helpers instead (parts/indexed.ts
// readBy, invitedSwarms.ts, pageReads.ts, swarmRows.ts) with a plan test. This test finds every Prisma call on a hot Swarm
// collection (every SuperTab and Swarm model of the schema) whose filter uses one of those operators, also through a delegate
// alias. The ones there were when it was written are allowed (hotFilters.allowed.json) and that list may only shrink: a new
// one fails here. It reads source, not types: a filter a helper function builds and returns (parts/load.ts `or`) is not
// followed.

const ROOT = join(import.meta.dirname, '..', '..')
const ALLOWED = join(import.meta.dirname, 'hotFilters.allowed.json')
const SCHEMA = join(ROOT, 'prisma', 'schema.prisma')

/** The Swarm models of a Prisma schema: every `SuperTab*` and `Swarm*` model. */
export function hotModels(schema: string): string[] {
  return [...schema.matchAll(/^model\s+((?:SuperTab|Swarm)\w*)\s*\{/gm)].map(match => match[1]!)
}

const MODELS = new Set(hotModels(readFileSync(SCHEMA, 'utf8')))
/** Their Prisma delegates (`db.swarmGroup`). */
const HOT = new Set([...MODELS].map(model => model[0]!.toLowerCase() + model.slice(1)))
/** `delegate(tx, kind)` (parts/write.ts) stands for any Swarm part collection. */
const PART_DELEGATE = 'delegate'
const METHODS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany',
  'deleteMany', 'update', 'delete', 'upsert'])
const OPERATORS = new Set(['in', 'notIn', 'has', 'hasSome', 'hasEvery'])

export interface HotFilter { file: string; line: number; call: string; operator: string }

const nameOf = (name: ts.PropertyName | ts.MemberName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : undefined

/** The hot delegate a type names: `Prisma.SwarmGroupDelegate`, `typeof db.swarmGroup`, `PrismaClient['swarmGroup']`. */
function hotType(type: ts.TypeNode | undefined): string | undefined {
  for (const word of type?.getText().match(/\w+/g) ?? []) {
    if (HOT.has(word)) return word
    const model = word.endsWith('Delegate') ? word.slice(0, -'Delegate'.length) : undefined
    if (model && MODELS.has(model)) return model[0]!.toLowerCase() + model.slice(1)
  }
  return undefined
}

/**
 * The hot collection a call's receiver is, if any: `x.swarmGroup`, `x['swarmGroup']`, `delegate(tx, kind)`, or a name bound to
 * one (`const groups = db.swarmGroup`, `const { swarmGroup: groups } = db`, a parameter typed as a hot delegate), followed
 * through aliases and conditionals.
 */
function hotReceiver(receiver: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
  const inner = unwrap(receiver)
  if (seen.has(inner)) return undefined
  seen.add(inner)
  if (ts.isPropertyAccessExpression(inner) && HOT.has(inner.name.text)) return inner.name.text
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression) && HOT.has(inner.argumentExpression.text)) {
    return inner.argumentExpression.text
  }
  if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === PART_DELEGATE) return 'part'
  if (ts.isConditionalExpression(inner)) return hotReceiver(inner.whenTrue, seen) ?? hotReceiver(inner.whenFalse, seen)
  if (ts.isBinaryExpression(inner)) return hotReceiver(inner.left, seen) ?? hotReceiver(inner.right, seen)
  if (!ts.isIdentifier(inner)) return undefined
  const bound = declaration(inner.text, inner)
  if (!bound) return undefined
  if (ts.isBindingElement(bound)) {
    const property = bound.propertyName ? nameOf(bound.propertyName as ts.PropertyName) : ts.isIdentifier(bound.name) ? bound.name.text : undefined
    if (property && HOT.has(property)) return property
    return bound.initializer ? hotReceiver(bound.initializer, seen) : undefined
  }
  return hotType(bound.type) ?? (bound.initializer ? hotReceiver(bound.initializer, seen) : undefined)
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
    || ts.isTypeAssertionExpression(node)) node = node.expression
  return node
}

type Binding = ts.VariableDeclaration | ts.BindingElement | ts.ParameterDeclaration

/** A node that scopes the `const`/`let`/parameters declared directly in it. */
const scopes = (node: ts.Node): boolean => ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)
  || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isFunctionLike(node)
  || ts.isClassLike(node)

/**
 * The nearest declaration of `name` (a `const`/`let`, a destructured name or a parameter) before `at` whose scope encloses
 * `at`: the scopes holding `at` are searched from the innermost out, each for its own declarations only, so a declaration
 * in a sibling block or a nested function never shadows the one in force at `at`.
 */
function declaration(name: string, at: ts.Node): Binding | undefined {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!scopes(scope)) continue
    let found: Binding | undefined
    const visit = (node: ts.Node) => {
      if (node.pos > at.pos) return
      if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.name.text === name
        && node.end <= at.pos) found = node
      // An inner scope's declarations are not in force here (an inner scope holding `at` was searched already).
      if (scopes(node)) return
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(scope, visit)
    if (found) return found
  }
  return undefined
}

/** The initializer of the nearest `const`/`let` named `name` declared before `at`. */
function declared(name: string, at: ts.Node): ts.Expression | undefined {
  const bound = declaration(name, at)
  return bound && ts.isVariableDeclaration(bound) ? bound.initializer : undefined
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

  it('follows a delegate through aliases, destructuring, element access and typed parameters', () => {
    const found = hotFilters('fixture.ts', `
      const groups = db.swarmGroup
      await groups.findMany({ where: { key: { in: ids } } })
      const again = groups
      await again.count({ where: { agentIds: { has: agentId } } })
      const { superTabDelivery: deliveries, swarmMember } = tx
      await deliveries.updateMany({ where: { status: { in: OPEN } }, data: {} })
      await swarmMember.findMany({ where: { memberId: { in: ids } } })
      await db['superTabRun'].findMany({ where: { id: { in: ids } } })
      const table = delegate(tx, kind)
      await table.deleteMany({ where: { id: { in: ids } } })
      const either = cond ? db.superTabConfiguration : tx.superTabConfiguration
      await either.findMany({ where: { tabId: { in: tabIds } } })
      async function read(roles: Prisma.SuperTabRoleTextDelegate, typed: typeof db.swarmAgent) {
        await roles.findMany({ where: { tabId: { in: tabIds } } })
        await typed.findFirst({ where: { agentId: { in: ids } } })
      }
      const machines = db.machine
      await machines.findMany({ where: { machineId: { in: ids } } })
      async function other(groups: Prisma.MachineDelegate) { await groups.findMany({ where: { machineId: { in: ids } } }) }
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([
      ['swarmGroup.findMany', 'in'], ['swarmGroup.count', 'has'], ['superTabDelivery.updateMany', 'in'], ['swarmMember.findMany', 'in'],
      ['superTabRun.findMany', 'in'], ['part.deleteMany', 'in'], ['superTabConfiguration.findMany', 'in'], ['superTabRoleText.findMany', 'in'],
      ['swarmAgent.findFirst', 'in']])
  })

  it('resolves a name to the declaration in force at the call, not one in a sibling block or nested function', () => {
    const found = hotFilters('fixture.ts', `
      const groups = db.swarmGroup
      if (flag) { const groups = db.machine }
      await groups.findMany({ where: { key: { in: ids } } })
      const ids2 = { in: ids }
      for (const x of xs) { const ids2 = {} }
      const run = () => { const groups = db.machine; return groups }
      await groups.count({ where: { key: ids2 } })
      if (flag) {
        const groups = db.machine
        await groups.findMany({ where: { machineId: { in: ids } } })
      }
      function inner(groups: Prisma.MachineDelegate) { return groups.findMany({ where: { machineId: { in: ids } } }) }
      const outer = db.machine
      { const outer = db.superTabMessage; await outer.findMany({ where: { id: { in: ids } } }) }
      await outer.findMany({ where: { id: { in: ids } } })
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([['swarmGroup.findMany', 'in'], ['swarmGroup.count', 'in'], ['superTabMessage.findMany', 'in']])
  })

  it('covers every SuperTab and Swarm model in the schema', () => {
    const schema = readFileSync(SCHEMA, 'utf8')
    const models = hotModels(schema)
    const all = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(match => match[1]!)
    expect(models).toEqual(all.filter(model => /^(SuperTab|Swarm)/.test(model)))
    expect(models).toEqual(expect.arrayContaining(['SuperTab', 'SuperTabConfiguration', 'SuperTabRoleText', 'SuperTabDelivery', 'SwarmGroup', 'SwarmWorkspace']))
    expect(hotModels('model SwarmNew {\n  id String @id\n}\nmodel Machine {\n}\nmodel SuperTabLater {\n}\n')).toEqual(['SwarmNew', 'SuperTabLater'])
    const found = hotFilters('fixture.ts', 'await db.superTabRoleText.findMany({ where: { tabId: { in: ids } } })')
    expect(found.map(f => f.call)).toEqual(['superTabRoleText.findMany'])
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
