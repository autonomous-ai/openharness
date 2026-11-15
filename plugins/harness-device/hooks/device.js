// The voice half of harness-device: it keeps one long poll open to the Harness daemon, and a prompt the person says
// at the dial comes back as its answer and is submitted as theirs. A waiting prompt is the PermissionRequest hook's to tell.
// When the Claude app shows this session, the mod posts its own session id, and nothing else, to the devices process's
// own socket, so the dial can turn to it; never through the daemon's core.
const INBOX = 'http://harness/api/hook/inbox'
const DEVICES = 'http://harness/'
const LINK = ['device', 'claude', 'link', '--json']
// No launcher, no daemon, no dial watching: the daemon answers at once, so ask again only this often.
const RETRY_MS = 60_000
// A 404, or a launcher that exits non-zero, is a Harness older than the inbox or one with no socket here (Windows):
// neither changes before an update.
const OLD_HARNESS_MS = 10 * 60_000
// An empty answer sooner than this was not held, and polling again at once would spin.
const HELD_MS = 1_000
// A link with no devices' socket (no dial attached yet, the daemon restarting) asks the launcher again at an attach, at
// most this often, so the app switching sessions does not start a process each time.
const RELINK_MS = 30_000
// `link` reads one file and checks one socket, so it answers as the CLI starts; under RELINK_MS, so two never run at once.
const RELINK_TIMEOUT_MS = 5_000
const PLUGIN_ID = 'harness-device@openharness'

/** @type {import('claude-code').Register} */
export const register = (on) => {
  /** @type {State} */
  const state = { linked: null, held: false, askedAt: null }
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // From a timer, not awaited here: the hook's budget would count the waits between polls.
    $.clock.after(0, () => void link($, state))
    return started
  })
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    const attached = await next(e)
    state.held = true
    // Unlinked, the link sends it if it has a devices' socket.
    if (state.linked) $.clock.after(0, () => void send($, state))
    return attached
  })
  on('session.detach', { surface: 'desktop' }, async ($, e, next) => {
    const detached = await next(e)
    // The app no longer shows it: an attach not sent yet must not be.
    state.held = false
    return detached
  })
}

/** @typedef {import('claude-code').EngineInterface} Engine */

/**
 * The session's own, made in `register` so a reload starts it over. `linked`: the launcher's last answer with a socket,
 * null before and once the plugin is off. `held`: the app shows this session and the devices have not been told.
 * `askedAt`: when the launcher was last asked again for the devices' socket.
 * @typedef {{ linked: Linked | null, held: boolean, askedAt: number | null }} State
 */

/**
 * Learns the daemon's socket from the launcher, then polls over it; without one, asks again later.
 * @param {Engine} $
 * @param {State} state
 */
async function link($, state) {
  // A call the engine refuses ($.env.get, say) is tried again later, not the end of the voice for the session.
  const found = await socketOf($).catch(() => ({ wait: RETRY_MS }))
  if ('socketPath' in found) {
    state.linked = found
    $.clock.after(0, () => void poll($, state, found))
    // With no devices' socket the launcher just said so: the attach stays held, and the next asks again.
    if (state.held && found.devicesSocket) $.clock.after(0, () => void send($, state))
  } else $.clock.after(found.wait, () => void link($, state))
}

/**
 * Tells the devices the app shows this session, once; a failed send is dropped. Without their socket, asks the launcher
 * that linked again, at most once in RELINK_MS, and sends once it prints one.
 * @param {Engine} $
 * @param {State} state
 */
async function send($, state) {
  if (!state.held || !state.linked) return
  const { devicesSocket, settingsPath, launcher } = state.linked
  if (devicesSocket) {
    state.held = false
    if (!(await isOn($, settingsPath))) return
    await $.http.fetch(DEVICES, {
      method: 'POST',
      socketPath: devicesSocket,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'attach', sessionId: await $.session.id() }),
    }).catch(() => {})
    return
  }
  const now = await $.clock.now()
  // Checked and set with no await between, so two attaches' timers ask once.
  if (state.askedAt !== null && now - state.askedAt < RELINK_MS) return
  state.askedAt = now
  const found = await devicesSocketOf($, launcher).catch(() => '')
  if (!found || !state.linked) return
  state.linked = { ...state.linked, devicesSocket: found }
  // Held still only if no detach came while the launcher ran.
  await send($, state)
}

