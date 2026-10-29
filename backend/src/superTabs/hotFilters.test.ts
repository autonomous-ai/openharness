import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Roadmap Phase 3 (database optimization, 2026-10-29): Prisma sends `in`, `notIn` and `has*` filters as $expr, which the
// planner bounds by an index's first field alone. On 28 Oct such reads on deliveries, native contexts and route decisions
// scanned 50 M documents for 220 k returned. Hot Swarm reads go through the named-index helpers instead (parts/indexed.ts
// readBy, invitedSwarms.ts, pageReads.ts, swarmRows.ts) with a plan test. This test finds every Prisma call on a hot Swarm
// collection (every SuperTab and Swarm model of the schema) whose filter uses one of those operators, also through a delegate
// alias. The ones there were when it was written are allowed (hotFilters.allowed.json) and that list may only shrink: a new
// one fails here. It reads source, not types: a call passes only when its receiver is proven another model's Prisma delegate
// (`db.machine` on a client typed or imported as one); any receiver it cannot tell is listed as `unresolved` for review rather
// than passed. A filter a helper function builds and returns (parts/load.ts `or`) is not followed.

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

/** Every model's delegate, hot or not: a receiver named one of these is known to be that collection. */
const DELEGATES = new Set([...readFileSync(SCHEMA, 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)].map(match => match[1]![0]!.toLowerCase() + match[1]!.slice(1)))
/** A receiver the lint cannot tell is a hot delegate or not: its calls are listed for review like a hot one's. */
const UNRESOLVED = 'unresolved'

/**
 * What a type says the value is: a hot delegate (`Prisma.SwarmGroupDelegate`, `typeof db.swarmGroup`,
 * `PrismaClient['swarmGroup']`), another model's Prisma delegate type (`Prisma.MachineDelegate`: undefined), or nothing it can
 * prove (UNRESOLVED).
 */
function typeReceiver(type: ts.TypeNode): string | undefined {
  let other = false
  for (const word of type.getText().match(/\w+/g) ?? []) {
    if (HOT.has(word)) return word
    const delegate = word.endsWith('Delegate') ? word[0]!.toLowerCase() + word.slice(1, -'Delegate'.length) : undefined
    if (delegate && HOT.has(delegate)) return delegate
    if (delegate && DELEGATES.has(delegate)) other = true
  }
  return other ? undefined : UNRESOLVED
}

/** Combines what the branches of a conditional may be: hot if any is, else unresolved if any is. */
const either = (...receivers: Array<string | undefined>) => receivers.find(r => r && r !== UNRESOLVED) ?? receivers.find(r => r === UNRESOLVED)

/** Type names that are a Prisma client themselves. */
const CLIENT_TYPES = new Set(['PrismaClient', 'TransactionClient'])
/** Wrappers that keep a client a client (`Pick<PrismaClient, '$transaction'>`). */
const CLIENT_WRAPPERS = new Set(['Pick', 'Omit', 'Readonly'])

/**
 * Whether a type is itself a Prisma client or transaction (`PrismaClient`, `Prisma.TransactionClient`, a type alias of one
 * declared in the same file, `Pick`/`Omit` of one, an intersection with one). A type that only holds one (`{ client:
 * PrismaClient }`) is not.
 */
function clientType(type: ts.TypeNode, seen = new Set<string>()): boolean {
  if (ts.isParenthesizedTypeNode(type)) return clientType(type.type, seen)
  if (ts.isIntersectionTypeNode(type)) return type.types.some(member => clientType(member, seen))
  if (ts.isUnionTypeNode(type)) return type.types.every(member => clientType(member, seen))
  if (!ts.isTypeReferenceNode(type)) return false
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text
  if (CLIENT_TYPES.has(name)) return true
  if (CLIENT_WRAPPERS.has(name)) return !!type.typeArguments?.[0] && clientType(type.typeArguments[0], seen)
  if (!ts.isIdentifier(type.typeName) || seen.has(name)) return false
  seen.add(name)
  const alias = type.getSourceFile().statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name)
  return !!alias && clientType(alias.type, seen)
}

/**
 * Whether `node` is proven a Prisma client or transaction: a name typed as one, `new PrismaClient()`, the app's client
 * imported from lib/prisma, the callback parameter of a proven client's `$transaction`, or a class field that is one.
 */
