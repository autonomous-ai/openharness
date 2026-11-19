/**
 * No daemon log line carries an error's words or hides its kind (AGENTS.md, Code standards, rules 6 and 7). A message
 * or a stack can quote the person's files, prompts or a peer's text, and since #4447 Export logs sends the daemon's log
 * off the machine. A line that says only "failed" names nothing anyone can act on. A failure is logged as
 * `errorKind(error)` (lib/log.ts): its type and its code, never its words. So this reads every file of the daemon, as
 * code, so that a comment or a string naming an error is no finding.
 *
 * A log call is a `console` call, or a call named `log`, `warn`, `error` or `info`, bare or on anything but `console`
 * and `Math`, whose value is not thrown. An error is what a catch or an error handler binds, a name on the left of
 * `instanceof` in the expression at hand, a name spelled as one (`e`, `err`, `error`, `ex`, `exception`, `…Error`,
 * `…Err`) that is not a parameter typed `string`, and the `.cause` of any of these. A log call is found when it prints
 * an error's `.message`, `.stack` or `.toString()`, an error whole (as itself, in a template, a sum, an object or a
 * branch, handed to any function but `errorKind`, or built in place), or a local made from either; when it runs in a
 * catch that binds nothing; and when it says "fail" in a catch that binds one and names nothing it caught.
 *
 * Its limits: a logger under another name, text carried two locals away, a catch with a binding that logs without the
 * word "fail", and an error's `.reason`, `.detail`, `.stderr`, `.stdout` and `.path`, which a follow-up adds with the
 * lines that log stored strings (docs/plans/2026-11-19-log-failure-kinds-plan.md, answer 6).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const SRC = __dirname

/** What a command prints on the terminal of the person who ran it, not in a log: these files print only that. */
const TERMINAL = [
  'cli.ts', // the commands; its lines that reach a log are kept to the rule by hand
  'remoteCommand.ts', // harness remote
  'shellLaunch.ts', // harness shell-launch, in the pane it starts
  'devices/client.ts', // harness hardware
  'orchestrator/command.ts', // harness orchestrator
  'lib/apiCommand.ts', // harness api
  'lib/newCommand.ts', // harness new
  'lib/flash.ts', // harness flash
  'lib/daemonStop.ts', // harness stop
  'lib/machineEngines.ts', // harness machines engines
  'lib/updateCommand.ts', // harness update
  'lib/windows/ptyUpdateCommand.ts', // harness update, its terminal host step
  'lib/daemonState.ts', // onError, how a command fails
]

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
  || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node

const LOGGERS = ['log', 'warn', 'error', 'info']

/** `console.*`, or a logger by its name on anything but `console` and `Math`; `throw contract.error(…)` builds an error. */
const isLogCall = (call: ts.CallExpression): boolean => {
  let at: ts.Node = call
  while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent
  if (ts.isThrowStatement(at.parent)) return false
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee)) return LOGGERS.includes(callee.text)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const on = unwrap(callee.expression)
  if (ts.isIdentifier(on) && on.text === 'console') return [...LOGGERS, 'debug'].includes(callee.name.text)
  return !(ts.isIdentifier(on) && on.text === 'Math') && LOGGERS.includes(callee.name.text)
}

const ERROR_EVENTS = ['error', 'unhandledRejection', 'uncaughtException']

/** A function handed an error first: `.catch(fn)`, `.then(_, fn)`, `.on('error', fn)` and its kin. */
const isErrorHandler = (fn: ts.Node): fn is ts.ArrowFunction | ts.FunctionExpression => {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  let at: ts.Node = fn
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent
  const call = at.parent
  if (!ts.isCallExpression(call)) return false
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const index = call.arguments.indexOf(at as ts.Expression)
  const event = call.arguments[0]
  switch (callee.name.text) {
    case 'catch': return index === 0
    case 'then': return index === 1
    case 'on': case 'once': case 'addListener': case 'prependListener':
      return index === 1 && !!event && ts.isStringLiteralLike(event) && ERROR_EVENTS.includes(event.text)
    default: return false
  }
}

const binds = (name: ts.BindingName, text: string): boolean => ts.isIdentifier(name)
  ? name.text === text
  : name.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name, text))

/** Where [identifier] is declared, the nearest scope first: a catch, a parameter, a local, a function or class. */
const declarationOf = (identifier: ts.Identifier): ts.Node | undefined => {
  const text = identifier.text
  const among = (list: ts.VariableDeclarationList): ts.VariableDeclaration | undefined =>
    list.declarations.find((declaration) => binds(declaration.name, text))
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(scope.variableDeclaration.name, text)) return scope.variableDeclaration
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((candidate) => binds(candidate.name, text))
      if (parameter) return parameter
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
      && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const declaration = among(scope.initializer)
      if (declaration) return declaration
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      for (const statement of scope.statements) {
        const declaration = ts.isVariableStatement(statement) ? among(statement.declarationList)
          : (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === text ? statement
          : undefined
        if (declaration) return declaration
      }
    }
  }
  return undefined
}

