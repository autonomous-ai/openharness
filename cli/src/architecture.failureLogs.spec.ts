/**
 * No daemon log line carries an error's words or hides its kind (AGENTS.md, Code standards, rules 6 and 7). A message
 * or a stack can quote the person's files, prompts or a peer's text, and since #4447 Export logs sends the daemon's log
 * off the machine. A line that says only "failed" names nothing anyone can act on. A failure is logged as
 * `errorKind(error)` (lib/log.ts): its type and its code, never its words. So this reads every file of the daemon, as
 * code, so that a comment or a string naming an error is no finding.
 *
 * A log call is a `console` call, or a call named `log`, `warn`, `error` or `info`, bare or on anything but `console`
 * and `Math`, or a call of one picked by `??`, `||` or `?:`, or of a name a parameter's default or a `const` binds to
 * one, whose value is not thrown. An error is what a catch or an error handler binds, a name on the left of
 * `instanceof` in the expression at hand, a name spelled as one (`e`, `err`, `error`, `ex`, `exception`, `…Error`,
 * `…Err`) that is not a parameter typed `string`, and the `.cause` of any of these. A log call is found when it prints
 * an error's `.message`, `.stack` or `.toString()`, an error whole (as itself, in a template, a sum, an object or a
 * branch, handed to any function but `errorKind`, or built in place), or a local made from either (its initializer, or
 * a value a `let` is given later); when it runs in a catch that binds nothing; and when it says "fail" in a catch that
 * binds one and names nothing it caught. What a function of the file's own logs of a parameter (a function, a `const`
 * one, a method called on `this`), and what a `writeSync` writes, are found the same way, but for the catch they run in.
 *
 * Its limits: a logger under another name, text carried two locals away or through a local of the function that logs
 * it, a catch with a binding that logs without the word "fail", and an error's `.reason`, `.detail`, `.stderr`,
 * `.stdout` and `.path`, which a follow-up adds with the lines that log stored strings
 * (docs/plans/2026-11-19-log-failure-kinds-plan.md, answer 6).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import typescript from 'typescript'
import { expect, it } from 'vitest'

// Vitest hands a test an imported package through a proxy that runs at every read, and the scan reads TypeScript's
// functions millions of times: through the alias, the package is read once, and the scan takes half the time.
import ts = typescript

const SRC = __dirname

/** What a command prints on the terminal of the person who ran it, not in a log: these files print only that. */
const TERMINAL = [
  'cli.ts', // the commands; its lines that reach a log are kept to the rule by hand
  'remoteCommand.ts', // harness remote
  'shellLaunch.ts', // harness shell-launch, in the pane it starts
  'devices/client.ts', // harness hardware
  'orchestrator/command.ts', // harness orchestrator
  'agentClient/settings.ts', // harness agent settings, from cli.ts alone: its `err` is the person's own terminal
  'lib/autonomous-device/addonCommand.ts', // harness addon, from cli.ts alone: its `print` is the command's JSON answer
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

/**
 * `console.*`, a logger by its name on anything but `console` and `Math`, one picked by `??`, `||` or `?:`
 * (`(deps.log ?? console.warn)(…)`), and a name a parameter's default or a `const` binds to one (`say = console.log`).
 */
const isLogger = (node: ts.Expression): boolean => {
  const callee = unwrap(node)
  if (ts.isConditionalExpression(callee)) return isLogger(callee.whenTrue) || isLogger(callee.whenFalse)
  if (ts.isBinaryExpression(callee)) {
    return [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(callee.operatorToken.kind)
      && (isLogger(callee.left) || isLogger(callee.right))
  }
  if (ts.isIdentifier(callee)) {
    if (LOGGERS.includes(callee.text)) return true
    const declaration = declarationOf(callee)
    return !!declaration && (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration))
      && !!declaration.initializer && isLogger(declaration.initializer)
  }
  if (!ts.isPropertyAccessExpression(callee)) return false
  const on = unwrap(callee.expression)
  if (ts.isIdentifier(on) && on.text === 'console') return [...LOGGERS, 'debug'].includes(callee.name.text)
  return !(ts.isIdentifier(on) && on.text === 'Math') && LOGGERS.includes(callee.name.text)
}

/** A logger called; `throw contract.error(…)` builds an error. */
const isLogCall = (call: ts.CallExpression): boolean => {
  let at: ts.Node = call
  while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent
  return !ts.isThrowStatement(at.parent) && isLogger(call.expression)
}

/** The master writes its fatal line to the log's fd with `writeSync` (masterProcess.ts `writeFatalTo`). */
const isWriteSync = (call: ts.CallExpression): boolean => {
  const callee = unwrap(call.expression)
  return (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '') === 'writeSync'
}

/**
 * The function of the file's own a call runs: a function or a `const` function by its name, or a method or function
 * property of the class `this` is.
 */
const calleeOf = (call: ts.CallExpression): ts.SignatureDeclaration | undefined => {
  const callee = unwrap(call.expression)
  const fn = (node: ts.Node | undefined): ts.SignatureDeclaration | undefined => {
    const value = node && (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer ? unwrap(node.initializer) : node
    return value && (ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value) || ts.isArrowFunction(value)
      || ts.isFunctionExpression(value)) ? value : undefined
  }
  if (ts.isIdentifier(callee)) return fn(declarationOf(callee))
  if (!ts.isPropertyAccessExpression(callee) || callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined
  for (let at = call.parent; at; at = at.parent) {
    if (ts.isClassLike(at)) {
      return fn(at.members.find((member) => member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
        && member.name.text === callee.name.text))
    }
    // `this` is not the class's in a function of its own or an object's method.
    if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at) || (ts.isMethodDeclaration(at) && ts.isObjectLiteralExpression(at.parent))) return undefined
  }
  return undefined
}