function prismaClient(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
  const inner = unwrap(node)
  if (seen.has(inner)) return false
  seen.add(inner)
  if (ts.isNewExpression(inner)) return ts.isIdentifier(inner.expression) && inner.expression.text === 'PrismaClient'
  if (ts.isConditionalExpression(inner)) return prismaClient(inner.whenTrue, seen) && prismaClient(inner.whenFalse, seen)
  if (ts.isBinaryExpression(inner)) return prismaClient(inner.left, seen) && prismaClient(inner.right, seen)
  const bound = ts.isIdentifier(inner) ? declaration(inner.text, inner)
    : ts.isPropertyAccessExpression(inner) && inner.expression.kind === ts.SyntaxKind.ThisKeyword ? classField(inner.name.text, inner) : undefined
  if (!bound) return ts.isIdentifier(inner) && importedClient(inner)
  if (ts.isBindingElement(bound)) return false
  if (bound.type) return clientType(bound.type)
  if (ts.isParameter(bound)) {
    const callback = bound.parent
    const call = callback.parent
    return (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isCallExpression(call)
      && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === '$transaction' && prismaClient(call.expression.expression, seen)
  }
  return !!bound.initializer && prismaClient(bound.initializer, seen)
}

/** Whether `name` is imported from the app's Prisma client module (src/lib/prisma.ts). */
function importedClient(name: ts.Identifier): boolean {
  return name.getSourceFile().statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && posix.join(posix.dirname(name.getSourceFile().fileName), statement.moduleSpecifier.text).replace(/\.js$/, '') === 'src/lib/prisma'
    && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some(element => element.name.text === name.text))
}

/** A delegate reached by name from `owner`: hot by its name, exempt only when `owner` is proven a Prisma client, else unresolved. */
function memberReceiver(owner: ts.Expression, name: string): string | undefined {
  if (HOT.has(name)) return name
  return DELEGATES.has(name) && prismaClient(owner) ? undefined : UNRESOLVED
}

/** What a declared name holds: by its delegate property when destructured, its type, else its initializer. */
function boundReceiver(bound: Binding | ts.PropertyDeclaration, seen: Set<ts.Node>): string | undefined {
  if (ts.isBindingElement(bound)) {
    const property = bound.propertyName ? nameOf(bound.propertyName as ts.PropertyName) : ts.isIdentifier(bound.name) ? bound.name.text : undefined
    if (bound.initializer) return either(property && HOT.has(property) ? property : undefined, hotReceiver(bound.initializer, seen))
    const owner = bound.parent.parent
    const from = ts.isObjectBindingPattern(bound.parent) && (ts.isVariableDeclaration(owner) || ts.isParameter(owner)) ? owner.initializer : undefined
    return property && from ? memberReceiver(from, property) : property && HOT.has(property) ? property : UNRESOLVED
  }
  if (bound.type) return typeReceiver(bound.type)
  return bound.initializer ? hotReceiver(bound.initializer, seen) : UNRESOLVED
}

/** The field `name` of the class holding `at`: a property, or a constructor parameter property. */
function classField(name: string, at: ts.Node): ts.PropertyDeclaration | ts.ParameterDeclaration | undefined {
  let owner: ts.Node | undefined = at.parent
  while (owner && !ts.isClassLike(owner)) owner = owner.parent
  if (!owner) return undefined
  for (const member of (owner as ts.ClassLikeDeclaration).members) {
    if (ts.isPropertyDeclaration(member) && nameOf(member.name) === name) return member
    if (ts.isConstructorDeclaration(member)) {
      const parameter = member.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === name && ts.getModifiers(p)?.length)
      if (parameter) return parameter
    }
  }
  return undefined
}

/**
 * The hot collection a call's receiver is: `x.swarmGroup`, `x['swarmGroup']`, `delegate(tx, kind)`, or a name or field bound
 * to one (`const groups = db.swarmGroup`, `const { swarmGroup: groups } = db`, `this.groups`, a parameter typed as a hot
 * delegate), followed through aliases and conditionals. Undefined only when it is proven another model's Prisma delegate
 * (`db.machine` on a proven client, a name typed `Prisma.MachineDelegate`); UNRESOLVED otherwise (an imported name, another
 * object's field, a call's result, a computed key), so that call is listed for review rather than passed.
 */