/**
 * The devices' socket the launcher prints now, '' for none.
 * @param {Engine} $
 * @param {string} launcher
 * @returns {Promise<string>}
 */
async function devicesSocketOf($, launcher) {
  const out = await $.process.run([launcher, ...LINK], { timeoutMs: RELINK_TIMEOUT_MS })
  if (out.exitCode !== 0) return ''
  const { devicesSocket } = JSON.parse(out.stdout)
  return typeof devicesSocket === 'string' ? devicesSocket : ''
}

/**
 * The socket the launcher prints, with the settings that say the plugin is on, or how long to wait before asking again.
 * @param {Engine} $
 * @returns {Promise<Linked | { wait: number }>}
 */
async function socketOf($) {
  const home = await $.env.get('HOME')
  const claudeHome = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : '')
  const settingsPath = claudeHome ? `${claudeHome}/settings.json` : ''
  const launchers = home ? [`${home}/.local/bin/harness`, 'harness'] : ['harness']
  for (const launcher of launchers) {
    let out
    try {
      out = await $.process.run([launcher, ...LINK])
    } catch {
      continue // It cannot start: the next one.
    }
    if (out.exitCode !== 0) return { wait: OLD_HARNESS_MS }
    try {
      const { socketPath, devicesSocket } = JSON.parse(out.stdout)
      if (typeof socketPath !== 'string' || socketPath === '') return { wait: RETRY_MS }
      return { socketPath, settingsPath, devicesSocket: typeof devicesSocket === 'string' ? devicesSocket : '', launcher }
    } catch {
      return { wait: RETRY_MS }
    }
  }
  return { wait: RETRY_MS }
}

/**
 * The launcher's answer: the daemon's socket, the devices' ('' when it printed none), and the launcher that answered.
 * @typedef {{ socketPath: string, settingsPath: string, devicesSocket: string, launcher: string }} Linked
 */

/**
 * One poll, and the next from a timer, even one due at once: a reload cancels the module's timers, so no poll of the old
 * copy goes on beside the new one's. With the plugin off, the launcher is asked again, and answers off.
 * @param {Engine} $
 * @param {State} state
 * @param {Linked} linked
 */
async function poll($, state, linked) {
  const wait = await pollOnce($, linked).catch(() => RETRY_MS)
  if (wait === null) {
    state.linked = null
    $.clock.after(0, () => void link($, state))
  } else $.clock.after(wait, () => void poll($, state, linked))
}

/**
 * One poll; resolves how long to wait before the next, 0 for at once, or null once the plugin is off.
 * @param {Engine} $
 * @param {Linked} linked
 * @returns {Promise<number | null>}
 */
async function pollOnce($, { socketPath, settingsPath }) {
  const sentAt = await $.clock.now()
  let answer = null
  try {
    answer = await $.http.fetch(INBOX, {
      method: 'POST',
      socketPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: await $.session.id() }),
    })
  } catch {
    // No daemon: still asked whether the plugin is on, so a session that waits for one stops too.
  }
  // Checked once the poll is back, before its text: a session started before `harness device claude disable` keeps
  // this module loaded, and nothing said at the dial may reach it after.
  if (!(await isOn($, settingsPath))) return null
  if (!answer) return RETRY_MS
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

/**
 * Whether the plugin is on, as `harness device claude link` and `asked` read it (cli/src/deviceClaude/plugin.ts
 * `claudePluginOn`): its entry in Claude Code's user settings, gone once `disable` uninstalls it. One read, which the
 * engine bounds. Settings it cannot read leave it on, as before this check.
 * @param {Engine} $
 * @param {string} settingsPath
 * @returns {Promise<boolean>}
 */
async function isOn($, settingsPath) {
  if (!settingsPath) return true
  let settings
  try {
    settings = JSON.parse(await $.fs.read(settingsPath))
  } catch {
    return true
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true
  const plugins = settings.enabledPlugins
  return !!plugins && typeof plugins === 'object' && plugins[PLUGIN_ID] === true
}
