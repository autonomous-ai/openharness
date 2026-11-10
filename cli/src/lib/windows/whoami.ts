/**
 * This process's own Windows account, as `whoami` prints it: guest sharing's installer names its owner by SID in the
 * ACLs it sets and its elevated runner makes its staging folder the owner's by it (lib/windows/guestHelperInstallWin.ts,
 * ./elevated.ts).
 */
import { checkSid } from './sid.js'

/** `whoami /user /fo csv /nh`: one line, `"<DOMAIN\name>","<SID>"`, this process's own account. */
export const WHOAMI_USER_ARGS = ['/user', '/fo', 'csv', '/nh']

/** The fields of one CSV line, quotes taken off (`""` inside a quoted field is one quote). */
function csvFields(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { field += '"'; i++ } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { fields.push(field); field = '' } else field += char
  }
  fields.push(field)
  return fields
}

/** The account's SID in what `whoami /user /fo csv /nh` printed (its last column: a name may hold a comma), or null. */
export function windowsUserSid(stdout: string): string | null {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean)
  const sid = line ? csvFields(line).at(-1) ?? '' : ''
  try { return checkSid(sid) } catch { return null }
}
