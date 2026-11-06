import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, posix, resolve } from 'node:path'

/**
 * The shell guard of a Swarm agent's session (task #3596, inventory Table A #5; anh Dee 11-06: a rule that can be checked
 * runs as code, not as a line in the instructions). Every Swarm agent was told, in its skill and its project's rules, never
 * to stop processes by name, use sudo or install system-wide, write fixed names in /tmp, or remove a worktree a live process
 * uses; they still did (one wrote `> /tmp/instr_wren.txt` on 11-05). Shared machines run several accounts' agents at once,
 * so each of these breaks someone else's work: a `pkill -f node` stops every agent's servers, a fixed /tmp name can be read
 * or planted by any account, and a worktree removed under a live agent loses its work.
 *
 * This reads a command the way a shell splits it (quotes, `;` `&&` `||` `|`, `$(…)`, backticks, `sh -c '…'`, heredocs)
 * and refuses it with one line saying why and what to do instead. It is a guard for honest agents, not a sandbox: a
 * command built at run time (`$(echo pk)ill`) is not read. Plain text (a commit message, `grep pkill`, `echo sudo`) is
 * never taken for a command: only a word in a command's own place is.
 */

const PREFIX = 'Harness shell guard:'

export const GUARD_REASONS = {
  killByName: `${PREFIX} stop only processes you started, by the process id you recorded; never by name or pattern `
    + '(pkill, killall, kill $(pgrep …), taskkill /IM).',
  systemWide: `${PREFIX} no sudo and no system-wide installs on a shared machine; put the tools you need in your session folder.`,
  fixedTmp: `${PREFIX} a fixed name in /tmp can be read or planted by every account; make a folder with `
    + 'mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX" and write inside it.',
  liveWorktree: (path: string, pid: number) => `${PREFIX} process ${pid} still works in the worktree ${path}; never remove a `
    + 'worktree a live process uses.',
  worktreeUnknown: (path: string) => `${PREFIX} could not tell whether a live process uses the worktree ${path}, so it is not `
    + 'removed; stop what runs there first.',
}

/** What the guard knows of the machine: seams, so a spec reads none of the machine it runs on. */
export interface GuardFacts {
  /** The folder the command runs in. */
  cwd: string
  platform: NodeJS.Platform
  /** Whether [path] is a folder only this account can open (what `mktemp -d` makes). */
  privateFolder: (path: string) => boolean
  /** Whether [path] is a linked git worktree (its `.git` is a file). */
  linkedWorktree: (path: string) => boolean
  /** Every live process's working folder, or null when they cannot be read. */
  liveCwds: () => { pid: number; cwd: string }[] | null
  /** [path] with its links resolved; [path] itself when absent or when it cannot be. */
  realpath?: (path: string) => string
}

/** One command in its own place: its words with quotes removed, and where its redirections write or read. */
interface Simple { words: string[]; targets: string[] }

/** The guard's answer for [command]: the reason it is refused, or null to let it run. */
export function shellRefusal(command: string, facts: GuardFacts): string | null {
  const commands = allCommands(command)
  if (commands.some(systemWide)) return GUARD_REASONS.systemWide
  if (killsByName(commands)) return GUARD_REASONS.killByName
  if (commands.some((simple) => fixedTmp(simple, facts))) return GUARD_REASONS.fixedTmp
  return liveWorktree(commands, facts)
}

/** The guard's answer for a file tool writing [path] (Claude Code's Write, Edit, MultiEdit and NotebookEdit). */
export function fileRefusal(path: string, facts: GuardFacts): string | null {
  return tmpPathRefused(resolveIn(facts.cwd, path, facts.platform), facts) ? GUARD_REASONS.fixedTmp : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a command

const MAX_DEPTH = 8

/** Every command in [text], in order, with those inside `$(…)`, backticks, `<(…)`, `sh -c '…'` and `eval`. */
function allCommands(text: string, depth = 0): Simple[] {
  if (depth > MAX_DEPTH) return []
  const nested: string[] = []
  const found: Simple[] = []
  for (const simple of split(text, nested)) {
    const words = programWords(simple.words)
    found.push({ words, targets: simple.targets })
    const script = scriptOf(words)
    if (script !== null) nested.push(script)
  }
  for (const inner of nested) found.push(...allCommands(inner, depth + 1))
  return found
}

/** The script a shell or `eval` runs from its words: `bash -lc '…'`, `sh -c "…"`, `pwsh -Command …`, `eval …`. */
function scriptOf(words: string[]): string | null {
  const program = programName(words[0])
  if (program === 'eval') return words.slice(1).join(' ')
  if (SHELLS.has(program)) {
    const flag = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/i.test(word))
    if (flag > 0 && words[flag + 1] !== undefined) return words[flag + 1]
  }
  if (POWERSHELLS.has(program)) {
    const flag = words.findIndex((word, index) => index > 0 && /^-(c|command)$/i.test(word))
    if (flag > 0) return words.slice(flag + 1).join(' ')
  }
  return null
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])

