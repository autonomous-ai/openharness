import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { channelTeamId } from './service.js'

const LIMIT = 64
const TTL = 5 * 60_000
const MAX_TEXT = 256 * 1024
const fingerprint = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
const promptText = (text: string): string => /^\s*<pasted_content id="([a-f0-9]+)">\r?\n([\s\S]*)\r?\n<\/pasted_content id="\1">\s*$/.exec(text)?.[2] ?? text

interface Submission { hash: string | null; teamId: string | null; expires: number; introduction: boolean; questionId?: string }
interface State {
  draft: string[]
  cursor: number
  known: boolean
  decoder: StringDecoder
  escape: string
  paste: boolean
  submissions: Submission[]
  observedHooks: string[]
  current: string | null
  question: string | null
  returns: Map<string, { teamId: string | null; question: string | null }>
}

/** Origin belongs to a submitted prompt, never to focus or the most recent keystroke.
 * Raw input is only evidence: it must match the prompt the engine actually accepts.
 * Unrecognised editor operations, ambiguous equal prompts and missing provenance fail closed.
 * No terminal bytes are changed, and no prompt text is persisted. */
export class SwarmPromptScopes {
  private states = new Map<string, State>()
  constructor(private readonly now: () => number = Date.now) {}
  private state(agentId: string): State {
    let state = this.states.get(agentId)
    if (!state) {
      state = { draft: [], cursor: 0, known: true, decoder: new StringDecoder('utf8'), escape: '', paste: false,
        submissions: [], observedHooks: [], current: null, question: null, returns: new Map() }
      this.states.set(agentId, state)
    }
    state.submissions = state.submissions.filter(s => s.expires > this.now())
    return state
  }
  current(agentId: string): string | null { return this.states.get(agentId)?.current ?? null }
  forget(agentId: string): void { this.states.delete(agentId) }
  replied(agentId: string, teamId: string, questionId: string): void {
    const state = this.states.get(agentId), key = `${teamId}/${questionId}`
    if (!state || state.question !== key) return
    const previous = state.returns.get(key)
    state.returns.delete(key)
    state.current = previous?.teamId ?? null
    state.question = previous?.question ?? null
  }

  /** Called at the actual structured-message write, including queued peer deliveries. */
  prepare(agentId: string, text: string, tabId?: string, deliveryId?: string): () => void {
    const delivery = /^team:([a-f0-9]{32}):([a-f0-9]{32}):(intro|question|answer|consult)$/.exec(deliveryId ?? '')
    const state = this.state(agentId)
    const submission: Submission = { hash: fingerprint(text), teamId: delivery?.[1] ?? (tabId ? channelTeamId(tabId) : null),
      introduction: delivery?.[3] === 'intro', expires: this.now() + TTL,
      ...(delivery?.[3] === 'question' ? { questionId: delivery[2] } : {}) }
    state.submissions.push(submission)
    if (state.submissions.length > LIMIT) state.submissions.shift()
    return () => { state.submissions = state.submissions.filter(s => s !== submission) }
  }

  /** Native prompt hooks run before tools. Transcript starts are the fallback and acknowledge
   * already handled hooks without moving scope backwards when the watcher is delayed. */
  started(agentId: string, text: string, source: 'hook' | 'transcript' = 'transcript', engine?: string): void {
    const state = this.state(agentId)
    const hashes = [fingerprint(text)]
    if (engine === 'claude') hashes.push(fingerprint(promptText(text)))
    if (source === 'transcript') {
      const acknowledged = state.observedHooks.findIndex(hash => hashes.includes(hash))
      if (acknowledged >= 0) { state.observedHooks.splice(acknowledged, 1); return }
    }
    // Prefer the exact text. A user can literally type Claude's paste-wrapper syntax,
    // and another engine does not attach Claude's envelope semantics to that text.
    const hash = hashes.find(hash => state.submissions.some(s => s.hash === hash)) ?? hashes[0]
    const matches = state.submissions.filter(s => s.hash === hash || s.hash === null)
    state.submissions = state.submissions.filter(s => s.hash !== hash && s.hash !== null)
    // Two identical pending messages can be reordered/edited by an engine's own queue.
    // There is no evidence for which origin won; never choose the first or latest swarm.
    if (matches.length !== 1 || matches[0].hash === null) { state.current = null; state.question = null; state.returns.clear() }
    else if (!matches[0].introduction) {
      const submission = matches[0]
      if (submission.questionId) {
        const key = `${submission.teamId}/${submission.questionId}`
        if (state.question !== key) {
          if (state.returns.size >= LIMIT) state.returns.clear()
          state.returns.set(key, { teamId: state.current, question: state.question })
        }
        state.question = key
      } else { state.question = null; state.returns.clear() }
      state.current = submission.teamId
    }
    if (source === 'hook') {
      state.observedHooks.push(hash)
      if (state.observedHooks.length > LIMIT) state.observedHooks.shift()
    }
  }

