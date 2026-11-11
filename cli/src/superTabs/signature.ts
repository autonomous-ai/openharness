/**
 * An agent's post as its channel and its person's chat show it: without its own name, and a time, at its start.
 *
 * On GitHub every agent of a person posts as one login, so it opens each comment with its name (lib/swarmSkills.ts), and it
 * carried the habit into the channel and its person's chat, which show who wrote a post, and when, beside it: "Ray, 16:25: @Cy
 * #20 and #21 are yours" (anh Dee, 2026-11-11: "not like how humans talk on slack ... here Ray says 'Ray something something'
 * is just weird"). The time was the model's guess besides: one agent's in UTC, another's local, both wrong.
 *
 * A signature is the agent's own name at the start, in any case, perhaps in bold or italics closed before its colon or after,
 * perhaps with a role's word or two in brackets ("Ray (PM)"), then a colon, or a comma, a time and a colon. "Ray, can you read
 * #12?" opens with its name and is no signature.
 */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Only an engine's name, which an agent's stored name can be (backend agentNames.ts isEngineName) and no agent signs with: a
 *  post that opens "Claude Code: ..." is about the engine. */
const ENGINE = /^(?:claude(?: code)?|codex|opencode|pi)$/i

/** [text] without a signature of any of [names] at its start; as it is when it has none, or nothing after it. */
export function unsigned(text: string, names: ReadonlyArray<string | null | undefined>): string {
  for (const raw of names) {
    const name = raw?.trim()
    if (!name || ENGINE.test(name)) continue
    const found = new RegExp(`^\\s*([*_]*)${escape(name)}(\\1)?(?:\\s*\\([A-Za-z][A-Za-z .-]{0,30}\\))?`
      + '\\s*(?:,\\s*\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[A-Za-z]{2,4})?\\s*:|:)', 'i').exec(text)
    if (!found) continue
    const markup = found[1]!, closed = !markup || !!found[2]
    let end = found[0].length
    // Its markup closed after the colon ("**Ray:**") goes with it; markup never closed is not a signature as it was written.
    if (!closed) {
      if (!text.startsWith(markup, end)) continue
      end += markup.length
    }
    // The spaces after it on its line, and that line's end: an indented code block on the next line keeps its indent.
    const rest = /^[ \t]*(?:\r?\n)?/.exec(text.slice(end))![0]
    if (text.slice(end + rest.length).trim()) return text.slice(end + rest.length)
  }
  return text
}