/** A program's name as matched: its last path part, lower case, without `.exe`. */
function programName(word: string | undefined): string {
  if (!word) return ''
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
}

/** Shell words that start a command but are not its program. */
const KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'function'])
/** Programs that run the rest of their words as a command, each with the options that take a value. */
const WRAPPERS: Record<string, { values: Set<string>; first?: 'duration' }> = {
  env: { values: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']) },
  command: { values: new Set() },
  builtin: { values: new Set() },
  exec: { values: new Set(['-a']) },
  nohup: { values: new Set() },
  nice: { values: new Set(['-n', '--adjustment']) },
  timeout: { values: new Set(['-s', '--signal', '-k', '--kill-after']), first: 'duration' },
  xargs: { values: new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']) },
  stdbuf: { values: new Set(['-i', '-o', '-e']) },
  caffeinate: { values: new Set(['-t', '-w']) },
}

/** [words] from the program on: leading assignments, shell keywords and wrappers (`env X=1`, `xargs -n1`, `nohup`) go. */
function programWords(words: string[]): string[] {
  let at = 0
  for (;;) {
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || KEYWORDS.has(words[at]))) at++
    const name = programName(words[at])
    const wrapper = WRAPPERS[name]
    if (!wrapper) return words.slice(at)
    at++
    let duration = wrapper.first === 'duration'
    while (at < words.length) {
      const word = words[at]
      if (word === '--') { at++; break }
      if (word.startsWith('-') && word.length > 1) { at += wrapper.values.has(word) ? 2 : 1; continue }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { at++; continue }
      if (duration) { duration = false; at++; continue }
      break
    }
  }
}

/**
 * The commands of [text] as a shell splits them. What `$(…)`, backticks and `<(…)` hold goes to [nested], to be read as
 * commands of their own; the word keeps its text. A heredoc's body is data, never commands (a commit message saying
 * "sudo" at a line's start is not a sudo). `#` starts a comment at a word's start.
 */
function split(text: string, nested: string[]): Simple[] {
  const out: Simple[] = []
  let words: string[] = [], targets: string[] = []
  let word = '', inWord = false, redirect = false
  const heredocs: { delimiter: string; strip: boolean }[] = []
  let pendingHeredoc: { strip: boolean } | null = null

  const endWord = () => {
    if (!inWord) return
    if (pendingHeredoc) { heredocs.push({ delimiter: word, strip: pendingHeredoc.strip }); pendingHeredoc = null }
    else if (redirect) { targets.push(word); redirect = false }
    else words.push(word)
    word = ''; inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length || targets.length) out.push({ words, targets })
    words = []; targets = []; redirect = false
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\n') {
      endCommand()
      i++
      // Skip each heredoc's body, line by line, up to its delimiter.
      for (const doc of heredocs.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf('\n', i)
          const line = text.slice(i, end === -1 ? text.length : end)
          i = end === -1 ? text.length : end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
        }
      }
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue }
    if (c === '#' && !inWord) { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue }
      word += text[i + 1] ?? ''; inWord = true; i += 2; continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      word += text.slice(i + 1, end === -1 ? text.length : end); inWord = true
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === '"') {
      inWord = true; i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`\n'.includes(text[i + 1] ?? '')) { word += text[i + 1]; i += 2; continue }
        const sub = substitution(text, i)
        if (sub) { nested.push(sub.inner); word += text.slice(i, sub.end); i = sub.end; continue }
        word += text[i]; i++
      }
      i++
      continue
    }
    const sub = substitution(text, i)
    if (sub) { nested.push(sub.inner); word += text.slice(i, sub.end); inWord = true; i = sub.end; continue }
    if ((c === '<' || c === '>') && text[i + 1] === '(') {
      const end = closing(text, i + 1)
      nested.push(text.slice(i + 2, end - 1)); word += text.slice(i, end); inWord = true; i = end
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      if (c === '&' && text[i + 1] === '>') { endWord(); i += text[i + 2] === '>' ? 3 : 2; redirect = true; continue }
      endCommand()
      i += (c === '&' && text[i + 1] === '&') || (c === '|' && (text[i + 1] === '|' || text[i + 1] === '&')) || (c === ';' && text[i + 1] === ';') ? 2 : 1
      continue
    }
    if (c === '<' || c === '>') {
      // A file descriptor before it (`2>`) is part of the redirection, not a word.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
        const strip = text[i + 2] === '-'
        i += strip ? 3 : 2
        pendingHeredoc = { strip }
        continue
      }
      let j = i + 1
      while (text[j] === '>' || text[j] === '<' || text[j] === '|') j++
      if (text[j] === '&') {
        // `>&2`, `2>&1`: to another descriptor, no file.
        j++
        while (/\d|-/.test(text[j] ?? '')) j++
        i = j
        continue
      }
      i = j
      redirect = true
      continue
    }
    word += c; inWord = true; i++
  }
  endCommand()
  return out
}

/** `$(…)` or `` `…` `` at [at]: what it holds and where it ends. */
function substitution(text: string, at: number): { inner: string; end: number } | null {
  if (text[at] === '$' && text[at + 1] === '(') {
    const end = closing(text, at + 1)
    return { inner: text.slice(at + 2, end - 1), end }
  }
  if (text[at] === '`') {
    const end = text.indexOf('`', at + 1)
    const stop = end === -1 ? text.length : end
    return { inner: text.slice(at + 1, stop), end: stop + 1 }
  }
  return null
}

