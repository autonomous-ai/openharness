import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isGitHubHost, MAX_CLONE_ALIASES, safeSshAlias } from './githubRepository.js'

/** Runs `ssh` with [args] and gives its standard output. */
export type SshRunner = (args: readonly string[]) => Promise<string>

/** `ssh -G` prints the configuration it would use and connects to nothing. Bounded as the project readers are: four
 *  seconds, 64 KiB. */
const runSsh: SshRunner = (args) => new Promise((resolve, reject) => {
  execFile('ssh', [...args], { timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout))
})

/** The host name [alias] stands for in this computer's SSH configuration, lowercased; null when ssh cannot say. An unsafe
 *  name never reaches ssh: it could be read as an option. */
export async function resolveHost(alias: string, ssh: SshRunner = runSsh): Promise<string | null> {
  if (!safeSshAlias(alias)) return null
  try {
    const line = (await ssh(['-G', alias])).split('\n').find(l => l.startsWith('hostname '))
    return line ? line.slice('hostname '.length).trim().toLowerCase() || null : null
  } catch { return null }
}

/** A configuration bigger than this is not one a person wrote by hand, and is not read. */
const MAX_CONFIG_BYTES = 256 * 1024
/** The most `ssh -G` runs one listing makes, so a long configuration costs a clone a bounded wait. */
const MAX_ASKED = 20

async function readConfig(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > MAX_CONFIG_BYTES) return null
    return await readFile(path, 'utf8')
  } catch { return null }
}

/** `keyword value…` or `keyword=value…`, as ssh_config(5) writes them; quotes taken off each value. */
function directives(text: string): { keyword: string; values: string[] }[] {
  return text.split('\n').flatMap((line) => {
    const m = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    return m ? [{ keyword: m[1]!.toLowerCase(), values: m[2]!.trim().split(/\s+/).map(v => v.replace(/^"(.*)"$/, '$1')) }] : []
  })
}

/** The files an `Include` names: relative to ~/.ssh, `~` for [home], and a `*` or `?` in the file name only. */
async function included(pattern: string, home: string): Promise<string[]> {
  const path = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(home, '.ssh', pattern)
  const name = basename(path)
  if (!/[*?]/.test(name)) return [path]
  const glob = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  try { return (await readdir(dirname(path))).filter(n => glob.test(n)).sort().map(n => join(dirname(path), n)) }
  catch { return [] }
}

/** The `Host` names of a configuration, in order, with its `Include`s read in place one level deep. Patterns and negations
 *  name no single host, so they are left out. */
async function hostNames(path: string, home: string, depth: number): Promise<string[]> {
  const text = await readConfig(path)
  if (text === null) return []
  const names: string[] = []
  for (const { keyword, values } of directives(text)) {
    if (keyword === 'host') names.push(...values.filter(v => !/[*?]/.test(v) && !v.startsWith('!')))
    else if (keyword === 'include' && depth === 0) {
      for (const pattern of values) for (const file of await included(pattern, home)) names.push(...await hostNames(file, home, 1))
    }
  }
  return names
}

/**
 * This computer's SSH aliases for github.com, in the order its configuration lists them, at most three: the keys of the
 * other GitHub accounts a person signed in with (`Host gh-work` / `HostName github.com`). Read only after GitHub refused a
 * clone, so a computer that clones fine never runs ssh for it.
 */
export async function githubAliases(options: { home?: string; ssh?: SshRunner } = {}): Promise<string[]> {
  const home = options.home ?? homedir()
  const candidates = [...new Set(await hostNames(join(home, '.ssh', 'config'), home, 0))].filter(safeSshAlias).filter(n => n !== 'github.com')
  const found: string[] = []
  for (const alias of candidates.slice(0, MAX_ASKED)) {
    if (found.length >= MAX_CLONE_ALIASES) break
    if (isGitHubHost(await resolveHost(alias, options.ssh))) found.push(alias)
  }
  return found
}
