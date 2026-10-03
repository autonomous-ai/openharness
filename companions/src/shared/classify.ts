/**
 * What a dialog asks, read on the machine that owns it (daemons/BRAIN.md, "the floor"). Three questions:
 *
 *   DENY-CLASS  Never approved by a key, a rule, a recommendation or the pair: pushes, force flags,
 *               destructive deletes and resets, sudo, piping a download into a shell, deploy, publish,
 *               drop, merge. Read over the WHOLE dialog — every line of the command, its prose and its
 *               options — because a wrapped `&& git push` sits on the second line. It leans wide: a false
 *               positive costs a key, a false negative approves a push.
 *   ALLOW-CLASS What a `[y]` key may approve at all: a permission prompt for a read, a test, a build, a
 *               linter or formatter, or an edit to a file in the project. Everything else — including every
 *               question that is not a permission prompt, and every prompt this file cannot read with
 *               CERTAINTY — gets `[g]` (open the pane) and no `[y]`. It leans narrow.
 *   PERSISTENT  An option that answers more than this once ("don't ask again", "allow all edits during
 *               this session", "always"). The daemon never picks one, for any caller: `y` is a one-time yes.
 *
 * How a command is read (pair/shell.ts): one line only; split on `;`, `&`, `&&`, `||`, `|`; refused on any
 * expansion (`$`, backticks, `<(`, `>(`), heredoc, subshell, brace or comment; an environment prefix
 * (`X=1 cmd`) is not allow-class; a redirection may only fold descriptors (`2>&1`) or write to /dev/null.
 * Each simple command must be on the allow-list below, with none of its write- or exec-capable forms, and
 * every path it names must resolve (symlinks and all) inside the project.
 *
 * The structured tool call, when the engine's transcript has it (Claude Code's `tool_use`, Codex's
 * `function_call`), is preferred over the painted dialog: it has the exact command, not a wrapped one.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseShell, type ShellCommand, type ShellWord } from './shell.js'

const DENY_PATTERNS: RegExp[] = [
  /\bpush(ed|es|ing)?\b/i,                                               // git push in any form
  /--force(-with-lease|-if-includes)?\b|\bforce[- ]?(push|with-lease)?\b|(^|\s)-f(\s|$)/i,
  /\bbranch\s+(-[a-zA-Z]*D|--delete\s+--force)\b/,                        // git branch -D
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|-[a-zA-Z]*\s+-[a-zA-Z]*[rR])/, // rm -r, -rf, -fr, -R, --recursive
  /\breset\s+--hard\b/i,
  /\bclean\s+-[a-zA-Z]*f/i,                                               // git clean -f, -fd, -fdx
  /\bsudo\b|\bdoas\b/i,
  /\|\s*(sudo\s+)?(ba|z|da|k|c|tc|fi)?sh\b/i,                             // | sh, | bash
  /\bch(mod|own|grp)\s+(-[a-zA-Z]*R|--recursive)/,
  /\bmkfs(\.\w+)?\b/i,
  /\bdeploy(s|ed|ing|ment)?\b/i,
  /\bpublish(es|ed|ing)?\b/i,
  /\bdrop\s+(table|database|schema|index|column|collection|view)\b|\bdropdb\b|\bdrop\b(?!down)/i,
  /\btruncate\s+table\b/i,
  /\bmerge(s|d)?\b/i,
]

/** `first` somewhere in `text`, and `then` true of the text from there on (across lines too: it leans wide). */
const after = (text: string, first: RegExp, then: (rest: string) => boolean): boolean => {
  const at = first.exec(text)
  return !!at && then(text.slice(at.index))
}

/** Deny checks that one regex would make slow — two runs that can both take blanks backtrack for every start
 *  (`dd` and 200,000 blanks took 19 s) — scanned in linear time instead. */
const DENY_SCANS: Array<(text: string) => boolean> = [
  (text) => after(text, /\b(curl|wget|fetch)\b/i, (rest) => rest.includes('|')),   // a download piped anywhere
  (text) => after(text, /\bdd\s/i, (rest) => /\bif=/i.test(rest)),                 // dd reading a device or file
]

/** A deny-class dialog: never approved by anything but the person's own hands in the pane. */
export function isDenyClass(dialog: string, options: readonly string[] = []): boolean {
  const text = [dialog, ...options].join('\n')
  return DENY_PATTERNS.some((pattern) => pattern.test(text)) || DENY_SCANS.some((scan) => scan(text))
}