/** Just past the `)` that closes the `(` at [open], skipping quotes and nested parentheses. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const end = text.indexOf("'", i + 1); i = end === -1 ? text.length : end; continue }
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++ }
      continue
    }
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return i + 1
  }
  return text.length
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules

const lower = (words: string[]) => words.map((word) => word.toLowerCase())
/** The first word after the program that is not an option. */
const subcommand = (words: string[]) => words.slice(1).find((word) => !word.startsWith('-'))?.toLowerCase()

const ELEVATORS = new Set(['sudo', 'doas', 'su', 'pkexec', 'gsudo', 'runas'])
const NODE_MANAGERS = new Set(['npm', 'pnpm', 'bun'])
const NODE_CHANGES = new Set(['install', 'i', 'in', 'isntall', 'add', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'un', 'r', 'link', 'ln'])
const BREW_CHANGES = new Set(['install', 'reinstall', 'upgrade', 'uninstall', 'remove', 'rm', 'tap', 'untap', 'link', 'unlink'])
const SYSTEM_PACKAGES = new Set(['apt', 'apt-get', 'aptitude', 'dnf', 'yum', 'zypper', 'apk', 'snap', 'port', 'pkg', 'emerge'])
const PACKAGE_CHANGES = new Set(['install', 'reinstall', 'upgrade', 'remove', 'purge', 'add', 'del', 'erase', 'autoremove',
  'dist-upgrade', 'full-upgrade', 'uninstall', 'selfupdate', 'selfupgrade', 'refresh'])
const WINDOWS_PACKAGES = new Set(['winget', 'choco'])

/** sudo and its kin, or an install that writes for every account on the machine. */
function systemWide({ words }: Simple): boolean {
  const program = programName(words[0])
  const all = lower(words)
  if (ELEVATORS.has(program)) return true
  if (NODE_MANAGERS.has(program)) {
    const global = all.some((word) => word === '-g' || word === '--global' || word === '--location=global')
      || all.some((word, index) => word === '--location' && all[index + 1] === 'global')
    return global && NODE_CHANGES.has(subcommand(words) ?? '')
  }
  if (program === 'yarn') return subcommand(words) === 'global'
  if (program === 'brew') return BREW_CHANGES.has(subcommand(words) ?? '')
  if (SYSTEM_PACKAGES.has(program)) return PACKAGE_CHANGES.has(subcommand(words) ?? '')
  if (program === 'pacman') return words.slice(1).some((word) => /^-[A-Za-z]*[SRU]/.test(word) || /^--(sync|remove|upgrade)$/.test(word))
  if (program === 'pip' || program === 'pip3' || (/^python[\d.]*$/.test(program) && all.includes('pip'))) {
    return all.includes('install') && all.some((word) => word === '--break-system-packages' || word === '--system')
  }
  if (program === 'installer') return all.includes('-pkg')
  if (program === 'softwareupdate') return all.slice(1).some((word) => ['-i', '--install', '-a', '--all', '-r', '--recommended'].includes(word))
  if (WINDOWS_PACKAGES.has(program)) return ['install', 'upgrade', 'uninstall'].includes(subcommand(words) ?? '')
  if (program === 'msiexec') return all.slice(1).some((word) => /^[/-](i|x|package|uninstall)$/.test(word))
  if (program === 'osascript') return all.some((word) => word.includes('with administrator privileges'))
  if (program === 'start-process') return all.some((word, index) => word === '-verb' && all[index + 1] === 'runas')
  if (['install-module', 'install-package', 'install-script'].includes(program)) {
    return all.some((word, index) => word === '-scope' && all[index + 1] === 'allusers')
  }
  return false
}

