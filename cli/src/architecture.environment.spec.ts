/**
 * The daemon never reads another process's environment (cli/AGENTS.md, Protect the core, rule 4). An API token, a
 * pairing code and every other secret a person exports is in one, and no system lets a reader take one variable of
 * it: `/proc/<pid>/environ`, `ps e` and `KERN_PROCARGS2` hand over all of it. So this reads every file of the daemon
 * and its hook, as code, so that a comment naming those is no finding.
 *
 * Its limits: it finds the patterns below and no more. A `ps` whose binary or argument list is built in a variable
 * (`run(ps, args)`) and a shell line (`sh -c 'ps eww …'`) are not reached; review is what catches those.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const CLI = join(__dirname, '..')

/** `ps`, or a path to it (`/bin/ps`). */
const isPs = (node: ts.Node | undefined): boolean => !!node && ts.isStringLiteralLike(node) && /(^|\/)ps$/.test(node.text)

/** Each read of another process's environment in [code], one line a finding. Read as code: a comment names nothing. */
function environmentReads(code: string, file = 'file.ts'): string[] {
  const kind = /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const report = (node: ts.Node, what: string): void => {
    found.push(`line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${what}`)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && node.text.split(/[/\\]/).includes('environ')) report(node, JSON.stringify(node.text))
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && /KERN_PROCARGS2|procargs/i.test(node.text)) report(node, node.text)
    if (ts.isCallExpression(node)) {
      node.arguments.forEach((argument, index) => {
        const list = node.arguments[index + 1]
        if (!isPs(argument) || !list || !ts.isArrayLiteralExpression(list)) return
        list.elements.forEach((element, at) => {
          if (!ts.isStringLiteralLike(element)) return
          const before = list.elements[at - 1]
          // A word after an option is that option's value (`-o etime`), not a BSD-style option of its own.
          const value = !!before && ts.isStringLiteralLike(before) && before.text.startsWith('-')
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
  'sysctl([CTL_KERN, KERN_PROCARGS2, pid])',
  "const name = 'kern.procargs2'",
])('finds %s', (code) => expect(environmentReads(code)).not.toEqual([]))

it.each([
  '// reads /proc/<pid>/environ, as ps eww does',
  "run('ps', ['-e', '-o', 'pid=,args='])",
  "run('ps', ['-ww', '-p', String(pid), '-o', 'ppid=,state=,comm=,lstart=,args='])",
  "run('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='])",
  "run('ps', ['-o', 'etime', '-p', String(pid)])",
  "podman.run(['ps', '--filter', 'label=x', '--format', 'json'])",
  'function home(environ: { HOME?: string }) { return environ.HOME }',
  "const text = 'the environment of this process'",
  "const own = /os\\.environ\\.pop/.test(code)",
  "const script = 'home = os.environ.get(\"HOME\")'",
  "const text = '/notes/environment'",
  "readFileSync(`/proc/${pid}/${field}`, 'utf8')",
  "readlink(join(proc, String(pid), 'fd', name))",
  "run('lsof', ['-n', '-P', '-w', '-p', String(pid), '-Fn'])",
])('passes %s', (code) => expect(environmentReads(code)).toEqual([]))

it('no file of the daemon or its hook reads another process\'s environment', () => {
  const files = ['src', 'hook'].flatMap((folder) => readdirSync(join(CLI, folder), { recursive: true, encoding: 'utf8' })
    .map((name) => join(folder, name)))
    .filter((file) => /\.(ts|mjs|js)$/.test(file) && !/\.(spec|test)\.ts$/.test(file))
  const found = files.flatMap((file) => environmentReads(readFileSync(join(CLI, file), 'utf8'), file).map((finding) => `${file}: ${finding}`))
  expect(found, 'The daemon never reads another process\'s environment (cli/AGENTS.md, Protect the core): an API token, a '
    + 'pairing code and every other secret is in one, and no system can read a single variable of it. A hook reads its own and '
    + 'says what it derives (hook/notify.mjs HOST_HINTS, ownGateway); a launch is on the registry\'s row.').toEqual([])
})