const forwarded = new WeakMap<ts.SignatureDeclaration, Set<number>>()

/** The parameters, by index, a function hands a logger, itself or through the functions of the file's own it calls. */
const forwardedBy = (fn: ts.SignatureDeclaration): Set<number> => {
  const known = forwarded.get(fn)
  if (known) return known
  const at = new Set<number>()
  // Kept before it is known: a function that calls itself reads what is found so far.
  forwarded.set(fn, at)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const logged = loggedArguments(node)
      fn.parameters.forEach((only, index) => {
        if (logged.length && firstPrinted(logged, true, { tested: new Set(), locals: false, only })) at.add(index)
      })
    }
    ts.forEachChild(node, visit)
  }
  if ('body' in fn && fn.body) visit(fn.body)
  return at
}

/** What a call writes to the log: a log call's or a `writeSync`'s arguments, and those a function of the file's own forwards. */
const loggedArguments = (call: ts.CallExpression): readonly ts.Expression[] => {
  if (isLogCall(call) || isWriteSync(call)) return call.arguments
  const fn = calleeOf(call)
  if (!fn) return []
  const at = forwardedBy(fn)
  return call.arguments.filter((_, index) => at.has(index))
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

const namesOf = (name: ts.BindingName): string[] => ts.isIdentifier(name)
  ? [name.text]
  : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : namesOf(element.name))

const scopes = new WeakMap<ts.Node, ReadonlyMap<string, ts.Node>>()

/**
 * The names a scope declares, each to its first declaration: a catch's, a function's parameters, a `for`'s locals, a
 * block's locals, functions and classes. Indexed once per scope: a lookup that read every statement of every block
 * around it, for each name of each call, was most of the time the scan spent past parsing.
 */
const declaredIn = (scope: ts.Node): ReadonlyMap<string, ts.Node> | undefined => {
  const known = scopes.get(scope)
  if (known) return known
  const names = new Map<string, ts.Node>()
  const add = (name: ts.BindingName, declaration: ts.Node): void => {
    for (const text of namesOf(name)) if (!names.has(text)) names.set(text, declaration)
  }
  if (ts.isCatchClause(scope)) {
    if (scope.variableDeclaration) add(scope.variableDeclaration.name, scope.variableDeclaration)
  } else if (ts.isFunctionLike(scope)) {
    scope.parameters.forEach((parameter) => add(parameter.name, parameter))
  } else if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
    if (scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      scope.initializer.declarations.forEach((declaration) => add(declaration.name, declaration))
    }
  } else if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    for (const statement of scope.statements) {
      if (ts.isVariableStatement(statement)) statement.declarationList.declarations.forEach((declaration) => add(declaration.name, declaration))
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) add(statement.name, statement)
    }
  } else return undefined
  scopes.set(scope, names)
  return names
}

/** Where [identifier] is declared, the nearest scope first: a catch, a parameter, a local, a function or class. */
const declarationOf = (identifier: ts.Identifier): ts.Node | undefined => {
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    const declaration = declaredIn(scope)?.get(identifier.text)
    if (declaration) return declaration
  }
  return undefined
}

const ERROR_NAME = /^(e|err|error|ex|exception)$|(Error|Err)$/

/**
 * What the expression at hand holds: the names it tests with `instanceof`, and whether a local made from an error counts.
 * [only] reads one parameter as the error and nothing else: what a function prints of it is what it logs of its callers'.
 */
type Hand = { tested: Set<string>, locals: boolean, only?: ts.ParameterDeclaration }

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
  if (hand.only) return declarationOf(identifier) === hand.only ? 'error' : undefined
  if (hand.tested.has(identifier.text)) return 'error'
  const declaration = declarationOf(identifier)
  if (declaration && ts.isVariableDeclaration(declaration) && ts.isCatchClause(declaration.parent)) return 'error'
  if (declaration && ts.isParameter(declaration)) {
    if (isErrorHandler(declaration.parent) && declaration.parent.parameters[0] === declaration) return 'error'
    if (declaration.type?.kind === ts.SyntaxKind.StringKeyword) return undefined
  }
  if (ERROR_NAME.test(identifier.text)) return 'error'
  if (hand.locals && declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)
    // Two locals away is a limit: a value is read without following its own locals.
    && valuesOf(declaration).some((value) => printed(value, true, handOf([value], false)))) return 'local'
  return undefined
}