const BY_NAME = new Set(['pkill', 'killall', 'killall5'])
const KILLERS = new Set(['kill', 'stop-process', 'spps'])
const LOOKUPS = new Set(['pgrep', 'pidof', 'lsof', 'fuser', 'get-process', 'gps'])

/** pkill and its kin, or a kill fed by a lookup by name or pattern (`kill $(pgrep …)`, `lsof -ti :3000 | xargs kill`). */
function killsByName(commands: Simple[]): boolean {
  let kills = false, looksUp = false
  for (const { words } of commands) {
    const program = programName(words[0])
    const all = lower(words)
    if (BY_NAME.has(program)) return true
    if (program === 'fuser' && all.slice(1).some((word) => /^-[a-z]*k/.test(word))) return true
    if (program === 'taskkill' && all.some((word) => word === '/im' || word === '-im')) return true
    if (KILLERS.has(program) && all.some((word) => word === '-name' || word === '-processname')) return true
    if (program === 'wmic' && all.includes('process') && all.some((word) => word === 'delete' || word === 'terminate')) return true
    if (KILLERS.has(program)) kills = true
    // `ps -p 4242` checks a recorded id; `ps aux` lists everything for a pattern to pick from.
    if (LOOKUPS.has(program) || (program === 'ps' && !all.some((word) => /^-[a-z]*[pq]$/.test(word) || word === '--pid'))) {
      if (!(program === 'get-process' || program === 'gps') || !all.includes('-id')) looksUp = true
    }
  }
  return kills && looksUp
}

