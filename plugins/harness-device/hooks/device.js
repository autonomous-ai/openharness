// The voice half of harness-device: it keeps one long poll open to the Harness daemon, and a prompt the person says
// at the dial comes back as its answer and is submitted as theirs. A waiting prompt is the PermissionRequest hook's to
// tell, but on Windows the mod's (below).
// When the Claude app shows this session, the mod posts its own session id, and nothing else, to the devices process's
// own socket, so the dial can turn to it; never through the daemon's core.
// On Windows a mod reaches no pipe and has no HMAC (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 2), so the mod
// runs the harness command instead, which proves the daemon's and the devices' tokens in its own process:
// `harness device claude inbox` holds the poll and prints each answer as a JSON line, and `harness device claude attach`
// tells the devices. No token, pipe name or other credential reaches the mod there.
const INBOX = 'http://harness/api/hook/inbox'
const DEVICES = 'http://harness/'
const LINK = ['device', 'claude', 'link', '--json']
const FOLLOW = ['device', 'claude', 'inbox']
const TELL = ['device', 'claude', 'attach']
const ASKED = ['device', 'claude', 'asked']
const SENT = '{"sent":true}'
// No launcher, no daemon, no dial watching: the daemon answers at once, so ask again only this often.
const RETRY_MS = 60_000
// A 404, or a launcher that exits non-zero, is a Harness older than the inbox: it does not change before an update. On
// Windows `inbox`'s `{"off":true}` waits as long, and so does a sixth follower in a row that ended under RAN_MS.
const OLD_HARNESS_MS = 10 * 60_000
// An empty answer sooner than this was not held, and polling again at once would spin.
const HELD_MS = 1_000
// A link with no devices' socket (no dial attached yet, the daemon restarting) asks the launcher again at an attach, at
// most this often, so the app switching sessions does not start a process each time; on Windows, so does an `attach`
// that did not tell.
const RELINK_MS = 30_000
// `link` reads one file and checks one socket, and `attach` sends one message, so each answers as the CLI starts; under
// RELINK_MS, so two never run at once.
const RELINK_TIMEOUT_MS = 5_000
// `asked` bounds its post at 1 s: the hook's own timeout.
const ASKED_TIMEOUT_MS = 5_000
// Windows: a follower that ran this long was holding polls, so the next starts after RESTART_MS and the count of quick
// ends starts over. Quick ends in a row start again after 1, 2, 4, 8 and 16 s, and the sixth waits OLD_HARNESS_MS.
const RAN_MS = 60_000
const RESTART_MS = 1_000
const QUICK_ENDS = 5
// The longest line `inbox` prints, a text of 20,000 characters each escaped to six, is under this: a longer one is not
// the command's, and is read no further.
const MAX_LINE = 131_072
const PLUGIN_ID = 'harness-device@openharness'

/** @type {import('claude-code').Register} */
export const register = (on) => {
  /** @type {State} */
  const state = { linked: null, held: false, askedAt: null, windows: false, quick: 0, shown: 0 }
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Asked here, so an attach after the start knows it. Refused, the mod takes the socket's way, as before it asked.
    state.windows = (await $.session.info().catch(() => null))?.platform === 'windows'
    // From a timer, not awaited here: the hook's budget would count the waits between polls.
    $.clock.after(0, () => void (state.windows ? follow($, state) : link($, state)))
    // An attach before this answer took the socket's way, which Windows has not: it is told now.
    if (state.windows && state.held) $.clock.after(0, () => void tell($, state))
    return started
  })
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    const attached = await next(e)
    state.held = true
    state.shown += 1
    // On Windows the harness command tells the devices. Elsewhere, unlinked, the link sends it if it has their socket.
    if (state.windows) $.clock.after(0, () => void tell($, state))
    else if (state.linked) $.clock.after(0, () => void send($, state))
    return attached
  })
  on('session.detach', { surface: 'desktop' }, async ($, e, next) => {
    const detached = await next(e)
    // The app no longer shows it: an attach not sent yet must not be.
    state.held = false
    state.shown += 1
    return detached
  })
  // Claude Code waits on the PermissionRequest hooks before the person can answer, and on Windows without Git Bash it
  // starts the plugin's hook in Windows PowerShell, 3-6 s (the VM notes, Task 2). So there the mod, which hears the
  // prompt above that hook, tells of it, from a timer so the prompt waits on no `asked`. The variable, set for the hooks
  // Claude Code starts after, says so: the hook's Windows halves then run nothing. Where this hook is passed over (an
  // organization's Claude Code) or the variable is not set, the hook tells, as before the mod did.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (state.windows) {
      const set = await $.env.set('HARNESS_DEVICE_MOD_ASKS', '1').catch(() => ({ deny: 'refused' }))
      if (!set.deny) $.clock.after(0, () => void ask($, e).catch(() => {}))
    }
    return next(e)
  })
}

