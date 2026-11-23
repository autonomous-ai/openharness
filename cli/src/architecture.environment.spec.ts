/**
 * The daemon never reads another process's environment (cli/AGENTS.md, Protect the core, rule 4). An API token, a
 * pairing code and every other secret a person exports is in one, and no system lets a reader take one variable of
 * it: `/proc/<pid>/environ`, `ps e` and `KERN_PROCARGS2` hand over all of it. Nor the environment of the person's tmux
 * server: `tmux show-environment` lists it whole, and the core unsets names in it instead (lib/tmuxBackend.ts). So this
 * reads every file of the daemon and its hook, as code, so that a comment naming those is no finding.
 *
 * One reader is left, outside what this reads: the macOS helper `native/darwin-process-images.c` hashes another
 * process's `KERN_PROCARGS2`, environment included (lib/nativeProcessControl.ts runs it). It is a listed follow-up
 * (docs/plans/2026-11-15-process-env-secrets-design.md, Follow-ups).
 *
 * Its limits: it finds the patterns below and no more. A `ps` argument list built in a variable (`run(ps, args)`) and a
 * `ps` in a shell line (`sh -c 'ps eww …'`) are not reached; review is what catches those.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { sourceFiles } from './testing/sourceFiles.js'

const CLI = join(__dirname, '..')

/** `ps`, a path to it (`/bin/ps`), or a variable named `ps` that holds one. */
const isPs = (node: ts.Node | undefined): boolean => !!node
  && ((ts.isStringLiteralLike(node) && /(^|\/)ps$/.test(node.text)) || (ts.isIdentifier(node) && node.text === 'ps'))

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node

/** The words of an argument list in order, into its spreads and both branches of a condition. */
const words = (node: ts.Expression): ts.Expression[] => {
  const inner = unwrap(node)
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.flatMap((element) => words(ts.isSpreadElement(element) ? element.expression : element))
  if (ts.isConditionalExpression(inner)) return [...words(inner.whenTrue), ...words(inner.whenFalse)]
  return [inner]
}

/** A `ps` option that takes the next word as its value: one ending in a letter that takes one (`-o`, `-wwp`), or a long one. */
const takesValue = (word: string): boolean => /^-[A-Za-z]*[oOpPtuUgGCqsNM]$/.test(word) || /^--[^=]+$/.test(word)

/** tmux's command that lists a server's or a session's environment, as tmux takes it: by name, by its alias, or by any
 *  prefix only it has (`show-e`; `show-` could be six commands). */
const isShowEnvironment = (word: string): boolean =>
  word === 'showenv' || (word.length >= 'show-e'.length && 'show-environment'.startsWith(word))