/** Options that answer for more than this once, and the one-time yes (pair/floor.ts, where the floor uses them). */
export { isOneTimeYes, isPersistentOption } from '../companion/floor.js'

// ── paths ───────────────────────────────────────────────────────────────────────────────────────────

export interface PathContext {
  /** The harness's folder: the project. Without it nothing resolves, and nothing is in the project. */
  cwd?: string | null
  /** This computer's home folder (os.homedir() when absent): `~`, and the dotfiles nothing may touch. */
  home?: string | null
}

/** Folders no daemon key ever approves a read or an edit in, wherever they sit: the daemon's own data, git's
 *  internals (hooks, config) and the engines' settings (their hooks run commands). */
const PROTECTED_SEGMENTS = new Set(['.harness', '.git', '.claude', '.codex'])
/** A name as a case- and Unicode-folding file system (APFS, NTFS) matches it: `.GIT`, `.Claude` and `.harneſs`
 *  open `.git`, `.claude` and `.harness` there, so they are compared folded. */
const folded = (segment: string): string => segment.normalize('NFKC').toLowerCase()

/** A path longer than this cannot be opened (ENAMETOOLONG on macOS and Linux): nothing past it is read with certainty. */
const PATH_MAX = 4096

/**
 * `path` as the kernel resolves it: the longest part of it that exists through realpath(3) — every symlink, and a
 * `..` after one taken from where the link really points (never folded away before the links are read: `link/..`
 * is the parent of the link's target) — and the part that does not exist yet appended as written. Null (not
 * certain) when that part holds a `..`, or starts at a symlink whose target is missing (a write would follow it).
 */
function realResolve(path: string): string | null {
  if (path.length > PATH_MAX || !isAbsolute(path)) return null
  const parts = path.split(sep).filter((part) => part && part !== '.')
  let at = parts.length
  let real: string | null = null
  while (real === null && at >= 0) {
    try { real = realpathSync.native(sep + parts.slice(0, at).join(sep)) } catch { at-- }
  }
  if (real === null) return null
  const rest = parts.slice(at)
  if (!rest.length) return real
  if (rest.includes('..')) return null
  try { if (lstatSync(join(real, rest[0]!)).isSymbolicLink()) return null } catch { /* truly absent */ }
  return join(real, ...rest)
}

/**
 * Whether `path` is in the project, for a key to approve reading or editing it: resolved against the
 * harness's folder, every symlink along it (the target and every parent) resolved, and still inside that
 * folder afterwards — and not under `.git/`, `.harness/`, `.claude/`, `.codex/`, not a dotfile or dot-folder
 * of the home folder, not a file with a second hard link. Anything it cannot resolve is not in the project.
 */
export function inProject(path: string, cwd?: string | null, opts: { home?: string | null } = {}): boolean {
  const p = path.trim()
  if (!p || !cwd || !isAbsolute(cwd)) return false
  const home = opts.home === undefined ? homedir() : opts.home
  let target: string
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return false
    target = `${resolve(home)}${sep}${p.slice(1)}`
  } else if (p.startsWith('~')) {
    return false                                                  // ~someone
  } else {
    // Joined as written, never normalized: `link/../x` is resolved by realResolve as the kernel would.
    target = isAbsolute(p) ? p : `${cwd}${sep}${p}`
  }
  const realCwd = realResolve(cwd)
  const realTarget = realResolve(target)
  if (!realCwd || !realTarget) return false
  const rel = relative(realCwd, realTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  if (rel.split(sep).some((segment) => PROTECTED_SEGMENTS.has(folded(segment)))) return false
  const realHome = home ? realResolve(resolve(home)) : null
  if (realHome) {
    const fromHome = relative(realHome, realTarget)
    if (fromHome && fromHome !== '..' && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome) && folded(fromHome.split(sep)[0]!).startsWith('.')) return false
  }
  // A second hard link: an edit here lands in another file too (a link to ~/.bashrc, say).
  try {
    const stat = lstatSync(realTarget)
    if (stat.isFile() && stat.nlink > 1) return false
  } catch { /* a file to be created */ }
  return true
}