function hotReceiver(receiver: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
  const inner = unwrap(receiver)
  if (seen.has(inner)) return UNRESOLVED
  seen.add(inner)
  if (ts.isPropertyAccessExpression(inner)) {
    if (inner.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const field = classField(inner.name.text, inner)
      return field ? boundReceiver(field, seen) : UNRESOLVED
    }
    return memberReceiver(inner.expression, inner.name.text)
  }
  if (ts.isElementAccessExpression(inner)) {
    return ts.isStringLiteralLike(inner.argumentExpression) ? memberReceiver(inner.expression, inner.argumentExpression.text) : UNRESOLVED
  }
  if (ts.isCallExpression(inner)) return ts.isIdentifier(inner.expression) && inner.expression.text === PART_DELEGATE ? 'part' : UNRESOLVED
  if (ts.isConditionalExpression(inner)) return either(hotReceiver(inner.whenTrue, seen), hotReceiver(inner.whenFalse, seen))
  if (ts.isBinaryExpression(inner)) return either(hotReceiver(inner.left, seen), hotReceiver(inner.right, seen))
  if (!ts.isIdentifier(inner)) return UNRESOLVED
  const bound = declaration(inner.text, inner)
  return bound ? boundReceiver(bound, seen) : UNRESOLVED
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
/** Where a `var` lands: its function, or the file. */
const hoists = (node: ts.Node): boolean => ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isModuleBlock(node)
const isVar = (node: Binding): boolean => !ts.isParameter(node) && !(ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped)

/**
 * The nearest declaration of `name` (a `const`/`let`/`var`, a destructured name or a parameter) before `at` whose scope
 * encloses `at`: the scopes holding `at` are searched from the innermost out, each for its own declarations only, so a
 * declaration in a sibling block or a nested function never shadows the one in force at `at`. A `var` belongs to its
 * function (or the file), so a function searches its nested blocks for `var`s.
 */
function declaration(name: string, at: ts.Node): Binding | undefined {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!scopes(scope)) continue
    let found: Binding | undefined
    const visit = (node: ts.Node, nested: boolean) => {
      if (node.pos > at.pos) return
      if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.name.text === name
        && node.end <= at.pos && (!nested || isVar(node))) found = node
      // An inner function's declarations are never in force here; an inner block's only when they are `var`s of this function.
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
      if (scopes(node)) {
        if (!hoists(scope!)) return
        nested = true
      }
      ts.forEachChild(node, child => visit(child, nested))
    }
    ts.forEachChild(scope, child => visit(child, false))
    if (found) return found
  }
  return undefined
}

/** The initializer of the nearest `const`/`let`/`var` named `name` declared before `at`. */
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

/** Fixture source, after a proven Prisma client `db` and transaction `tx`. */
const lint = (source: string) => hotFilters('fixture.ts', `declare const db: PrismaClient\ndeclare const tx: Prisma.TransactionClient\n${source}`)

