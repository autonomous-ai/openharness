/**
 * No daemon log line carries an error's words, a stored string, process output, a path or a URL, or hides an error's
 * kind (AGENTS.md, Code standards, rules 6 and 7). A message, a stack, a result's detail, a process's stderr or a
 * folder can quote the person's files, prompts, account name or a peer's text, and since #4447 Export logs sends the
 * daemon's log off the machine. A line that says only "failed" names nothing anyone can act on. A failure is logged as
 * `errorKind(error)` (lib/log.ts): its type and its code, never its words; a stored or a peer's string as
 * `codeOrLength(value)`, a path, URL or label as a fixed word or `hashOf(text)`, process output as its length. So this
 * reads every file of the daemon, `testing/` too (its shapes mirror the daemon's wiring), as code, so that a comment or
 * a string naming an error is no finding.
 *
 * A log call is a `console` call (`console.warn`, `console[stream]`), or a call named `log`, `warn`, `error` or
 * `info`, bare or on anything but `console` and `Math`, or a call of one picked by `??`, `||` or `?:`, or of a name a
 * parameter's default or a `const` binds to one, whose value is not thrown. An error is what a catch or an error
 * handler binds, a name on the left of `instanceof` in the expression at hand, a name spelled as one (`e`, `err`,
 * `error`, `ex`, `exception`, `…Error`, `…Err`) that is not a parameter typed `string`, and the `.cause` of any of
 * these. A log call is found when it prints an error's `.message`, `.stack`, `.reason`, `.detail`, `.stderr`,
 * `.stdout`, `.path`, `.dest`, `.cmd`, `.spawnargs` or `.toString()`, an error whole (as itself, in a template, a sum, an object, a branch, the right
 * side of `&&`, a method's receiver or what a callback returns, handed to any function but the safe ones below, or
 * built in place), or a local made from either (its initializer, or a value a `let` is given later); when it runs in a
 * catch that binds nothing; and when it says "fail" in a catch that binds one and names nothing it caught. It is
 * found, too, when it prints whole, as an identifier or a property read's last name, a name of any value that holds
 * content: process output (`stderr`, `stdout`, `output`, `…Stderr`, `…Stdout`, `…Output`), free text (`detail`,
 * `details`, `message`, `…Detail`, `…Message`), a path or URL (`path`, `cwd`, `dir`, `folder`, `file`, `home`, `url`,
 * `workspace`, `…Path`, `…Cwd`, `…Dir`, `…Folder`, `…File`, `…Home`, `…Url`, `…URL`, `…Workspace`, and constants
 * `…_PATH`, `…_DIR`, `…_FOLDER`, `…_FILE`, `…_HOME`, `…_URL`), a machine's name (`machine`, `machineName`,
 * `…MachineName`); but not a module of Node's own by its default or namespace name (`path` of `node:path`), nor a
 * forwarder's: a plain parameter handed on bare by a function whose callers are checked where they call it, one bound
 * to a logger's name (`log: (line) => …`, `deps.log ?? (…)`) or a function of the file's own. And when it prints whole
 * a property of a local given a function of the file's own's result (awaited or not) or an object literal, and the
 * value there is found by the rules above. A `.length` or a `.size`, a type test, a comparison, a `?:`'s condition (it
 * is tested, never printed), and what these return carry no words: `errorKind`, `codeOrLength`, `hashOf` and `sid`
 * (lib/log.ts), `serialPortName` (cable/serial.ts, the one way a serial port's name is logged) and `backendName`
 * (config/env.ts, which backend a URL names, in fixed words), each imported from its module under its own name or
 * called in that module; and Node's `Number`, `Boolean` and `Buffer.byteLength` where the file declares no such name.
 * What a function of the file's own logs of a parameter (a function, a `const` one, a method called on `this`), and
 * what a `writeSync` writes, are found the same way, but for the catch they run in.
 *
 * Its limits: a logger under another name; text carried two locals away or through a local of the function that logs
 * it; a local whose value is content of a name the rules read (`const shown = basename(file)`), never followed; what a
 * function of the file's own returns, but at a property of a local given it; a local destructured from an error or a
 * result; an error's or a value's words read by element access (`error['message']`); an `AggregateError`'s `.errors`;
 * a catch with a binding that logs without the word "fail"; a name the rules do not read (`reason`, `why`, a string
 * `error`: a syntactic rule cannot tell a literal union's fixed words from free text; `label`, which on the tree names
 * engines, runtimes and tallies in fixed words); a path read from a call (`process.cwd()`, `os.homedir()`, `tmpdir()`)
 * or from the environment's own `HOME` or `PATH`; a hold's sentence (`HookPreparationHeld`'s `hold`), which no rule
 * reads and `architecture.hookHolds.spec.ts` keeps to string literals; and a value built in one file and logged in
 * another (a hold's reason, a peer's answer, a probe's result, a stream's close reason), each fixed at its sink with a
 * behaviour test (docs/plans/2026-11-21-log-no-stored-strings-plan.md).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import typescript from 'typescript'
import { expect, it } from 'vitest'

// Vitest hands a test an imported package through a proxy that runs at every read, and the scan reads TypeScript's
// functions millions of times: through the alias, the package is read once, and the scan takes half the time.
import ts = typescript

const SRC = __dirname

/** What a command prints on the terminal of the person who ran it, not in a log: these files print only that. */
const TERMINAL = [
  'cli.ts', // the commands; a core run here fails in core/main.ts, its other lines that reach a log keep the rule by hand
  'config/startHome.ts', // before a command runs, from cli.ts alone: the folder a HOME that is not the account's gets
  'remoteCommand.ts', // harness remote
  'shellLaunch.ts', // harness shell-launch, in the pane it starts
  'devices/client.ts', // harness hardware
  'orchestrator/command.ts', // harness orchestrator
  'agentClient/settings.ts', // harness agent settings, from cli.ts alone: its `err` is the person's own terminal
  'agentClient/mcpServers.ts', // harness mcp-servers, from cli.ts alone
  'dsh/command.ts', // harness dsh, from cli.ts alone
  'engines/hooksCommand.ts', // harness hooks, from cli.ts alone: the entries a person adds to Hermes by hand
  'lib/autonomous-device/addonCommand.ts', // harness addon, from cli.ts alone: its `print` is the command's JSON answer
  'lib/apiCommand.ts', // harness api
  'lib/newCommand.ts', // harness new
  'lib/flash.ts', // harness flash
  'lib/daemonStop.ts', // harness stop
  'lib/machineEngines.ts', // harness machines engines
  'lib/updateCommand.ts', // harness update
  'lib/windows/ptyUpdateCommand.ts', // harness update, its terminal host step
]

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
  || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node

