// The voice half of harness-device: it keeps one long poll open to the Harness daemon, and a prompt the person says
// at the dial comes back as its answer and is submitted as theirs. Approvals are the PermissionRequest hook's.
const INBOX = 'http://harness/api/hook/inbox'
const LINK = ['device', 'claude', 'link', '--json']
// No launcher, no daemon, no dial watching: the daemon answers at once, so ask again only this often.
const RETRY_MS = 60_000
// A 404 is a Harness older than the inbox: it will not learn the route before an update.
const OLD_HARNESS_MS = 10 * 60_000
// An empty answer sooner than this was not held, and polling again at once would spin.
const HELD_MS = 1_000

/** @type {import('claude-code').Register} */
export const register = (on) =>
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // From a timer, not awaited here: the hook's budget would count the waits between polls.
    $.clock.after(0, () => void link($))
    return started
  })

/** @typedef {import('claude-code').EngineInterface} Engine */

/**
 * Learns the daemon's socket from the launcher, then polls over it; without one, asks again later.
 * @param {Engine} $
 */
async function link($) {
  const socketPath = await socketOf($)
  if (socketPath === undefined) $.clock.after(RETRY_MS, () => void link($))
  else $.clock.after(0, () => void poll($, socketPath))
}

/**
 * @param {Engine} $
 * @returns {Promise<string | undefined>}
 */
async function socketOf($) {
  const home = await $.env.get('HOME')
  const launchers = home ? [`${home}/.local/bin/harness`, 'harness'] : ['harness']
  for (const launcher of launchers) {
    let out
    try {
      out = await $.process.run([launcher, ...LINK])
    } catch {
      continue // It cannot start: the next one.
    }
    if (out.exitCode !== 0) return undefined
    try {
      const { socketPath } = JSON.parse(out.stdout)
      return typeof socketPath === 'string' && socketPath !== '' ? socketPath : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * One poll, and the next from a timer, even one due at once: a reload cancels the module's timers, so no poll of the old
 * copy goes on beside the new one's.
 * @param {Engine} $
 * @param {string} socketPath
 */
async function poll($, socketPath) {
  const wait = await pollOnce($, socketPath)
  $.clock.after(wait, () => void poll($, socketPath))
}

/**
 * One poll; resolves how long to wait before the next, 0 for at once.
 * @param {Engine} $
 * @param {string} socketPath
 * @returns {Promise<number>}
 */
async function pollOnce($, socketPath) {
  const sentAt = await $.clock.now()
  let answer
  try {
    answer = await $.http.fetch(INBOX, {
      method: 'POST',
      socketPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: await $.session.id() }),
    })
  } catch {
    return RETRY_MS
  }
  if (answer.status === 404) return OLD_HARNESS_MS
  if (answer.status !== 200) return RETRY_MS
  let text
  try {
    text = JSON.parse(answer.text).text
  } catch {
    return RETRY_MS
  }
  if (typeof text === 'string' && text !== '') {
    // Not awaited: it resolves only once the session is idle and the turn starts, and the next poll opens now. A
    // refused prompt is the person's to see in the session, not a reason to stop listening.
    $.prompt.submit({ text, asUser: true }).catch(() => {})
    return 0
  }
  return (await $.clock.now()) - sentAt >= HELD_MS ? 0 : RETRY_MS
}
