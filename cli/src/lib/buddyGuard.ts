/**
 * A Buddy's guard: the Claude Code PreToolUse hook its folder's settings run before every tool call (lib/swarmSkills.ts).
 *
 * A Buddy never changes anything, and it must never stall on a permission prompt nobody at its terminal answers (Ken,
 * 10-29). Asking mode stalled on every read command; full permissions would let Bash push or open pull requests with its
 * person's own GitHub login, which the Edit and Write deny rules do not stop. So it launches in Claude Code's dontAsk
 * mode, and this guard answers every call: allow for its read tools, its Super Tab commands and a fixed set of read
 * commands, each one plain command, and deny for everything else. Its deny outranks any allow rule in the person's own
 * settings, which dontAsk alone would honour.
 *
 * A Bash command is allowed only as words the guard can read exactly as the shell will: unquoted letters, digits and
 * `_-./:=,@%+`, single-quoted text, and double-quoted text without `$`, a backtick, `\` or `!`. Anything else (pipes,
 * redirects, `;`, `&`, `$()`, globs, braces, `~`, comments, a newline) refuses the whole command, so a read command cannot
 * carry another one. The read commands' own ways to write or run something are refused too: git's `--output`, `-O`/
 * `--open-files-in-pager` and `--ext-diff` (git takes any unique prefix of a long option, so prefixes too), gh's `--web`,
 * and rg's `--pre`, `--pre-glob`, `-z` and `--hostname-bin`, which runs a program (rg 14.1.1, tried).
 *
 * What it reads stays in its folder (security review 2 of #2092): the machine is its person's, the folder is the project.
 * Read, Grep, Glob and LS take paths there only, by real path, so a link out is out; a Bash word that is an absolute path
 * or has a ".." part is refused, and so are gh's -R/--repo (any repository its person can read) and git's --no-index.
 * Its Super Tab commands are a Buddy's own (status, messages, message, decisions, post, propose, help) as the pane it runs
 * in identifies it: never --agent, --port or --machine. Nothing runs on: no background shell, no tail -f.
 *
 * Plain JavaScript with node's own modules only, written into the Buddy's folder with that folder's real path and run by
 * Harness's node: the tests run this exact text (lib/buddyGuard.spec.ts, and Claude Code itself in
 * lib/buddyGuard.claude.spec.ts).
 */
