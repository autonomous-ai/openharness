import { createHash } from 'node:crypto'

/** What a prompt says, once the markers Claude Code records around a paste are off it and its spacing is one: Claude Code keeps a
 *  typed paste between `<pasted_content id=…>` tags, and an engine may space its lines as it likes. */
const PASTE_MARKS = /<\/?pasted_content\b[^>]*>/g
const said = (text: string): string => text.replace(PASTE_MARKS, ' ').replace(/\s+/g, ' ').trim()

/** A prompt by what it says, never its words: the core names the turn that ended by it, and the Swarm host names the message it typed
 *  by it, so the one that answers the other is found without either handing the other a word of it (core/turns/ends.ts,
 *  superTabs/agentReplies.ts). The host keeps it in its journal, so it stays what it was when a host of an older release wrote it. */
export const promptHash = (text: string): string => createHash('sha256').update(said(text)).digest('hex').slice(0, 32)
