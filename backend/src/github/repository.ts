/** A repository on github.com, as a Swarm project records it (superTabs/commands.ts `repositoryUrl`). */
export interface GitHubRepository { owner: string; name: string; fullName: string }

// GitHub's own limits: an owner is 1–39 letters, digits and single dashes; a repository name is letters, digits, `.`, `_`
// and `-`, never `.` or `..` alone.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

/** `owner/name` of a github.com repository address (https, ssh or scp-like), or null for any other host or shape. */
export function githubRepository(url: string | null | undefined): GitHubRepository | null {
  if (!url) return null
  let path: string
  const scp = /^git@github\.com:(.+)$/i.exec(url)
  if (scp) path = scp[1]!
  else {
    let parsed: URL
    try { parsed = new URL(url) } catch { return null }
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.search || parsed.hash) return null
    if (parsed.protocol === 'ssh:' ? parsed.username !== 'git' : !['https:', 'http:'].includes(parsed.protocol) || parsed.username) return null
    path = parsed.pathname.replace(/^\//, '')
  }
  const parts = path.replace(/\/$/, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts as [string, string]
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null
  return { owner, name, fullName: `${owner}/${name}` }
}
