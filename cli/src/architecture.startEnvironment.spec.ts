/**
 * A start gives the daemon only the variables an allowlist names (lib/startEnvironment.ts). A variable the daemon reads
 * that is on no list would be gone under `harness start` with nobody having decided it, so this reads every file of the
 * daemon, as code, and holds each name it reads to the allowlist or to DROPPED_ON_PURPOSE
 * (docs/plans/2026-11-17-daemon-minimal-env-design.md).
 *
 * Its limits: it sees `process.env` and no other name for it. A variable read through a parameter that defaults to
 * `process.env` is pinned by lib/startEnvironment.spec.ts instead, and a computed name (`process.env[name]`) by review.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { DROPPED_ON_PURPOSE, startEnvironment } from './lib/startEnvironment.js'

const SRC = __dirname

/** `process.env`, the object every read below goes through. */
const isProcessEnv = (node: ts.Expression): boolean => ts.isPropertyAccessExpression(node)
  && ts.isIdentifier(node.expression) && node.expression.text === 'process' && node.name.text === 'env'

/** The names [code] reads, sets or deletes on `process.env` by a name written out. Read as code: a comment or a string
 *  names nothing. */
function environmentNames(code: string, file = 'file.ts'): string[] {
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) found.add(node.name.text)
    if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      found.add(node.argumentExpression.text)
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isProcessEnv(node.initializer)) {
      for (const element of node.name.elements) {
        // `...rest` reads no name of its own.
        if (element.dotDotDotToken) continue
        const key = element.propertyName ?? element.name
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) found.add(key.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...found]
}

it.each([
  ['process.env.FOO', ['FOO']], ["process.env['BAR']", ['BAR']], ['process.env?.BAZ', ['BAZ']],
  ['const { A, B: b, ...rest } = process.env', ['A', 'B']],
  ['// process.env.COMMENTED', []], ["const text = 'process.env.IN_A_STRING'", []],
  ['process.env[name]', []], ['env.NOT_PROCESS', []], ['process.env.A = "1"; delete process.env.B', ['A', 'B']],
])('finds the names in %s', (code, names) => expect(environmentNames(code).sort()).toEqual(names))

// A new read of a variable on neither list fails here, so whoever adds the read decides
// (docs/plans/2026-11-17-daemon-minimal-env-design.md).
it('every variable the daemon reads is on the allowlist or dropped on purpose', () => {
  const read = new Map<string, string>()
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split(/[\\/]/).join('/'))
    .filter((file) => /\.(tsx?|mjs|js)$/.test(file) && !/\.(spec|test)\./.test(file)
      && !file.split('/').some((folder) => ['testing', 'e2e', '__fixtures__', 'fixtures'].includes(folder)))
  for (const file of files) {
    const code = readFileSync(join(SRC, file), 'utf8')
    // Most files never name it, and parsing every one of them would take seconds.
    if (!code.includes('process.env')) continue
    for (const name of environmentNames(code, file)) if (!read.has(name)) read.set(name, file)
  }
  // "Allowed" is kept on Linux: Windows keeps the whole environment, so a name read there only is dropped on purpose.
  const allowed = (name: string): boolean => Object.keys(startEnvironment({ [name]: 'x' }, 'linux')).length === 1
  const unlisted = [...read].filter(([name]) => !allowed(name) && !(name in DROPPED_ON_PURPOSE)).map(([name, file]) => `${name} (${file})`)
  expect(unlisted, 'Every variable the daemon reads is kept by a start (START_ENV_NAMES, START_ENV_PREFIXES) or listed in '
    + 'DROPPED_ON_PURPOSE with why, in lib/startEnvironment.ts.').toEqual([])
})
