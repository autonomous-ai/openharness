/** A repository's name for comparing two addresses of it: host and path, lowercase, without credentials, port or `.git`,
 * the same over HTTPS and SSH. Null for a folder on disk or an address it cannot read. A machine reports its checkouts'
 * origins this way (readCheckouts), so no credential in an origin leaves it. */
export function repositoryKey(url: string): string | null {
  const text = url.trim()
  // Only the host and the path are kept: userinfo, a port, a query and a fragment can all carry what is not the repository's
  // name, a token among them (review of #1743).
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)([^?#]+)/.exec(text)
  let host: string | undefined, path: string | undefined
  if (scp) [, host, path] = scp
  else {
    try {
      const parsed = new URL(text)
      if (['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) [host, path] = [parsed.hostname, decodeURIComponent(parsed.pathname)]
    } catch { /* Not an address: a folder on disk, or nothing readable. */ }
  }
  const clean = path?.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return host && clean ? `${host}/${clean}`.toLowerCase() : null
}
