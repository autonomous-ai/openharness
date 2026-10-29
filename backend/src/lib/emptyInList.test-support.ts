/**
 * Finds reads that can send an empty `in` list to Prisma on MongoDB (Database optimization roadmap, phase 0.3). Prisma turns
 * `in: []` into `$or: []`, which no index serves: a scan of the whole collection that returns nothing, seen in the slow log on
 * machines, users and SuperTab. A read of one of those models (or a raw `$in`) that names a list held in a variable must test
 * that list's `.length` or `.size` first in the same function (an `if`, a `?:` or `&&`), or pass a literal list or a constant.
 * A filter given by name (`where`, a spread, the whole arguments) is read where it is built; one the check cannot see into (a
 * parameter, a call's result, one declared after the read) is flagged rather than passed. Known limits: a list inside a
 * function's result, an array of filters (`AND: [filter]`), a spread of an import, and a `const` built by a conditional are not
 * followed; the check guards our own code against reintroducing an empty list by accident, not against someone working round it.
 * The test must tell empty from not empty: the length alone, negated, or compared with 0 (or 1); a filter built in its own
 * variable and passed to the read is read like one written in the call.
 * A `.map` or a `new Set` of a list is empty exactly when that list is, so a test of the source list counts; a `.filter` is
 * not: name the filtered list and test that.
 */
import ts from 'typescript'

/** The collections the slow log names. */
export const GUARDED_MODELS = new Set(['machine', 'user', 'superTab'])

export interface Unguarded { file: string; line: number; list: string }

const isCondition = (node: ts.Node): boolean => ts.isIfStatement(node) || ts.isConditionalExpression(node)
  || (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
const conditionOf = (node: ts.Node): ts.Expression => ts.isIfStatement(node) ? node.expression : ts.isConditionalExpression(node) ? node.condition : node as ts.Expression

const isLengthOf = (node: ts.Node, list: string): boolean => ts.isPropertyAccessExpression(node) && ['length', 'size'].includes(node.name.text) && node.expression.getText() === list
const numberOf = (node: ts.Node): number | null => ts.isNumericLiteral(node) ? Number(node.text) : null
const SIGNS = ts.SyntaxKind
/** The comparison with its two sides swapped. */
const MIRROR: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = { [SIGNS.EqualsEqualsToken]: SIGNS.EqualsEqualsToken, [SIGNS.EqualsEqualsEqualsToken]: SIGNS.EqualsEqualsEqualsToken,
  [SIGNS.ExclamationEqualsToken]: SIGNS.ExclamationEqualsToken, [SIGNS.ExclamationEqualsEqualsToken]: SIGNS.ExclamationEqualsEqualsToken,
  [SIGNS.GreaterThanToken]: SIGNS.LessThanToken, [SIGNS.GreaterThanEqualsToken]: SIGNS.LessThanEqualsToken,
  [SIGNS.LessThanToken]: SIGNS.GreaterThanToken, [SIGNS.LessThanEqualsToken]: SIGNS.GreaterThanEqualsToken }
/** `length <sign> number` for the comparisons that split the empty list from every other: nothing else says whether it is empty. */
const EMPTY_OR_NOT: Array<[ts.SyntaxKind, number]> = [[SIGNS.EqualsEqualsToken, 0], [SIGNS.EqualsEqualsEqualsToken, 0], [SIGNS.ExclamationEqualsToken, 0],
  [SIGNS.ExclamationEqualsEqualsToken, 0], [SIGNS.GreaterThanToken, 0], [SIGNS.LessThanEqualsToken, 0], [SIGNS.LessThanToken, 1], [SIGNS.GreaterThanEqualsToken, 1]]
/** Whether `condition` tells an empty `list` from one that is not: its length alone (or `!`), or its length against 0 or 1. */
function tellsEmpty(condition: ts.Node, list: string): boolean {
  if (ts.isParenthesizedExpression(condition)) return tellsEmpty(condition.expression, list)
  if (isLengthOf(condition, list)) return true
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === SIGNS.ExclamationToken) return tellsEmpty(condition.operand, list)
  if (ts.isBinaryExpression(condition)) {
    const op = condition.operatorToken.kind
    if (op === SIGNS.AmpersandAmpersandToken || op === SIGNS.BarBarToken) return tellsEmpty(condition.left, list) || tellsEmpty(condition.right, list)
    const [left, right] = [numberOf(condition.left), numberOf(condition.right)]
    // Written with the length on the left: `0 < ids.length` is `ids.length > 0`.
    const lengthFirst = isLengthOf(condition.left, list)
    const bound = lengthFirst ? right : isLengthOf(condition.right, list) ? left : null
    if (bound === null) return false
    const sign = lengthFirst ? op : MIRROR[op]
    return sign !== undefined && EMPTY_OR_NOT.some(([kind, number]) => kind === sign && number === bound)
  }
  return false
}
const isListName = (node: ts.Expression): boolean => ts.isIdentifier(node) || (ts.isPropertyAccessExpression(node) && isListName(node.expression))
const CONSTANT = /^[A-Z][A-Z0-9_]*$/

/** The list a `.map(...)` or `[...new Set(list)]` is as long as; the expression itself for anything else. */
function listOf(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node)) return listOf(node.expression)
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') return listOf(node.expression.expression)
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 1 && ts.isSpreadElement(node.elements[0]!)) {
    const spread = node.elements[0].expression
    if (ts.isNewExpression(spread) && spread.expression.getText() === 'Set' && spread.arguments?.length === 1) return listOf(spread.arguments[0]!)
  }
  return node
}