/** What a local is given: its initializer and, for a `let`, every value assigned or added to it where it is declared. */
const valuesOf = (declaration: ts.VariableDeclaration): ts.Expression[] => {
  const values = declaration.initializer ? [declaration.initializer] : []
  if (!(declaration.parent.flags & ts.NodeFlags.Let)) return values
  const name = declaration.name.getText()
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)
      && ts.isIdentifier(node.left) && node.left.text === name && declarationOf(node.left) === declaration) values.push(node.right)
    ts.forEachChild(node, visit)
  }
  visit(declaration.parent.parent.parent)
  return values
}

const isBuilt = (node: ts.Expression): boolean => ts.isNewExpression(node)
  && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))
  && /Error$/.test(ts.isIdentifier(node.expression) ? node.expression.text : node.expression.name.text)

const isError = (node: ts.Expression, hand: Hand): boolean => {
  const inner = unwrap(node)
  if (ts.isIdentifier(inner)) return nameOf(inner, hand) === 'error'
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'cause') return isError(inner.expression, hand)
  return !hand.only && isBuilt(inner)
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
  // The rule reads no JSDoc: leaving it unparsed takes a tenth off the parse.
  const source = ts.createSourceFile(file, code, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // A `writeSync` and a function of the file's own are read for what they log, not for the catch they run in.
      const logged = loggedArguments(node)
      // The hand is read only for a call that logs: read for every call, a chain's arguments were walked once per link.
      const finding = (logged.length ? firstPrinted(logged, true, handOf(node.arguments, true)) : undefined)
        ?? (isLogCall(node) ? hidden(node) : undefined)
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
  "try { run() } catch (error) { (deps.log ?? console.warn)(`[x] paused · ${error instanceof Error ? error.message : String(error)}`) }",
  "try { run() } catch (err) { (failed ? console.error : console.log)(`[x] ${String(err)}`) }",
  "function probe(say: (line: string) => void = console.log) { try { run() } catch (error) { say(`[x] failed: ${(error as Error).message}`) } }",
  "class Viewer { private fail(state: State, line: string) { this.log(line); this.halt(state) } start() { try { run() } catch (error) { void this.fail(this.state, `[x] could not start · ${error instanceof Error ? error.message : error}`) } } }",
  "class Mirror { private trace(id: string, line: string, isError = false) { (isError ? console.error : console.log)(`[recap] ${line}`) } end() { work().catch((err) => this.trace('s', `failed: ${err instanceof Error ? err.message : String(err)}`, true)) } }",
  "const say = (line: string): void => { if (line !== said) { said = line; log(line) } }; proc.on('error', (error) => { say(`[x] could not start: ${error.message}`) })",
  "function once(line: string) { if (said.has(line)) return; console.warn(line) } try { run() } catch (error) { once(`[x] unreadable · ${String(error)}`) }",
  "const stay = (why: string) => deps.log(`[x] ${why} — keeping`); const keep = (why: string) => { removeMarker(); stay(why) }; run().catch((error) => keep(`failed (${describe(error)})`))",
  "let busy = 'the lock is busy'; await lock().catch((error) => { busy = `could not take the lock (${message(error)})` }); deps.log(`[x] ${busy}`)",
  "process.on('uncaughtException', (error) => { writeSync(fd, `[x] stopped: ${error instanceof Error ? error.stack ?? error.message : format(error)}\\n`) })",
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
  "try { run() } catch (error) { (deps.log ?? console.warn)(`[x] paused · ${errorKind(error)}`) }",
  "try { run() } catch (err) { (failed ? console.error : console.log)(`[x] ${errorKind(err)}`) }",
  "function probe(say: (line: string) => void = console.log) { try { run() } catch (error) { say(`[x] failed: ${errorKind(error)}`) } }",
  "class Viewer { private fail(state: State, line: string) { this.log(line); this.halt(state) } start() { try { run() } catch (error) { void this.fail(this.state, `[x] could not start · ${errorKind(error)}`) } } }",
  "const say = (line: string): void => { if (line !== said) { said = line; log(line) } }; proc.on('error', (error) => { say(`[x] could not start: ${errorKind(error)}`) })",
  "let busy = 'the lock is busy'; await lock().catch((error) => { busy = `could not take the lock (${errorKind(error)})` }); deps.log(`[x] ${busy}`)",
  "process.on('uncaughtException', (error) => { writeSync(fd, `[x] stopped: ${errorKind(error)}\\n`) })",
  // A function's own words are checked only where it logs them: here the error's go to the reply, its kind to the log.
  "const refused = (id: string, error: unknown, detail: string) => { log(`[x] ${id} refused · ${errorKind(error)}`); reply({ detail }) }; try { run() } catch (error) { refused('a', error, (error as Error).message) }",
  "const sizeOf = (line: string) => log(`[x] a line of ${line.length} chars`); try { run() } catch (error) { sizeOf((error as Error).message) }",
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