export const buddyGuardSource = (root: string): string => String.raw`#!/usr/bin/env node
// A Buddy's guard, written by Harness (cli/src/lib/buddyGuard.ts). Do not edit: Harness writes it again at each launch.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// The Buddy's folder, as its real path: what it reads stays in it.
const ROOT = ${JSON.stringify(root)}
const TOOLS = new Set(['TodoWrite', 'ToolSearch'])
const READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'pwd'])
const GIT = new Set(['grep', 'log', 'show', 'diff', 'blame', 'status'])
const GH = { issue: new Set(['view', 'list']), pr: new Set(['view', 'list', 'diff']) }
const GIT_LONG = ['output', 'open-files-in-pager', 'ext-diff']
const RG_LONG = ['pre', 'pre-glob', 'search-zip', 'hostname-bin']
// A Buddy's own Super Tab commands: reading its chats and posting in its own, and its owner's proposal. The pane it runs in
// says who it is (superTabs/command.ts), so it never names an agent, a port or a machine.
const SUPER_TAB = new Set(['status', 'messages', 'message', 'decisions', 'post', 'propose', 'help'])
const MAY = 'A Buddy only reads, so this was refused and nobody will be asked. Read the code with Read, Grep and Glob. ' +
  'In the shell, run one plain command at a time (no pipes, redirects, ;, &&, $() or globs): git grep, log, show, diff, ' +
  'blame or status; gh issue view or list; gh pr view, list or diff; ls, cat, rg, head, tail, wc or grep; or harness super-tab.'

// The command's words, or null when the shell could read it any other way.
function words(command) {
  const out = []
  let word = null
  for (let i = 0; i < command.length;) {
    const c = command[i]
    if (c === ' ' || c === '\t') { if (word !== null) out.push(word); word = null; i++; continue }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      word = (word ?? '') + command.slice(i + 1, end); i = end + 1; continue
    }
    if (c === '"') {
      let end = i + 1
      while (end < command.length && command[end] !== '"') {
        if ('$\x60\\!'.includes(command[end])) return null
        end++
      }
      if (end >= command.length) return null
      word = (word ?? '') + command.slice(i + 1, end); i = end + 1; continue
    }
    // zsh expands a word that starts with = to a command's path.
    if (!/[A-Za-z0-9_\-.\/:=,@%+]/.test(c) || (c === '=' && word === null)) return null
    word = (word ?? '') + c; i++
  }
  if (word !== null) out.push(word)
  return out
}

// Whether [path] is in the Buddy's folder: by the real path of the file, or of its nearest folder that exists, so a
// link out of the folder, or a ".." out of it, is out.
function inside(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false
  let at = resolve(ROOT, path), rest = ''
  for (;;) {
    try {
      const real = join(realpathSync(at), rest)
      return real === ROOT || real.startsWith(ROOT + sep)
    } catch { /* not there: its folder decides */ }
    if (dirname(at) === at) return false
    rest = rest ? join(basename(at), rest) : basename(at)
    at = dirname(at)
  }
}

// A word that names a place out of the folder: an absolute path (the machine's files, /dev), or one with a ".." part,
// alone or after "=" or ":" (--file=/x, HEAD:../x). A range such as main..HEAD has no ".." part.
const outward = (word) => word.split(/[=:]/).some((part) => isAbsolute(part) || part.split('/').includes('..'))

const short = (word) => /^-[^-]/.test(word)
// A long option naming one of these, or a unique prefix of one: git takes either.
const longNames = (word, names) => word.startsWith('--') && names.some((name) => {
  const given = word.slice(2).split('=')[0]
  return given.length > 0 && name.startsWith(given)
})

// harness super-tab [--tab ID] ACTION ...: only a Buddy's actions, and an --attach only from its folder.
function superTabAllowed(rest) {
  let i = 0
  while (rest[i] === '--tab') i += 2
  if (i > rest.length || !SUPER_TAB.has(rest[i])) return false
  return !rest.slice(i + 1).some((word, at, after) => (word === '--attach' && (after[at + 1] === undefined || outward(after[at + 1])))
    || ['--agent', '--port', '--machine'].includes(word))
}

function bashAllowed(command) {
  if (typeof command !== 'string') return false
  const w = words(command)
  if (!w || w.length === 0) return false
  const [name, sub, verb] = w
  const rest = w.slice(1)
  if (name === 'harness') return sub === 'super-tab' && superTabAllowed(w.slice(2))
  if (rest.some(outward)) return false
  // Nothing that runs on: a background shell, or tail following a file.
  if (name === 'tail') return !rest.some((word) => longNames(word, ['follow']) || (short(word) && /[fF]/.test(word)))
  if (READERS.has(name)) return true
  if (name === 'git') {
    return GIT.has(sub) && !rest.some((word) => longNames(word, GIT_LONG) || word === '--no-index' || (short(word) && word.includes('O')))
  }
  if (name === 'gh') {
    // Its own project's issues and pull requests only: -R/--repo would read any repository its person can.
    return Object.hasOwn(GH, sub) && GH[sub].has(verb)
      && !rest.some((word) => word === '--web' || word.startsWith('--web=') || word === '--repo' || word.startsWith('--repo=')
        || (short(word) && /[wR]/.test(word)))
  }
  if (name === 'rg') {
    return !rest.some((word) => longNames(word, RG_LONG) || (short(word) && word.includes('z')))
  }
  return false
}

function decide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool_name !== 'string') return false
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null
  if (!tool) return false
  if (TOOLS.has(input.tool_name)) return true
  // Its read tools, in its folder: Read a file there, Grep and Glob there (their folder by default), LS a folder there.
  if (input.tool_name === 'Read') return inside(tool.file_path)
  if (input.tool_name === 'LS') return inside(tool.path)
  if (input.tool_name === 'Grep') return tool.path === undefined || inside(tool.path)
  if (input.tool_name === 'Glob') {
    return (tool.path === undefined || inside(tool.path)) && typeof tool.pattern === 'string' && !outward(tool.pattern)
  }
  return input.tool_name === 'Bash' && tool.run_in_background !== true && bashAllowed(tool.command)
}

let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { text += chunk })
process.stdin.on('end', () => {
  let input = null
  try { input = JSON.parse(text) } catch { /* refused below */ }
  const allow = decide(input)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'A Buddy may read.' : MAY } }))
})
`

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The hook's command. Exit 2 is Claude Code's blocking error: a guard that cannot run refuses the call, where any other
 *  failure would hand it to the permission rules, the person's own allow rules among them. */
export function buddyGuardCommand(node: string, script: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} || exit 2`
}
