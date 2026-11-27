/**
 * No process of the daemon sets `process.title`. On Unix libuv writes a title over the start of the process's argument
 * area and blanks the rest of it. On macOS the environment follows that area, and `pgrep -f` printed its first
 * variables as the process's arguments: on 2026-11-17 the master's and the services' listings carried a session's
 * token (docs/plans/2026-11-17-harnessd-process-title-env-design.md). A process is named by the hard link of Node it is
 * started through (harnessd/processName.ts), and by nothing else. So this reads every file of the daemon, as code, so
 * that a comment or a string naming the title is no finding.
 *
 * Its limits: an alias (`const p = process`), `Object.assign`, `Object.defineProperty` or `Reflect.set` on `process`,
 * `node --title=…` and a script kept as text are not reached. e2e/processArguments.e2e.ts reads the real processes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { sourceFiles } from './testing/sourceFiles.js'

const SRC = __dirname

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node

/** `process`, `globalThis.process` or `global.process`. */
const isProcess = (node: ts.Expression): boolean => {
  const inner = unwrap(node)
  if (ts.isIdentifier(inner)) return inner.text === 'process'
  return ts.isPropertyAccessExpression(inner) && inner.name.text === 'process'
    && ts.isIdentifier(inner.expression) && ['globalThis', 'global'].includes(inner.expression.text)
}

/** `.title` or `['title']` on the process. */
const isTitle = (node: ts.Expression): boolean => {
  const inner = unwrap(node)
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === 'title' && isProcess(inner.expression)
  return ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)
    && inner.argumentExpression.text === 'title' && isProcess(inner.expression)
}

/** Each assignment to the process's title in [code], `=` or a compound one, one line a finding. */
function titleWrites(code: string, file = 'file.ts'): string[] {
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isTitle(node.left)) {
      found.push(`line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: process.title`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

it.each([
  "process.title = 'harnessd'",
  'process.title = `harnessd-${name}`',
  "process['title'] = name",
  "process.title += ' (core)'",
  "globalThis.process.title = 'harnessd'",
  "global.process.title = 'harnessd'",
  "(process as NodeJS.Process).title = 'harnessd'",
  'if (named) process.title = named',
])('finds %s', (code) => expect(titleWrites(code)).not.toEqual([]))

it.each([
  "// process.title = 'harnessd'",
  'const script = "process.title = \'codex\'"',
  'const script = `process.title = ${JSON.stringify(engine)}`',
  'const title = process.title',
  "if (process.title === 'node') start()",
  "document.title = 'Harness'",
  'pane.title = name',
  'this.process.title = name',
])('passes %s', (code) => expect(titleWrites(code)).toEqual([]))

it('no file of the daemon sets a process title', () => {
  // Every .ts, .tsx, .js, .mjs and .cjs under cli/src but its specs and tests, as architecture.environment.spec.ts lists them.
  const files = sourceFiles(SRC)
    .filter((file) => /\.([cm]?[jt]s|tsx)$/.test(file) && !/\.(spec|test)\.([cm]?ts|tsx)$/.test(file))
  const found = files.flatMap((file) => titleWrites(readFileSync(join(SRC, file), 'utf8'), file).map((finding) => `${file}: ${finding}`))
  expect(found, 'No process of the daemon sets process.title: on macOS the title is written over the process\'s arguments, '
    + 'and `pgrep -f` then prints the first variables of its environment in their place. A process is named by the hard link '
    + 'it is started through (harnessd/processName.ts).').toEqual([])
})
