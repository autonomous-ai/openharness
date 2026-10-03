/**
 * A small, CONSERVATIVE shell tokenizer for the floor (pair/classify.ts): enough of POSIX sh to split a
 * one-line command into simple commands, words and redirections, and to REFUSE everything it cannot read
 * with certainty. It never runs anything and never expands anything; anything that would be expanded by a
 * shell (a `$`, a backtick, a process substitution, a heredoc, a brace, a subshell, a comment, a newline)
 * makes the whole command unreadable, and an unreadable command is never allow-class.
 *
 *   separators   `;`  `&`  `&&`  `||`  `|`  `|&`   — each side is its own simple command
 *   quoting      '…' (literal), "…" (only \" \\ \$ \` escapes; any $ or ` inside refuses), \x outside quotes
 *   redirection  [n]> [n]>> [n]>| [n]< &> &>> [n]>&m — the target is the next word
 *   refused      newline, $, `, <( >(, <<, <<<, <>, ( ) { }, # at a word start, ! at a word start, control chars,
 *                invisible or look-alike characters (zero-width, bidi, no-break space, a fullwidth ；)
 */

export interface ShellWord {
  /** The word after quote removal. */
  text: string
  /** Any part of it was quoted or escaped (a quoted `*` is not a glob, a quoted `=` is not an assignment). */
  quoted: boolean
  /** An unquoted `*`, `?` or `[`: the shell would expand it against the file system. */
  glob: boolean
  /** An unquoted `~` at its start: the shell would put a home folder there. */
  tilde: boolean
  /** `NAME=value` before any quote: an assignment when it comes before the command name. */
  assignment: boolean
}

export interface ShellRedirect {
  /** `>`, `>>`, `>|`, `<`, `&>`, `&>>`, `>&`, `<&`. */
  op: string
  /** The file descriptor written before it (`2>`), or null. */
  fd: number | null
  target: string
}

export interface ShellCommand {
  words: ShellWord[]
  redirects: ShellRedirect[]
}

export type ShellParse = { ok: true; commands: ShellCommand[] } | { ok: false; reason: string }

const REFUSE = (reason: string): ShellParse => ({ ok: false, reason })

/** Shell syntax and blanks: what a look-alike character normalizes to. */
const SHELL_CHARS = /[\s;&|<>()$`{}#!'"\\*?[\]~=]/

/**
 * What the person reads is not what runs: a character outside ASCII that is invisible or a control (zero-width,
 * bidi, BOM, C1, private or unassigned), a blank or line separator (no-break space, U+2028), or a look-alike of
 * a shell character (a fullwidth `；`, the Greek question mark that is `;`). Ordinary text (`café`, `✓`) is not.
 */
function unreadable(src: string): boolean {
  for (const ch of src) {
    if (ch <= '\x7f') continue
    if (/[\p{C}\p{Z}]/u.test(ch) || SHELL_CHARS.test(ch.normalize('NFKC'))) return true
  }
  return false
}

/** Split a ONE-LINE command. Anything this cannot read with certainty is `{ ok: false }`. */
export function parseShell(source: string): ShellParse {
  const src = source.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '')
  if (!src) return REFUSE('empty')
  if (/[\r\n]/.test(src)) return REFUSE('multi-line')
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(src)) return REFUSE('control character')
  if (unreadable(src)) return REFUSE('an invisible or look-alike character')

  const commands: ShellCommand[] = []
  let words: ShellWord[] = []
  let redirects: ShellRedirect[] = []
  let word: ShellWord | null = null
  /** A redirection waiting for its target word. */
  let pending: { op: string; fd: number | null } | null = null

  const endWord = (): ShellParse | null => {
    if (!word) return null
    const done = word
    word = null
    if (pending) {
      redirects.push({ ...pending, target: done.text })
      pending = null
      if (done.glob || done.tilde) return REFUSE('a redirection target that the shell would expand')
      return null
    }
    words.push(done)
    return null
  }
  const endCommand = (separator: string): ShellParse | null => {
    const failed = endWord()
    if (failed) return failed
    if (pending) return REFUSE(`a redirection with no target before ${separator}`)
    if (!words.length && !redirects.length) return REFUSE(`an empty command before ${separator}`)
    commands.push({ words, redirects })
    words = []
    redirects = []
    return null
  }
  const start = (): ShellWord => (word ??= { text: '', quoted: false, glob: false, tilde: false, assignment: false })

  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const next = src[i + 1]
    if (c === ' ' || c === '\t') {
      const failed = endWord()
      if (failed) return failed
      i++
      continue
    }
    if (c === '$') return REFUSE('an expansion ($)')
    if (c === '`') return REFUSE('a command substitution (`)')
    if (c === '(' || c === ')') return REFUSE('a subshell or process substitution')
    if (c === '{' || c === '}') return REFUSE('a brace group or brace expansion')
    if ((c === '#' || c === '!') && !word) return REFUSE(c === '#' ? 'a comment' : 'a negation or history expansion')
    if (c === ';') {
      const failed = endCommand(';')
      if (failed) return failed
      i++
      continue
    }
    if (c === '|') {
      const failed = endCommand('|')
      if (failed) return failed
      i += next === '|' || next === '&' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (next === '>') {
        const failed = endWord()
        if (failed) return failed
        const append = src[i + 2] === '>'
        pending = { op: append ? '&>>' : '&>', fd: null }
        i += append ? 3 : 2
        continue
      }
      const failed = endCommand('&')
      if (failed) return failed
      i += next === '&' ? 2 : 1
      continue
    }
    if (c === '<' || c === '>') {
      if (next === '(') return REFUSE('a process substitution')
      if (c === '<' && (next === '<' || next === '>')) return REFUSE('a heredoc, herestring or read-write redirection')
      // A word made only of digits right before it is the file descriptor (`2>`), not an argument.
      let fd: number | null = null
      const before = word as ShellWord | null   // closures above assign it: TS cannot follow them
      if (before && !before.quoted && /^\d+$/.test(before.text)) { fd = Number(before.text); word = null }
      const failed = endWord()
      if (failed) return failed
      if (pending) return REFUSE('two redirections in a row')
      let op = c
      let step = 1
      if (c === '>' && (next === '>' || next === '|' || next === '&')) { op = `>${next}`; step = 2 }
      else if (c === '<' && next === '&') { op = '<&'; step = 2 }
      pending = { op, fd }
      i += step
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return REFUSE('an unterminated quote')
      const w = start()
      w.text += src.slice(i + 1, end)
      w.quoted = true
      i = end + 1
      continue
    }
    if (c === '"') {
      const w = start()
      w.quoted = true
      let j = i + 1
      let closed = false
      while (j < src.length) {
        const d = src[j]!
        if (d === '"') { closed = true; break }
        if (d === '$' || d === '`') return REFUSE('an expansion inside double quotes')
        if (d === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1]!)) { w.text += src[j + 1]; j += 2; continue }
        w.text += d
        j++
      }
      if (!closed) return REFUSE('an unterminated quote')
      i = j + 1
      continue
    }
    if (c === '\\') {
      if (next === undefined) return REFUSE('a trailing backslash')
      const w = start()
      w.text += next
      w.quoted = true
      i += 2
      continue
    }
    const fresh = !word
    const w = start()
    if (c === '*' || c === '?' || c === '[') w.glob = true
    if (c === '~' && fresh) w.tilde = true
    if (c === '=' && !w.quoted && !w.assignment && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w.text)) w.assignment = true
    w.text += c
    i++
  }
  const failed = endCommand('the end')
  if (failed) return failed
  return { ok: true, commands }
}
