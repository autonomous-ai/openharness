/**
 * Finds reads that can send an empty `in` list to Prisma on MongoDB (Database optimization roadmap, phase 0.3). Prisma turns
 * `in: []` into `$or: []`, which no index serves: a scan of the whole collection that returns nothing, seen in the slow log on
 * machines, users and SuperTab. A read of one of those models (or a raw `$in`) that names a list held in a variable must test
 * that list's `.length` or `.size` first in the same function (an `if`, a `?:` or `&&`), or pass a literal list or a constant.
 * A `.map` or a `new Set` of a list is empty exactly when that list is, so a test of the source list counts; a `.filter` is
 * not: name the filtered list and test that.
 */
import ts from 'typescript'

/** The collections the slow log names. */
export const GUARDED_MODELS = new Set(['machine', 'user', 'superTab'])

export interface Unguarded { file: string; line: number; list: string }

const isCondition = (node: ts.Node): boolean => ts.isIfStatement(node) || ts.isConditionalExpression(node)
  || (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
const conditionText = (node: ts.Node): string => ts.isIfStatement(node) || ts.isConditionalExpression(node) ? node.getChildAt(ts.isIfStatement(node) ? 2 : 0).getText() : node.getText()
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
    const tests = (node: ts.Node) => names.some(list => [`${list}.length`, `${list}.size`].some(text => conditionText(node).includes(text)))
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
      const lookFor = (inner: ts.Node) => {
        if (ts.isPropertyAssignment(inner) && ['in', '$in'].includes(inner.name.getText().replaceAll(/['"]/g, ''))
          && !ts.isArrayLiteralExpression(inner.initializer) && !(ts.isIdentifier(inner.initializer) && CONSTANT.test(inner.initializer.text))) {
          const list = inner.initializer.getText()
          if (!(isListName(listOf(inner.initializer)) && guarded(node, inner.initializer))) {
            found.push({ file, line: sf.getLineAndCharacterOfPosition(inner.getStart()).line + 1, list })
          }
        }
        ts.forEachChild(inner, lookFor)
      }
      node.arguments.forEach(lookFor)
    }
    ts.forEachChild(node, visitCall)
  }
  visitCall(sf)
  return found
}