const ERROR_NAME = /^(e|err|error|ex|exception)$|(Error|Err)$/

/** What the expression at hand holds: the names it tests with `instanceof`, and whether a local made from an error counts. */
type Hand = { tested: Set<string>, locals: boolean }

const handOf = (nodes: readonly ts.Node[], locals: boolean): Hand => {
  const tested = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const left = unwrap(node.left)
      if (ts.isIdentifier(left)) tested.add(left.text)
    }
    ts.forEachChild(node, visit)
  }
  nodes.forEach(visit)
  return { tested, locals }
}

/** `error`, `local` (a `const` or `let` made from an error's words or the error, rule 3) or neither. */
const nameOf = (identifier: ts.Identifier, hand: Hand): 'error' | 'local' | undefined => {
  if (hand.tested.has(identifier.text)) return 'error'
  const declaration = declarationOf(identifier)
  if (declaration && ts.isVariableDeclaration(declaration) && ts.isCatchClause(declaration.parent)) return 'error'
  if (declaration && ts.isParameter(declaration)) {
    if (isErrorHandler(declaration.parent) && declaration.parent.parameters[0] === declaration) return 'error'
    if (declaration.type?.kind === ts.SyntaxKind.StringKeyword) return undefined
  }
  if (ERROR_NAME.test(identifier.text)) return 'error'
  if (hand.locals && declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    && declaration.initializer && ts.isVariableDeclarationList(declaration.parent)
    && declaration.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)
    // Two locals away is a limit: the initializer is read without following its own locals.
    && printed(declaration.initializer, true, handOf([declaration.initializer], false))) return 'local'
  return undefined
}

const isBuilt = (node: ts.Expression): boolean => ts.isNewExpression(node)
  && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))
  && /Error$/.test(ts.isIdentifier(node.expression) ? node.expression.text : node.expression.name.text)

const isError = (node: ts.Expression, hand: Hand): boolean => {
  const inner = unwrap(node)
  if (ts.isIdentifier(inner)) return nameOf(inner, hand) === 'error'
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'cause') return isError(inner.expression, hand)
  return isBuilt(inner)
}

const PASSING_OPERATORS = [
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InstanceOfKeyword,
]
// A sum prints both its sides, and `??` and `||` print either.
const OPERAND_OPERATORS = [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]

const shown = (node: ts.Node): string => node.getText().replace(/\s+/g, ' ')

const firstPrinted = (parts: readonly ts.Node[], whole: boolean, hand: Hand): string | undefined => {
  for (const part of parts) {
    const found = printed(part, whole, hand)
    if (found) return found
  }
  return undefined
}

/**
 * What [node] prints of an error, or undefined. [whole] says its value is printed as it is (an argument, a template's
 * part, a branch): an error there is printed whole. Elsewhere (a property read, a condition) only its words can be.
 */
function printed(node: ts.Node, whole: boolean, hand: Hand): string | undefined {
  const inner = ts.isExpression(node) ? unwrap(node) : node
  // A kind, a number, a type test and a comparison carry no words.
  if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && ['errorKind', 'Number'].includes(inner.expression.text)) return undefined
  if (ts.isTypeOfExpression(inner)) return undefined
  if (ts.isBinaryExpression(inner) && PASSING_OPERATORS.includes(inner.operatorToken.kind)) return undefined
  if (ts.isIdentifier(inner)) {
    const name = whole ? nameOf(inner, hand) : undefined
    return name === 'error' ? `an error, ${inner.text}` : name === 'local' ? `a local made from an error, ${inner.text}` : undefined
  }
  if (ts.isExpression(inner) && whole && isError(inner, hand)) return `an error, ${shown(inner)}`
  const first = (parts: readonly ts.Node[], partsWhole: boolean): string | undefined => firstPrinted(parts, partsWhole, hand)
  if (ts.isPropertyAccessExpression(inner)) {
    if (['message', 'stack'].includes(inner.name.text) && isError(inner.expression, hand)) return `an error's words, ${shown(inner)}`
    return printed(inner.expression, false, hand)
  }
  if (ts.isCallExpression(inner)) {
    const callee = unwrap(inner.expression)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toString' && isError(callee.expression, hand)) {
      return `an error's words, ${shown(inner)}`
    }
    // Handed to any function, an error is printed by what that function makes of it.
    return printed(callee, false, hand) ?? first(inner.arguments, true)
  }
  if (ts.isNewExpression(inner)) return first(inner.arguments ?? [], true)
  if (ts.isTemplateExpression(inner)) return first(inner.templateSpans.map((span) => span.expression), true)
  if (ts.isConditionalExpression(inner)) return printed(inner.condition, false, hand) ?? first([inner.whenTrue, inner.whenFalse], true)
  if (ts.isBinaryExpression(inner)) {
    const operands = OPERAND_OPERATORS.includes(inner.operatorToken.kind)
    return printed(inner.left, operands, hand) ?? printed(inner.right, operands, hand)
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return first(inner.properties.flatMap((property) => ts.isPropertyAssignment(property) ? [property.initializer]
      : ts.isShorthandPropertyAssignment(property) ? [property.name]
      : ts.isSpreadAssignment(property) ? [property.expression] : []), true)
  }
  if (ts.isArrayLiteralExpression(inner)) return first(inner.elements, true)
  if (ts.isSpreadElement(inner) || ts.isAwaitExpression(inner)) return printed(inner.expression, true, hand)
  const children: ts.Node[] = []
  ts.forEachChild(inner, (child) => { children.push(child) })
  return first(children, false)
}