const LOGGERS = ['log', 'warn', 'error', 'info']

/**
 * `console.*`, by name or by element access (`console[stream]`), a logger by its name on anything but `console` and
 * `Math`, one picked by `??`, `||` or `?:` (`(deps.log ?? console.warn)(…)`), and a name a parameter's default or a
 * `const` binds to one (`say = console.log`).
 */
const isLogger = (node: ts.Expression): boolean => {
  const callee = unwrap(node)
  if (ts.isConditionalExpression(callee)) return isLogger(callee.whenTrue) || isLogger(callee.whenFalse)
  if (ts.isElementAccessExpression(callee)) {
    const on = unwrap(callee.expression)
    return ts.isIdentifier(on) && on.text === 'console'
  }
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

/** The master writes its fatal line to the log's fd with `writeSync` (lib/log.ts `exitOnFatal`). */
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

/** The values a function returns: its `return`s outside the functions it holds, or an arrow's body. */
const returnsOf = (fn: ts.SignatureDeclaration): ts.Expression[] => {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body]
  const values: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) values.push(node.expression)
    } else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit)
  }
  if ('body' in fn && fn.body) ts.forEachChild(fn.body, visit)
  return values
}

const awaited = (value: ts.Expression): ts.Expression => {
  const inner = unwrap(value)
  return ts.isAwaitExpression(inner) ? awaited(inner.expression) : inner
}

/** The object literals a value can be, through `await`, `?:`, `??` and `||`. */
const objectsIn = (value: ts.Expression): ts.ObjectLiteralExpression[] => {
  const inner = awaited(value)
  if (ts.isConditionalExpression(inner)) return [...objectsIn(inner.whenTrue), ...objectsIn(inner.whenFalse)]
  if (ts.isBinaryExpression(inner) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(inner.operatorToken.kind)) {
    return [...objectsIn(inner.left), ...objectsIn(inner.right)]
  }
  return ts.isObjectLiteralExpression(inner) ? [inner] : []
}

