/** A Windows security identifier in its `S-1-…` string form: what an elevated script or an ACL may name an account by. */
const SID_PATTERN = /^S-1-\d+(-\d+)+$/

/** [sid] as it is, or a throw naming [what] when it is not a SID. */
export function checkSid(sid: string, what = 'account'): string {
  if (!SID_PATTERN.test(sid)) throw new Error(`the ${what} is not a SID: ${JSON.stringify(sid)}`)
  return sid
}