/** A path as a dialog paints it: quotes around it, and a question's own punctuation after it. */
function paintedPath(text: string): string {
  const p = text.trim().replace(/^["'`]|["'`]$/g, '').replace(/[?,:]$/, '')
  return p.endsWith('.') && !p.endsWith('..') && p !== '.' ? p.slice(0, -1) : p
}

// ── allow-class commands ────────────────────────────────────────────────────────────────────────────

interface Ctx { cwd: string | null; home: string | null }

/** Reads with no option that writes or runs anything. Every argument that is a path must be in the project. */
const READS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'stat', 'du', 'df', 'cut', 'tr', 'jq',
  'diff', 'cmp', 'basename', 'dirname', 'realpath', 'nl', 'column'])
/** Words, not paths: nothing they print is a file. */
const TEXT = new Set(['echo', 'printf', 'true', 'which', 'type'])
/** Their first operand is a pattern or a program, not a path. */
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'jq'])

const TEST_TOOLS = new Set(['vitest', 'jest', 'mocha', 'tsc', 'eslint', 'prettier', 'biome', 'stylelint'])
const PY_TOOLS = new Set(['pytest', 'mypy', 'ruff', 'black', 'isort', 'flake8', 'pylint', 'pyright'])
const PY_MODULES = new Set(['pytest', 'unittest', 'mypy', 'ruff', 'black', 'isort', 'compileall'])
const SCRIPT = /^(test|tests|check|lint|typecheck|type-check|tsc|build|format|fmt|prettier)(:[\w:-]+)?$/
const MAKE_TARGETS = new Set(['test', 'tests', 'check', 'build', 'lint', 'fmt', 'format', 'all'])
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'grep'])
const GIT_BRANCH_LIST = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--list', '--show-current'])
/** git options that write a file, run a pager or a driver, or point git somewhere else. */
const GIT_REFUSED_LONG = ['--output', '--open-files-in-pager', '--ext-diff', '--exec-path', '--git-dir', '--work-tree', '--config-env', '--upload-pack', '--receive-pack']
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
const FIND_VALUE_ARGS = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-wholename', '-iwholename', '-type',
  '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-newermt', '-perm', '-user', '-group'])
/** `sed -n 10,20p`, `sed -n '/a/,/b/p'`: printing lines — never `w`, `e`, `r`, `-i`, `-e` or `-f`. */
const SED_PRINT = /^((\d+|\$|\/[^/\\]*\/)(,(\d+|\$|\/[^/\\]*\/))?)?p$/

const isFlag = (w: ShellWord): boolean => w.text.startsWith('-') && w.text !== '-'
/** The letters of a short-option cluster, up to the value one of them may carry in the same word: `-uo/tmp/x` → `uo`. */
const shortLetters = (text: string): string => /^-([A-Za-z0-9]+)/.exec(text)?.[1] ?? ''
/** One of `longs`, spelled out or abbreviated (getopt_long and git take any unique prefix: `--out=x` is `--output`). */
const isLong = (text: string, longs: readonly string[]): boolean => {
  if (!text.startsWith('--')) return false
  const name = text.split('=')[0]!
  return name.length > 2 && longs.some((long) => long.startsWith(name))
}
/** A short-option cluster (`-uo`, `-o./out`) that carries one of `letters`, or one of the long options (with or without `=`). */
const hasOption = (words: ShellWord[], letters: string, longs: string[] = []): boolean => words.some((w) =>
  [...letters].some((l) => shortLetters(w.text).includes(l)) || isLong(w.text, longs))
/** A git option that writes, runs a pager or a driver, or points git elsewhere — abbreviated too, and `-O` in a cluster. */
const gitRefused = (w: ShellWord): boolean => isLong(w.text, GIT_REFUSED_LONG) || shortLetters(w.text).includes('O')

