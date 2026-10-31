import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { isTeamAccount } from '../team/config.js'
import { buddyAccountFile } from './buddyAccount.js'
import { durableEngineHomes } from './engineHomes.js'
import type { AgentEngine } from '../engines/types.js'
import { env } from '../config/env.js'
import { PASTE_DROPS_DIR } from './pasteDropFiles.js'

/** Where a Buddy's guard reads what its person sent it (the host's list for this Buddy), and where Harness downloads chat
 *  files to (lib/pasteDropFiles.ts). */
export interface BuddyReads { file: string; drops: string }
/** Wide mode's settings for a Buddy's guard (docs/specs/2026-10-30-buddy-read-access.md): its person's home, the places
 *  outside its folder that stay closed, and its person's approvals on this machine. */
export interface BuddyWide { home: string; denied: readonly string[];
  /** Outside the folder, all that may be read: the home and named system folders, the closed places within them aside. */
  readable: readonly string[]; approvalsDir: string; repos: readonly string[]; hosts: readonly string[];
  /** Where Claude Code keeps sessions' tool output: closed to the Buddy's reads, open to its sandbox, which writes its output there. */
  sessionTemp: readonly string[]
  /** This launch, at random: a grant from before a relaunch is none (delta reviews of #2310). */
  launch: string
  /** Where the host keeps the account signed in on this machine (`writeBuddyAccount`): a grant holds only for it. */
  accountFile: string
  /** Where every Swarm session's folder on this machine is (Harness's worktrees folder): closed to this one's reads but its
   *  own folder, so a Buddy's thread session never reads another session's folder or the files sent to it (spec
   *  2026-10-30-buddy-thread-sessions). The guard's alone: closing it in the sandbox would close the session's own folder. */
  otherSessions?: readonly string[] }

/** Where each engine Harness runs keeps its sessions, history and sign-in in a home: closed to a Buddy, as other agents on
 *  this machine keep Swarm chats there (delta reviews of #2310). Typed by the engine list, so a new engine names its own. */
export const BUDDY_ENGINE_HOMES: Record<Exclude<AgentEngine, 'terminal'>, readonly string[]> = {
  claude: ['.claude', '.claude.json', '.local/share/claude', 'Library/Application Support/Claude'],
  codex: ['.codex'],
  cursor: ['.cursor', '.config/cursor', 'Library/Application Support/Cursor'],
  opencode: ['.config/opencode', '.local/share/opencode', '.local/state/opencode'],
  pi: ['.pi'],
  omp: ['.omp', '.config/omp'],
  hermes: ['.hermes'],
  commandcode: ['.commandcode'],
  devin: ['.devin', '.config/devin'],
  muse: ['.muse', '.config/muse'],
  amp: ['.amp', '.config/amp', '.local/share/amp'],
  kilo: ['.kilocode', '.config/kilo', '.local/share/kilo'],
  grok: ['.grok'],
  agy: ['.gemini', '.antigravity', 'Library/Application Support/Antigravity'],
  copilot: ['.copilot', '.config/github-copilot'],
}

/** Places in a home that hold secrets or other people's data (the Lead's list, 10-30): ssh, cloud, GitHub, ArgoCD and
 *  Harness credentials; keychains; browser profiles and mail; shell and database histories, which keep typed secrets; and
 *  the Claude Code and Codex folders, where agents on this machine keep transcripts and pasted Swarm messages from chats
 *  the Buddy may not read (private chats, other projects, the Leads conversation from before its removal). */
const CLOSED_IN_HOME = ['.ssh', '.aws', '.azure', '.config/gcloud', '.gnupg', '.kube', '.docker', '.config/gh', '.config/hub', '.config/anthropic', '.config/argocd',
  '.argocd', '.secrets', '.config/git/credentials', '.password-store', '.config/op', '.zsh_sessions', '.bash_sessions', '.local/share/fish',
  'Library/Caches/claude-cli-nodejs', ...Object.values(BUDDY_ENGINE_HOMES).flat(),
  '.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge', '.zsh_history',
  '.bash_history', '.zhistory', '.python_history', '.node_repl_history', '.mongodb', '.dbshell', '.psql_history', '.mysql_history',
  '.lesshst', '.viminfo', 'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Messages', 'Library/Mail',
  'Library/Containers/com.apple.mail', 'Library/Group Containers', 'Library/Application Support/Google',
  'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Arc',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/com.operasoftware.Opera',
  'Library/Application Support/Claude']

/** System folders a Buddy may read outside its folder: configuration, shared data and logs. */
const SYSTEM_READABLE = process.platform === 'darwin'
  ? ['/etc', '/usr/share', '/usr/local/etc', '/opt/homebrew/etc', '/Library/Logs', '/var/log']
  : ['/etc', '/usr/share', '/var/log']


/** Wide mode for one person's Buddy: [home] is theirs, [dataDir] Harness's data folder (its lists, approvals, downloads and
 *  agent records stay closed), [tmpDirs] where Claude Code keeps other sessions' tool output, and [repos] the project's repositories (owner/name), the only ones gh api reads. */
export function buddyWideOf(input: { home: string; dataDir: string; tmpDirs: readonly string[]; repos: readonly string[]; hosts?: readonly string[];
  system?: readonly string[]; launch?: string; closed?: readonly string[]; otherSessions?: readonly string[] }): BuddyWide {
  return { home: input.home, launch: input.launch ?? randomUUID(), accountFile: buddyAccountFile(input.dataDir), readable: [input.home, ...(input.system ?? SYSTEM_READABLE)], repos: input.repos, hosts: input.hosts ?? [], sessionTemp: input.tmpDirs, denied: [...CLOSED_IN_HOME.map(path => join(input.home, path)), input.dataDir, ...input.tmpDirs, ...(input.closed ?? [])],
    approvalsDir: join(input.dataDir, 'buddy-approvals'), ...(input.otherSessions?.length ? { otherSessions: input.otherSessions } : {}) }
}

/** What a Buddy's launch reads of its machine to decide wide mode (`buddyLaunchWide`). */
export interface BuddyLaunchFacts { platform: NodeJS.Platform; team: boolean; home: string; dataDir: string; uid: number; hasBwrap: boolean
  /** Engine homes Harness points agents at beside the default ones; null when they cannot be read. */
  engineHomes: readonly string[] | null }
const launchFacts = (): BuddyLaunchFacts => ({ platform: process.platform, team: isTeamAccount(), home: homedir(), dataDir: env.ADAPTER_DATA_DIR,
  uid: process.getuid?.() ?? -1, hasBwrap: spawnSync('/bin/sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0,
  engineHomes: engineHomesOutsideDefaults(env.ADAPTER_DATA_DIR, process.env) })

/** The settings that point an engine at a home of its own (vitest.setup.ts lists the same), which Harness passes on. */
const ENGINE_HOME_SETTINGS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'GROK_HOME', 'COPILOT_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR',
  'CURSOR_DATA_DIR', 'HERMES_HOME', 'PI_HOME', 'PI_CODING_AGENT_DIR', 'COMMANDCODE_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR']

/**
 * The engine homes Harness itself points agents at outside the defaults (final review of #2310: a probe read ~/.codex-work):
 * the Codex profiles linked here (codex-profiles.json, lib/codexProfiles.ts), the Claude Code and Codex homes Harness
 * adopted (lib/engineHomes.ts, for this machine's own data folder), and those this process was started with. Null when any
 * of them cannot be read: the launch then keeps the Buddy to its folder rather than guess.
 */