/** What an object literal holds at [name]: an assigned value or a shorthand's name. */
const valuesAt = (object: ts.ObjectLiteralExpression, name: string): ts.Expression[] => object.properties.flatMap((property) =>
  ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name
    ? [property.initializer]
    : ts.isShorthandPropertyAssignment(property) && property.name.text === name ? [property.name] : [])

const reading = new Set<ts.SignatureDeclaration>()

/**
 * What a property of a local, printed whole, prints of what the local was given: a function of the file's own's result
 * (awaited or not) or an object literal, read at that property as the log call's own argument. A function that calls
 * itself is read once.
 */
const returnedBy = (read: ts.PropertyAccessExpression, hand: Hand): string | undefined => {
  const on = unwrap(read.expression)
  const declaration = hand.locals && ts.isIdentifier(on) ? declarationOf(on) : undefined
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
    || !(declaration.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) return undefined
  for (const value of valuesOf(declaration)) {
    const given = awaited(value)
    const fn = ts.isCallExpression(given) ? calleeOf(given) : undefined
    if (fn && reading.has(fn)) continue
    const objects = fn ? returnsOf(fn).flatMap(objectsIn) : ts.isObjectLiteralExpression(given) ? [given] : []
    if (fn) reading.add(fn)
    let found: string | undefined
    for (const at of objects.flatMap((object) => valuesAt(object, read.name.text))) {
      found ??= printed(at, true, handOf([at], true))
    }
    if (fn) reading.delete(fn)
    if (found) return found
  }
  return undefined
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

/** The names an import binds: its default, its namespace or each of its named bindings. */
const importedBy = (clause: ts.ImportClause): ts.Identifier[] => [
  ...clause.name ? [clause.name] : [],
  ...!clause.namedBindings ? [] : ts.isNamespaceImport(clause.namedBindings) ? [clause.namedBindings.name]
    : clause.namedBindings.elements.map((element) => element.name),
]

const scopes = new WeakMap<ts.Node, ReadonlyMap<string, ts.Node>>()

/**
 * The names a scope declares, each to its first declaration: a catch's, a function's parameters, a `for`'s locals, a
 * block's locals, functions, classes and imports. Indexed once per scope: a lookup that read every statement of every
 * block around it, for each name of each call, was most of the time the scan spent past parsing.
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
      else if (ts.isImportDeclaration(statement) && statement.importClause) importedBy(statement.importClause).forEach((name) => add(name, statement))
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
 * What the expression at hand holds: the names it tests with `instanceof`, and whether it is the log call's own, where
 * a local made from an error counts and so do the names of content (a local's own value is read for an error alone).
 * [only] reads one parameter as the error and nothing else: what a function prints of it is what it logs of its callers'.
 * [passed] are the arguments a forwarder hands on as they are.
 */
type Hand = { tested: Set<string>, locals: boolean, only?: ts.ParameterDeclaration, passed?: ReadonlySet<ts.Node> }

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

/**
 * An error's fields that hold its words: what it says and where, what it stored, what a process printed, and Node's
 * own: a path and where it went, the command line that ran, a child's arguments.
 */
const ERROR_WORDS = ['message', 'stack', 'reason', 'detail', 'stderr', 'stdout', 'path', 'dest', 'cmd', 'spawnargs']

/** Names that hold content, of any value: what a process printed, free text, where a person's things are, and a name a person chose. */
const CONTENT_NAMES: ReadonlyArray<readonly [string, RegExp]> = [
  ['process output', /^(stderr|stdout|output)$|(Stderr|Stdout|Output)$/],
  ['free text', /^(detail|details|message)$|(Detail|Message)$/],
  ['a path or URL', /^(path|cwd|dir|folder|file|home|url|workspace)$|(Path|Cwd|Dir|Folder|File|Home|Url|URL|Workspace)$|_(PATH|DIR|FOLDER|FILE|HOME|URL)$/],
  ["a machine's name", /^(machine|machineName)$|MachineName$/],
]

/** What a name of the log call's own says it holds, when it is content. */
const contentNamed = (name: string, hand: Hand): string | undefined =>
  hand.locals ? CONTENT_NAMES.find(([, pattern]) => pattern.test(name))?.[0] : undefined

/**
 * The functions whose value carries no words, each by the module that holds it (from cli/src): a kind, a code or a
 * length, a hash, a short id, a serial port's name (the one function that passes it), and which backend a URL names, in
 * fixed words. Trusted by its name, any function so named would be: a local `sid` that slices a path.
 */
const SAFE_HELPERS: ReadonlyMap<string, string> = new Map([
  ['errorKind', 'lib/log'], ['codeOrLength', 'lib/log'], ['hashOf', 'lib/log'], ['sid', 'lib/log'],
  ['serialPortName', 'cable/serial'], ['backendName', 'config/env'],
])

/** Whether [name], called, is its safe helper: imported from the helper's module as itself, or that module's own. */
const isHelper = (name: ts.Identifier): boolean => {
  const home = SAFE_HELPERS.get(name.text)
  const declaration = home ? declarationOf(name) : undefined
  if (!home || !declaration) return false
  const file = name.getSourceFile().fileName
  if (ts.isFunctionDeclaration(declaration)) return file.replace(/\.ts$/, '') === home
  const bindings = ts.isImportDeclaration(declaration) ? declaration.importClause?.namedBindings : undefined
  return !!bindings && ts.isNamedImports(bindings) && ts.isStringLiteral(declaration.moduleSpecifier)
    && posix.join(posix.dirname(file), declaration.moduleSpecifier.text).replace(/\.[jt]s$/, '') === home
    && bindings.elements.some((element) => element.name.text === name.text && (element.propertyName ?? element.name).text === name.text)
}

/** A safe helper's call, or Node's own `Number`, `Boolean` or `Buffer.byteLength` where the file declares no such name. */
const isSafe = (call: ts.CallExpression): boolean => {
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee)) return ['Number', 'Boolean'].includes(callee.text) ? !declarationOf(callee) : isHelper(callee)
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Buffer'
    && callee.name.text === 'byteLength' && !declarationOf(callee.expression)
}