/** The catch a log call runs in: the nearest catch clause or error handler in the function it is in. */
const catchOf = (call: ts.Node): ts.CatchClause | ts.ArrowFunction | ts.FunctionExpression | undefined => {
  for (let at = call.parent; at; at = at.parent) {
    if (ts.isCatchClause(at)) return at
    if (ts.isFunctionLike(at)) return isErrorHandler(at) ? at : undefined
  }
  return undefined
}

/** Every name the arguments read, as a value: not a property's name, not a type. */
const namesIn = (nodes: readonly ts.Node[]): ts.Identifier[] => {
  const names: ts.Identifier[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return
    if (ts.isIdentifier(node)) names.push(node)
    else if (ts.isPropertyAccessExpression(node)) visit(node.expression)
    else if (ts.isPropertyAssignment(node)) visit(node.initializer)
    else ts.forEachChild(node, visit)
  }
  nodes.forEach(visit)
  return names
}

/** The words a log call writes of its own: its strings and its templates' text. */
const textOf = (nodes: readonly ts.Node[]): string => {
  const text: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text.push(node.text)
    ts.forEachChild(node, visit)
  }
  nodes.forEach(visit)
  return text.join(' ')
}

/** What a log call in a catch hides: a catch that binds nothing, or "fail" that names nothing it caught. */
const hidden = (call: ts.CallExpression): string | undefined => {
  const caught = catchOf(call)
  if (!caught) return undefined
  const binding = ts.isCatchClause(caught) ? caught.variableDeclaration : caught.parameters[0]
  if (!binding) return 'a catch that binds nothing'
  if (!/fail/i.test(textOf(call.arguments))) return undefined
  const madeFrom = (declaration: ts.Node | undefined): boolean => declaration === binding
    || (!!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer
      && namesIn([declaration.initializer]).some((name) => declarationOf(name) === binding))
  return namesIn(call.arguments).some((name) => madeFrom(declarationOf(name))) ? undefined : '"fail" naming nothing it caught'
}