/** @typedef {import('claude-code').EngineInterface} Engine */

/**
 * The session's own, made in `register` so a reload starts it over. `linked`: the launcher's last answer with a socket,
 * null before and once the plugin is off. `held`: the app shows this session and the devices have not been told.
 * `askedAt`: when the launcher was last asked again for the devices' socket; on Windows, when `attach` last ran, until
 * it tells. `windows`: the session runs on Windows. `quick`: the followers in a row that ended under RAN_MS. `shown`:
 * the desktop's attaches and detaches so far, so a Windows `attach` knows whether one came while it ran.
 * @typedef {{ linked: Linked | null, held: boolean, askedAt: number | null, windows: boolean, quick: number, shown: number }} State
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
    // Off, it stays held, as when the poll notices first: the link that follows switching on again sends it.
    if (!(await isOn($, settingsPath))) return
    // Checked again and cleared with no await before the fetch: a detach during the read, or a second timer, sends nothing.
    if (!state.held) return
    state.held = false
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
  // Held still only if no detach came while the launcher ran. From a timer, so a reload while it ran cancels it.
  $.clock.after(0, () => void send($, state))
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

/**
 * Windows: one follower, then the next from a timer, so a reload (which cancels the module's timers and ends the loop)
 * starts no other beside the new copy's. Leaving the loop kills nothing there: Claude Code closes the follower's stdout,
 * and it ends at its next write, within a minute, while the new copy's poll ends its hold in the core (the VM notes,
 * Task 15). Bounded: a `harness` that ends at once starts six times in about 10.5 minutes.
 * @param {Engine} $
 * @param {State} state
 */
async function follow($, state) {
  try {
    const startedAt = await $.clock.now()
    // A call the engine refuses ($.env.get, say) is tried again later, as on the socket's way.
    const end = await followOnce($).catch(() => /** @type {End} */ ('missing'))
    if (end === 'none') return
    const ran = (await $.clock.now()) - startedAt
    $.clock.after(restartAfter(state, end, ran), () => void follow($, state))
  } catch {
    // A reload ends the loop and unloads this copy, whose $ then refuses every call: the new copy follows.
  }
}

/**
 * Windows: how long before the next follower, after one that ended this way and ran this long.
 * @param {State} state
 * @param {End} end
 * @param {number} ran
 * @returns {number}
 */
function restartAfter(state, end, ran) {
  if (end === 'missing') return RETRY_MS
  if (end === 'off') {
    state.quick = 0
    return OLD_HARNESS_MS
  }
  if (ran >= RAN_MS) {
    state.quick = 0
    return RESTART_MS
  }
  if (state.quick === QUICK_ENDS) {
    state.quick = 0
    return OLD_HARNESS_MS
  }
  return RESTART_MS * 2 ** state.quick++
}

/**
 * Windows: runs `harness device claude inbox` for this session to its end, and submits each text it prints as the
 * person's. 'off': it printed `{"off":true}`. 'missing': no `harness` on PATH, so no Harness here. 'none': this Claude
 * Code has no $.process.spawn, so no voice here, as with a Harness older than the inbox. 'ended': it exited, was
 * killed, could not start or printed a line too long.
 * @typedef {'off' | 'missing' | 'none' | 'ended'} End
 * @param {Engine} $
 * @returns {Promise<End>}
 */
