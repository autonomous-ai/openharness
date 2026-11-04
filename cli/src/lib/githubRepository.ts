/** A GitHub repository as a person pastes it: the browser's link, `git@github.com:`, or an SSH host alias from their own
 *  SSH configuration (`Host gh-work` / `HostName github.com`), which is how a computer with two GitHub accounts picks a
 *  key. The desktop app's repository_clone.dart parses the same way; both are held to
 *  __fixtures__/github-repository-vectors.json. */
export interface GitHubRepository {
  /** The address git clones, always ending `.git`. */
  url: string
  owner: string
  name: string
  transport: 'https' | 'ssh' | 'alias'
  /** The SSH host alias, for `transport: 'alias'` only. */
  alias?: string
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
/** A name that can never be read as an option by ssh or git: it starts with a letter or digit. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export function safeSshAlias(alias: string): boolean {
  return ALIAS.test(alias)
}

/** Whether an SSH host name is GitHub: `ssh.github.com` is GitHub's SSH over port 443, which a second account's alias
 *  behind a firewall uses. */
export function isGitHubHost(host: string | null): boolean {
  return host === 'github.com' || host === 'ssh.github.com'
}

/** Null for anything that is not one GitHub repository: credentials, ports, queries, a page inside a repository, another
 *  host, a local path. A bare `owner/repo` is still one, for the GitHub prompt and older apps. */
export function parseGitHubRepository(input: string): GitHubRepository | null {
  const raw = input.trim()
  // A query, a fragment, an escape or a space is never part of a repository's address, even an empty one: the URL parser
  // would drop or decode it, and the app's parser must give the same answer (the shared vectors).
  if (/[\s?#%]/.test(raw)) return null
  let host = 'github.com', path: string
  const scp = /^git@([^:/\s]+):(\S+)$/.exec(raw)
  if (scp) {
    host = scp[1]!
    if (host !== 'github.com' && !safeSshAlias(host)) return null
    path = scp[2]!
  } else {
    let url: URL
    try { url = new URL(raw.includes('://') ? raw : raw.startsWith('github.com/') ? `https://${raw}` : `https://github.com/${raw}`) }
    catch { return null }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) return null
    path = url.pathname.replace(/^\//, '')
  }
  const parts = path.replace(/\/$/, '').replace(/\.git$/, '').split('/')
  const [owner, name] = parts
  if (parts.length !== 2 || !OWNER.test(owner!) || !NAME.test(name!) || name === '.' || name === '..') return null
  if (!scp) return { url: `https://github.com/${owner}/${name}.git`, owner: owner!, name: name!, transport: 'https' }
  if (host === 'github.com') return { url: `git@github.com:${owner}/${name}.git`, owner: owner!, name: name!, transport: 'ssh' }
  return { url: `git@${host}:${owner}/${name}.git`, owner: owner!, name: name!, transport: 'alias', alias: host }
}

/**
 * One repository however git spells its address: `github.com/owner/repo` for `https://github.com/Owner/Repo.git/`,
 * `git@github.com:owner/repo`, `ssh://git@github.com:22/owner/repo.git` and `git://github.com/owner/repo`, credentials and
 * ports left out. Lowercased: host names are case-insensitive, and so are GitHub's owner and repository names, the only
 * host a clone is asked for. Null for a local path or anything else that names no host.
 */
export function repositoryIdentity(address: string): string | null {
  const raw = address.trim()
  let host: string, path: string
  // scp-like `[user@]host:path`, which has no scheme and no slash before its colon.
  const scp = raw.includes('://') ? null : /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(raw)
  if (scp) { host = scp[1]!; path = scp[2]! }
  else {
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return null
    host = url.hostname
    path = url.pathname
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  return host && path ? `${host}/${path}`.toLowerCase() : null
}

/** [repositoryIdentity] with an SSH alias read as the host it names (`ssh.github.com` as GitHub), so a checkout cloned as `git@gh-work:org/repo` is the
 *  repository a browser link `https://github.com/org/repo` asks for. Only a name that could be an alias is resolved. */
export async function resolvedRepositoryIdentity(address: string, resolveHost: (alias: string) => Promise<string | null>): Promise<string | null> {
  const identity = repositoryIdentity(address)
  if (!identity) return null
  const slash = identity.indexOf('/')
  const host = identity.slice(0, slash)
  // Only ssh reads ~/.ssh/config: an https or git:// host is a real name, never an alias.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(address.trim())?.[1]?.toLowerCase()
  const viaSsh = scheme === undefined || scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git'
  const named = host === 'github.com' || !viaSsh || !safeSshAlias(host) ? host : (await resolveHost(host))?.toLowerCase() ?? host
  return `${isGitHubHost(named) ? 'github.com' : named}${identity.slice(slash)}`
}

/** The most SSH aliases one clone tries: each refused attempt costs a round trip to GitHub, about a second. */
export const MAX_CLONE_ALIASES = 3

/** The addresses a clone tries, in order: what was pasted, the other transport, then [aliases] (the computer's own aliases
 *  for github.com, safe names only, at most three). A pasted alias is tried once. */
export function cloneAttempts(repository: GitHubRepository, aliases: readonly string[]): string[] {
  const { owner, name } = repository
  const https = `https://github.com/${owner}/${name}.git`, ssh = `git@github.com:${owner}/${name}.git`
  const others = repository.transport === 'https' ? [ssh] : repository.transport === 'ssh' ? [https] : [https, ssh]
  const extra = aliases.filter(alias => alias !== 'github.com' && alias !== repository.alias && safeSshAlias(alias))
    .slice(0, MAX_CLONE_ALIASES).map(alias => `git@${alias}:${owner}/${name}.git`)
  return [...new Set([repository.url, ...others, ...extra])]
}
