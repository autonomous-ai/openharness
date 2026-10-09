/**
 * The strings a spec writes out, evaluated without running it: literals, templates over the file's constants,
 * `[...].join('\n')`, stringified object literals (`JSON.stringify({...})` or a one-expression alias of it) and the
 * file's one-expression helpers (`footer('x')`). A golden uses them as the inputs the repository already has, and
 * copies what it took, so that a later edit of a spec does not move it. An expression that cannot be evaluated
 * whole is left out.
 */
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const NONE = Symbol('none')
type Env = Map<string, unknown>

/** Every string value the file's expressions evaluate to, in order of first appearance, once each. */
export function specStrings(path: string, minLength = 3): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const constants: Env = new Map()
  const helpers = new Map<string, ts.ArrowFunction>()
  const lookup = (name: string, env: Env): unknown => env.has(name) ? env.get(name) : constants.has(name) ? constants.get(name) : NONE
  const evaluate = (node: ts.Node, env: Env = new Map(), depth = 0): unknown => {
    if (depth > 20) return NONE
    const again = (child: ts.Node): unknown => evaluate(child, env, depth + 1)
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return again(node.expression)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isIdentifier(node)) return node.text === 'undefined' ? undefined : lookup(node.text, env)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = again(node.left), right = again(node.right)
      return typeof left === 'string' && (typeof right === 'string' || typeof right === 'number') ? left + String(right) : NONE
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text
      for (const span of node.templateSpans) {
        const value = again(span.expression)
        if (typeof value !== 'string' && typeof value !== 'number') return NONE
        out += String(value) + span.literal.text
      }
      return out
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values: unknown[] = []
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = again(element.expression)
          if (!Array.isArray(spread)) return NONE
          values.push(...spread)
        } else {
          const value = again(element)
          if (value === NONE) return NONE
          values.push(value)
        }
      }
      return values
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {}
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) {
          const value = again(property.initializer)
          if (value === NONE) return NONE
          out[property.name.text] = value
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const value = lookup(property.name.text, env)
          if (value === NONE) return NONE
          out[property.name.text] = value
        } else if (ts.isSpreadAssignment(property)) {
          const value = again(property.expression)
          if (!value || typeof value !== 'object' || Array.isArray(value)) return NONE
          Object.assign(out, value)
        } else return NONE
      }
      return out
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map((arg) => ts.isSpreadElement(arg) ? NONE : again(arg))
      if (args.includes(NONE)) return NONE
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join' && args.length <= 1) {
        const list = again(node.expression.expression)
        const separator = args.length ? args[0] : ','
        return Array.isArray(list) && typeof separator === 'string' && list.every((item) => typeof item === 'string' || typeof item === 'number')
          ? list.join(separator) : NONE
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'repeat' && args.length === 1) {
        const value = again(node.expression.expression)
        return typeof value === 'string' && typeof args[0] === 'number' && args[0] >= 0 && args[0] <= 1000 ? value.repeat(args[0]) : NONE
      }
      const callee = node.expression.getText()
      if (callee === 'JSON.stringify' && args.length === 1) return JSON.stringify(args[0])
      const helper = helpers.get(callee)
      if (!helper || ts.isBlock(helper.body)) return NONE
      const scope: Env = new Map()
      helper.parameters.forEach((parameter, i) => {
        if (!ts.isIdentifier(parameter.name)) return
        if (parameter.dotDotDotToken) scope.set(parameter.name.text, args.slice(i))
        else scope.set(parameter.name.text, i < args.length ? args[i] : parameter.initializer ? evaluate(parameter.initializer, scope, depth + 1) : undefined)
      })
      return evaluate(helper.body, scope, depth + 1)
    }
    return NONE
  }
  const declare = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer)) helpers.set(node.name.text, node.initializer)
      else if (!constants.has(node.name.text)) {
        const value = evaluate(node.initializer)
        if (value !== NONE) constants.set(node.name.text, value)
      }
    }
    ts.forEachChild(node, declare)
  }
  declare(source)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && !ts.isIdentifier(node)) {
      const value = evaluate(node)
      if (typeof value === 'string' && value.length >= minLength) found.add(value)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...found]
}
