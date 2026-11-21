/**
 * A hold is said in the daemon's log by its sentence (engines/kit/hookHeld.ts `hold`), which no rule of
 * architecture.failureLogs.spec.ts reads: that is safe only while every hold is built from fixed words. A sentence
 * made from a path, an error's words or anything a person wrote would reach the log, and Export logs sends it off the
 * machine. So this reads every file of cli/src but its specs, as code, and finds each hold built from anything but a
 * string literal: a `new` of `HookPreparationHeld`, or of a class that extends one, to any depth, with such an
 * argument, and a `super(…)` with one in such a class's constructor. HookPreparationHeld's own `super` is its prefix and
 * the argument a `new` of it was given, checked there.
 *
 * Its limits: a hold by another name (an import's alias, a value holding the class); a class that extends a hold
 * through an expression rather than its name.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import typescript from 'typescript'
import { expect, it } from 'vitest'

// Read through the alias, the package's proxy runs once rather than at every read (architecture.failureLogs.spec.ts).
import ts = typescript

const SRC = __dirname
const ROOT_HOLD = 'HookPreparationHeld'

const nameOf = (expression: ts.Expression): string | undefined => ts.isIdentifier(expression) ? expression.text
  : ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined

/** The class a class extends, by its name. */
const extended = (node: ts.ClassLikeDeclaration): string | undefined => {
  const clause = node.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword)
  return clause?.types[0] ? nameOf(clause.types[0].expression) : undefined
}

const fixedWords = (argument: ts.Expression): boolean => ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)

const visit = (node: ts.Node, each: (node: ts.Node) => void): void => {
  each(node)
  ts.forEachChild(node, (child) => visit(child, each))
}

/** Each hold in [files] (`[path, code]`) built from anything but string literals, as `<file>:<line>`. */
function holdsNotFixed(files: ReadonlyArray<readonly [string, string]>): string[] {
  const parsed = new Map<string, ts.SourceFile>()
  const sourceOf = (file: string, code: string): ts.SourceFile => parsed.get(file) ?? parsed.set(file, ts.createSourceFile(file, code,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, true, ts.ScriptKind.TS)).get(file)!
  // A file that names no hold builds none: only those are parsed, and read again as the holds grow.
  const naming = (holds: ReadonlySet<string>) => files.filter(([, code]) => [...holds].some((hold) => code.includes(hold)))
  const holds = new Set([ROOT_HOLD])
  for (let grew = true; grew;) {
    grew = false
    for (const [file, code] of naming(holds)) {
      visit(sourceOf(file, code), (node) => {
        const name = ts.isClassLike(node) ? node.name?.text : undefined
        if (name && !holds.has(name) && holds.has(extended(node as ts.ClassLikeDeclaration) ?? '')) { holds.add(name); grew = true }
      })
    }
  }
  const found: string[] = []
  for (const [file, code] of naming(holds)) {
    const source = sourceOf(file, code)
    const at = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    visit(source, (node) => {
      if (ts.isNewExpression(node) && holds.has(nameOf(node.expression) ?? '') && !(node.arguments ?? []).every(fixedWords)) found.push(at(node))
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && !node.arguments.every(fixedWords)) {
        let constructor: ts.Node = node.parent
        while (!ts.isFunctionLike(constructor) && !ts.isSourceFile(constructor)) constructor = constructor.parent
        if (ts.isConstructorDeclaration(constructor) && holds.has(extended(constructor.parent) ?? '')) found.push(at(node))
      }
    })
  }
  return found
}

const planted = (code: string): string[] => holdsNotFixed([['file.ts', code]])

it.each([
  'throw new HookPreparationHeld(`a hook argument ${reason}`)',
  'throw new HookPreparationHeld(detail)',
  "throw new HookPreparationHeld('a hook argument ' + reason)",
  "class A extends HookPreparationHeld { constructor(s: string) { super(s) } }; new A('x')",
  "class A extends HookPreparationHeld {}; class B extends A {}; new B(why)",
])('finds %s', (code) => expect(planted(code)).not.toEqual([]))

it.each([
  "throw new HookPreparationHeld('the settings do not have the declared object shape')",
  'throw new HookPreparationHeld(`the hooks member is not an object`)',
  'throw new HookScriptMissing()',
  "class Missing extends HookPreparationHeld { constructor() { super('notify.mjs is missing') } }",
  // Not a hold: an Error of another kind is the failure guard's.
  'throw new Error(`${detail}`)',
])('passes %s', (code) => expect(planted(code)).toEqual([]))

/**
 * Every file under [dir], from cli/src, but in a folder whose name starts with a dot: specs make scratch folders in
 * src/.tmp while this runs (engines/pluginPosts.spec.ts), and one that went mid-walk failed the scan.
 */
const sources = (dir: string): string[] => readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
  entry.name.startsWith('.') ? [] : entry.isDirectory() ? sources(join(dir, entry.name)) : [join(dir, entry.name)])

it('every hold is built from string literals', () => {
  const files = sources('')
    .map((file) => file.split(sep).join('/'))
    .filter((file) => file.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(file))
    .map((file) => [file, readFileSync(join(SRC, file), 'utf8')] as const)
  expect(holdsNotFixed(files), 'A hold (HookPreparationHeld, or a class that extends it) is built from fixed words alone: '
    + 'its sentence is printed in the daemon\'s log, which Export logs sends off the machine, and a path, an error\'s words '
    + 'or a person\'s text there would go with it. Write the sentence as a string literal, one per case.').toEqual([])
})