/** Each log call in [code] that prints an error's words or hides its kind, as `<file>:<line>: <what it found>`. */
function failureLogs(code: string, file = 'file.ts'): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLogCall(node)) {
      const finding = firstPrinted(node.arguments, true, handOf(node.arguments, true)) ?? hidden(node)
      if (finding) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${finding}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The hits in every file of the daemon: every .ts under cli/src but tests, scripts of tests, the TUI and the terminal list. */
const daemonHits = (): string[] => readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split(sep).join('/'))
  .filter((file) => file.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(file) && !/^(e2e|tui|testing)\//.test(file)
    && !/(^|\/)__fixtures__\//.test(file) && !TERMINAL.includes(file))
  .flatMap((file) => failureLogs(readFileSync(join(SRC, file), 'utf8'), file))

it.each([
  "try { run() } catch (error) { console.error('[x] failed:', error) }",
  "try { run() } catch (error) { console.error(`[x] failed: ${error}`) }",
  "try { run() } catch (error) { console.warn(`[x] failed: ${error instanceof Error ? error.message : String(error)}`) }",
  "try { run() } catch (err) { console.error('[x] failed:', err instanceof Error ? (err.stack ?? err.message) : err) }",
  "try { run() } catch (error) { console.warn('[x] ' + (error as Error).message) }",
  "try { run() } catch (e) { d.error(`[x] ${e}`) }",
  "try { run() } catch (error) { console.warn(`[x] ${error.toString()}`) }",
  "try { run() } catch (error) { console.error('[x] failed', (error as { cause?: unknown }).cause) }",
  "try { run() } catch (error) { wiring.log('[x] failed', { error }) }",
  "try { run() } catch (error) { this.opts.log?.(`[x] ${describe(error)}`) }",
  "try { run() } catch (error) { warn('[x] could not announce', new Error('archive unavailable')) }",
  "run().catch((reason) => console.error('[x] failed', reason))",
  "run().then(done, (why) => log(`[x] ${why}`))",
  "socket.on('error', (problem) => console.error('[x] socket error:', problem.message))",
  "process.on('unhandledRejection', (reason) => { console.error('[x]', reason) })",
  "function report(err: unknown) { deps.log(`[x] failed · ${String(err)}`) }",
  "function report(value: unknown) { log(`[x] ${value instanceof Error ? value.message : 'unknown'}`) }",
  "try { run() } catch (error) { const detail = error instanceof Error ? error.message : String(error); reply({ error: detail }); console.warn(`[x] refused · ${detail}`) }",
  "try { run() } catch (error) { const line = explain(error); console.error(line) }",
  "try { run() } catch { console.error('[x] save failed') }",
  "try { run() } catch { log('[x] its reader is unavailable') }",
  "run().catch(() => console.error('[x] save failed'))",
  "run().catch(() => { saved = false; log('[x] LIVE_REATTACH_FAILED') })",
  "try { run() } catch (error) { if (strict) throw wrap(error); console.error('[x] save failed') }",
  "socket.on('error', (err) => { const status = /^Unexpected server response: (\\d{3})$/.exec(err.message)?.[1]; console.error(`[x] socket error: ${status}`) })",
])('finds %s', (code) => expect(failureLogs(code)).not.toEqual([]))

it.each([
  "try { run() } catch (error) { console.error(`[x] save failed · ${errorKind(error)}`) }",
  "run().catch((error) => console.error(`[x] failed · ${errorKind(error)}`))",
  "try { run() } catch (error) { console.error(`[x] failed · ${errorKind((error as { cause?: unknown }).cause)}`) }",
  "// console.error('[x] failed:', error)",
  "const script = \"console.error('failed', error.message)\"",
  "try { run() } catch (error) { reply({ error: error instanceof Error ? error.message : 'FAILED' }) }",
  "try { run() } catch (error) { throw contract.error(error) }",
  "const refused = (error: string) => { log(`[frames] ${error}`); return { error } }",
  "console.warn(`[x] refused · ${verdict.error}`)",
  "console.log(JSON.stringify({ ok: false, error: 'NOT_SIGNED_IN' }))",
  "try { run() } catch (error) { console.warn(`[x] unavailable · ${error instanceof ReadError ? error.code : 'UNAVAILABLE'}`) }",
  "try { run() } catch (error) { log(`[x] not opened · ${(error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'in use' : 'failed'}`) }",
  "try { run() } catch (error) { const code = error instanceof Error && error.message === 'TOO_LARGE' ? 'LIVE_TOO_LARGE' : 'LIVE_OPEN_FAILED'; console.warn(`[x] ${code}`) }",
  "try { run() } catch (error) { const disposition = classify(error); console.error(`[x] not staying up — ${disposition.reason}`) }",
  "try { run() } catch (error) { if (missing(error)) return; console.log('[x] nothing saved yet') }",
  "try { run() } catch { /* not there yet */ }",
  "run().catch(() => undefined)",
  "const depth = Math.log(error)",
  "setTimeout(() => console.log('[x] retrying'), 100)",
  "socket.on('error', (err) => { const status = Number(/^Unexpected server response: (\\d{3})$/.exec(err.message)?.[1]); console.error(`[x] socket error: ${errorKind(err)}${status ? ` · Unexpected server response: ${status}` : ''}`) })",
  // Not yet: the follow-up task moves these two to `finds` when it adds the stored fields (answer 6).
  "try { run() } catch (error) { console.warn(`[x] not unpacked (${error.reason})`) }",
  "try { run() } catch (error) { console.error('[x] git refused:', (error as { stderr?: string }).stderr) }",
])('passes %s', (code) => expect(failureLogs(code)).toEqual([]))

it('no daemon log line carries an error\'s words or hides its kind', () => {
  expect(daemonHits(), 'A daemon log line names a failure by its kind, '
    + '`errorKind(error)` from lib/log.ts, and never prints an error\'s message, stack or the error itself: those can quote '
    + 'the person\'s files and prompts, and Export logs sends the log off the machine. A catch that logs binds what it '
    + 'caught and names its kind, so someone can act on the line.').toEqual([])
})

it('every terminal file exists', () => {
  expect(TERMINAL.filter((file) => !existsSync(join(SRC, file)))).toEqual([])
})
