/**
 * An agent's post as its channel and its person's chat show it: without its own name, and a time, at its start.
 *
 * On GitHub every agent of a person posts as one login, so it opens each comment with its name (lib/swarmSkills.ts), and it
 * carried the habit into the channel and its person's chat, which show who wrote a post, and when, beside it: "Ray, 16:25: @Cy
 * #20 and #21 are yours" (anh Dee, 2026-11-11: "not like how humans talk on slack ... here Ray says 'Ray something something'
 * is just weird"). The time was the model's guess besides: one agent's in UTC, another's local, both wrong.
 *
 * A signature is the agent's own name at the start, perhaps a word in brackets after it ("Ray (PM)"), then a colon, or a
 * comma and a time and a colon. "Ray, can you read #12?" opens with its name and is no signature.
 */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** [text] without a signature of any of [names] at its start; as it is when it has none, or nothing after it. */
export function unsigned(text: string, names: ReadonlyArray<string | null | undefined>): string {
  for (const name of names) {
    if (!name?.trim()) continue
    const signature = new RegExp(`^\\s*[*_]*${escape(name.trim())}[*_]*(?:\\s*\\([^()\\n]{1,40}\\))?`
      + '\\s*(?:,\\s*\\d{1,2}:\\d{2}(?:\\s*[A-Z]{2,4})?\\s*:|:)\\s*')
    const found = signature.exec(text)
    if (found && found[0].length < text.length) return text.slice(found[0].length)
  }
  return text
}