export function unguardedInLists(source: string, file: string): Unguarded[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: Unguarded[] = []
  /** The lists whose emptiness is the list's: itself, its source, and what a `const` it names was built from. */
  const sameAs = (scope: ts.Node, expression: ts.Expression): string[] => {
    const base = listOf(expression)
    const names = [base.getText()]
    if (ts.isIdentifier(base)) {
      const declared = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText() === base.text && node.initializer) names.push(...sameAs(scope, node.initializer))
        ts.forEachChild(node, declared)
      }
      declared(scope)
    }
    return names
  }
  const guarded = (call: ts.Node, expression: ts.Expression): boolean => {
    let scope: ts.Node | undefined = call.parent
    while (scope && !ts.isFunctionLike(scope)) scope = scope.parent
    const names = sameAs(scope ?? sf, expression)
    const tests = (node: ts.Node) => names.some(list => tellsEmpty(conditionOf(node), list))
    let ok = false
    const visit = (node: ts.Node) => {
      if (node.getStart() >= call.getStart()) return
      if (isCondition(node) && tests(node)) ok = true
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(scope ?? sf, visit)
    // A guard around the call itself: `ids.length ? await read(ids) : []`.
    for (let up: ts.Node | undefined = call.parent; up && up !== scope; up = up.parent) if (isCondition(up) && tests(up)) ok = true
    return ok
  }
  const visitCall = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
      && GUARDED_MODELS.has(node.expression.expression.name.text)) {
      const seen = new Set<ts.Node>()
      /** What the identifier names where it is used: the nearest `const` or `let` before it in its own block or an enclosing one (an
       *  earlier declarator of its own statement counts), and nothing when a parameter of a nearer function has that name (it holds
       *  whatever its caller passes). */
      const builtBefore = (id: ts.Identifier): ts.Expression | undefined => {
        const named = new RegExp(`\\b${id.text}\\b`)
        for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
          if (ts.isFunctionLike(scope) && scope.parameters.some(p => named.test(p.name.getText()))) return undefined
          const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : null
          let found: ts.VariableDeclaration | undefined
          for (const statement of statements ?? []) {
            if (statement.getStart() >= id.getStart()) break
            if (ts.isVariableStatement(statement)) {
              for (const declaration of statement.declarationList.declarations) if (declaration.end <= id.getStart() && declaration.name.getText() === id.text) found = declaration
            }
          }
          if (found) return found.initializer
        }
        return undefined
      }
      /** An import is a value fixed when the module loads: it holds no list of this call. */
      const imported = (id: ts.Identifier) => sf.statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause?.getText().match(new RegExp(`\\b${id.text}\\b`)))
      const unwrap = (expression: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
        ? unwrap(expression.expression) : expression
      /** A value used as a filter is read as if it were written in the call: an object, both branches of a conditional, or the
       *  value of a name. A `where` or the whole arguments the check cannot see into (a parameter, one declared after the read, a
       *  call's result) is flagged: it may carry an empty list. A spread of one is not (known limit: it is a part of a filter). */
      const visitValue = (expression: ts.Expression, at: ts.Node, strict: boolean) => {
        const value = unwrap(expression)
        if (ts.isObjectLiteralExpression(value)) {
          if (!seen.has(value)) { seen.add(value); lookFor(value) }
        } else if (ts.isConditionalExpression(value)) {
          visitValue(value.whenTrue, at, strict)
          visitValue(value.whenFalse, at, strict)
        } else if (ts.isIdentifier(value)) follow(value, strict)
        else if (strict) found.push({ file, line: sf.getLineAndCharacterOfPosition(at.getStart()).line + 1, list: at.getText() })
      }
      const follow = (id: ts.Identifier, strict: boolean) => {
        if (CONSTANT.test(id.text) || imported(id)) return
        const built = builtBefore(id)
        if (built) visitValue(built, id, strict)
        else if (strict) found.push({ file, line: sf.getLineAndCharacterOfPosition(id.getStart()).line + 1, list: id.text })
      }
      function lookFor(inner: ts.Node) {
        if (ts.isPropertyAssignment(inner) && inner.name.getText() === 'where' && ts.isIdentifier(inner.initializer)) follow(inner.initializer, true)
        else if (ts.isShorthandPropertyAssignment(inner) && inner.name.text === 'where') follow(inner.name, true)
        else if (ts.isSpreadAssignment(inner) && ts.isIdentifier(inner.expression)) follow(inner.expression, false)
        if (ts.isPropertyAssignment(inner) && ['in', '$in'].includes(inner.name.getText().replaceAll(/['"]/g, ''))
          && !ts.isArrayLiteralExpression(inner.initializer) && !(ts.isIdentifier(inner.initializer) && CONSTANT.test(inner.initializer.text))) {
          const list = inner.initializer.getText()
          if (!(isListName(listOf(inner.initializer)) && guarded(node, inner.initializer))) {
            found.push({ file, line: sf.getLineAndCharacterOfPosition(inner.getStart()).line + 1, list })
          }
        }
        ts.forEachChild(inner, lookFor)
      }
      for (const argument of node.arguments) ts.isIdentifier(argument) ? follow(argument, true) : lookFor(argument)
    }
    ts.forEachChild(node, visitCall)
  }
  visitCall(sf)
  return found
}