  raw(agentId: string, bytes: Uint8Array, tabId?: string, pasted = false): void {
    const state = this.state(agentId)
    const insert = (text: string): void => {
      if (!state.known) return
      const chars = [...text]
      if (state.draft.length + chars.length > MAX_TEXT) { state.known = false; state.draft = []; return }
      // Keystrokes append in constant time; a large atomic paste avoids spread-argument limits.
      if (chars.length <= 8192) state.draft.splice(state.cursor, 0, ...chars)
      else state.draft = [...state.draft.slice(0, state.cursor), ...chars, ...state.draft.slice(state.cursor)]
      state.cursor += chars.length
    }
    if (pasted) {
      if (bytes.length > MAX_TEXT) { state.known = false; state.draft = []; return }
      insert(Buffer.from(bytes).toString('utf8')); return
    }
    // The app writes each line key as one string, so ⌥⏎ (and its \n under LNM) is only
    // recognised within this call; a lone Esc followed later by Return fails closed.
    let escaped = false, metaReturn = false
    for (const char of state.decoder.write(Buffer.from(bytes))) {
      if (metaReturn) { metaReturn = false; if (char === '\n') continue }
      if (state.escape) {
        state.escape += char
        if (state.escape === '\x1b[200~') { state.paste = true; state.escape = ''; continue }
        if (state.escape === '\x1b[201~') { state.paste = false; state.escape = ''; continue }
        // The app sends ⇧⏎ as CSI-u and ⌥⏎ as Meta+Return; engines read both as a line break.
        // Inside a paste the engine receives those bytes literally, so they fail closed there.
        if (state.escape === '\x1b[13;2u' && !state.paste) { state.escape = ''; insert('\n'); continue }
        if (state.escape === '\x1b\r' && escaped && !state.paste) { state.escape = ''; insert('\n'); metaReturn = true; continue }
        // SGR mouse reports (focus clicks, wheel) never type text. If a click did move the engine's
        // caret, the draft stops matching the accepted prompt, which still fails closed.
        if (state.escape.startsWith('\x1b[<') && !state.paste) {
          if (/^\x1b\[<[\d;]*$/.test(state.escape) && state.escape.length < 32) continue
          if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(state.escape)) { state.escape = ''; continue }
        }
        if (['\x1b', '\x1b[', '\x1b[1', '\x1b[13', '\x1b[13;', '\x1b[13;2', '\x1b[2', '\x1b[20', '\x1b[200', '\x1b[201', '\x1b[3', '\x1bO'].includes(state.escape)) continue
        const sequence = state.escape
        state.escape = ''
        if (sequence === '\x1b[D') state.cursor = Math.max(0, state.cursor - 1)
        else if (sequence === '\x1b[C') state.cursor = Math.min(state.draft.length, state.cursor + 1)
        else if (sequence === '\x1b[H' || sequence === '\x1bOH') state.cursor = 0
        else if (sequence === '\x1b[F' || sequence === '\x1bOF') state.cursor = state.draft.length
        else if (sequence === '\x1b[3~') state.draft.splice(state.cursor, 1)
        // ⌥⌫ (\x1b\x7f) fails closed too: engines may disagree on word boundaries.
        else { state.known = false; state.draft = [] }
        continue
      }
      if (char === '\x1b') { state.escape = char; escaped = true; continue }
      if (state.paste) { insert(char); continue }
      if (char === '\r') {
        if (state.known && state.draft.length) this.prepare(agentId, state.draft.join(''), tabId)
        else if (!state.known) {
          // A recalled/edited prompt might equal an older pending prompt. Retain the uncertainty
          // until the engine accepts input; matching that older text alone would assign its swarm.
          state.submissions.push({ hash: null, teamId: null, introduction: false, expires: this.now() + TTL })
          if (state.submissions.length > LIMIT) state.submissions.shift()
        }
        state.draft = []; state.cursor = 0; state.known = true
      } else if (char === '\x03') {
        state.draft = []; state.cursor = 0; state.known = true
      } else if (char === '\x7f' || char === '\b') {
        if (state.cursor > 0) state.draft.splice(--state.cursor, 1)
      } else if (char === '\x01') state.cursor = 0
      else if (char === '\x05') state.cursor = state.draft.length
      else if (char === '\x15') { state.draft.splice(0, state.cursor); state.cursor = 0 }
      else if (char === '\x0b') state.draft.splice(state.cursor)
      else if (char === '\n') insert(char)
      else if (char < ' ' || char === '\x7f') { state.known = false; state.draft = [] }
      else insert(char)
    }
  }
}
