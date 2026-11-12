/**
 * An agent's post as its channel and its person's chat show it: without its own name, and a time, at its start.
 *
 * On GitHub every agent of a person posts as one login, so it opens each comment with its name (lib/swarmSkills.ts), and it
 * carried the habit into the channel and its person's chat, which show who wrote a post, and when, beside it: "Ray, 16:25: @Cy
 * #20 and #21 are yours" (anh Dee, 2026-11-11: "not like how humans talk on slack ... here Ray says 'Ray something something'
 * is just weird"). The time was the model's guess besides: one agent's in UTC, another's local, both wrong.
 *
 * A signature is the agent's own name at the start, written as a name is ("Juno" for a stored "juno", never "juno"), perhaps in
 * bold or italics closed before its colon or after, perhaps with a role's word or two in brackets ("Ray (PM)"), then a colon, or
 * a comma, a time (with "pm" or a zone such as "UTC") and a colon. "Ray, can you read #12?" opens with its name and is no
 * signature; nor are "vale: 3 errors", a linter's report, and "Ray, 9:00 call: agenda" (review of #4074).
 *
 * After the mentions a post opens with too, which stay: "@Devon Lennox: Flutter 3.47.2 is now on Mac 3" (anh Dee, 2026-11-12:
 * "why does lenox put 'Lenox:' there. it's awkward").
 */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Only an engine's name, which an agent's stored name can be (backend agentNames.ts isEngineName) and no agent signs with: a
 *  post that opens "Claude Code: ..." is about the engine. */
const ENGINE = /^(?:claude(?: code)?|codex|opencode|pi)$/i

/** The mentions a post opens with ("@Devon @Cy "), each a word of its own. */
const MENTIONS = /^\s*((?:@[^\s@]+\s+)+)/

/** [text] without a signature of any of [names] at its start, or after the mentions it opens with; as it is when it has none,
 *  or nothing after it. */
export function unsigned(text: string, names: ReadonlyArray<string | null | undefined>): string {
  const mentions = MENTIONS.exec(text)
  if (mentions) {
    const said = signedOff(text.slice(mentions[0].length), names)
    return said === null ? text : `${mentions[1]!.trim().split(/\s+/).join(' ')} ${said}`
  }
  return signedOff(text, names) ?? text
}

/** What [text] says after a signature of any of [names] at its very start, or null when it has none or nothing after it. */
function signedOff(text: string, names: ReadonlyArray<string | null | undefined>): string | null {
  for (const raw of names) {
    const name = raw?.trim()
    if (!name || ENGINE.test(name)) continue
    // Markup of three at most: unbounded, a name only of markup, which a rename allows, read a post of underscores in quadratic
    // time (3 s for 200,000 of them).
    const found = new RegExp(`^\\s*([*_]{0,3})(${escape(name)})(\\1)?(?:\\s*\\([A-Za-z][A-Za-z .-]{0,30}\\))?`
      + '\\s*(?:,\\s*\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*([A-Za-z]{2,4}))?\\s*:|:)', 'i').exec(text)
    if (!found || /^\p{Ll}/u.test(found[2]!) || found[4] && !/^(?:[AaPp][Mm]|[A-Z]{2,4})$/.test(found[4])) continue
    const markup = found[1]!, closed = !markup || !!found[3]
    let end = found[0].length
    // Its markup closed after the colon ("**Ray:**") goes with it; markup never closed is not a signature as it was written.
    if (!closed) {
      if (!text.startsWith(markup, end)) continue
      end += markup.length
    }
    // From its first word: the server trims a post's ends (backend commands.ts), so an indent kept here would reach nobody.
    const said = text.slice(end).trimStart()
    if (said) return said
  }
  return null
}