/** A path-like argument (or the value of a `--flag=value`) must resolve inside the project. */
function pathOk(w: ShellWord, ctx: Ctx): boolean {
  // `.*` (and `.?`) can match `..` in some shells: a glob that starts a segment with a dot is not certain.
  if (w.glob && w.text.split('/').some((segment) => segment.startsWith('.') && /[*?[]/.test(segment))) return false
  let text = w.text
  if (isFlag(w)) {
    const eq = text.indexOf('=')
    // `--file=/x`, or a short option with its value attached (`-f/x`): the value names a path when it looks like one.
    text = eq >= 0 ? text.slice(eq + 1) : text.startsWith('--') ? '' : text.slice(1 + shortLetters(text).length)
    if (!(text.startsWith('/') || text.startsWith('~') || text.split('/').includes('..'))) return true
  }
  if (!w.tilde && text.startsWith('~')) return false            // a quoted `~`: a folder named `~`, or not — refused
  return inProject(text, ctx.cwd, { home: ctx.home })
}

/** Every argument that is not a flag names a path in the project, after `skipOperands` leading operands. */
function argsInProject(words: ShellWord[], ctx: Ctx, skipOperands = 0): boolean {
  let skipped = 0
  for (const w of words) {
    if (!isFlag(w) && skipped < skipOperands) { skipped++; continue }
    if (!pathOk(w, ctx)) return false
  }
  return true
}

/** `npx vitest …`: a test tool named first, no launcher flag (`-y`, `-p` install and run a package). */
function allowedTool(argv: string[], words: ShellWord[], ctx: Ctx): boolean {
  const [tool, ...rest] = argv
  if (!tool) return false
  if (tool === 'playwright') return rest[0] === 'test' && argsInProject(words.slice(2), ctx)
  return TEST_TOOLS.has(tool) && argsInProject(words.slice(1), ctx)
}

/** One simple command, already free of expansions: is it a read, a test, a build, a linter or a formatter? */
function allowedSimple(cmd: ShellCommand, ctx: Ctx): boolean {
  const [head, ...args] = cmd.words
  // `X=1 npm test`: an environment prefix changes what the command does (NODE_OPTIONS, GIT_*, LD_*).
  if (!head || head.assignment) return false
  const name = head.text
  if (head.quoted || head.glob || head.tilde || (name.includes('/') && name !== './gradlew')) return false
  const argv = args.map((w) => w.text)
  const noGlobs = !args.some((w) => w.glob)
  const patternFirst = (words: ShellWord[]): number => hasOption(words, 'ef', ['--regexp', '--file']) ? 0 : 1

  if (TEXT.has(name)) return true
  if (READS.has(name)) return argsInProject(args, ctx, PATTERN_FIRST.has(name) ? patternFirst(args) : 0)
  switch (name) {
    case 'date':
      return !hasOption(args, 's', ['--set'])
    case 'sort':
      // --files0-from reads the names of the files to print from a file: a path this cannot check.
      return noGlobs && !hasOption(args, 'oT', ['--output', '--compress-program', '--temporary-directory', '--files0-from']) && argsInProject(args, ctx)
    case 'uniq':
      return noGlobs && args.filter((w) => !isFlag(w)).length <= 1 && argsInProject(args, ctx)
    case 'tree':
      return noGlobs && !hasOption(args, 'oR', ['--output']) && argsInProject(args.filter((_w, i) => !['-I', '-P'].includes(args[i - 1]?.text ?? '')), ctx)
    case 'file':
      return !hasOption(args, 'C', ['--compile']) && argsInProject(args, ctx)
    case 'rg':
      return noGlobs && !args.some((w) => /^--pre(-glob)?(=|$)/.test(w.text)) && argsInProject(args, ctx, patternFirst(args))
    case 'find':
      if (!noGlobs || args.some((w) => FIND_ACTIONS.has(w.text))) return false
      return argsInProject(args.filter((_w, i) => !FIND_VALUE_ARGS.has(args[i - 1]?.text ?? '')), ctx)
    case 'sed': {
      if (!noGlobs) return false
      const flags = args.filter(isFlag).map((w) => w.text)
      if (!flags.some((f) => ['-n', '--quiet', '--silent'].includes(f))) return false
      if (flags.some((f) => !['-n', '-E', '-r', '--quiet', '--silent'].includes(f))) return false
      const operands = args.filter((w) => !isFlag(w))
      return operands.length >= 1 && SED_PRINT.test(operands[0]!.text) && argsInProject(operands.slice(1), ctx)
    }
    case 'cd':
      return args.length === 1 && argv[0] !== '-' && pathOk(args[0]!, ctx)
    case 'git': {
      if (!noGlobs) return false
      let rest = args
      while (rest[0]?.text === '--no-pager') rest = rest.slice(1)
      const sub = rest[0]?.text ?? ''
      const tail = rest.slice(1)
      if (tail.some(gitRefused)) return false
      if (GIT_READS.has(sub)) return argsInProject(tail, ctx, sub === 'grep' ? patternFirst(tail) : 0)
      if (sub === 'reflog') return tail.length === 0 || (tail[0]!.text === 'show' && argsInProject(tail.slice(1), ctx))
      if (sub === 'stash') return tail.length === 1 && tail[0]!.text === 'list'
      if (sub === 'remote') return tail.length === 0 || (tail.length === 1 && ['-v', '--verbose'].includes(tail[0]!.text))
      if (sub === 'branch') return tail.every((w) => GIT_BRANCH_LIST.has(w.text))
      return false
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      if (name === 'pnpm' && argv[0] === 'exec') return allowedTool(argv.slice(1), args.slice(1), ctx)
      if (name === 'yarn' && argv[0] && TEST_TOOLS.has(argv[0])) return allowedTool(argv, args, ctx)
      const at = argv[0] === 'run' ? 1 : 0
      return !!argv[at] && SCRIPT.test(argv[at]!) && argsInProject(args.slice(at + 1), ctx)
    }
    case 'npx': case 'bunx':
      return allowedTool(argv, args, ctx)
    case 'python': case 'python3':
      return argv[0] === '-m' && !!argv[1] && PY_MODULES.has(argv[1]) && argsInProject(args.slice(2), ctx)
    case 'go':
      if (args.some((w) => /^--?(exec|toolexec|vettool)(=|$)/.test(w.text))) return false
      return ['test', 'build', 'vet', 'fmt'].includes(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'gofmt':
      return argsInProject(args, ctx)
    case 'cargo':
      if (args.some((w) => /^--config(=|$)|^-Z/.test(w.text))) return false
      return ['test', 'build', 'check', 'clippy', 'fmt', 'doc'].includes(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'make':
      return args.every((w) => !isFlag(w) && MAKE_TARGETS.has(w.text))
    case 'flutter': case 'dart':
      return ['test', 'analyze', 'format', 'build'].includes(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'gradle': case './gradlew':
      return /^(test|build|check|assemble\w*)$/.test(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'mvn':
      return ['test', 'compile', 'verify', 'package'].includes(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'swift':
      return ['test', 'build'].includes(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'rspec': case 'ctest': case 'rubocop':
      return argsInProject(args, ctx)
    case 'mix':
      return ['test', 'format', 'compile'].includes(argv[0] ?? '') && argsInProject(args.slice(1), ctx)
    case 'bundle':
      if (argv[0] !== 'exec') return false
      if (argv[1] === 'rspec' || argv[1] === 'rubocop') return argsInProject(args.slice(2), ctx)
      return argv[1] === 'rake' && ['test', 'spec'].includes(argv[2] ?? '') && argsInProject(args.slice(3), ctx)
    default:
      return (TEST_TOOLS.has(name) || PY_TOOLS.has(name)) && argsInProject(args, ctx)
  }
}

/** A redirection that only folds descriptors (`2>&1`), discards (`>/dev/null`) or reads a project file. */
function redirectOk(r: { op: string; fd: number | null; target: string }, ctx: Ctx): boolean {
  if ((r.op === '>&' || r.op === '<&') && /^\d+$/.test(r.target)) return true
  if (['>', '>>', '&>', '&>>', '>|'].includes(r.op)) return r.target === '/dev/null'
  if (r.op === '<') return inProject(r.target, ctx.cwd, { home: ctx.home })
  return false
}

/** The most of a command read at all: DIALOG_MAX, the most a dialog shows in full (protocol.ts, which re-exports
 *  from this file — so the number is kept here rather than imported). */
const COMMAND_MAX = 16_000

/**
 * One command line is allowed when it reads with certainty and EVERY simple command in it is allowed.
 * Paths are resolved against `opts.cwd`: without one, a command that names any path is not allowed.
 */
export function isAllowedCommand(command: string, opts: PathContext = {}): boolean {
  // Longer than a dialog shows in full, it cannot be read before a key approves it — and every path in it
  // costs a realpath: a bound on the time one command can take.
  if (!command.trim() || command.length > COMMAND_MAX || isDenyClass(command)) return false
  const parsed = parseShell(command)
  if (!parsed.ok) return false
  const ctx: Ctx = { cwd: opts.cwd ?? null, home: opts.home === undefined ? homedir() : opts.home }
  return parsed.commands.every((cmd) => cmd.redirects.every((r) => redirectOk(r, ctx)) && allowedSimple(cmd, ctx))
}

// ── the structured tool call ────────────────────────────────────────────────────────────────────────

/** A tool call as the engine's transcript records it (Claude Code `tool_use`, Codex `function_call`). */
export interface ToolCall { name: string; input: unknown }

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const parseMaybe = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
const shellQuote = (word: string): string => /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS'])
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell'])

/** The shell command a tool call runs, exactly, or null when it runs none (or one this cannot read). */
export function toolCommand(tool: ToolCall): string | null {
  if (!SHELL_TOOLS.has(tool.name)) return null
  const input = record(parseMaybe(tool.input))
  if (!input) return null
  if (typeof input.command === 'string') return input.command
  if (typeof input.cmd === 'string') return input.cmd
  const argv = Array.isArray(input.command) && input.command.every((a) => typeof a === 'string') ? input.command as string[] : null
  if (!argv?.length) return null
  // Codex: ["bash", "-lc", "<script>"] runs the script; anything else is an argv, quoted back into a line.
  if (argv.length === 3 && /^(\/bin\/|\/usr\/bin\/)?(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv[2]!
  return argv.map(shellQuote).join(' ')
}

/** The file a read/edit/search tool call names; null for a search with no path (the project itself). */
function toolPath(tool: ToolCall): string | null | undefined {
  const input = record(parseMaybe(tool.input))
  if (!input) return undefined
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof input[key] === 'string') return input[key] as string
  return null
}

/** Whether a `[y]` may approve this exact tool call. Anything unrecognised is not. */
export function isAllowToolCall(tool: ToolCall, opts: PathContext = {}): boolean {
  if (SHELL_TOOLS.has(tool.name)) {
    const command = toolCommand(tool)
    return command !== null && isAllowedCommand(command, opts)
  }
  const path = toolPath(tool)
  if (EDIT_TOOLS.has(tool.name)) return typeof path === 'string' && inProject(path, opts.cwd, { home: opts.home })
  if (SEARCH_TOOLS.has(tool.name)) return path === null || (typeof path === 'string' && inProject(path, opts.cwd, { home: opts.home }))
  return false
}

const squash = (text: string): string => text.replace(/\s+/g, '')

const FILE_HEADER = /^(edit|write|create|update|read|view)( file)?$/i
const SEARCH_HEADER = /^(glob|grep|search|list( files)?|ls)$/i
const BASH_HEADER = /^(bash( command)?|run( command)?|shell( command)?|execute( shell)?( command)?)$/i
const EDIT_QUESTION = /make this edit to (.+?)\?\s*$/i
/** An option row as painted (`❯ 1. Yes`), or a key hint under them. */
const OPTION_ROW = /^([>›❯*]\s*)?\d+[.)]\s|^(esc|press|enter|tab)\b/i

/** The lines under a header, to the first blank line after them. */
function blockUnder(lines: string[], headerAt: number): string[] {
  const block: string[] = []
  for (const line of lines.slice(headerAt + 1)) {
    if (!line) { if (block.length) break; continue }
    block.push(line)
  }
  return block
}

/** The `$ ` command line (Codex), with the lines under it up to a blank one; null when there is not exactly one. */
function dollarBlock(lines: string[]): { at: number; lines: string[] } | null {
  const starts = lines.map((line, at) => ({ line, at })).filter(({ line }) => line.startsWith('$ '))
  if (starts.length !== 1) return null
  const at = starts[0]!.at
  const out = [lines[at]!.slice(2)]
  for (const line of lines.slice(at + 1)) { if (!line) break; out.push(line) }
  return { at, lines: out }
}

/**
 * The ONE open tool call this dialog paints, or null (none, or more than one could be). Strict: a shell
 * call only under a shell header (or Codex's `$ `), whose painted lines are exactly its command (and its
 * description); a file call only under a file header that names exactly its file.
 */
export function matchToolCall(dialog: string, tools: readonly ToolCall[], cwd?: string | null): ToolCall | null {
  const lines = dialog.split('\n').map((line) => line.trim())
  const headerAt = lines.findIndex((line) => FILE_HEADER.test(line) || BASH_HEADER.test(line) || SEARCH_HEADER.test(line))
  const header = headerAt >= 0 ? lines[headerAt]! : ''
  const dollar = dollarBlock(lines)
  const hits = tools.filter((tool) => {
    if (SHELL_TOOLS.has(tool.name)) {
      const command = toolCommand(tool)
      if (!command || !squash(command)) return false
      const input = record(parseMaybe(tool.input))
      const description = typeof input?.description === 'string' ? squash(input.description) : ''
      if (dollar) return squash(dollar.lines.join('')) === squash(command)
      if (!BASH_HEADER.test(header)) return false
      const painted = squash(blockUnder(lines, headerAt).join(''))
      return painted === squash(command) || (!!description && painted === squash(command) + description)
    }
    if (!FILE_HEADER.test(header) && !SEARCH_HEADER.test(header)) return false
    const path = toolPath(tool)
    if (typeof path !== 'string' || !path) return false
    const named = paintedPath(blockUnder(lines, headerAt)[0] ?? '')
    const shown = cwd && isAbsolute(path) ? relative(cwd, path) : path
    return named === shown || named === path
  })
  return hits.length === 1 ? hits[0]! : null
}

// ── allow-class dialogs ─────────────────────────────────────────────────────────────────────────────

export interface AllowOptions extends PathContext {
  permission: boolean
  /** The engine's open tool calls for this harness, when its transcript has them. */
  tools?: readonly ToolCall[]
}

/**
 * Whether a `[y]` may approve this dialog. `dialog` is the whole dialog, line by line, as painted.
 * Only a permission prompt can be allow-class; anything unrecognised, or not read with certainty, is not.
 */
export function isAllowClass(dialog: string, opts: AllowOptions): boolean {
  if (!opts.permission || !dialog.trim() || isDenyClass(dialog)) return false
  const ctx: PathContext = { cwd: opts.cwd, home: opts.home }
  const lines = dialog.split('\n').map((line) => line.trim())

  // Claude's edit prompt: the header names the file, the preview follows, then ONE question naming the
  // same file, then only the options. A second "make this edit" line, or one with more than options after
  // it (a line the preview's text painted), is file content, not the dialog: no [y].
  const edits = lines.map((line, at) => ({ at, match: EDIT_QUESTION.exec(line) })).filter((e) => e.match)
  if (edits.length > 1) return false
  if (edits.length === 1) {
    const { at, match } = edits[0]!
    if (lines.slice(at + 1).some((line) => line && !OPTION_ROW.test(line))) return false
    const file = paintedPath(match![1]!)
    const headerAt = lines.findIndex((line) => FILE_HEADER.test(line))
    if (headerAt < 0 || headerAt > at || paintedPath(blockUnder(lines, headerAt)[0] ?? '') !== file) return false
  }

  // The exact call, when the transcript has exactly one that this dialog paints.
  const tool = opts.tools?.length ? matchToolCall(dialog, opts.tools, opts.cwd) : null
  if (tool) return isAllowToolCall(tool, ctx)
  if (edits.length === 1) return inProject(paintedPath(edits[0]!.match![1]!), opts.cwd, { home: opts.home })

  // Codex (and anything that prints the command with a `$ ` prompt): exactly ONE command line, standing
  // alone. A line right under it could be the command continuing (or wrapping): not read with certainty.
  if (lines.some((line) => line.startsWith('$ '))) {
    const dollar = dollarBlock(lines)
    return !!dollar && dollar.lines.length === 1 && isAllowedCommand(dollar.lines[0]!, ctx)
  }

  const headerAt = lines.findIndex((line) => FILE_HEADER.test(line) || SEARCH_HEADER.test(line) || BASH_HEADER.test(line))
  if (headerAt < 0) return false
  const header = lines[headerAt]!
  const block = blockUnder(lines, headerAt)
  if (!block.length) return SEARCH_HEADER.test(header)
  if (FILE_HEADER.test(header)) return block.length === 1 && inProject(paintedPath(block[0]!), opts.cwd, { home: opts.home })
  if (SEARCH_HEADER.test(header)) {
    return block.every((line) => !/(^|\s)(\/|~|\.\.)/.test(line) || inProject(paintedPath(line.split(/\s+/).pop()!), opts.cwd, { home: opts.home }))
  }
  // Bash, painted: the command's lines, then (usually) a description line — which a line of the command can
  // look exactly like. Without the transcript's tool call, only a block of ONE line is read with certainty.
  return block.length === 1 && isAllowedCommand(block[0]!, ctx)
}