export function engineHomesOutsideDefaults(dataDir: string, environment: NodeJS.ProcessEnv): string[] | null {
  const homes = ENGINE_HOME_SETTINGS.map(name => environment[name]).filter((home): home is string => !!home && isAbsolute(home))
  try {
    const linked = JSON.parse(readFileSync(join(dataDir, 'codex-profiles.json'), 'utf8')) as unknown
    if (!Array.isArray(linked)) return null
    homes.push(...linked.filter((home): home is string => typeof home === 'string' && isAbsolute(home)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  if (dataDir === env.ADAPTER_DATA_DIR) {
    try {
      const adopted = durableEngineHomes()
      homes.push(...adopted.claude, ...adopted.codex)
    } catch { return null }
  }
  return [...new Set(homes)]
}

/** The GitHub repositories [root]'s remotes name, as owner/name: the only ones its gh api reads. */
function githubRepos(root: string): string[] {
  const remotes = spawnSync('git', ['-C', root, 'remote', '-v'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? ''
  const repos = [...remotes.matchAll(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\s/g)].map(match => `${match[1]}/${match[2]}`)
  return [...new Set(repos)].sort()
}

/** The hosts the person's ArgoCD and cluster settings name, and nothing else of those files, which hold their tokens. */
function configHosts(home: string): string[] {
  const hosts: string[] = []
  for (const file of [join(home, '.config', 'argocd', 'config'), join(home, '.argocd', 'config'), join(home, '.kube', 'config')]) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const [, server] of text.matchAll(/^[ \t-]*server:[ \t]*["']?([^\s"']+)/gm)) {
      const host = server!.replace(/^[a-z]+:\/\//i, '').split(/[/:]/)[0]!
      if (/^[A-Za-z0-9.-]+$/.test(host)) hosts.push(host)
    }
  }
  return [...new Set(hosts)]
}

/**
 * Wide mode for a Buddy launched in [root], or null for its folder alone (docs/specs/2026-10-30-buddy-read-access.md,
 * section 1). The Swarm starts a Buddy only on its person's own machine (backend BUDDY_OWN_MACHINE_REFUSAL); here it also
 * needs their own account, never a Harness Team account, and Claude Code's sandbox to run its shell in: macOS, or Linux
 * with bubblewrap. Windows has none.
 */
export function buddyLaunchWide(root: string, facts: BuddyLaunchFacts = launchFacts()): BuddyWide | null {
  if (facts.team || !(facts.platform === 'darwin' || (facts.platform === 'linux' && facts.hasBwrap)) || !facts.engineHomes) return null
  // Where Claude Code keeps every session's tool output on this machine.
  const tmpDirs = [...new Set([`/tmp/claude-${facts.uid}`, `/private/tmp/claude-${facts.uid}`, join(tmpdir(), `claude-${facts.uid}`)])]
  return buddyWideOf({ home: facts.home, dataDir: facts.dataDir, tmpDirs, repos: githubRepos(root), hosts: configHosts(facts.home), closed: facts.engineHomes,
    otherSessions: sessionsFolderOf(root, facts.home) })
}

/** Harness's worktrees folder, where every Swarm session's folder is (lib/gitProject.ts), when [root] is one of them: a
 *  Buddy or thread session in a worktree of its own. None for a folder elsewhere, which nothing here would close. */
function sessionsFolderOf(root: string, home: string): string[] {
  const real = (path: string) => { try { return realpathSync(path) } catch { return null } }
  // lib/projectFolder.ts projectsRoot, which this module does not import: it brings git and every source host with it.
  const worktrees = join(home, process.env.HARNESS_OS === '1' ? 'projects' : 'harnesses', 'worktrees'), at = real(root), folder = real(worktrees)
  if (!at || !folder) return []
  const inside = relative(folder, at)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? [worktrees] : []
}


/** Where GitHub sends a run's logs, which gh run view --log fetches: its Actions hosts and its own result storage accounts
 *  (GitHub's list of the hosts its runners reach), never every Azure storage account (review of #2310). */
const GITHUB_LOG_HOSTS = ['*.actions.githubusercontent.com', ...Array.from({ length: 20 }, (_, n) => `productionresultssa${n}.blob.core.windows.net`)]
/** [root]'s person's clone and its git folder, when [root] is a worktree of it (or the clone itself): none when unknown. */
function cloneOf(root: string): string[] {
  const common = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000 })
  if (common.status !== 0 || !common.stdout.trim()) return []
  const git = common.stdout.trim()
  return [git, dirname(git)]
}

/** The tools' own sign-ins, which they read to sign in: closed to the Buddy's own reads, open to the tools in the sandbox. */
const TOOL_SIGN_INS = ['.config/gh', '.config/argocd', '.argocd', '.kube']

/**
 * Claude Code's sandbox for a wide Buddy's shell (tried with Claude Code 2.1.314): every command in it but Harness's own,
 * which needs its daemon and terminal. Nothing may be written, its folder included (Claude Code otherwise lets a command
 * write where it runs), and nothing reached but GitHub and the person's ArgoCD and cluster hosts: not even this machine's
 * own ports, as Harness's own commands, which reach its daemon, run outside it. A command may never ask to leave it. The
 * guard still judges every command first.
 *
 * gh, argocd and kubectl are Go tools: in the sandbox they verify TLS only through macOS's certificate service, which
 * enableWeakerNetworkIsolation opens (without it every TLS check fails; with it an expired, self-signed or untrusted
 * certificate is still refused). That service makes its own requests outside the host list, a small path out, for every
 * command of the session. Ken chose it over running those tools outside the sandbox (10-30), so the sandbox's no-writes
 * and host list hold for them too.
 */
export function buddySandboxSettings(root: string, wide: BuddyWide): Record<string, unknown> {
  // Open to the sandbox: the tools' own sign-ins, and Claude Code's temporary folder, where every command's output goes
  // (with it closed, even cat failed: "cat: stdout: Operation not permitted", Claude Code 2.1.314). The guard keeps both
  // closed to the Buddy's own reads.
  const signIns = new Set([...TOOL_SIGN_INS.map(path => join(wide.home, path)), ...wide.sessionTemp])
  return {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, enableWeakerNetworkIsolation: true,
    excludedCommands: ['harness super-tab *', 'harness buddy-read *'],
    network: { allowedDomains: ['api.github.com', 'github.com', ...GITHUB_LOG_HOSTS, ...wide.hosts] },
    // Writes are denied by name where Claude Code would allow them: the folder it runs in; its person's clone and its git
    // folder, which a command in a worktree could otherwise commit to; and every session's folder in Claude Code's own
    // temporary folder (both found by the real sandbox test, review of #2310). That folder itself stays writable: Claude
    // Code writes a file there for each command from inside the sandbox ("/bin/bash: /tmp/claude-501/cwd-…: Operation not
    // permitted" without it).
    filesystem: { allowWrite: [], denyWrite: [...new Set([root, ...cloneOf(root), ...wide.sessionTemp.map(path => `${path}/-*`)])],
      denyRead: wide.denied.filter(path => !signIns.has(path)) },
  }
}

/** One person's approvals on this machine, by their id and membership: a new membership starts with none. */
export function buddyApprovalsOf(personKey: string, dataDir: string = env.ADAPTER_DATA_DIR): string {
  return join(dataDir, 'buddy-approvals', `${createHash('sha256').update(personKey).digest('hex')}.json`)
}

/** A listed file or link lasts as long as Harness keeps a download (lib/pasteDropFiles.ts): a day. */
const KEPT_MS = 24 * 60 * 60 * 1000

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
 * It confines the Buddy's own reads to its folder (security review 2 of #2092): the machine is its person's, the folder is
 * the project. That is the whole claim. Files another local process places in the folder, by link, hard link or copy, are
 * outside it: the guard judges a path when it answers and Claude Code opens it afterwards, so a link swapped in between,
 * or a hard link (whose real path is its name in the folder), reads what that process put there (review 4 of #2092, the
 * Lead's ruling). The Buddy itself has no command that writes, so it can place none of them.
 * Read, Grep, Glob and LS take paths there only, by real path, so a link out is out. Each part of a Bash word that could
 * be a path (itself, after "=" or ":", and after each letter of a short option, as -S/x or -fout/x glue a value on) is
 * refused when it is absolute, has a ".." part, or by its real path as the command runs leaves the folder: a link a pull
 * brings after launch included, and nothing in the folder is removed for it (review 3 of #2092, Lead). So are the read
 * commands' ways to follow links as they walk (grep -R/-S/-O, rg -L, ls -L), gh's -R/--repo (any repository its person
 * can read) and git's --no-index. grep's and rg's long options are allowlists, by whole name: both are bundled with Claude
 * Code, and a newer build must not add one that follows links or runs a program unnoticed.
 * Its Super Tab commands are a Buddy's own (status, messages, message, decisions, post, propose, help) as the pane it runs
 * in identifies it: never --agent, --port or --machine. Nothing runs on: no background shell, no tail -f.
 *
 * Outside its folder it reads only what its person sent it in their Buddy chat (Tony, 10-30: his Buddy could open neither
 * the screenshot he sent it nor an Artifact he linked). The host lists those for this Buddy alone (`allowBuddyReads`
 * below, superTabs/host.ts), out of the project, so no commit or pull can add to the list. Read opens a listed file by the
 * exact path the Buddy was handed, while it is still the one file Harness downloaded there and still holds the bytes it
 * held when listed (its SHA-256); the Artifact tool reads a listed link with its read action alone. The guard judges the
 * file when it answers and Claude Code opens it afterwards, as for its folder: bytes written into it in between are read.
 *
 * Plain JavaScript with node's own modules only, written into the Buddy's folder with that folder's real path and run by
 * Harness's node: the tests run this exact text (lib/buddyGuard.spec.ts, and Claude Code itself in
 * lib/buddyGuard.claude.spec.ts).
 */
export const buddyGuardSource = (root: string, reads: BuddyReads, wide: BuddyWide | null = null): string => String.raw`#!/usr/bin/env node
// A Buddy's guard, written by Harness (cli/src/lib/buddyGuard.ts). Do not edit: Harness writes it again at each launch.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The Buddy's folder, as its real path: what it reads stays in it.
const ROOT = ${JSON.stringify(root)}
// What its person sent it in their Buddy chat, as the host lists it, and the folder Harness downloads chat files to.
const READS = ${JSON.stringify(reads.file)}
const DROPS = ${JSON.stringify(reads.drops)}
const KEPT_MS = ${KEPT_MS}
// Wide mode (docs/specs/2026-10-30-buddy-read-access.md): null keeps every read in the folder. Set only for a Buddy on its
// person's own machine, under their own account; it names their home and the places in it that stay closed.
const WIDE = ${JSON.stringify(wide)}
const TOOLS = new Set(['TodoWrite', 'ToolSearch'])
const READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'pwd'])
const WIDE_READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'rg'])
const GIT = new Set(['grep', 'log', 'show', 'diff', 'blame', 'status'])
const GH = { issue: new Set(['view', 'list']), pr: new Set(['view', 'list', 'diff']) }
const GIT_LONG = ['output', 'open-files-in-pager', 'ext-diff']
// rg's long options likewise, so a newer bundled rg cannot add one that follows links or runs a program unnoticed
// (security re-check of #2092): only these, each by its whole name. --pre, --pre-glob, --search-zip, --hostname-bin and
// --follow are not among them.
const RG_LONG = new Set(['line-number', 'no-line-number', 'ignore-case', 'smart-case', 'case-sensitive', 'fixed-strings',
  'word-regexp', 'line-regexp', 'regexp', 'count', 'count-matches', 'files-with-matches', 'files-without-match', 'glob',
  'iglob', 'type', 'type-not', 'context', 'after-context', 'before-context', 'max-count', 'max-depth', 'invert-match',
  'only-matching', 'no-filename', 'with-filename', 'heading', 'no-heading', 'hidden', 'no-ignore', 'column', 'vimgrep',
  'json', 'color', 'trim', 'multiline', 'sort'])
// A Buddy's grep is Claude Code's shell function around its built-in ugrep (2.1.312), whose long options go much further
// than grep's: --dereference-files follows links while it walks, and others filter through commands, read configs, page
// or index (security re-check of #2092). Only these, each by its whole name, with or without =VALUE.
const GREP_LONG = new Set(['include', 'exclude', 'exclude-dir', 'include-dir', 'line-number', 'ignore-case', 'smart-case',
  'recursive', 'count', 'files-with-matches', 'files-without-match', 'word-regexp', 'line-regexp', 'fixed-strings',
  'extended-regexp', 'basic-regexp', 'perl-regexp', 'context', 'after-context', 'before-context', 'max-count',
  'invert-match', 'only-matching', 'no-filename', 'with-filename', 'color', 'colour', 'regexp', 'text', 'no-messages',
  'quiet', 'silent'])
// A Buddy's own Super Tab commands: reading its chats and posting in its own, and its owner's proposal. The pane it runs in
// says who it is (superTabs/command.ts), so it never names an agent, a port or a machine.
const SUPER_TAB = new Set(['status', 'messages', 'message', 'decisions', 'post', 'propose', 'help'])
const MAY = 'A Buddy only reads, so this was refused and nobody will be asked. Read the code with Read, Grep and Glob. ' +
  'In the shell, run one plain command at a time (no pipes, redirects, ;, &&, $() or globs): git grep, log, show, diff, ' +
  'blame or status; gh issue view or list; gh pr view, list or diff; ls, cat, rg, head, tail, wc or grep; or harness super-tab. ' +
  'A file your person sent you in your chat opens with Read, by the path you were given; an Artifact link they sent, with the ' +
  'Artifact tool\'s read and that link.'

// Why the call was refused, as the Buddy is told it.
let reason = MAY

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

// Whether [part], read as a path from the folder, leaves it: absolute (the machine's files, /dev), a ".." part, or, by its
// real path when the guard answers, a link out (one a pull brought after launch too), a broken link, or a path under one.
// What another process changes after that answer is outside the guard (see the top of this file).
// A word that names nothing there (a pattern, a revision) is judged by the folder it would be in.
function escapes(part) {
  if (!part) return false
  if (isAbsolute(part) || part.split('/').includes('..')) return true
  const full = resolve(ROOT, part)
  try { lstatSync(full) } catch { return !inside(part) }
  try {
    const real = realpathSync(full)
    return !(real === ROOT || real.startsWith(ROOT + sep))
  } catch { return true }
}

// A word that names a place out of the folder: itself, what follows "=" or ":" (--file=/x, HEAD:../x), and for a short
// option what follows each of its letters, since a value may be glued on (-S/x, -f../x, -fout/x). A range such as
// main..HEAD has no ".." part.
const outward = (word) => word.split(/[=:]/).some(escapes)
  || (/^-[^-]/.test(word) && [...word].some((_, at) => at >= 2 && escapes(word.slice(at))))

const short = (word) => /^-[^-]/.test(word)

// The real path of [path] as the guard can best tell now: of the file, or of its nearest folder that exists with the rest
// added. The native call, so a case-insensitive volume gives the name as stored (.SSH reads as .ssh). Null when unreadable.
function realOf(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return null
  let at = resolve(ROOT, path), rest = ''
  for (;;) {
    try { return join(realpathSync.native(at), rest) } catch { /* not there: its folder decides */ }
    if (dirname(at) === at) return null
    rest = rest ? join(basename(at), rest) : basename(at)
    at = dirname(at)
  }
}
// macOS volumes are case-insensitive by default: compare names as the volume does.
const fold = process.platform === 'darwin' || process.platform === 'win32' ? (path) => path.toLowerCase() : (path) => path
const under = (path, folder) => fold(path) === fold(folder) || fold(path).startsWith(fold(folder) + sep)
// Names that hold secrets wherever they are: .env files, keys and certificates, ssh keys, credential files, Harness's own
// folders and the person's prod database login (~/.harness-ro-prod-db, 10-28).
const SECRET_NAMES = [/^\.env/i, /\.env$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^credentials/i,
  // A secrets folder, as the read-only prod database login is kept in ~/.secrets/ (harness buddy-read db-size, 10-30).
  /^\.?secrets?(\.|$)/i, /^\.harness/i,
  // Every Claude Code and Codex home or file by its name, wherever it is: a settings backup (~/.claude.json.bak-…), a home
  // beside the default one (~/.codex-work, final review of #2310).
  /^\.claude/i, /^\.codex/i, /ro-?prod|prod-?db/i, /^\.?(netrc|npmrc|pypirc|pgpass|htpasswd|git-credentials)$/i]
const secretName = (path) => path.split(sep).some((part) => SECRET_NAMES.some((name) => name.test(part)))
const realRoots = (paths) => paths.map((path) => realOf(path) ?? path)
// Other sessions' folders (WIDE.otherSessions) are closed as these are; its own folder is read as its folder, before any of this.
const DENIED = WIDE ? realRoots([...WIDE.denied, ...(WIDE.otherSessions ?? [])]) : []
// What may be read outside the folder at all: the person's home and the system folders named for it. Everything else is
// closed, the process and device folders and every temporary folder among it (security reviews 1 and 2 of #2310: on Linux
// /proc/<pid>/environ held the read-only DB URL while db-size ran; on macOS /private/var/folders held other processes'
// files).
const READABLE = WIDE ? realRoots(WIDE.readable) : []
// Whether the host granted wide mode to this session: it checked, at its person's last message, that they are the account
// signed in on this machine (superTabs/host.ts, security reviews 1 and 2 of #2310). Without it, the folder alone.
// A grant is for this launch, the account signed in here now, and an hour at most (delta reviews of #2310): one from before
// a relaunch, under another account, after a sign-out, or older is none.
const GRANT_MS = 60 * 60 * 1000
function granted() {
  if (!WIDE) return false
  try {
    const list = JSON.parse(readFileSync(READS, 'utf8')), grant = list.wide
    if (!grant || typeof grant !== 'object' || grant.session !== list.session || grant.launch !== WIDE.launch) return false
    const account = JSON.parse(readFileSync(WIDE.accountFile, 'utf8')).accountId, age = Date.now() - grant.at
    return typeof account === 'string' && account.length > 0 && grant.account === account && Number.isFinite(grant.at) && age > -60_000 && age < GRANT_MS
  } catch { return false }
}
const NOT_GRANTED = 'Reading beyond your folder opens once your owner writes to you in your chat, on their own computer signed in as ' +
  'them. It was refused, and nobody will be asked. Tell your owner in one line.'
const NEVER = ['/proc', '/sys', '/dev']
const HOME = WIDE ? realOf(WIDE.home) : null
// Where people's homes are (/Users, /home): every one but the person's own stays closed. macOS's Shared folder is nobody's.
const HOMES = HOME ? dirname(HOME) : null
function otherHome(real) {
  if (!HOMES || !under(real, HOMES) || fold(real) === fold(HOMES) || under(real, HOME)) return false
  return fold(relative(HOMES, real).split(sep)[0]) !== 'shared'
}

// Whether [path], outside the folder, may be read in wide mode. 'any': Read (it may not exist yet); 'file': one regular
// file (content search: a folder could hold a .env or a key); 'dir': one folder's names (LS, ls); 'tree': a folder searched
// by name all the way down (Glob), so nothing closed may lie under it. The path as given and its real path are both
// judged: a link named innocently into ~/.ssh is refused, and so is one named .env.
function outsideAllowed(path, kind) {
  if (!WIDE || typeof path !== 'string' || !granted()) return false
  const real = realOf(path)
  if (!real || !HOME) return false
  if (!READABLE.some((root) => under(real, root)) || NEVER.some((root) => under(real, root))) return false
  if (secretName(real) || secretName(resolve(ROOT, path)) || otherHome(real) || DENIED.some((root) => under(real, root))) return false
  if (kind === 'tree' && (DENIED.some((root) => under(root, real)) || (HOMES && under(HOMES, real)))) return false
  if (kind === 'any') return true
  try {
    const stat = statSync(real)
    return kind === 'file' ? stat.isFile() : kind === 'dir' ? stat.isDirectory() : stat.isDirectory()
  } catch { return false }
}
// A long option naming one of these, or a unique prefix of one: git takes either.
const longNames = (word, names) => word.startsWith('--') && names.some((name) => {
  const given = word.slice(2).split('=')[0]
  return given.length > 0 && name.startsWith(given)
})

// The list's [kind] entries from the last day, as long as Harness keeps a download; none when it cannot be read.
function listed(kind) {
  try {
    const entries = JSON.parse(readFileSync(READS, 'utf8'))[kind], now = Date.now()
    return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object' && Number.isFinite(entry.at)
      && now - entry.at < KEPT_MS) : []
  } catch { return [] }
}

// Whether [stat] is the one file the list names: a regular file with no other name, of the same device, inode and size.
const same = (stat, file) => stat.isFile() && stat.nlink === 1n && String(stat.dev) === file.dev && String(stat.ino) === file.ino
  && String(stat.size) === file.size

// Whether [path] is a file its person sent: listed by that exact path, in the downloads folder, still the one file Harness
// downloaded there (its device, inode and size), with no other name, and still holding the bytes it held when the host
// listed it. A link, a hard link (a second name for it) or another file put in its place would read something its person
// did not send; so would other bytes written into it, which keep its inode and can keep its size (security reviews 1 and
// 2 of #2248: 'OWNER' written over with 'OTHER' was read).
function attached(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || dirname(path) !== DROPS) return false
  const file = listed('files').find((entry) => entry.path === path)
  if (!file || typeof file.sha256 !== 'string') return false
  let fd
  try {
    if (!same(lstatSync(path, { bigint: true }), file) || realpathSync(path) !== join(realpathSync(DROPS), basename(path))) return false
    // Its bytes, read from the file just checked: opened without following a link, and checked again as opened.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd, { bigint: true })
    if (!same(opened, file)) return false
    // No more than its listed size: a file still being written to is not read on and on.
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    let total = 0n
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      total += BigInt(read)
      if (total > opened.size) return false
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest('hex') === file.sha256
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}

// A claude.ai Artifact link as the host lists it (artifactLink in lib/buddyGuard.ts), or null: https, claude.ai or
// preview.claude.ai, an artifact's own path, and nothing more (no port, user, query or fragment).
function artifactLink(text) {
  if (typeof text !== 'string') return null
  let url
  try { url = new URL(text) } catch { return null }
  const path = /^\/((?:code\/)?artifact\/[A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname)
  if (!path || url.protocol !== 'https:' || !['claude.ai', 'preview.claude.ai'].includes(url.hostname) || url.port || url.username
    || url.password || url.search || url.hash) return null
  return 'https://' + url.hostname + '/' + path[1]
}

// Claude Code's Artifact tool reads a claude.ai link as its person's own Claude sign-in: its read action alone, of a link
// its person sent, with no file of it saved to a folder of the Buddy's choosing and nothing published, listed or removed.
const ARTIFACT_READ = new Set(['action', 'url', 'prompt', 'page'])
function artifactAllowed(tool) {
  if (tool.action !== 'read' || !Object.keys(tool).every((key) => ARTIFACT_READ.has(key))) return false
  if ((tool.prompt !== undefined && typeof tool.prompt !== 'string') || (tool.page !== undefined && typeof tool.page !== 'boolean')) return false
  // The prompt goes to claude.ai with the read: no secret in it (security reviews 1 and 2 of #2310).
  const kind = tool.prompt === undefined ? null : leakIn([tool.prompt])
  if (kind) { reason = SECRET(kind); return false }
  const link = artifactLink(tool.url)
  return link !== null && listed('links').some((entry) => entry.url === link)
}

// Secrets by their shape (docs/specs/2026-10-30-buddy-read-access.md, section 4), each named by its kind: what a Buddy
// reads must never reach a chat, its owner's own included, as Harness stores chats and shows them on other devices.
const SECRETS = [
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an API key', /\bsk-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{36}/],
  ['an AWS key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a URL with a password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:[^\s\/@]+@/i],
  ['a password or token', /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;]{20,}/i],
]
const secretIn = (text) => SECRETS.find(([, shape]) => shape.test(text))?.[0] ?? null
// The distinctive shapes alone, without word edges, for text run together: a token broken by spaces or newlines, or split
// across fields or files (security reviews 1 and 2 of #2310). The generic ones would find secrets in ordinary prose once
// its spaces are gone ("risk-assessment" holds "sk-assessment…").
const RUN_TOGETHER = SECRETS.filter(([kind]) => kind !== 'an API key' && kind !== 'a password or token')
  .map(([kind, shape]) => [kind, new RegExp(shape.source.replace(/\\b/g, ''), shape.flags)])
// The kind of secret in [fields], each as written, without its spaces, and all of them run together; null when none.
function leakIn(fields) {
  const texts = fields.filter((field) => typeof field === 'string')
  const kind = texts.map(secretIn).find(Boolean)
  if (kind) return kind
  // Spaces, and zero-width and other format characters (delta reviews of #2310), hide a token alike.
  const together = [...texts, texts.join('')].map((text) => text.replace(/[\s\p{Cf}]+/gu, ''))
  return RUN_TOGETHER.find(([, shape]) => together.some((text) => shape.test(text)))?.[0] ?? null
}
// Every string in a JSON value, as the CLI decodes it before sending: an escape such as g hides nothing.
function decoded(text) {
  let value
  try { value = JSON.parse(text) } catch { return [] }
  const out = []
  const walk = (node) => { if (typeof node === 'string') out.push(node); else if (node && typeof node === 'object') Object.values(node).forEach(walk) }
  walk(value)
  return out
}
const SECRET = (kind) => 'This holds what looks like ' + kind + ', so nothing was sent, and nobody will be asked. Take it out and ' +
  'send again: never pass on secrets, tokens, keys or connection strings.'
// A file to attach, in the folder (outward refused any other), read whole as text to be checked for secrets. A Buddy's files
// stay at 10 MB, the form upload's size: a chat file may be 256 MB now, but one past 10 MB would go out with only its
// start checked, so it is refused. One that is not there holds nothing, as sending it fails anyway; one there that cannot
// be read is refused.
const ATTACH_MAX_BYTES = 10 * 1024 * 1024
const TOO_LARGE = 'A Buddy attaches files of up to 10 MB, so nothing was sent, and nobody will be asked. Attach a smaller file.'
function fileText(path) {
  let fd
  try {
    fd = openSync(resolve(ROOT, path), constants.O_RDONLY)
    const buffer = Buffer.alloc(ATTACH_MAX_BYTES + 1), read = readSync(fd, buffer, 0, buffer.length, 0)
    if (read > ATTACH_MAX_BYTES) { reason = TOO_LARGE; return null }
    return buffer.subarray(0, read).toString('utf8')
  } catch (error) { return error?.code === 'ENOENT' ? '' : null } finally { if (fd !== undefined) closeSync(fd) }
}
// In wide mode a proposal carries a summary, never what a command printed: no code block and at most 10 lines.
function pastedOutput(json) {
  let proposal
  try { proposal = JSON.parse(json) } catch { return false }
  const text = [proposal?.goal, proposal?.scope].filter((part) => typeof part === 'string').join('\n')
  return text.includes('\x60\x60\x60') || text.split('\n').length > 10
}
const STDIN = (action) => (action === 'post' ? 'A Buddy passes its message as TEXT itself' : 'A Buddy passes its proposal\'s JSON itself') +
  ': - in its place reads it from stdin, where Harness cannot check it for secrets. Nothing was sent, and nobody will be asked. ' +
  'Send again with it in quotes where the - was: ' + (action === 'post' ? 'harness super-tab post GROUP \'your message\' OPERATION_ID'
    + ', or in double quotes when it holds an apostrophe: "it\'s done"' : 'harness super-tab propose OPERATION_ID \'{"conversationId":"...","goal":"..."}\'') + '.'
const SUMMARIZE ='A proposal carries your summary of what you read, never its output: no code block and at most 10 lines. Nothing ' +
  'was sent, and nobody will be asked. Summarize the numbers and findings in a few lines and send again.'

// harness super-tab [--tab ID] ACTION ...: only a Buddy's actions, an --attach only from its folder, and nothing it sends
// carrying a secret.
function superTabAllowed(rest) {
  let i = 0
  while (rest[i] === '--tab') i += 2
  if (i > rest.length || !SUPER_TAB.has(rest[i])) return false
  const after = rest.slice(i + 1)
  if (after.some((word, at) => (word === '--attach' && (after[at + 1] === undefined || outward(after[at + 1])))
    || ['--agent', '--port', '--machine'].includes(word))) return false
  if (rest[i] !== 'post' && rest[i] !== 'propose') return true
  // A post's TEXT or a proposal's JSON that is exactly - is read from stdin (superTabs/command.ts, post since #2355), where
  // this guard sees only the dash and cannot check what is sent for secrets. A Buddy cannot feed stdin today (no pipes,
  // redirects or heredocs above), but the secret check must not rest on that. Any other text, -- or "- P1" among them, is
  // the message itself and is checked as it is.
  if (after[1] === '-') { reason = STDIN(rest[i]); return false }
  const attached = after.flatMap((word, at) => after[at - 1] === '--attach' ? [fileText(word)] : [])
  if (attached.includes(null)) return false
  // Its words one by one, and what it says run together: the post's text or the proposal's decoded fields, with its files.
  const content = rest[i] === 'post' ? [after[1]] : after[1] !== undefined ? decoded(after[1]) : []
  const kind = after.map(secretIn).find(Boolean) ?? leakIn([...content, ...attached])
  if (kind) { reason = SECRET(kind); return false }
  if (WIDE && rest[i] === 'propose' && after[1] !== undefined && pastedOutput(after[1])) { reason = SUMMARIZE; return false }
  return true
}

function bashAllowed(command) {
  if (typeof command !== 'string') return false
  const w = words(command)
  if (!w || w.length === 0) return false
  const [name, sub, verb] = w
  const rest = w.slice(1)
  if (name === 'harness') return sub === 'super-tab' && superTabAllowed(w.slice(2))
  const out = rest.filter(outward)
  if (out.length) {
    // In wide mode the plain readers take a path outside the folder as a word of its own: a file (a folder for ls, and not
    // ls -R), never an option with a path glued on. Content search takes files only, as Grep does.
    if (!WIDE || !WIDE_READERS.has(name) || out.some((word) => word.startsWith('-') || !outsideAllowed(word, name === 'ls' ? 'dir' : 'file'))) return false
    if (name === 'ls' && rest.some((word) => longNames(word, ['recursive']) || (short(word) && word.includes('R')))) return false
  }
  // Nothing that runs on: a background shell, or tail following a file.
  if (name === 'tail') return !rest.some((word) => longNames(word, ['follow']) || (short(word) && /[fF]/.test(word)))
  // Nor following links while walking the folder: grep -R/-S/-O, rg -L, ls -L; nor ugrep's query screen (-Q).
  if (name === 'grep') {
    return !rest.some((word) => (word.startsWith('--') && word !== '--' && !GREP_LONG.has(word.slice(2).split('=')[0]))
      || (short(word) && /[RSOQ]/.test(word)))
  }
  if (name === 'ls') return !rest.some((word) => longNames(word, ['dereference']) || (short(word) && word.includes('L')))
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
    return !rest.some((word) => (word.startsWith('--') && word !== '--' && !RG_LONG.has(word.slice(2).split('=')[0]))
      || (short(word) && /[zL]/.test(word)))
  }
  return false
}

// Wide mode's commands (docs/specs/2026-10-30-buddy-read-access.md): reads of CI, ArgoCD, the cluster and Harness's own
// read-only recipes, each by an allowlist of subcommands and options, every option by its exact word (no prefixes, no
// short options run together). A command outside these never runs, approved or not; one inside them runs once its person
// has approved its exact words.

// [args] read by [spec]: its options, each a flag or one taking a value (as the next word, or after = for a long one,
// checked by spec.check when given), and the rest as positional words; null when any word is not the spec's.
function parse(args, spec) {
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word.startsWith('-') && word.length > 1) {
      const [name, glued] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
      if (glued === undefined && (spec.flags ?? []).includes(name)) continue
      if (!(spec.values ?? []).includes(name)) return null
      const value = glued ?? args[++i]
      if (value === undefined || (spec.check?.[name] && !spec.check[name](value))) return null
      continue
    }
    positional.push(word)
  }
  return spec.positional(positional) ? positional : null
}
const none = (p) => p.length === 0
const one = (test) => (p) => p.length === 1 && test(p[0])
// Repositories the project names, as owner/name.
const REPOS = new Set(WIDE?.repos ?? [])
const QUERY = /^\?[A-Za-z0-9_.,%-]+=[A-Za-z0-9_.,%-]*(&[A-Za-z0-9_.,%-]+=[A-Za-z0-9_.,%-]*)*$/
// A REST path of the project's own repositories, GET only, and none of its secrets, keys, tokens or hooks.
function repoPath(text) {
  const at = text.indexOf('?'), path = (at < 0 ? text : text.slice(0, at)).replace(/^\//, '').replace(/\/$/, '')
  if (at >= 0 && !QUERY.test(text.slice(at))) return false
  const parts = path.split('/')
  if (parts[0] !== 'repos' || parts.length < 3 || !REPOS.has(parts[1] + '/' + parts[2])) return false
  return parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '..' && part !== '.') && !parts.some((part) => /secret|key|token|hook/i.test(part))
}
const appName = (text) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?)?$/.test(text)
// A resource word naming a ConfigMap, whose values a dump would print (security reviews 1 and 2 of #2310).
const configMap = (text) => /configmap/i.test(text) || text.split(',').some((part) => /^cm(\.|\/|$)/i.test(part))
// A cluster resource word (pods, deploy/x, pods,services) naming no secret.
const resource = (text) => /^[A-Za-z0-9.\/,-]+$/.test(text) && !/secret/i.test(text)
const WIDE_COMMANDS = {
  gh: {
    run: {
      list: { values: ['--limit', '-L', '--workflow', '-w', '--branch', '-b', '--status', '-s', '--event', '-e', '--commit', '-c', '--user',
        '-u', '--created', '--json', '--jq', '-q'], positional: none },
      view: { flags: ['--log', '--log-failed', '--verbose', '-v', '--exit-status'], values: ['--job', '-j', '--attempt', '-a', '--json', '--jq', '-q'],
        positional: (p) => p.length <= 1 && p.every((id) => /^[0-9]+$/.test(id)) },
    },
    api: { flags: ['--paginate', '--silent', '--slurp', '--include', '-i'], values: ['--jq', '-q', '--cache', '--method', '-X'],
      check: { '--method': (v) => v === 'GET', '-X': (v) => v === 'GET' }, positional: one(repoPath) },
  },
  argocd: {
    app: {
      list: { flags: ['--grpc-web'], values: ['-o', '--output', '-l', '--selector', '-p', '--project'], positional: none },
      get: { flags: ['--grpc-web', '--show-operation', '--show-params'], values: ['-o', '--output'], positional: one(appName) },
      resources: { flags: ['--grpc-web', '--orphaned'], values: ['-o', '--output'], positional: one(appName) },
      history: { flags: ['--grpc-web'], values: ['-o', '--output'], positional: one(appName) },
      // One resource of an app as the cluster holds it (Juno's pods, restarts and HPA read, 10-30): never a Secret.
      'get-resource': { flags: ['--grpc-web'], values: ['--kind', '--group', '--namespace', '--resource-name', '-o', '--output'],
        check: { '--kind': (v) => !/secret|configmap/i.test(v), '--resource-name': (v) => !/secret/i.test(v) }, positional: one(appName) },
      logs: { flags: ['--grpc-web', '--previous', '-p', '--match-case'], values: ['--tail', '--since-seconds', '--until-time', '--container',
        '-c', '--kind', '--name', '--group', '--namespace', '--filter'], positional: one(appName) },
    },
    version: { flags: ['--client', '--short', '--grpc-web'], values: ['-o', '--output'], positional: none },
  },
  kubectl: {
    get: { flags: ['-A', '--all-namespaces', '--show-labels', '--no-headers'], values: ['-n', '--namespace', '--context', '-o', '--output',
      '-l', '--selector', '--field-selector', '--sort-by', '--request-timeout'], positional: (p) => p.length >= 1 && p.every(resource) },
    describe: { flags: ['-A', '--all-namespaces'], values: ['-n', '--namespace', '--context', '-l', '--selector', '--request-timeout'],
      positional: (p) => p.length >= 1 && p.every(resource) },
    top: { flags: ['-A', '--all-namespaces', '--containers', '--no-headers'], values: ['-n', '--namespace', '--context', '-l', '--selector',
      '--sort-by', '--request-timeout'], positional: (p) => p.length >= 1 && p.length <= 2 && ['pods', 'pod', 'po', 'nodes', 'node', 'no'].includes(p[0])
      && p.every(resource) },
    logs: { flags: ['--previous', '-p', '--timestamps', '--all-containers', '--prefix'], values: ['-n', '--namespace', '--context', '--since',
      '--since-time', '--tail', '-c', '--container', '--limit-bytes', '-l', '--selector', '--request-timeout'], positional: one(resource) },
    version: { flags: ['--client'], values: ['-o', '--output', '--context'], positional: none },
    'api-resources': { flags: ['--no-headers'], values: ['-o', '--output', '--context', '--namespaced'], positional: none },
    config: { positional: (p) => p.length === 1 && p[0] === 'current-context' },
  },
}
// Harness's own read-only measurements (lib/buddyRecipes.ts): their names alone, nothing added. API CPU has none: it is
// Juno's ArgoCD logs read, run as it is (Lead, 10-30).
const RECIPES = new Set(['db-size'])

// Whether [w] is one of wide mode's reads, whatever its approval.
function widerRead(w) {
  if (!WIDE) return false
  if (w[0] === 'harness') return w.length === 3 && w[1] === 'buddy-read' && RECIPES.has(w[2])
  let spec = WIDE_COMMANDS[w[0]], at = 1
  while (spec && !spec.positional && at < w.length) spec = Object.hasOwn(spec, w[at]) ? spec[w[at++]] : undefined
  const positional = spec?.positional ? parse(w.slice(at), spec) : null
  if (!positional) return false
  // A ConfigMap is listed by name only: never described or printed whole.
  if (w[0] === 'kubectl' && positional.some(configMap)) {
    if (w[1] !== 'get') return false
    // kubectl takes the last -o or --output it is given, so every one is read.
    const formats = w.flatMap((word, at) => word === '-o' || word === '--output' ? [w[at + 1]] : word.startsWith('--output=') ? [word.slice(9)] : [])
    return formats.every((format) => format === 'name' || format === 'wide')
  }
  return true
}

// An approval lasts 30 days from when its person sent it (docs/specs/2026-10-30-buddy-read-access.md, Design 1).
const APPROVAL_MS = 30 * 24 * 60 * 60 * 1000
// Whether its person approved exactly these words on this machine, by their own "run:" line: the file the host pointed this
// session's list at once it had checked who sent them (superTabs/host.ts), and only in Harness's approvals folder. No
// pointer, a file elsewhere or one it cannot read approves nothing.
function approved(w) {
  try {
    const at = JSON.parse(readFileSync(READS, 'utf8')).approvals
    if (typeof at !== 'string' || !isAbsolute(at) || resolve(at) !== at || dirname(at) !== WIDE.approvalsDir) return false
    const entries = JSON.parse(readFileSync(at, 'utf8')).entries, now = Date.now(), want = JSON.stringify(w)
    return Array.isArray(entries) && entries.some((entry) => entry && Array.isArray(entry.argv) && entry.argv.every((word) => typeof word === 'string')
      && Number.isFinite(entry.at) && now - entry.at < APPROVAL_MS && JSON.stringify(entry.argv) === want)
  } catch { return false }
}

const ASK = (command) => 'Not run before, so it was refused, and nobody will be asked here. Ask your person in your chat first: show ' +
  'them this exact command, why you want it and what it reads. They approve it by sending a line of their own: run: ' + command +
  ' . Do not run it again until they have.'
function decide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tool_name !== 'string') return false
  const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null
  if (!tool) return false
  if (TOOLS.has(input.tool_name)) return true
  // Its read tools, in its folder: Read a file there, Grep and Glob there (their folder by default), LS a folder there.
  // Read opens what its person sent it too, and the Artifact tool reads the links they sent.
  if (input.tool_name === 'Read') return inside(tool.file_path) || attached(tool.file_path) || outsideAllowed(tool.file_path, 'any')
  if (input.tool_name === 'Artifact') return artifactAllowed(tool)
  if (input.tool_name === 'LS') return inside(tool.path) || outsideAllowed(tool.path, 'dir')
  if (input.tool_name === 'Grep') return tool.path === undefined || inside(tool.path) || outsideAllowed(tool.path, 'file')
  if (input.tool_name === 'Glob') {
    return (tool.path === undefined || inside(tool.path) || outsideAllowed(tool.path, 'tree')) && typeof tool.pattern === 'string'
      && !outward(tool.pattern)
  }
  // A command never leaves Claude Code's sandbox (wide mode's, lib/buddyGuard.ts buddySandboxSettings): the guard's allow
  // must not stand in for the person's approval Claude Code would otherwise ask for.
  if (input.tool_name !== 'Bash' || tool.run_in_background === true || tool.dangerouslyDisableSandbox !== undefined
    || typeof tool.command !== 'string') return false
  if (bashAllowed(tool.command)) return true
  const w = words(tool.command)
  if (!w || !widerRead(w)) return false
  if (!granted()) { reason = NOT_GRANTED; return false }
  if (approved(w)) return true
  reason = ASK(tool.command)
  return false
}

let text = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { text += chunk })
process.stdin.on('end', () => {
  // The host's question (lib/buddyGuard.ts recordBuddyApprovals): is this command one of wide mode's reads? Asked with an
  // argument Claude Code never passes, so the host judges a person's "run:" line with these very rules.
  if (process.argv[2] === '--classify') {
    let commands = []
    try { commands = JSON.parse(text) } catch { /* judged as none */ }
    const verdicts = (Array.isArray(commands) ? commands : []).map((command) => {
      const w = typeof command === 'string' ? words(command.trim()) : null
      return { read: !!(w && w.length && widerRead(w)), argv: w }
    })
    process.stdout.write(JSON.stringify({ wide: !!WIDE, verdicts }))
    return
  }
  let input = null
  try { input = JSON.parse(text) } catch { /* refused below */ }
  const allow = decide(input)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'A Buddy may read.' : reason } }))
})
`

/** Where every Buddy session's list is kept: Harness's data folder, never a Buddy's own folder, where a commit or a pull
 *  could put one. */
const listsDir = () => join(env.ADAPTER_DATA_DIR, 'buddy-reads')

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The list for one Buddy session, by its Swarm skill's key. */
export function buddyReadsOf(key: string): BuddyReads {
  return { file: join(listsDir(), `${sha256(key)}.json`), drops: PASTE_DROPS_DIR }
}

/**
 * The mark beside [list] that [session] listed in it: an empty file, read by its name alone. The end of a session finds its
 * own lists by these even where a list cannot be read, and so leaves every other session's alone. Follow-up to #2248 (Lead,
 * 10-30): whose a list was that could not be read could not be told, so it held back the end of every Buddy on the machine.
 */
const markOf = (list: string, session: string) => `${list.replace(/\.json$/, '')}.${sha256(session)}.owner`
const MARK = /\.[0-9a-f]{64}\.owner$/

/** A message holds at most ten files (superTabs/attachments.ts): ten messages' worth, and as many links. */
const MAX_FILES = 100
const MAX_LINKS = 50
/** The backend's per-file limit (superTabs/attachments.ts MAX_ATTACHMENT_BYTES, 256 MB): no download is larger, so nothing
 *  larger is listed. A listed file is never read whole: its bytes are hashed 64 KiB at a time, here and in the guard. */
const MAX_BYTES = 256 * 1024 * 1024

/** A claude.ai Artifact link as the guard compares it (`artifactLink` in the guard above, the same rules), or null. */
function artifactLink(text: string): string | null {
  let url: URL
  try { url = new URL(text) } catch { return null }
  const path = /^\/((?:code\/)?artifact\/[A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname)
  if (!path || url.protocol !== 'https:' || !['claude.ai', 'preview.claude.ai'].includes(url.hostname) || url.port || url.username
    || url.password || url.search || url.hash) return null
  return `https://${url.hostname}/${path[1]}`
}

/** The claude.ai Artifact links in a message's text, each as the artifact's own link: a query or fragment the person's
 *  link carried is dropped, so the Buddy reads the artifact by the one link the guard lets it read. */
export function artifactLinks(text: string): string[] {
  const found = new Set<string>()
  for (const [candidate] of text.matchAll(/https:\/\/[^\s<>()[\]{}"'`]+/gi)) {
    let url: URL
    try { url = new URL(candidate.replace(/[.,;:!?]+$/, '')) } catch { continue }
    url.search = ''; url.hash = ''
    const link = artifactLink(url.href)
    if (link) found.add(link)
  }
  return [...found].slice(0, MAX_LINKS)
}

interface ListedFile { path: string; dev: string; ino: string; size: string; sha256: string; at: number }
interface ListedLink { url: string; at: number }
/** `session`: the native session the host delivered these to, whose lists go when the Swarm ends it (`forgetBuddyReads`).
 *  `approvals`: its person's approvals on this machine (`recordBuddyApprovals`), set by the host once it checked a message
 *  was theirs; the guard reads no approvals without it. */
/** A grant of wide mode: to this session, at this launch, for this account, at this time (delta reviews of #2310). */
interface Grant { session: string; account: string; launch: string; at: number }
interface List { version: 1; session: string; files: ListedFile[]; links: ListedLink[]; approvals?: string; wide?: Grant | false }

/** What [file] holds for [session]: nothing another session listed under the same key, nor anything unreadable. */
function heldList(file: string, session: string): List {
  const none: List = { version: 1, session, files: [], links: [] }
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { session?: unknown; files?: unknown; links?: unknown }
    if (held.session !== session) return none
    const entries = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : []
    const { approvals, wide } = held as { approvals?: unknown; wide?: unknown }
    const grant = wide === false ? false : wide && typeof wide === 'object' ? wide as Grant : undefined
    return { version: 1, session, ...(typeof approvals === 'string' ? { approvals } : {}), ...(grant !== undefined ? { wide: grant } : {}),
      files: entries(held.files).filter((entry): entry is Record<string, unknown> & ListedFile => ['path', 'dev', 'ino', 'size', 'sha256']
        .every(field => typeof entry[field] === 'string') && Number.isFinite(entry.at)),
      links: entries(held.links).filter((entry): entry is Record<string, unknown> & ListedLink => typeof entry.url === 'string' && Number.isFinite(entry.at)) }
  } catch { return none }
}

/** [path] as a listed file: one regular file with no other name, at most a download's size, by its device, inode, size and
 *  the SHA-256 of its bytes, all read from the one file opened (never through a link); null for anything else. */
function listedFile(path: string, at: number): ListedFile | null {
  let fd: number | undefined
  try {
    const named = lstatSync(path, { bigint: true })
    if (!named.isFile() || named.nlink !== 1n || named.size > MAX_BYTES) return null
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > MAX_BYTES) return null
    // No more than the size it opened at: the host's loop waits on this, and a file still being written to is not read on.
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    let total = 0n
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      total += BigInt(read)
      if (total > stat.size) return null
      hash.update(chunk.subarray(0, read))
    }
    return { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256: hash.digest('hex'), at }
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

/** Best-effort, as the downloads' own prune is (lib/pasteDropFiles.ts): the lists of Buddy sessions nothing has written to
 *  for a day, ended or quiet, hold nothing the guard would still allow; approvals, after [kept] (30 days). A mark goes once
 *  its list has, and not before, however old: its session's end still finds the list by it. */
function sweep(dir: string, now: number, kept = KEPT_MS): void {
  try {
    const names = readdirSync(dir), present = new Set(names)
    for (const name of names) {
      try {
        if (MARK.test(name)) { if (!present.has(name.replace(MARK, '.json'))) rmSync(join(dir, name), { force: true }) }
        else if ((name.endsWith('.json') || name.endsWith('.tmp')) && now - statSync(join(dir, name)).mtimeMs >= kept) rmSync(join(dir, name), { force: true })
      } catch { /* raced: ignore */ }
    }
  } catch { /* unreadable: nothing to sweep */ }
}

/**
 * Lists for one Buddy session the files and Artifact links its person sent it in their own Buddy chat (superTabs/host.ts
 * decides that), before the message reaches it. Each file is listed by its path with its device, inode, size and SHA-256,
 * and only as one regular file in the downloads folder with no other name: what the guard checks again when the Buddy
 * opens it. Entries last a day, or until the Swarm ends the session. The host's poll loop is the only writer, and it
 * writes synchronously, so two deliveries never interleave; the guard reads a whole old list or a whole new one, never a
 * part (a rename).
 */
export function allowBuddyReads(reads: BuddyReads, sent: { session: string; files: readonly string[]; links: readonly string[] }, now = Date.now()): void {
  const files = sent.files.flatMap(path => {
    const file = dirname(path) === reads.drops ? listedFile(path, now) : null
    return file ? [file] : []
  })
  const links = sent.links.flatMap((url): ListedLink[] => artifactLink(url) === url ? [{ url, at: now }] : [])
  if (!files.length && !links.length) return
  const dir = dirname(reads.file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweep(dir, now)
  const held = heldList(reads.file, sent.session)
  const fresh = <T extends { at: number }>(entries: T[]) => entries.filter(entry => now - entry.at < KEPT_MS)
  const list: List = { version: 1, session: sent.session, ...(held.approvals ? { approvals: held.approvals } : {}),
    ...(held.wide !== undefined ? { wide: held.wide } : {}),
    files: [...fresh(held.files).filter(entry => !files.some(file => file.path === entry.path)), ...files].slice(-MAX_FILES),
    links: [...fresh(held.links).filter(entry => !links.some(link => link.url === entry.url)), ...links].slice(-MAX_LINKS) }
  // Whose the list is, before the list says so; a mark it cannot write lists nothing.
  writeList(reads.file, sent.session, list)
}

/**
 * Writes [list] as [session]'s: every writer of a session's list comes here (security reviews of #2261, folded into #2310,
 * Lead 10-30). Its mark first, so a list that cannot be read still holds back its own session's end and no other
 * (`forgetBuddyReads`): created only as a file of its own, never through a link, and one already there must be a plain
 * file. Other sessions' marks beside the list go, as the list is no longer theirs. Then the list, as one rename. Throws
 * when it cannot, so the host tries the delivery again.
 */
function writeList(file: string, session: string, list: List): void {
  const dir = dirname(file), own = markOf(file, session)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let fd: number | undefined
  try { fd = openSync(own, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(own).isFile()) throw error
  } finally { if (fd !== undefined) closeSync(fd) }
  const prefix = `${basename(file).replace(/\.json$/, '')}.`
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix) && MARK.test(name) && name.length === prefix.length + 70 && join(dir, name) !== own) rmSync(join(dir, name), { force: true })
  }
  writeWhole(file, list)
}

/** Writes [value] to [file] as one rename, mode 600: a reader sees a whole old file or a whole new one, never a part. */
function writeWhole(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** An approval lasts 30 days from when its person sent it, and a person keeps at most 200 (the spec's Design 1). */
const APPROVAL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_APPROVALS = 200
interface Approval { argv: string[]; at: number; messageId: string }

/** A person's line approving one command: "run:" at its start, the command after it, in backticks or not. A "yes", an
 *  "ok", a quoted line ("> run: …") or one mentioning run: in passing approves nothing. */
const RUN_LINE = /^[ \t]*run:[ \t]*`?([^`\n]*?)`?[ \t]*$/gim
const FORGET_LINE = /^[ \t]*forget runs[ \t]*$/im

/** The guard's own judgement of [commands] (its --classify mode), in one run: whether it is in wide mode, and for each
 *  command whether it is one of its reads, with its words. */
function classify(node: string, guard: string, commands: readonly string[]): { wide: boolean; verdicts: { read: boolean; argv: string[] | null }[] } {
  const run = spawnSync(node, [guard, '--classify'], { input: JSON.stringify(commands), encoding: 'utf8', timeout: 10_000 })
  if (run.status !== 0) throw new Error(`The Buddy's guard could not judge a command (${run.error?.message ?? `exit ${run.status}`}).`)
  const judged = JSON.parse(run.stdout) as { wide?: unknown; verdicts?: unknown }
  if (!Array.isArray(judged.verdicts) || judged.verdicts.length !== commands.length) throw new Error('The Buddy\'s guard judged no commands.')
  return { wide: judged.wide === true, verdicts: judged.verdicts as { read: boolean; argv: string[] | null }[] }
}

/**
 * Grants a Buddy session wide mode, or takes it back ([wide]), in its list ([reads]), keeping what else the list holds. The
 * host decides at each of its person's own messages: theirs, in their own Buddy chat, on their own machine, and the account
 * signed in on this machine (superTabs/host.ts). The guard reads beyond the folder only while it is granted. Throws when
 * it cannot write, so the host tries the delivery again.
 */
export function grantBuddyWide(reads: BuddyReads, input: { session: string; wide: false } | { session: string; wide: true; account: string; launch: string },
  now = Date.now()): void {
  const wide: Grant | false = input.wide ? { session: input.session, account: input.account, launch: input.launch, at: now } : false
  writeList(reads.file, input.session, { ...heldList(reads.file, input.session), wide })
}

/** Takes back the grant in [reads]'s list, whoever's session it names: at each launch (delta reviews of #2310). */
export function revokeBuddyWide(reads: BuddyReads): void {
  let session: unknown
  try { session = (JSON.parse(readFileSync(reads.file, 'utf8')) as { session?: unknown }).session } catch { return }
  if (typeof session === 'string') writeList(reads.file, session, { ...heldList(reads.file, session), wide: false })
}

export { buddyAccountFile, writeBuddyAccount } from './buddyAccount.js'

/** Where a Buddy's launch keeps its launch id in its folder, and what it says there now. */
export const buddyLaunchFile = (folder: string): string => join(folder, '.claude', 'buddy-launch')
export function buddyLaunchOf(folder: string): string | null {
  try { return readFileSync(buddyLaunchFile(folder), 'utf8').trim() || null } catch { return null }
}

/** Whether [text] has a line approving commands or forgetting them: the host judges it only then. */
export const hasBuddyApprovals = (text: string): boolean => new RegExp(RUN_LINE.source, 'im').test(text) || FORGET_LINE.test(text)

/** A person's message, judged: the commands of its "run:" lines that a Buddy may run (with their words) and those it never
 *  may, and whether it said "forget runs". `wide`: the Buddy's guard is in wide mode; without it nothing is recorded. */
export interface JudgedApprovals { wide: boolean; approve: { command: string; argv: string[] }[]; refused: string[]; forgot: boolean }

/**
 * Judges the "run:" lines of a person's message with the Buddy's own guard [guard] (docs/specs/2026-10-30-buddy-read-access.md),
 * so a command its grammar refuses (a write, a secret read, anything not a read) is never approved: one run of node for the
 * whole message. Before any write, as the host judges it before its delivery lease (superTabs/host.ts). Throws when the
 * guard cannot judge, so the delivery is tried again.
 */
export function judgeBuddyApprovals(input: { node: string; guard: string; text: string }): JudgedApprovals {
  const forgot = FORGET_LINE.test(input.text)
  const commands = [...input.text.matchAll(RUN_LINE)].map(match => match[1]!.trim()).filter(Boolean)
  if (!commands.length && !forgot) return { wide: false, approve: [], refused: [], forgot: false }
  const judged = classify(input.node, input.guard, commands)
  if (!judged.wide) return { wide: false, approve: [], refused: [], forgot: false }
  const approve: JudgedApprovals['approve'] = [], refused: string[] = []
  commands.forEach((command, at) => {
    const verdict = judged.verdicts[at]!
    if (verdict.read === true && Array.isArray(verdict.argv)) approve.push({ command, argv: verdict.argv })
    else refused.push(command)
  })
  return { wide: true, approve, refused, forgot }
}

/**
 * Records what [judged] approves, once the caller has checked the message is the person's own, in their own Buddy chat, on
 * their own machine (superTabs/host.ts). Approvals are kept per person and membership on this machine ([approvals],
 * `buddyApprovalsOf`), never sent anywhere, by their exact words; one approved again is renewed, and "forget runs" clears
 * them first. The session's list ([reads]) then points at them, keeping what else it lists. Nothing is written for a guard
 * not in wide mode. Anything it cannot write throws, so the host tries the delivery again.
 */
export function recordBuddyApprovals(input: { reads: BuddyReads; session: string; approvals: string; judged: JudgedApprovals; messageId: string },
  now = Date.now()): void {
  const { judged } = input
  if (!judged.wide) return
  let held: Approval[] = []
  if (!judged.forgot) {
    try {
      const entries = (JSON.parse(readFileSync(input.approvals, 'utf8')) as { entries?: unknown }).entries
      held = Array.isArray(entries) ? entries.filter((entry): entry is Approval => !!entry && Array.isArray(entry.argv)
        && entry.argv.every((word: unknown) => typeof word === 'string') && Number.isFinite(entry.at) && typeof entry.messageId === 'string') : []
    } catch { /* none yet, or unreadable: start again */ }
  }
  const key = (argv: readonly string[]) => JSON.stringify(argv)
  const fresh = judged.approve.filter((entry, at) => judged.approve.findIndex(other => key(other.argv) === key(entry.argv)) === at)
    .map(entry => ({ argv: entry.argv, at: now, messageId: input.messageId }))
  const renewed = new Set(fresh.map(entry => key(entry.argv)))
  const entries = [...held.filter(entry => now - entry.at < APPROVAL_MS && !renewed.has(key(entry.argv))), ...fresh].slice(-MAX_APPROVALS)
  mkdirSync(dirname(input.approvals), { recursive: true, mode: 0o700 })
  chmodSync(dirname(input.approvals), 0o700)
  // Files nothing approved into for 30 days approve nothing any more: an earlier membership's, or a person who left.
  sweep(dirname(input.approvals), now, APPROVAL_MS)
  writeWhole(input.approvals, { version: 1, entries })
  writeList(input.reads.file, input.session, { ...heldList(input.reads.file, input.session), approvals: input.approvals })
}

/**
 * Deletes the lists of [session], once the Swarm has ended it: its Buddy removed, its person gone from the Swarm, or its
 * chat purged with its project (Lead, 10-30). A session no longer running here is found too. Its own lists are those its
 * mark is beside (`markOf`), unless another session has listed under the same key since, and, beside no mark of its own,
 * those that name it (a list written before lists were marked). Nothing else is touched or holds its end back: another
 * session's list, or one that names no session beside no mark, which the host never writes and the day's sweep removes.
 * Follow-up to #2248 (Lead, 10-30): one list that could not be read held back the end of every Buddy on the machine. So
 * a list is read only for the session it names: one that cannot be read names none. Its own is removed unread, by its
 * mark; another session's is skipped, and is that session's to remove.
 *
 * What it cannot finish throws, so the host tries again and does not acknowledge the end meanwhile (re-check 2 of #2248):
 * an own list it cannot delete (a folder it cannot write to), which it empties in place where it can, needing only the
 * file, so the guard allows nothing meanwhile, keeping that list's mark and its session so the next try finds it; and a
 * mark it cannot delete. A list that went between the folder's read and its own counts as gone.
 *
 * It fails by fixed codes alone (`SentListsError`), never with the error it caught: the host logs what it failed with, and
 * a filesystem error's message names its path, in the person's home (follow-up to #2389's security re-check 2).
 */
export function forgetBuddyReads(session: string, dir = listsDir()): void {
  let names: string[]
  try { names = readdirSync(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new SentListsError(['SENT_LISTS_UNREAD'])
  }
  const own = `.${sha256(session)}.owner`
  const marked = new Set(names.filter(name => name.endsWith(own)).map(name => `${name.slice(0, -own.length)}.json`))
  const kept = new Set<string>()
  const failed = new Set<SentListsFailure>()
  // Only a list's own name: a .tmp is a write not yet renamed, which no guard reads.
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let text: string | undefined, unreadable = false
    try { text = readFileSync(file, 'utf8') } catch (error) { unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    let named: unknown
    try { named = text === undefined ? undefined : (JSON.parse(text) as { session?: unknown } | null)?.session } catch { /* not JSON: it names no session */ }
    if (!marked.has(name)) {
      // Not its own by mark. One it cannot read is another session's to remove when that session's mark is beside it, and
      // otherwise whose it is cannot be told: kept, and the end fails so it is tried again, as before marks (review of #2261).
      if (unreadable) {
        const base = `${name.slice(0, -'.json'.length)}.`
        if (!names.some(other => other.startsWith(base) && MARK.test(other))) failed.add('SENT_LIST_UNREAD')
        continue
      }
      if (named !== session) continue
    } else if (typeof named === 'string' && named !== session) continue
    try { rmSync(file, { force: true }) } catch {
      const empty: List = { version: 1, session, files: [], links: [] }
      try { writeFileSync(file, `${JSON.stringify(empty)}\n`) } catch { /* neither: the host's next try is all that is left */ }
      kept.add(name)
      failed.add('SENT_LIST_KEPT')
    }
  }
  for (const name of names) {
    if (!name.endsWith(own) || kept.has(`${name.slice(0, -own.length)}.json`)) continue
    try { rmSync(join(dir, name), { force: true }) } catch { failed.add('SENT_LIST_MARK_KEPT') }
  }
  if (failed.size) throw new SentListsError(SENT_LISTS_FAILURES.filter(code => failed.has(code)))
}

/** What kept an ended session's lists from all going, in the order they are named: its lists folder could not be read; a list
 *  whose session could not be told could not be read, and was kept; one of its own lists could not be deleted, and was emptied
 *  where it could be; or the mark beside one could not be deleted. */
const SENT_LISTS_FAILURES = ['SENT_LISTS_UNREAD', 'SENT_LIST_UNREAD', 'SENT_LIST_KEPT', 'SENT_LIST_MARK_KEPT'] as const
export type SentListsFailure = typeof SENT_LISTS_FAILURES[number]

/** `forgetBuddyReads`'s failure: its codes, each once, and nothing of the errors behind them, whose messages name paths. */
export class SentListsError extends Error {
  constructor(readonly codes: readonly SentListsFailure[]) {
    super(codes.join(', '))
    this.name = 'SentListsError'
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The hook's command. Exit 2 is Claude Code's blocking error: a guard that cannot run refuses the call, where any other
 *  failure would hand it to the permission rules, the person's own allow rules among them. */
export function buddyGuardCommand(node: string, script: string): string {
  return `${shellQuote(node)} ${shellQuote(script)} || exit 2`
}
