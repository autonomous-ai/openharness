/**
 * When About You should be built or brought up to date, without the person asking.
 *
 * The first build is due as soon as there is anything to build from. After that, an update is due once
 * the person has sent enough new messages since the last build, and not more than once a day: a profile
 * of how someone works does not change by the hour, and each build is a turn on the model they chose.
 */

export const NEW_MESSAGES = 200
export const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

const dayKey = (at) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** The person's messages on days after `since` (the build day itself is not counted twice). */
export function messagesSince(activity, since) {
  const after = dayKey(since)
  return (activity ?? []).reduce((sum, row) => (row.day > after ? sum + (row.asks ?? 0) : sum), 0)
}

/** `{ due, first, reason, newMessages }` for one snapshot. */
export function due(snap, { now = Date.now(), newMessages = NEW_MESSAGES, minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const asks = snap?.sessions?.asks ?? 0
  const saved = (snap?.memories ?? []).filter((row) => row.kind === 'you').length
  if (!snap?.about) {
    if (asks > 0 || saved > 0) return { due: true, first: true, reason: 'no About You yet', newMessages: asks }
    return { due: false, first: true, reason: 'nothing to build from yet', newMessages: 0 }
  }
  const fresh = messagesSince(snap.sessions?.activity, snap.about.modified)
  if (now - snap.about.modified < minIntervalMs) return { due: false, first: false, reason: 'built in the last day', newMessages: fresh }
  if (fresh < newMessages) return { due: false, first: false, reason: `${fresh} new messages since the last build`, newMessages: fresh }
  return { due: true, first: false, reason: `${fresh} new messages since the last build`, newMessages: fresh }
}

/** The turn the pane gives its own agent: plain words, as if the person had typed them. */
export function buildRequest(state) {
  return state.first ? 'Build my About You.' : 'Update my About You with what I have said since it was last built.'
}