/** A module of Node's own by its default or namespace name (`path` of `import path from 'node:path'`). */
const isNodeModule = (identifier: ts.Identifier, declaration: ts.Node | undefined): boolean => {
  if (!declaration || !ts.isImportDeclaration(declaration) || !declaration.importClause) return false
  const { name, namedBindings } = declaration.importClause
  return ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text.startsWith('node:')
    && (name?.text === identifier.text || (!!namedBindings && ts.isNamespaceImport(namedBindings) && namedBindings.name.text === identifier.text))
}

const firstPrinted = (parts: readonly ts.Node[], whole: boolean, hand: Hand): string | undefined => {
  for (const part of parts) {
    const found = printed(part, whole, hand)
    if (found) return found
  }
  return undefined
}

/**
 * What [node] prints of an error or of content, or undefined. [whole] says its value is printed as it is (an argument,
 * a template's part, a branch, a method's receiver): an error there is printed whole, and so is a name of content.
 * Elsewhere (a property read, the left side of `&&`) only an error's words can be.
 */
function printed(node: ts.Node, whole: boolean, hand: Hand): string | undefined {
  const inner = ts.isExpression(node) ? unwrap(node) : node
  // A kind, a code, a hash, a number, a type test and a comparison carry no words.
  if (ts.isCallExpression(inner) && isSafe(inner)) return undefined
  if (ts.isTypeOfExpression(inner)) return undefined
  if (ts.isBinaryExpression(inner) && PASSING_OPERATORS.includes(inner.operatorToken.kind)) return undefined
  if (ts.isIdentifier(inner)) {
    if (!whole) return undefined
    const name = nameOf(inner, hand)
    if (name) return name === 'error' ? `an error, ${inner.text}` : `a local made from an error, ${inner.text}`
    // A forwarder's parameter is checked where its callers hand it on, and a module of Node's own is no path (`path`).
    const content = contentNamed(inner.text, hand)
    if (!content || hand.passed?.has(inner)) return undefined
    return isNodeModule(inner, declarationOf(inner)) ? undefined : `${content}, ${inner.text}`
  }
  if (ts.isExpression(inner) && whole && isError(inner, hand)) return `an error, ${shown(inner)}`
  const first = (parts: readonly ts.Node[], partsWhole: boolean): string | undefined => firstPrinted(parts, partsWhole, hand)
  if (ts.isPropertyAccessExpression(inner)) {
    const name = inner.name.text
    // A size is a number, of an error's words too.
    if (name === 'length' || name === 'size') return undefined
    if (ERROR_WORDS.includes(name) && isError(inner.expression, hand)) return `an error's words, ${shown(inner)}`
    const content = whole ? contentNamed(name, hand) : undefined
    if (content) return `${content}, ${shown(inner)}`
    return (whole ? returnedBy(inner, hand) : undefined) ?? printed(inner.expression, false, hand)
  }
  if (ts.isCallExpression(inner)) {
    const callee = unwrap(inner.expression)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toString' && isError(callee.expression, hand)) {
      return `an error's words, ${shown(inner)}`
    }
    // Handed to any function, a value is printed by what that function makes of it, and so is a method's receiver
    // (`stream.stderr.trim()`).
    return (ts.isPropertyAccessExpression(callee) ? printed(callee.expression, true, hand) : printed(callee, false, hand))
      ?? first(inner.arguments, true)
  }
  // A callback prints what it returns, to the function it is handed (`.map((i) => i.path)`).
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return first(returnsOf(inner), whole)
  if (ts.isNewExpression(inner)) return first(inner.arguments ?? [], true)
  if (ts.isTemplateExpression(inner)) return first(inner.templateSpans.map((span) => span.expression), true)
  // A condition is tested, never printed: only a branch is.
  if (ts.isConditionalExpression(inner)) return first([inner.whenTrue, inner.whenFalse], true)
  if (ts.isBinaryExpression(inner)) {
    const operands = OPERAND_OPERATORS.includes(inner.operatorToken.kind)
    // `&&` prints its right side whenever its left is truthy.
    return printed(inner.left, operands, hand)
      ?? printed(inner.right, operands || inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken, hand)
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

/**
 * Whether [fn]'s callers are checked where they call it: it is bound to a logger's name (`log: (line) => …`,
 * `const log = deps.log ?? ((line) => …)`), so each of its calls is a log call, or it is a function of the file's own
 * (`calleeOf`), whose calls are read through its forwarding.
 */
const callersChecked = (fn: ts.SignatureDeclaration): boolean => {
  const named = (name: ts.Node | undefined): boolean => !!name && ts.isIdentifier(name) && LOGGERS.includes(name.text)
  if (ts.isFunctionDeclaration(fn)) return true
  if (ts.isMethodDeclaration(fn)) return ts.isClassLike(fn.parent) || named(fn.name)
  let bound: ts.Node = fn
  while (ts.isParenthesizedExpression(bound.parent) || ts.isAsExpression(bound.parent) || ts.isSatisfiesExpression(bound.parent)) bound = bound.parent
  if ((ts.isVariableDeclaration(bound.parent) || (ts.isPropertyDeclaration(bound.parent) && ts.isClassLike(bound.parent.parent)))
    && bound.parent.initializer === bound) return true
  // A logger's name binds it through `??`, `||` and `?:` too: what is picked is called as that logger.
  let picked: ts.Node = fn
  while (ts.isParenthesizedExpression(picked.parent) || ts.isConditionalExpression(picked.parent) || (ts.isBinaryExpression(picked.parent)
    && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(picked.parent.operatorToken.kind))) picked = picked.parent
  const binding = picked.parent
  return (ts.isPropertyAssignment(binding) || ts.isVariableDeclaration(binding) || ts.isParameter(binding) || ts.isPropertyDeclaration(binding))
    && named(binding.name)
}

/**
 * What a forwarder hands on as it is: an argument that is, bare, a plain parameter of the function the call is in, when
 * that function's callers are checked where they call it.
 */
const passedOn = (call: ts.CallExpression, logged: readonly ts.Expression[]): Set<ts.Node> => {
  let fn: ts.Node = call.parent
  while (!ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent
  if (!ts.isFunctionLike(fn) || !callersChecked(fn)) return new Set()
  return new Set(logged.map(unwrap).filter((argument) => {
    const declaration = ts.isIdentifier(argument) ? declarationOf(argument) : undefined
    return !!declaration && ts.isParameter(declaration) && declaration.parent === fn && ts.isIdentifier(declaration.name)
  }))
}

/** Each log call in [code] that prints an error's words or content or hides its kind, as `<file>:<line>: <what>`. */
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
      const finding = (logged.length ? firstPrinted(logged, true, { ...handOf(node.arguments, true), passed: passedOn(node, logged) }) : undefined)
        ?? (isLogCall(node) ? hidden(node) : undefined)
      if (finding) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${finding}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Every file under [dir], as a path from cli/src with `/`. A dot-folder (`.tmp`) holds no daemon code but specs'
 * scratch folders, which a spec running beside this one deletes mid-scan: walked, it failed the scan with ENOENT.
 */
const filesUnder = (dir: string): string[] => readdirSync(join(SRC, dir), { withFileTypes: true })
  .flatMap((entry) => {
    const file = dir ? `${dir}/${entry.name}` : entry.name
    return entry.isDirectory() ? (entry.name.startsWith('.') ? [] : filesUnder(file)) : [file]
  })

/** The hits in every file of the daemon: every .ts under cli/src but tests, e2e scripts, the TUI and the terminal list. */
const daemonHits = (): string[] => filesUnder('')
  .filter((file) => file.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(file) && !/^(e2e|tui)\//.test(file)
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
  "try { run() } catch (error) { console.warn(`[x] not unpacked (${error.reason})`) }",
  "try { run() } catch (error) { console.error('[x] git refused:', (error as { stderr?: string }).stderr) }",
  "console.warn(`[agent] create refused · ${engine} · ${refusal.detail}`)",
  "const detail = 'Too many unverified hooks are pending'; console.log(`[hooks] held · ${detail}`)",
  "console.log(`[backend] connected → ${this.url}`)",
  "console.warn(`[x] exec exited (${code}): ${stream.stderr.trim()}`)",
  "console.log(`[turn] aborted by codex error · ${preview(message)}`)",
  "const tally = (tier: string, detail: string) => log(`notify · ${tier} · ${detail}`)",
  "console.log(`[harnessd] services run from ${config.serviceScriptPath}`)",
  "console.warn(`[state] ${basename(file)} could not be set aside`)",
  "function run() { const r = probe(); log(`[x] ${r.reason}`) } function probe() { try { return { ok: true } } catch (err) { return { ok: false, reason: (err as Error).message } } }",
  "async function run() { const r = await probe(); log(`[x] ${r.why}`) } async function probe() { return { ok: false, why: stderr } }",
  "let outcome; try { outcome = await move() } catch (error) { outcome = { moved: false, reason: error instanceof Error ? error.message : String(error) } } log(`[x] ${outcome.reason}`)",
  "this.host.log(`cable: ${port.path} is in use by another program`)",
  "console.warn(`[x] ${error instanceof HookPreparationHeld ? error.reason : errorKind(error)}`)",
  "try { run() } catch (error) { console[level](`[x] failed: ${error.message}`) }",
  "function sayOnce(stream: 'log' | 'warn', file: string) { console[stream](`[hooks] removed from ${file}`) }",
  "console.log(rule.messages.installed.replace('{file}', () => rule.file))",
  "console.log(`[x] ${items.map((i) => i.path).join(', ')}`)",
  "log(`[x] ${problems.map(function (problem) { return problem.message }).join(' · ')}`)",
  "console.log(`[x] done${ok && result.detail}`)",
  "log(`[x] exited ${code} ${verbose && stderr}`)",
  // A callback handed to a library: its callers are not the file's to check.
  "child.stderr.on('data', (output) => console.log(output))",
  "run().then((output) => console.log(output))",
  "console.log(`[x] data in ${env.ADAPTER_DATA_DIR}`)",
  "console.log(`[x] pid in ${PID_FILE}`)",
  "log(`[x] opened ${workspace}`)",
  "log(`[x] moved to ${agent.projectWorkspace}`)",
  "import { stateDir } from './paths.js'; console.log(`[x] state in ${stateDir}`)",
  "import stateFile from './paths.js'; console.log(`[x] state in ${stateFile}`)",
  "console.log(`[x] paired with ${machineName}`)",
  "log(`[x] shared by ${share.machine}`)",
  "log(`[x] shared by ${peerMachineName}`)",
  // A helper is trusted by the module that holds it, not by its name.
  "const hashOf = (text: string) => text; console.log(`[x] ${hashOf(file)}`)",
  "function errorKind(error: unknown) { return String(error) } try { run() } catch (error) { console.error(`[x] ${errorKind(error)}`) }",
  "import { sid } from './agentIds.js'; console.log(`[x] ${sid(transcriptPath)}`)",
  "import { codeOrLength as sid } from './lib/log.js'; import { preview as hashOf } from './lib/log.js'; console.log(`[x] ${hashOf(message)}`)",
  "const Number = (value: unknown) => value; console.log(`[x] ${Number(stderr)}`)",
  // Node's error fields: a command line, a child's arguments, a path.
  "try { execSync(line) } catch (error) { console.warn(`[x] exited · ${(error as { cmd?: string }).cmd}`) }",
  "proc.on('error', (err) => log(`[x] not started · ${err.spawnargs.join(' ')}`))",
  "try { renameSync(from, to) } catch (error) { console.warn(`[x] not moved to ${(error as { dest?: string }).dest}`) }",
])('finds %s', (code) => expect(failureLogs(code)).not.toEqual([]))

/** The safe helpers, imported as the daemon's files import them: each is trusted from its own module alone. */
const withHelpers = (code: string): string => "import { codeOrLength, errorKind, hashOf, sid } from './lib/log.js'; "
  + "import { serialPortName } from './cable/serial.js'; import { backendName } from './config/env.js'; " + code

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
  "console.warn(`[agent] create refused · ${engine} · ${codeOrLength(refusal.error)}`)",
  "console.log(`[backend] connected · ${hashOf(this.url)}`)",
  "console.warn(`[x] exec exited (${code}): ${stream.stderr.length} B`)",
  "console.log(`[x] ${Buffer.byteLength(stderr)} B`)",
  "this.host.log(`cable: ${serialPortName(port.path)} is in use by another program`)",
  "const say = (message: string) => console.log(message)",
  "const deps = { log: (line: string) => console.log(line) }",
  "const log = deps.log ?? ((message: string) => console.log(message))",
  "class Viewer { private say(message: string) { console.log(message) } }",
  "import path from 'node:path'; console.log(`[x] ${path.sep}`)",
  "import * as path from 'node:path'; console.log(`[x] a ${path.extname(name)} file`)",
  "function run() { const r = probe(); log(`[x] ${r.reason}`) } function probe() { return { ok: false, reason: 'busy' } }",
  "function openOf(p: unknown) { return { session: { engine: 'codex', transcriptPath: p } } } const ask = openOf(payload); console.warn(`[engine ${ask.session.engine}] LIVE_OPEN_FAILED`)",
  // A condition is tested, never printed.
  "console.warn(`[x] ${err.reason ? 'not a lock this CLI made' : 'held'}`)",
  "console.warn(`[x] ${error instanceof HookPreparationHeld ? error.hold : errorKind(error)}`)",
  "console.log(`[backend] connected · ${backendName(this.url)}`)",
])('passes %s', (code) => expect(failureLogs(withHelpers(code))).toEqual([]))

it('trusts a helper its own module calls', () => {
  expect(failureLogs("export function errorKind(error: unknown): string { return typeof error } "
    + "process.on('uncaughtException', (error) => { writeSync(fd, `[x] stopped: ${errorKind(error)}\\n`) })", 'lib/log.ts')).toEqual([])
})

it('no daemon log line carries an error\'s words, a stored string, process output, a path or a URL, or hides its kind', () => {
  expect(daemonHits(), 'A daemon log line names a failure by its kind, '
    + '`errorKind(error)` from lib/log.ts, and never prints an error\'s message, stack or the error itself: those can quote '
    + 'the person\'s files and prompts, and Export logs sends the log off the machine. A catch that logs binds what it '
    + 'caught and names its kind, so someone can act on the line. A stored or peer string is logged as '
    + '`codeOrLength(value)`, a path, URL or label as a fixed word or `hashOf(text)`, process output as its length.').toEqual([])
})

it('every terminal file exists', () => {
  expect(TERMINAL.filter((file) => !existsSync(join(SRC, file)))).toEqual([])
})