const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']
/** A path in /tmp inside a word: at its start, or after `=`, `:` or `,` (`--output=/tmp/x`, `PATH=a:/tmp/b`). */
const TMP_PATH = /(?:^|[=:,])((?:\/private)?(?:\/var)?\/tmp\/[^\s"'`;|&<>()]+)/g

/** A word or redirection writing, reading or running a fixed name in /tmp; `mktemp`'s own words are its templates. */
function fixedTmp({ words, targets }: Simple, facts: GuardFacts): boolean {
  const program = programName(words[0])
  if (targets.some((target) => fileRefusal(target, facts) !== null)) return true
  if (program === 'mktemp') return false
  // `cd /tmp` and then a plain name writes a fixed name there.
  if ((program === 'cd' || program === 'pushd') && words[1] && TMP_ROOTS.includes(words[1].replace(/\/+$/, ''))) return true
  return words.some((word) => tmpPathRefused(word, facts))
}

/** Whether [word] names a path in /tmp whose top folder is not one only this account can open. */
function tmpPathRefused(word: string, facts: GuardFacts): boolean {
  for (const match of word.matchAll(TMP_PATH)) {
    // Check the destination, not an earlier private component that `..` leaves behind.
    const path = posix.normalize(match[1])
    const root = TMP_ROOTS.find(root => path.startsWith(`${root}/`))
    if (root && !facts.privateFolder(`${root}/${path.slice(root.length + 1).split('/')[0]}`)) return true
  }
  return false
}

/** `git worktree remove P` or `rm -r P` of a linked worktree some live process still works in. */
function liveWorktree(commands: Simple[], facts: GuardFacts): string | null {
  let cwd = facts.cwd
  for (const { words } of commands) {
    const program = programName(words[0])
    if (program === 'cd' && words[1] && !words[1].startsWith('-') && !words[1].includes('$') && !words[1].startsWith('~')) {
      cwd = resolveIn(cwd, words[1], facts.platform)
      continue
    }
    for (const target of removedFolders(words, cwd, facts.platform)) {
      const real = facts.realpath?.(target) ?? target
      if (!facts.linkedWorktree(real) && !facts.linkedWorktree(target)) continue
      const live = facts.liveCwds()
      if (live === null) return GUARD_REASONS.worktreeUnknown(target)
      const user = live.find(({ cwd: there }) => within(there, real) || within(there, target))
      if (user) return GUARD_REASONS.liveWorktree(target, user.pid)
    }
  }
  return null
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
const resolveIn = (cwd: string, path: string, platform: NodeJS.Platform) =>
  (platform === 'win32' ? resolve(cwd, path) : posix.resolve(cwd, path)).replace(/(.)\/+$/, '$1')

/** The folders [words] remove: `git [-C dir] worktree remove [-f] P`, or each target of a recursive `rm`. */
function removedFolders(words: string[], cwd: string, platform: NodeJS.Platform): string[] {
  const program = programName(words[0])
  if (program === 'git') {
    let at = 1, here = cwd
    while (at < words.length && words[at].startsWith('-')) {
      if (words[at] === '-C' && words[at + 1]) { here = resolveIn(here, words[at + 1], platform); at += 2; continue }
      at += words[at] === '-c' ? 2 : 1
    }
    if (words[at] !== 'worktree' || words[at + 1] !== 'remove') return []
    const path = words.slice(at + 2).find((word) => !word.startsWith('-'))
    return path ? [resolveIn(here, path, platform)] : []
  }
  if (program === 'rm') {
    const args = words.slice(1)
    const end = args.indexOf('--')
    const options = end === -1 ? args.filter((word) => word.startsWith('-')) : args.slice(0, end).filter((word) => word.startsWith('-'))
    if (!options.some((word) => word === '--recursive' || /^-[a-zA-Z]*[rR]/.test(word))) return []
    const paths = end === -1 ? args.filter((word) => !word.startsWith('-')) : [...args.slice(0, end).filter((word) => !word.startsWith('-')), ...args.slice(end + 1)]
    return paths.map((path) => resolveIn(cwd, path, platform))
  }
  return []
}

// ---------------------------------------------------------------------------------------------------------------------
// The machine's facts

/** Whether [path] is a folder (not a link) this account owns and only it can open: what `mktemp -d` makes. */
export function privateFolderOf(path: string): boolean {
  try {
    const stat = lstatSync(path)
    const uid = process.getuid?.()
    return stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0
  } catch { return false }
}

/** Whether [path] is a linked git worktree: a folder whose `.git` is a file naming the main repository's. */
export function linkedWorktreeOf(path: string): boolean {
  try { return lstatSync(path).isDirectory() && lstatSync(`${path}/.git`).isFile() } catch { return false }
}

/**
 * Every live process's working folder. Linux reads /proc; a Mac asks lsof for working folders only (`-d cwd`), which
 * lists this account's processes. Windows refuses by itself to remove a folder a process works in, so nothing is read
 * there. Null when they cannot be read: the guard then refuses the removal rather than guess.
 */
export function liveCwdsOf(platform: NodeJS.Platform = process.platform): { pid: number; cwd: string }[] | null {
  if (platform === 'win32') return []
  if (platform === 'linux') {
    try {
      return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
        try { return [{ pid: Number(pid), cwd: readlinkSync(`/proc/${pid}/cwd`) }] } catch { return [] }
      })
    } catch { return null }
  }
  const run = spawnSync('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-w'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (run.error || !run.stdout) return null
  const found: { pid: number; cwd: string }[] = []
  let pid = 0
  for (const line of run.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) found.push({ pid, cwd: line.slice(1) })
  }
  return found
}

/** The guard's facts for a command run in [cwd] on this machine. */
export function machineFacts(cwd: string): GuardFacts {
  let live: ReturnType<typeof liveCwdsOf> | undefined
  return {
    cwd: isAbsolute(cwd) ? cwd : resolve(cwd),
    platform: process.platform,
    privateFolder: privateFolderOf,
    linkedWorktree: linkedWorktreeOf,
    liveCwds: () => (live === undefined ? (live = liveCwdsOf()) : live),
    realpath: (path) => { try { return realpathSync(path) } catch { return path } },
  }
}