async function followOnce($) {
  const { profile, launcher } = await harnessOf($)
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const settingsPath = configDir ? `${configDir}\\settings.json` : profile ? `${profile}\\.claude\\settings.json` : ''
  const argv = [launcher, ...FOLLOW, await $.session.id()]
  let child
  try {
    // In the profile: a follower that outlives its session holds no project folder open.
    child = $.process.spawn({ argv, cwd: profile })
  } catch {
    return 'none'
  }
  let off = false
  let pulled = false
  let rest = ''
  try {
    for await (const { stream, text } of child) {
      pulled = true
      if (stream !== 'stdout') continue
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      // Leaving the loop closes the child's stdout: it ends at its next write (the VM notes, Task 15).
      if (rest.length > MAX_LINE || lines.some((line) => line.length > MAX_LINE)) return 'ended'
      for (const line of lines) {
        const said = parsed(line)
        if (said?.off === true) off = true
        // Checked at each text, as the poll checks it on the socket's way: nothing said at the dial reaches a session
        // after `harness device claude disable`.
        else if (typeof said?.text === 'string' && said.text !== '' && (await isOn($, settingsPath))) {
          // Not awaited, as on the socket's way: it resolves only once the turn starts.
          $.prompt.submit({ text: said.text, asUser: true }).catch(() => {})
        }
      }
    }
  } catch {
    // The first pull rejects when the command cannot start.
    if (!pulled && launcher === 'harness') return 'missing'
  }
  return off ? 'off' : 'ended'
}

/**
 * A line `inbox` printed, parsed; undefined when it is not JSON.
 * @param {string} line
 * @returns {any}
 */
function parsed(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Windows: tells the devices the app shows this session through `harness device claude attach`. Not told, the session
 * stays held unless a detach came, and the next attach runs it again, at most once in RELINK_MS. Told, while the app
 * left the session and came back, it runs again: the devices may have heard of another session since.
 * @param {Engine} $
 * @param {State} state
 */
async function tell($, state) {
  const now = await $.clock.now()
  // Checked and set with no await between, so two attaches' timers run it once.
  if (!state.held || (state.askedAt !== null && now - state.askedAt < RELINK_MS)) return
  state.askedAt = now
  const shown = state.shown
  if (!(await told($).catch(() => false))) return
  // The app back on this session after another tells again at once.
  state.askedAt = null
  if (state.shown === shown) state.held = false
  // From a timer, so a reload while it ran cancels it.
  else $.clock.after(0, () => void tell($, state))
}

/**
 * Windows: whether `attach` told the devices, its first line `{"sent":true}`.
 * @param {Engine} $
 * @returns {Promise<boolean>}
 */
async function told($) {
  const { profile, launcher } = await harnessOf($)
  const out = await $.process.run([launcher, ...TELL, await $.session.id()], { timeoutMs: RELINK_TIMEOUT_MS, cwd: profile })
  return out.stdout.split('\n')[0] === SENT
}

/**
 * Windows: tells the daemon a prompt waits through `harness device claude asked`, the hook's input on its stdin, as the
 * hook gives it. What it prints and how it exits are dropped, as the hook drops them: they decide nothing.
 * @param {Engine} $
 * @param {unknown} input
 */
async function ask($, input) {
  const { profile, launcher } = await harnessOf($)
  await $.process.run([launcher, ...ASKED], { stdin: JSON.stringify(input), timeoutMs: ASKED_TIMEOUT_MS, cwd: profile })
}

/**
 * Windows: the profile, and the `harness` to run there: the install's own harness.exe when it is there, else `harness`
 * on PATH. Looked for with $.fs.exists: a missing absolute path starts and exits 1 there, never rejecting (Task 2).
 * @param {Engine} $
 * @returns {Promise<{ profile: string | undefined, launcher: string }>}
 */
async function harnessOf($) {
  const profile = await $.env.get('USERPROFILE')
  const installed = `${profile}\\.harness\\bin\\harness.exe`
  return { profile, launcher: profile && (await $.fs.exists(installed)) ? installed : 'harness' }
}