/** Each read of another process's environment in [code], one line a finding. Read as code: a comment names nothing. */
function environmentReads(code: string, file = 'file.ts'): string[] {
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const report = (node: ts.Node, what: string): void => {
    found.push(`line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${what}`)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      // Anywhere in the text, not only as a whole segment: a plugin's source, a shell line and a Python f-string are text.
      && (/(?:^|[/\\])environ(?![\w$])/.test(node.text) || node.text.split(/[\s;|&()'"`]+/).some(isShowEnvironment))) {
      report(node, JSON.stringify(node.text))
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && /KERN_PROCARGS2|procargs/i.test(node.text)) report(node, node.text)
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((argument, index) => {
        const list = node.arguments[index + 1] && unwrap(node.arguments[index + 1])
        if (!isPs(argument) || !list || !(ts.isArrayLiteralExpression(list) || ts.isConditionalExpression(list))) return
        const all = words(list)
        all.forEach((element, at) => {
          if (!ts.isStringLiteralLike(element)) return
          const before = all[at - 1]
          // A word after an option that takes one is its value (`-o etime`), not a BSD-style option of its own.
          const value = !!before && ts.isStringLiteralLike(before) && takesValue(before.text)
          if ((/^[A-Za-z]*e[A-Za-z]*$/.test(element.text) && !value) || /^-[A-Za-z]*E[A-Za-z]*$/.test(element.text)) {
            report(element, `ps ${element.text}`)
          }
        })
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

it.each([
  "readFile(`/proc/${pid}/environ`, 'utf8')",
  "readFileSync('/proc/' + pid + '/environ')",
  "open(join(proc, String(pid), 'environ'))",
  "const plugin = `readFileSync('/proc/' + pid + '/environ')`",
  "const plugin = `cat /proc/${pid}/environ | tr`",
  "const line = 'cat /proc/1/environ | tr \\\\0 \\\\n'",
  "const script = 'open(f\"/proc/{pid}/environ\")'",
  "execFile('ps', ['eww', '-p', String(pid), '-o', 'command='], done)",
  "run('/bin/ps', ['axe'])",
  "spawn('ps', ['-E', '-p', String(pid)])",
  "spawn('ps', ['-wwE'])",
  "execFile('ps', ['eww', '-p', String(pid)] as const)",
  "execFile('ps', (['eww']) satisfies string[])",
  "run('ps', [...(mac ? ['eww'] : []), '-p', String(pid)])",
  "run('ps', [...(mac ? [] : ['e']), '-p', String(pid)])",
  "run('ps', ['-p', String(pid), mac ? 'eww' : '-e'])",
  "read(ps, ['eww'])",
  "run('ps', ['-ww', 'e', '-p', String(pid)])",
  'sysctl([CTL_KERN, KERN_PROCARGS2, pid])',
  "const name = 'kern.procargs2'",
  "run('tmux', ['show-environment', '-g'])",
  "execFile('tmux', ['showenv', '-g'], done)",
  "run('tmux', ['show-env'])",
  "const line = 'tmux show-e -g | grep KEY'",
  'const script = `tmux -L ${socket} show-environment -t ${session}`',
])('finds %s', (code) => expect(environmentReads(code)).not.toEqual([]))

it.each([
  '// reads /proc/<pid>/environ, as ps eww does',
  "run('ps', ['-e', '-o', 'pid=,args='])",
  "run('ps', ['-ww', '-p', String(pid), '-o', 'ppid=,state=,comm=,lstart=,args='])",
  "run('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='])",
  "run('ps', ['-o', 'etime', '-p', String(pid)])",
  "run('ps', ['-wwo', 'etime', '-p', String(pid)] as const)",
  "run('ps', ['--sort', 'etime', '-p', String(pid)])",
  "read(ps, ['-A', '-o', 'pid=,ppid=,comm='], env)",
  "podman.run(['ps', '--filter', 'label=x', '--format', 'json'])",
  'function home(environ: { HOME?: string }) { return environ.HOME }',
  "const text = 'the environment of this process'",
  "const own = /os\\.environ\\.pop/.test(code)",
  "const script = 'home = os.environ.get(\"HOME\")'",
  "const text = '/notes/environment'",
  "readFileSync(`/proc/${pid}/${field}`, 'utf8')",
  "readlink(join(proc, String(pid), 'fd', name))",
  "run('lsof', ['-n', '-P', '-w', '-p', String(pid), '-Fn'])",
  '// never runs tmux show-environment',
  "run('tmux', ['set-environment', '-g', '-u', name])",
  "run('tmux', ['show-options', '-g'])",
  "const style = 'show-error'",
])('passes %s', (code) => expect(environmentReads(code)).toEqual([]))

it('no file of the daemon or its hook reads another process\'s environment', () => {
  const files = ['src', 'hook'].flatMap((folder) => sourceFiles(join(CLI, folder)).map((name) => `${folder}/${name}`))
    .filter((file) => /\.([cm]?[jt]s|tsx)$/.test(file) && !/\.(spec|test)\.([cm]?ts|tsx)$/.test(file))
  const found = files.flatMap((file) => environmentReads(readFileSync(join(CLI, file), 'utf8'), file).map((finding) => `${file}: ${finding}`))
  expect(found, 'The daemon never reads another process\'s environment (cli/AGENTS.md, Protect the core): an API token, a '
    + 'pairing code and every other secret is in one, and no system can read a single variable of it. A hook reads its own and '
    + 'says what it derives (hook/notify.mjs HOST_HINTS, ownGateway); a launch is on the registry\'s row; a tmux server\'s '
    + 'names are unset, never listed (lib/tmuxBackend.ts serverVariablesToUnset).').toEqual([])
})