describe('no new Prisma in/has filter on a hot Swarm collection', () => {
  it('finds them through where, spreads, conditionals and local constants, and only on hot collections', () => {
    const found = lint(`
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
    const found = lint(`
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
    const found = lint(`
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

  it('resolves a var to its function, also from a nested block', () => {
    const found = lint(`
      async function read() {
        { var groups = db.swarmGroup }
        await groups.findMany({ where: { key: { in: ids } } })
        if (flag) { var keys = { in: ids } }
        await db.swarmHead.findMany({ where: { key: keys } })
      }
      async function other() { await groups.count({ where: { key: { in: ids } } }) }
      function scoped() { { var machines = db.machine } return machines.findMany({ where: { machineId: { in: ids } } }) }
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([['swarmGroup.findMany', 'in'], ['swarmHead.findMany', 'in'], ['unresolved.count', 'in']])
  })

  it('lists a call on a receiver it cannot resolve for review, and passes one surely on another collection', () => {
    const found = lint(`
      import { groups } from './elsewhere'
      await groups.findMany({ where: { key: { in: ids } } })
      await repo.groups.findMany({ where: { key: { in: ids } } })
      await pick(tx).findMany({ where: { key: { in: ids } } })
      await db[model].findMany({ where: { key: { in: ids } } })
      async function typed(table: SomeTable) { await table.findMany({ where: { key: { in: ids } } }) }
      await groups.findMany({ where: { key } })
      class Store {
        private groups = db.swarmGroup
        constructor(private db: PrismaClient, private machines: Prisma.MachineDelegate, private runs: typeof db.superTabRun) {}
        async read() {
          await this.groups.findMany({ where: { key: { in: ids } } })
          await this.machines.findMany({ where: { machineId: { in: ids } } })
          await this.runs.count({ where: { id: { in: ids } } })
          await this.db.machine.findMany({ where: { machineId: { in: ids } } })
          await (flag ? this.db.machine : this.other).findMany({ where: { id: { in: ids } } })
        }
      }
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([
      ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'],
      ['swarmGroup.findMany', 'in'], ['superTabRun.count', 'in'], ['unresolved.findMany', 'in']])
  })

  it('passes a non-hot model name only on a proven Prisma client', () => {
    const found = lint(`
      class Store {
        private machine = db.swarmGroup
        read() { return this.machine.findMany({ where: { key: { in: ids } } }) }
      }
      await repo.machine.findMany({ where: { machineId: { in: ids } } })
      await db[name].findMany({ where: { machineId: { in: ids } } })
      await repo['machine'].findMany({ where: { machineId: { in: ids } } })
      await db['machine'].findMany({ where: { machineId: { in: ids } } })
      await db.machine.findMany({ where: { machineId: { in: ids } } })
      await prisma.machine.findMany({ where: { machineId: { in: ids } } })
      await db.$transaction(async t => t.machine.findMany({ where: { machineId: { in: ids } } }))
      async function run(client: Client) { await client.machine.findMany({ where: { machineId: { in: ids } } }) }
      type Client = Prisma.TransactionClient
      const { machine } = db
      await machine.findMany({ where: { machineId: { in: ids } } })
      const { machine: other } = repo
      await other.findMany({ where: { machineId: { in: ids } } })
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([['swarmGroup.findMany', 'in'], ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'],
      ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in']])
  })

  it('takes neither a type holding a client nor any object\'s $transaction as proof', () => {
    const found = lint(`
      async function read(repo: { client: PrismaClient; machine: typeof db.swarmGroup }) {
        await repo.machine.findMany({ where: { key: { in: ids } } })
      }
      async function held(box: Box) { await box.machine.findMany({ where: { machineId: { in: ids } } }) }
      type Box = { client: PrismaClient }
      await repo.$transaction(async t => t.machine.findMany({ where: { machineId: { in: ids } } }))
      await db.$transaction(async t => t.machine.findMany({ where: { machineId: { in: ids } } }))
      async function picked(client: Pick<PrismaClient, 'machine'> & Prisma.TransactionClient) {
        await client.machine.findMany({ where: { machineId: { in: ids } } })
      }
    `)
    expect(found.map(f => [f.call, f.operator])).toEqual([['unresolved.findMany', 'in'], ['unresolved.findMany', 'in'], ['unresolved.findMany', 'in']])
  })

  it('covers every SuperTab and Swarm model in the schema', () => {
    const schema = readFileSync(SCHEMA, 'utf8')
    const models = hotModels(schema)
    const all = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(match => match[1]!)
    expect(models).toEqual(all.filter(model => /^(SuperTab|Swarm)/.test(model)))
    expect(models).toEqual(expect.arrayContaining(['SuperTab', 'SuperTabConfiguration', 'SuperTabRoleText', 'SuperTabDelivery', 'SwarmGroup', 'SwarmWorkspace']))
    expect(hotModels('model SwarmNew {\n  id String @id\n}\nmodel Machine {\n}\nmodel SuperTabLater {\n}\n')).toEqual(['SwarmNew', 'SuperTabLater'])
    const found = lint('await db.superTabRoleText.findMany({ where: { tabId: { in: ids } } })')
    expect(found.map(f => f.call)).toEqual(['superTabRoleText.findMany'])
  })

  it('allows only the uses already listed, and the list only shrinks', () => {
    const current = counted(sources(join(ROOT, 'src')).flatMap(path => hotFilters(relative(ROOT, path), readFileSync(path, 'utf8'))))
    if (process.env.UPDATE_HOT_FILTERS) writeFileSync(ALLOWED, `${JSON.stringify(current, null, 2)}\n`)
    const allowed = JSON.parse(readFileSync(ALLOWED, 'utf8')) as Record<string, number>
    const added = Object.entries(current).filter(([key, count]) => count > (allowed[key] ?? 0))
      .map(([key, count]) => `${key}: ${count} (allowed ${allowed[key] ?? 0})`)
    expect(added, 'A Prisma in/has filter on a hot Swarm collection is sent as $expr, which no index bounds. Read through a named index (parts/indexed.ts readBy) with a plan test instead. An `unresolved` call is one whose collection this test cannot tell: name the delegate (db.swarmGroup, or a parameter typed Prisma.XDelegate), or list it after checking it is not a hot collection.').toEqual([])
    const fewer = Object.entries(allowed).filter(([key, count]) => count > (current[key] ?? 0)).map(([key, count]) => `${key}: ${current[key] ?? 0} (listed ${count})`)
    expect(fewer, 'Fewer uses than listed: lower them in hotFilters.allowed.json (UPDATE_HOT_FILTERS=1 rewrites it).').toEqual([])
  })
})
