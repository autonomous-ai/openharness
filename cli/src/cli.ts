#!/usr/bin/env node
import './config/loadEnv.js'
import { runDevicesCommand } from './devices/client.js'
import { fingerprint as e2eeCoreFingerprint, b64d as e2eeCoreDecode } from './lib/e2ee/core.js'
/**
 * machine-adapter CLI (the `harness` command) — connect this computer to a "remote" agent.
 *
 * Terminology: the MACHINE signs in with SSO (`harness login` → durable session); a BROWSER
 * *pairs* with the computer for end-to-end encryption (`pair`/`unpair`/`pairings`, code + fingerprint).
 * Keeping "pair" for the browser relationship only avoids overloading the word across two trust relations.
 *
 *   harness login           opens native loopback SSO and saves this computer's session.
 *   harness start           refreshes that session, resolves the machine, and starts the adapter.
 *
 * What runs: engine hooks/plugins (session metadata → localhost hook server → process registry),
 * transcript/store readers, tmux process discovery,
 * and the backend socket (events up / chat + RPCs down).
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, openSync, existsSync, rmSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { createServer } from 'http'
import { createInterface, emitKeypressEvents } from 'readline'
import { homedir, hostname } from 'os'
import { env } from './config/env.js'
import { VERSION } from './version.js'
import { runCore, runCoreInForeground } from './core/main.js'
import { GRID_MINT_TIMEOUT_MS, backendHttpBase, requestJson, postJson, controlPlaneAuth } from './lib/controlPlane.js'
import { LEGACY_LOG_FILE, MACHINE_NAME_FILE, tildify, computerId, thisDeviceLabel, DAEMON_LOG_FILE, HARNESSD_STATUS_FILE, daemonPort, isAlive, isDaemonRunning, readPid } from './lib/daemonState.js'
import { onError, BIND_WAIT_MS, connectFailure, defaultLaunchDeps, waitForBind } from './lib/daemonLaunch.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { buildLogBundle, bundleFileName, redactSecretsInText } from './lib/logBundle.js'

import { machineListCachePath } from './device/machineList.js'
import { registry } from './lib/registry.js'
import { readSafeModeMarker } from './lib/daemonSafeMode.js'
import { SpawnLockBusyError, describeSpawnLockBusyPlainly, describeSpawnLockFailure, describeSpawnLockOwner, describeSpawnLockWaitPlainly, withSpawnLock } from './lib/daemonSpawnLock.js'
import { stopDaemonProcess } from './lib/daemonStop.js'
import { installedPlatform, serviceDefinition, startUnderPlatform } from './lib/platformDaemon.js'
import { serviceCommand, serviceCommandDeps } from './lib/serviceCommand.js'
import { flashCommand } from './lib/flash.js'
import { awaitLoginCallback, extractCallbackParams, LOGIN_TIMEOUT_MESSAGE, type LoginCallbackParams } from './lib/loginCallback.js'
import { AUTH_DIR, AuthSessionError, AuthSessionManager, clearAuthSession, knownSsoClientId, newSignInEpoch, readAuthSession, ssoClientIdFor, writeAuthSession, type AuthSession } from './lib/authSession.js'
import { handOffToGrid } from './lib/gridHandoff.js'
import { qrSignIn } from './lib/qrSignIn.js'
import { pickSignInMethod, signInMethodFlag, signInProviderName, withSignInProvider, type SignInMethod, type SignInProvider } from './lib/signInMethodPicker.js'
import { watchJsonDriver, type JsonDriver } from './lib/jsonDriver.js'
import { terminalQr } from './lib/terminalQr.js'
import { ensureHarnessGrid, type EnsureStatus } from './lib/gridEnsure.js'
import { passThroughToGridLogout } from './lib/gridLogout.js'
import { warnIfGridSignInRemains } from './lib/gridCredentials.js'
import { gridExec } from './lib/gridExec.js'
import { ENGINE_CLI_COMMANDS, PROCESS_ENGINES } from './lib/engineBin.js'
import { SESSION_SEARCH_FILE, searchCommand } from './lib/sessionSearch/command.js'
import { dshCommand, dshUsage } from './dsh/command.js'
import { ApiConnections } from './lib/apiConnections.js'
import { apiCommand, apiUsage } from './lib/apiCommand.js'
import { remoteCommand } from './remoteCommand.js'
import { tuiCommand } from './tui/index.js'
import { newCommand } from './lib/newCommand.js'
import { gridSetupCommand } from './lib/gridSetupCommand.js'
import { WebSocket as NewCommandSocket } from 'ws'
import { describeMasterStatus, readStatusFile } from './harnessd/master.js'
import { namedNode } from './harnessd/processName.js'
import { probeThisMaster, startMaster } from './masterProcess.js'
import { startServiceProcess } from './serviceProcess.js'
import { isLocalSocketName } from './lib/localSocket.js'
import { legacyDaemonStatus, localDaemonStatus } from './lib/daemonEndpoint.js'
import { runAutonomousDeviceCommand } from './lib/autonomous-device/command.js'
import { E2eeStore, identitySpent, peekIdentityPub } from './lib/e2ee/store.js'
import { confirmsRemoval, deviceRegistration, deviceStatusValue, formatDeviceDetail, formatDeviceHistory, formatDeviceList, logOrder, removeConfirmation } from './lib/e2ee/deviceDisplay.js'
import { b64e } from './lib/e2ee/core.js'
import { MachinePeerStore } from './lib/e2ee/machinePeers.js'
import { connectWithPassword, type PwConnectProgress } from './lib/e2ee/relayClient.js'
import type { LinkedPeer } from './lib/e2ee/manager.js'
import { DeviceLogStore } from './lib/e2ee/deviceLogStore.js'
import { TrustGroupStore } from './lib/e2ee/trustGroup.js'
import { confirm as confirmUpdate, fetchManifest, downloadVerified, canary, stage, semverGt, isLocalDevBuild, type UpdateEntry } from './lib/selfUpdate.js'
import { managedNodePath } from './lib/nodeRuntime.js'
import { updateManagedTui } from './tui/manage.js'
import { ensureHnLauncher, ensureLauncher, ensureManagedGrid, ensureManagedRuntime } from './lib/runtimeInstall.js'
// Before ANY child is spawned: on Linux an absent locale makes tmux and ps mangle their output,
// which silently costs the daemon every pane it would have discovered. See lib/childLocale.ts.
ensureUtf8Locale()
import { prepareLogFile } from './lib/log.js'


// Daemon stdout/stderr. Capped at LOG_MAX_BYTES — see prepareLogFile/trimLogFile in lib/log.ts.
const LOG_FILE = DAEMON_LOG_FILE


function usage(exitCode = 0): never {
  console.log(`harness v${VERSION} — connect this computer to your machine

Agents — after "harness start", run the vendor CLI directly inside tmux. Harness discovers supported
top-level processes automatically; it does not launch them or change their permission flags:
${PROCESS_ENGINES.map((engine) => `  ${ENGINE_CLI_COMMANDS[engine]}`).join('\n')}
A launcher that hands the pane to one of these works the same — "ori claude" is a Claude Code agent.

Machine:
  harness login                sign in (asks: Google or Apple in your browser, or scan a QR with your phone)
  harness login --google       sign in with Google in your browser, without asking
  harness login --apple        sign in with Apple in your browser, without asking
  harness login --qr           sign in by scanning a QR with Harness on your phone, without asking
  harness login --force        stop the daemon and sign in with a different account
  harness login --json         emit machine-readable NDJSON instead of opening a browser (for GUI clients)
  harness login --entry-point=desktop   record which surface started the sign-in (GUI clients; default cli)
  harness auth status --json   print {loggedIn,...} for this computer's saved session
  harness start                start the adapter using the saved SSO session
  harness start -f             run the adapter in the FOREGROUND (for a supervisor; logs to stdout)
  harness start --device-dump[=<file>]
                               record every frame to/from the paired Autonomous device, decrypted, as
                               JSON lines (default ~/.harness/logs/device-dump-<time>.jsonl). Contains
                               prompts and answers in the clear — diagnostics only. Stop the daemon first.
  harness start --repair       also re-verify the managed Node runtime and repoint the launcher at it
                               (normally done once by the installer; use this if a start fails because
                               the launcher points at a Node that no longer runs)
  harness logout               stop the adapter and clear this computer's SSO session
  harness stop                 stop the background adapter (keeps the SSO session)
  harness reset                stop the adapter and clear local CLI state
  harness status               show whether it's running (+ version)
  harness service install      run the daemon under launchd (macOS) or systemd (Linux): it starts at login
                               and comes back if it dies; start and stop then go through it (opt-in)
  harness service uninstall    undo that: the daemon goes back to \`harness start\`
  harness service status       what launchd or systemd has registered, and whether it runs (--json)
  harness logs export          zip the last 7 days of logs (app, CLI, dial, daemon) to the Desktop
  harness tui                  all of Harness in this terminal: swarms, panes, every machine (⌥O ⌥P ⌥N)
  harness new [agent] [@machine] [folder|name] [-- task]
                               make a harness from a shell: \`harness new\` is claude here; see \`harness new -h\`
  harness machines             list the machines on this account (this computer's is marked)
  harness search <words>       find the conversation on this computer that said them: every turn of
                               every harness, live or stopped (--limit=N, --json)
  harness channel --help       consult agents in a swarm and read shared collaboration history
  harness team --help          advanced team commands and correlated agent replies
  harness machines delete <id> remove ANOTHER machine (refuses this one; use \`harness logout\`)
  harness remote               from a Harness terminal tile: open a terminal on another of your machines and move this tile to it
  harness version              print the installed version (v${VERSION})
  harness update [--force]     update to the latest build now (it also self-updates in the background;
                               neither touches a local install-cli.sh build without --force)
  harness flash [flags]        re-flash a plugged-in circle device over USB. Flags go straight to the
                               flasher: --detect-only, --port, --version, --yes, --erase-nvs

Grid (the fleet of AI engines the \`grid\` CLI serves — needs \`grid\` on PATH):
  harness grid login           sign in to your grid reusing THIS computer's Autonomous account —
                               no second browser, no second approval
  harness grid login --force   sign the harness in as a different account first, then the grid
  harness grid login --json    emit the same machine-readable NDJSON \`harness login --json\` emits
  harness grid setup           have grid ready here through the running daemon: installed, signed in
                               with THIS computer's Harness account, and the account's grid made
  harness grid logout [flags]  sign out of your grid — the whole of \`grid logout\`, which stops what
                               this box is serving BEFORE deleting anything. Flags go straight to it:
                               --force signs out over a serve child it could not confirm stopped
  harness grid env <grid>      print <grid>'s relay address and key as shell exports, for
                               eval "$(harness grid env <grid>)" — through the harness's own \`grid\`

${dshUsage()}

${apiUsage}

Browser end-to-end encryption:
  harness autonomous-device <command>     pair/status/list/revoke an Autonomous device
  harness pair <code>          pair a BROWSER (code shown on the machine page)
  harness pairings             list paired clients
  harness unpair <#|fp>        unpair one browser (by list number or fingerprint)
  harness unpair --all         unpair every browser

Machine-to-machine linking (lets this machine's relay reach ANOTHER of your machines with the CLI,
not the app, terminating E2EE). A machine's remote password is persistent — set once, reused for
every future connect, until you change or clear it:
  harness remote-password set   set/rotate this machine's persistent remote password
  harness remote-password status   show whether one is set, and its fingerprint
  harness remote-password clear   remove this machine's remote password
  harness link connect <id>    join a machine using ITS remote password (fully automatic)
                               (--name=<label> names the machine in messages instead of its id)
  harness link list            list machines this one has linked
  harness link unlink <id>     remove a linked machine's trust
  harness group list           machines and phones that trust each other through links: link one
                               machine and every member reaches it both ways, no more passwords
  harness group sync           compare with every reachable member now (it also happens on its own)
  harness group remove <id>    drop a member (machine id, # or fingerprint) from every member
  harness devices list         the account's devices — signing in on one is what makes the others trust
                               it; a device you do not recognise is someone else signed in as you
  harness devices show <#|fp>  one device in full: its key code and how to check it on that device
  harness devices remove <fp>  take a device out of the account on every device, by key code (or its
                               first 4+ characters); a # or a shorter start asks first, --yes skips it
  harness devices history      every device added to or removed from the account, newest first, as this
                               machine verified it (--json for the rows)
  harness devices dismiss [<#|fp>]  mark every new device as seen, or just that one
  harness devices rebaseline   the device list froze (the backend served one that does not match what
                               this machine verified): show what changed, --yes to trust it again
  (both \`remote-password set\` and \`link connect\` prompt for the password interactively, or read one
  line from stdin with --stdin; add --json for NDJSON output instead of the human-readable text)

  harness --help

This computer's id lives at ${tildify(env.ADAPTER_COMPUTER_ID_FILE)} and is created once. Nothing here
regenerates it — that is what keeps "harness start" reconnecting to the same machine instead of
making a new one. Deleting it (or ~/.harness) makes this look like a brand-new computer. On a box with
no durable home, a container or CI job, pin ADAPTER_COMPUTER_ID instead.

Env: BACKEND_WS_URL (${env.BACKEND_WS_URL}), WEB_URL (${env.WEB_URL}), ADAPTER_DATA_DIR,
     ADAPTER_COMPUTER_ID, CLAUDE_PROJECTS_DIR, PORT`)
  process.exit(exitCode)
}

/** The `supervisor` row: who keeps the daemon running when it is not `harness start`. */
function supervisorRow(platform: string): string {
  return `${platform} · starts at login, comes back if it dies (harness service status)`
}


/** The currently-running script — dist/cli.js when built, src/cli.ts under tsx. */
const SCRIPT_PATH = fileURLToPath(import.meta.url)
ensureHnLauncher(SCRIPT_PATH)


// ── login ──────────────────────────────────────────────────────────────────────────────────────


/** Resolve the canonical machine for the durable computer id without ever using a machine API key. */
async function resolveComputerMachine(signal?: AbortSignal): Promise<AuthSession> {
  const current = readAuthSession()
  if (!current) throw new Error('Not signed in. Run `harness login`.')
  const auth = new AuthSessionManager(backendHttpBase())
  const accessToken = await auth.accessToken()
  const result = await postJson<{ machine?: { machineId?: string } }>('/api/machines/resolve-computer', {
    computerId: current.computerId,
    label: hostname(),
    // Same claim the adapter-ws dial carries: a machine deleted while this computer was offline must
    // come back as 403, not as a quietly minted replacement.
    ...(current.machineId ? { machineId: current.machineId } : {}),
  }, {
    authorization: `Bearer ${accessToken}`,
    'x-autonomous-env': current.autonomousEnv,
  }, signal)
  const machineId = result.machine?.machineId
  if (!machineId) throw new Error('Backend did not return a machine id for this computer')
  // Refresh can atomically replace the session while this request is in flight. Always merge the
  // machine id into the newest file so a stale caller never rolls its rotated refresh token back.
  const latest = readAuthSession()
  if (!latest) throw new Error('SSO session disappeared while resolving this computer')
  const next = latest.machineId === machineId
    ? latest
    : { ...latest, machineId, updatedAt: Date.now() }
  if (next !== latest) writeAuthSession(next)
  return next
}


/** This machine's device key code. Signing in is what puts the key into the account, so `create` makes
 *  the identity when it is missing; the read-only commands (`status`, `auth status`) only look, and
 *  show nothing rather than mint a key. Null whenever it cannot be had. */
function thisDeviceFingerprint(create: boolean): string | null {
  try {
    const pub = create ? b64e(new E2eeStore().init().pub) : peekIdentityPub()
    return pub ? e2eeCoreFingerprint(e2eeCoreDecode(pub)) : null
  } catch { return null }
}

/** `harness auth status --json` — one JSON line, always exit 0; logged-out is a valid answer, not a
 *  process failure. Reuses AuthSessionManager.accessToken() (not a raw file read) so a session that's
 *  on-disk-but-about-to-expire gets refreshed here rather than reporting loggedIn:true and 401ing on
 *  the caller's very next request. */
async function authStatusCommand(json: boolean): Promise<void> {
  const session = readAuthSession()
  if (!session) {
    // The computer id travels even signed out: it is the id this computer's daemon serves itself
    // under, and the app keys the local machine by it until a sign-in hands out a machineId.
    if (json) console.log(JSON.stringify({ loggedIn: false, computerId: computerId() }))
    else console.log('\n  ✗ Not signed in. Run: harness login\n')
    return
  }
  const auth = new AuthSessionManager(backendHttpBase())
  let loggedIn = true
  let offline = false
  try {
    await auth.accessToken()
  } catch (err) {
    // Only a session the SSO service will never renew (or none at all) is "not signed in". A refresh
    // that could not be SERVED right now — no network, service down — is a signed-in computer that is
    // offline, and says so; it used to read as signed out and send the desktop app to a login screen
    // that could not have succeeded either. Same split proxyBackend makes (401 vs 502).
    if (err instanceof AuthSessionError && err.code === 'UNAVAILABLE') offline = true
    else loggedIn = !(err instanceof AuthSessionError)
  }
  const latest = readAuthSession()
  const signedIn = loggedIn && latest !== null
  const fingerprintNow = thisDeviceFingerprint(false)
  const payload = {
    loggedIn: signedIn,
    ...(signedIn && offline ? { offline: true } : {}),
    computerId: latest?.computerId,
    machineId: latest?.machineId,
    autonomousEnv: latest?.autonomousEnv,
    expiresAt: latest?.expiresAt,
    method: latest?.method ?? 'sso',
    // Read-only: a machine that has not signed in yet has no key, and asking must not make one.
    ...(fingerprintNow ? { fingerprint: fingerprintNow } : {}),
  }
  if (json) console.log(JSON.stringify(payload))
  else {
    console.log(`\n  ${payload.loggedIn ? '✓ Signed in' : '✗ Not signed in'}${payload.machineId ? ` (machine ${payload.machineId})` : ''}${payload.loggedIn && payload.method === 'qr' ? ' — by your phone' : ''}\n`)
    // A session a phone approved is Harness's own: the Autonomous services behind billing and grid
    // do not take it. Say so where the person looks, not only when one of them refuses.
    if (payload.loggedIn && payload.method === 'qr') console.log('  Billing and grid need a Google or Apple sign-in: harness login --force\n')
  }
}

/**
 * `harness login` — and, `chained`, the first half of `harness grid login`.
 *
 * Returns whether this computer ended up signed in, so a caller can go on to its own step. `chained`
 * suppresses only the terminating SUCCESS line — the authorize URL, the SSH paste fallback and every
 * error line are the sign-in's to emit either way, and the caller adds the one result line that ends
 * the stream. Under `--json` a sign-in failure therefore still arrives as itself, coded, exactly
 * once; without it the sign-in throws, as `harness login` has always done, and the top-level handler
 * prints it.
 */
type SignInOutcome =
  /** Signed in — `alreadySignedIn` distinguishes a session that was already there from a fresh one,
   *  which is the one fact a caller cannot re-derive except by watching for an `authorize_url`. */
  | { signedIn: true; alreadySignedIn: boolean; stoppedDaemon?: boolean }
  /** Refused. Under `--json` its own coded result line has already been emitted. */
  | { signedIn: false }

/** What the `--json` client and the sign-in itself tell each other beyond the result line. */
interface SignInHooks {
  /** The --json client's answers. */
  driver?: JsonDriver | null
  /** The QR exists: how to take it back. */
  onStarted?: (cancel: () => Promise<void>) => void
  /** The person said yes / the browser came back: finish the sign-in, do not abandon it. */
  onCommitted?: () => void
}

/**
 * The account's private grid exists — its name minted or read, then the grid itself created if it is
 * not there yet.
 *
 * The second half of attaching a machine to grid, and the half `harness grid login` used to skip:
 * that command signed in and stopped, so an account whose grid had never been created was left
 * signed in to nothing, with an empty model picker and no way to tell why. Shared from here so the
 * sign-in's grid half and the explicit command cannot drift apart again.
 *
 * **The name is the backend's to mint and remember** — this CLI holds neither the account's email
 * nor its id (see `backend/src/routes/grid.ts`). A backend without the route is simply an older
 * backend: no grid is ensured, nothing fails, and the next sign-in after it ships picks this up.
 *
 * Best-effort throughout: every failure is a note through `note` and nothing more.
 */
async function ensureAccountGrid(note: (line: string) => void): Promise<{ status: EnsureStatus; name: string | null }> {
  let gridName: string | null = null
  try {
    const { headers } = await controlPlaneAuth()
    // Bounded like the daemon's own mint (reconcileGridAttach): a forced sign-in runs this under the
    // daemon spawn lock, and a stalled control-plane connection must not hold that lock open.
    gridName = (await postJson<{ gridName?: string }>('/api/grid/name', {}, headers, AbortSignal.timeout(GRID_MINT_TIMEOUT_MS))).gridName ?? null
  } catch (err) {
    note(`Could not read this account's grid name (${(err as Error).message}); skipping grid setup.`)
    return { status: 'skipped', name: null }
  }
  if (!gridName) return { status: 'skipped', name: null }
  const ensured = await ensureHarnessGrid(gridName)
  if (ensured.status === 'failed' || ensured.status === 'skipped') note(ensured.message)
  else if (ensured.status === 'created') note(`Created your private grid '${gridName}'.`)
  return { status: ensured.status, name: gridName }
}

async function loginCommand(
  foreground: boolean,
  force: boolean,
  json: boolean,
  opts: { chained?: boolean; entryPoint?: string; method?: SignInMethod | 'ask' } = {},
): Promise<SignInOutcome> {
  if (foreground) throw new Error('`harness login` does not run the adapter. Use `harness start -f`.')
  // Which surface asked to sign in. A person in a terminal is `cli`; the desktop app runs this same
  // command and says so with `--entry-point=desktop`. Analytics only — it names no privilege.
  const entryPoint = opts.entryPoint ?? 'cli'
  // Once the sign-in has been abandoned nothing more is written: the reader is gone, and a late line
  // would only meet a closed pipe.
  let abandoned = false
  const emit = (line: Record<string, unknown>): void => { if (json && !abandoned) console.log(JSON.stringify(line)) }
  // Harness only. Grid is an add-on: this computer is signed in to it the first time a grid feature is
  // used (`ensureGrid` in the daemon, `lib/gridAttach.ts`) — with this session's token, no second
  // browser — and never as a side effect of signing in to Harness.
  const succeed = async (alreadySignedIn: boolean, email?: string): Promise<SignInOutcome> => {
    if (opts.chained) return { signedIn: true, alreadySignedIn }
    // The key code is what the person compares on their other devices, so it is said at the moment the
    // machine joins them. Left out when it cannot be computed: the line is then exactly what it was.
    const fp = thisDeviceFingerprint(true)
    const device = fp ? ` · ${fp}` : ''
    if (json) emit(alreadySignedIn ? { type: 'result', status: 'success', alreadySignedIn: true, ...(fp ? { fingerprint: fp } : {}) } : { type: 'result', status: 'success', ...(email ? { email } : {}), ...(fp ? { fingerprint: fp } : {}) })
    else {
      const hint = '    Run `harness start` to connect this computer.'
      if (!fp) console.log(alreadySignedIn ? '\n  ✓ Already signed in. Run `harness start` to connect this computer.\n' : `\n  ✓ Signed in${email ? ` as ${email}` : ''}. Run \`harness start\` to connect this computer.\n`)
      else if (alreadySignedIn) console.log(`\n  ✓ Already signed in — this machine is "${thisDeviceLabel()}"${device}\n${hint}\n`)
      else console.log(`\n  ✓ Signed in${email ? ` as ${email}` : ''} — this machine joins your devices as "${thisDeviceLabel()}"${device}\n${hint}\n`)
    }
    return { signedIn: true, alreadySignedIn }
  }
  // Google or Apple in the browser, or a QR the phone scans. Asked only of a person at a terminal
  // with no flag. Nothing named — a client driving --json that predates the flags, a pipe — is the
  // browser still, on the sign-in page's own chooser.
  let method: SignInMethod | undefined = opts.method === 'ask' ? undefined : opts.method
  // The app driving --json: its answers, and its going away. A sign-in it left behind (the app quit
  // or restarted) would otherwise wait on — minutes, holding the daemon spawn lock — and the app's
  // next sign-in would sit behind it with nothing on screen. So while it waits on a person it takes
  // its QR back and stops. Once the person has said yes the sign-in finishes instead: the session
  // write is quick, and cancelling the code then would race its claim.
  const driver = json ? watchJsonDriver() : null
  const GONE = 'Sign-in stopped: the app that started it has gone.'
  let takeBack: (() => Promise<void>) | null = null
  let waiting = false
  let driverGone = false
  const abandon = async (message: string): Promise<void> => {
    if (abandoned) return
    emit({ type: 'result', status: 'error', code: 'CANCELLED', message })
    abandoned = true
    await Promise.race([takeBack?.() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3_000))])
    process.exit(1)
  }
  // An app that went away before the wait began (during the lock wait) is acted on the moment it does.
  const setWaiting = (on: boolean): void => {
    waiting = on
    if (on && driverGone) void abandon(GONE)
  }
  if (driver) {
    // EPIPE once the app has gone: `gone` handles that. Left unhandled it would crash the process
    // before the QR is taken back.
    process.stdout.on('error', () => {})
    void driver.gone.then(() => {
      driverGone = true
      if (waiting) void abandon(GONE)
    })
    // The app's Cancel / quit sends SIGTERM — the code goes back with it. Otherwise exit as SIGTERM
    // would, with the spawn-lock exit hook still run.
    process.on('SIGTERM', () => { if (waiting) void abandon('Sign-in was cancelled.'); else process.exit(143) })
  }
  const signIn = async (): Promise<SignInOutcome> => {
    try {
      return method === 'qr'
        ? await qrSignInCommand(json, emit, (email) => succeed(false, email), { driver, onStarted: (cancel) => { takeBack = cancel }, onCommitted: () => setWaiting(false) })
        : await browserSignIn(json, emit, () => succeed(false), { entryPoint, provider: method }, { onCommitted: () => setWaiting(false) })
    } finally {
      setWaiting(false)
    }
  }
  if (readAuthSession() && !force) {
    // Guarded exactly like the identical call after the exchange below. Unguarded, a hiccup on
    // `/api/machines/resolve-computer` reached `onError`, which is JSON-unaware — so the ONE mode a
    // client drives answered a stack trace and NO result line at all, on the commonest path there
    // is (a computer that is already signed in).
    try {
      await resolveComputerMachine()
    } catch (err) {
      // An `AuthSessionError` is passed on rather than coded here: it is not the backend failing, it
      // is THIS computer's harness session, and only the caller knows which of the two sign-ins the
      // person should be sent to. `harness login` is unaffected — it never caught this before either.
      if (json && !(err instanceof AuthSessionError)) {
        emit({ type: 'result', status: 'error', code: 'BACKEND_ERROR', message: (err as Error).message })
        process.exitCode = 1
        return { signedIn: false }
      }
      throw err
    }
    return await succeed(true)
  }
  if (opts.method === 'ask') {
    const picked = await askSignInMethod()
    if (!picked) {
      console.error('\n  ✗ Not signed in.\n')
      process.exitCode = 1
      return { signedIn: false }
    }
    method = picked
  }
  setWaiting(true)
  if (!force) return await signIn()
  // A forced login may intentionally switch SSO accounts. The old daemon must not keep streaming
  // under its existing socket while this process replaces the durable session — and no NEW daemon
  // may come up on the old session in the meantime. The desktop app re-runs `harness start` whenever
  // the control port goes quiet, which it does the moment the old daemon is stopped, and that start
  // reads whatever session is on disk: for as long as the browser is open, the old account's. The
  // daemon it spawned came up on the old account and stayed — the `harness start` this command
  // recommends afterwards found it "already running" — so the whole switch, from the stop until the
  // new session is on disk, holds the daemon spawn lock: a start that lands
  // meanwhile waits its turn and then reads the new session.
  try {
    return await withSpawnLock('login', async () => {
      // ⚠️ A daemon running WITHOUT a session holds no account to switch away from, and stopping it
      // here would take every local terminal on this computer down for as long as the person is in
      // the browser. There is nothing to race either: the lock is held, and the identity swap happens
      // afterwards, once there is an identity to swap to (`restartDaemonForIdentity`).
      const stopped = readAuthSession() ? (await stopDaemonProcess()).pid !== null : false
      const outcome = await signIn()
      // The daemon stopped for the switch comes back once it is made (`restartDaemonForIdentity`).
      return outcome.signedIn && stopped ? { ...outcome, stoppedDaemon: true } : outcome
    }, {
      onWaiting: (owner) => {
        // On stdout too, for the app: stderr is a developer's, and a sign-in that shows nothing while
        // it waits looks broken.
        emit({ type: 'waiting', message: describeSpawnLockWaitPlainly(owner) })
        console.error(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`)
      },
    })
  } catch (err) {
    setWaiting(false)
    if (!(err instanceof SpawnLockBusyError)) throw err
    // A holder that outlived the wait is not something a sign-in can override the way `stop` does:
    // signing in AROUND it is the race above. Say so and stop. The person gets what Harness is still
    // doing and what to do — the desktop shows `message` as is — and the pid and the lock go to
    // stderr, where a developer reads them (the desktop keeps that stream in its log).
    const message = describeSpawnLockBusyPlainly(err)
    const detail = `the daemon spawn lock is ${describeSpawnLockFailure(err)}`
    if (json) {
      emit({ type: 'result', status: 'error', code: 'DAEMON_BUSY', message })
      console.error(`  ${detail}`)
    } else {
      console.error(`\n  ✗ ${message}\n    (${detail})\n`)
    }
    process.exitCode = 1
    return { signedIn: false }
  }
}

/** `harness login` at a terminal, with no flag: which way to sign in. Enter is Google, the first row. */
async function askSignInMethod(): Promise<SignInMethod | null> {
  const method = await pickSignInMethod({ input: process.stdin, output: process.stdout })
  if (method) console.log(`  (next time: harness login --${method})`)
  return method
}

/** One line from standard input — the person at the terminal, or the app driving `--json`. */
function askLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, ...(question ? { output: process.stdout } : {}) })
    let done = false
    const finish = (line: string): void => { if (done) return; done = true; rl.close(); resolve(line) }
    rl.on('close', () => finish(''))
    if (question) rl.question(question, finish)
    else rl.once('line', finish)
  })
}

/**
 * The QR half of a sign-in (lib/qrSignIn.ts): show a QR, wait for a signed-in phone to approve it,
 * ask the person here whether to sign in as the account that approved, then save the session.
 * Under --json the QR is an event (`{"type":"qr"}`) and the question is one too
 * (`{"type":"confirm","email"}`), answered with a `yes` or `no` line on standard input.
 */
async function qrSignInCommand(
  json: boolean,
  emit: (line: Record<string, unknown>) => void,
  succeed: (email: string) => Promise<SignInOutcome>,
  hooks: SignInHooks = {},
): Promise<SignInOutcome> {
  const fail = (code: string, message: string): SignInOutcome => {
    if (json) emit({ type: 'result', status: 'error', code, message })
    else console.error(`\n  ✗ ${message}\n`)
    process.exitCode = 1
    return { signedIn: false }
  }
  let shown = false
  const result = await qrSignIn({
    post: (path, body) => postJson(path, body),
    ...(hooks.onStarted ? { onStarted: hooks.onStarted } : {}),
    label: hostname().slice(0, 80),
    computerId: computerId(),
    show: (link, expiresIn) => {
      if (json) { emit({ type: 'qr', url: link, expiresIn }); return }
      if (shown) return
      shown = true
      console.log('\n  On your phone, open Harness ▸ Settings ▸ Sign in a computer, and scan:\n')
      console.log(terminalQr(link).split('\n').map((l) => `    ${l}`).join('\n'))
      console.log('\n  Waiting for your phone…')
    },
    confirm: async (email) => {
      if (json) {
        emit({ type: 'confirm', email })
        const yes = ((hooks.driver ? await hooks.driver.nextLine() : await askLine('')) ?? '').trim().toLowerCase() === 'yes'
        if (yes) hooks.onCommitted?.()
        return yes
      }
      const answer = await askLine(`\n  Your phone approved this sign-in for ${email}.\n  Sign in as ${email}? [Y/n] `)
      const yes = !/^n/i.test(answer.trim())
      if (yes) hooks.onCommitted?.()
      return yes
    },
  })
  if (!result.ok) return fail(result.code, result.message)
  const { tokens } = result
  writeAuthSession({
    version: 1,
    accessToken: tokens.token,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresIn ? { expiresAt: Date.now() + tokens.expiresIn * 1000 } : {}),
    autonomousEnv: tokens.autonomousEnv ?? env.AUTONOMOUS_ENV,
    computerId: computerId(),
    method: 'qr',
    updatedAt: Date.now(),
    signInEpoch: newSignInEpoch(),
  })
  try {
    await resolveComputerMachine()
  } catch (err) {
    return fail('BACKEND_ERROR', (err as Error).message)
  }
  return await succeed(tokens.email)
}

/**
 * The browser half of a sign-in: a loopback callback server, the SSO page, the code exchange, and
 * the new session — machine id included — on disk. Under --json every failure is a result line and
 * an exit code (`emit`); on the human path it is thrown. `succeed` finishes the job once the
 * session is on disk. `provider` is the account the page opens on (Google, Apple); without one it
 * is the page's own chooser. The sign-in is made as [entryPoint]'s own auth-service client
 * (`ssoClientIdFor`), and the session keeps the client the backend says the tokens were issued to.
 */
async function browserSignIn(
  json: boolean,
  emit: (line: Record<string, unknown>) => void,
  succeed: () => Promise<SignInOutcome>,
  { entryPoint, provider }: { entryPoint: string; provider?: SignInProvider },
  hooks: Pick<SignInHooks, 'onCommitted'> = {},
): Promise<SignInOutcome> {
  const callback = createServer()
  await new Promise<void>((resolve, reject) => {
    callback.once('error', reject)
    // 0 = whatever the OS gives, which is what a real computer wants. Pinned only where the browser
    // and this listener are not on the same loopback — see ADAPTER_LOGIN_CALLBACK_PORT.
    callback.listen(env.ADAPTER_LOGIN_CALLBACK_PORT, '127.0.0.1', () => resolve())
  })
  const address = callback.address()
  if (!address || typeof address === 'string') throw new Error('Could not start the SSO callback server')
  const redirectUri = `http://127.0.0.1:${address.port}/callback`
  try {
    let start: { authorizeUrl?: string; tx?: string }
    try {
      start = await postJson<{ authorizeUrl?: string; tx?: string }>('/api/auth/authorize-native', {
        redirectUri,
        autonomousEnv: env.AUTONOMOUS_ENV,
        entryPoint,
        clientId: ssoClientIdFor(entryPoint),
        ...(provider ? { provider } : {}),
      })
      if (!start.authorizeUrl || !start.tx) throw new Error('Backend did not return an SSO authorize URL')
    } catch (err) {
      if (json) { emit({ type: 'result', status: 'error', code: 'BACKEND_ERROR', message: (err as Error).message }); process.exitCode = 1; return { signedIn: false } }
      throw err
    }
    const authorizeUrl = withSignInProvider(start.authorizeUrl, provider)
    if (json) {
      emit({ type: 'authorize_url', url: authorizeUrl })
    } else {
      console.log(`\n  Sign in to Harness${provider ? ` with ${signInProviderName(provider)}` : ''} in your browser:\n`)
      console.log(`    ${authorizeUrl}\n`)
      openInBrowser(authorizeUrl)
    }
    // A browser on this SAME machine can reach the loopback server directly. Over SSH the user's
    // browser is on a DIFFERENT machine — its own 127.0.0.1 has nothing listening on that port, so the
    // redirect never arrives here. It still lands on a URL carrying `code`/`state` (the page just fails
    // to load); let them paste that URL back in instead of hanging until the 5-minute timeout.
    const manual = !json && process.stdin.isTTY ? promptForCallbackUrl(redirectUri) : null
    let callbackResult: LoginCallbackParams
    try {
      callbackResult = await awaitLoginCallback({ server: callback, redirectUri, manual: manual?.promise ?? null, timeoutMs: 5 * 60_000, entryPoint })
    } catch (err) {
      const timedOut = (err as Error).message === LOGIN_TIMEOUT_MESSAGE
      if (json) { emit({ type: 'result', status: 'error', code: timedOut ? 'TIMEOUT' : 'CALLBACK_ERROR', message: (err as Error).message }); process.exitCode = 1; return { signedIn: false } }
      throw err
    } finally {
      manual?.cancel()
    }
    // The browser came back: from here the exchange and the session write run to the end.
    hooks.onCommitted?.()
    let exchanged: { token?: string; refreshToken?: string; expiresIn?: number; autonomousEnv?: 'prod' | 'stag'; clientId?: string }
    try {
      exchanged = await postJson<typeof exchanged>('/api/auth/exchange', {
        code: callbackResult.code,
        state: callbackResult.state,
        tx: start.tx,
        // The utm_* and rid auth.autonomous.ai carried back: how the account came (PR #785).
        ...(callbackResult.attribution ? { attribution: callbackResult.attribution } : {}),
      })
      if (!exchanged.token) throw new Error('SSO exchange returned no access token')
    } catch (err) {
      if (json) { emit({ type: 'result', status: 'error', code: 'EXCHANGE_FAILED', message: (err as Error).message }); process.exitCode = 1; return { signedIn: false } }
      throw err
    }
    const id = computerId()
    const session: AuthSession = {
      version: 1,
      accessToken: exchanged.token,
      ...(exchanged.refreshToken ? { refreshToken: exchanged.refreshToken } : {}),
      ...(exchanged.expiresIn ? { expiresAt: Date.now() + exchanged.expiresIn * 1000 } : {}),
      autonomousEnv: exchanged.autonomousEnv ?? env.AUTONOMOUS_ENV,
      computerId: id,
      // What the backend says it exchanged as — never what was asked for: a backend from before
      // the clients were split signs every sign-in in as its configured one, and names none.
      ...(knownSsoClientId(exchanged.clientId) ? { clientId: knownSsoClientId(exchanged.clientId) } : {}),
      updatedAt: Date.now(),
      signInEpoch: newSignInEpoch(),
    }
    writeAuthSession(session)
    try {
      await resolveComputerMachine()
    } catch (err) {
      if (json) { emit({ type: 'result', status: 'error', code: 'BACKEND_ERROR', message: (err as Error).message }); process.exitCode = 1; return { signedIn: false } }
      throw err
    }
    return await succeed()
  } finally {
    // A keep-alive socket the browser left open would hold `close()` until it idles out (a pinned
    // ADAPTER_LOGIN_CALLBACK_PORT behind an SSH tunnel is where that shows up); drop it first.
    callback.closeAllConnections?.()
    await new Promise<void>((resolve) => callback.close(() => resolve()))
  }
}

// ── grid ───────────────────────────────────────────────────────────────────────────────────────
/**
 * `harness grid login` — sign in to your grid with the Autonomous account this computer already has.
 *
 * Two halves and one result. The first is `loginCommand` reused WHOLE, so this command inherits its
 * already-signed-in short-circuit (no browser when a session exists), `--force`, the NDJSON contract
 * and the paste-the-callback-URL fallback an SSH session needs — rather than reimplementing any of
 * them. The second is the hand-off: the token goes to `grid login --harness` on its standard input.
 *
 * The token comes from `AuthSessionManager.accessToken()` and never off disk, which is the whole of
 * this command's answer to "the harness token expired": a refresh happens transparently there,
 * already coalesced in this process and across processes by the file lock. A refresh token that has
 * gone invalid is an `AuthSessionError` whose own sentence names `harness login`, so the person is
 * told WHICH of the two sign-ins broke instead of reading a stack trace about the other one.
 */
async function gridLoginCommand(force: boolean, json: boolean): Promise<void> {
  // `extra` carries what the child itself said. Under --json both its streams are captured, so
  // without this the one channel a client is reading is left with an exit code and nothing else.
  const fail = (code: string, message: string, exitCode: number, extra: Record<string, unknown> = {}): void => {
    if (json) console.log(JSON.stringify({ type: 'result', status: 'error', code, message, ...extra }))
    else console.error(`\n  ✗ ${message}\n`)
    process.exitCode = exitCode
  }
  let signIn: SignInOutcome
  let token: string
  try {
    // `chained`: the sign-in emits its authorize URL and any error line, but not a success line, so
    // what a client driving this reads is exactly one terminating result — this command's.
    signIn = await loginCommand(false, force, json, { chained: true })
    // ⚠️ On the FIELD, never on the object: every outcome is truthy, so `if (!outcome)` would read
    // a refusal as a success and hand a token that was never obtained to the child.
    if (signIn.signedIn === false) return
    token = await new AuthSessionManager(backendHttpBase()).accessToken()
  } catch (err) {
    if (!(err instanceof AuthSessionError)) throw err
    fail('AUTH_ERROR', err.message, 1)
    return
  }
  const handoff = await handOffToGrid(token, { json })
  if (handoff.code !== 'OK') { fail(handoff.code, handoff.message, handoff.exitCode, gridSaid(handoff)); return }
  // The sign-in on its own leaves an account whose grid was never created signed in to nothing —
  // this command used to stop here, and the empty model picker that followed named no cause. Same
  // second half the harness sign-in does, and best-effort in the same way.
  //
  // Deliberately NOT on the result line: that line is this command's pinned contract (the sign-in's
  // outcome and what `grid` itself said), and a client driving it reads exactly those keys. A person
  // on the human path gets the notes on stderr, where every other note from this command goes.
  await ensureAccountGrid((line) => { if (!json) console.error(`  · ${line}`) })
  if (!json) return
  // The same key `harness login --json` uses, present only when it is true, so a client driving the
  // two reads one contract rather than two — the harness sign-in's own line is worded exactly so.
  console.log(JSON.stringify({
    type: 'result',
    status: 'success',
    ...(signIn.alreadySignedIn ? { alreadySignedIn: true } : {}),
    ...gridSaid(handoff),
  }))
}

/** What `grid` itself said, carried out on the result line beside this command's own classification.
 *
 *  `grid`'s answer on success is a JSON document on stdout, so it travels parsed, under `grid`. Its
 *  refusals go to **stderr** — every one of them already names its own way forward — and those
 *  travel verbatim under `detail`, because a client reading NDJSON off stdout would otherwise have
 *  the exit code and no sentence to show anybody. Both are omitted when empty rather than sent as
 *  `null`: an absent key reads as "the child said nothing there", which is what it means. */
function gridSaid(handoff: { stdout: string; stderr: string }): Record<string, unknown> {
  const out = handoff.stdout.trim()
  const err = handoff.stderr.trim()
  let parsed: unknown = null
  if (out) { try { parsed = JSON.parse(out) } catch { parsed = out } }
  return { ...(out ? { grid: parsed } : {}), ...(err ? { detail: err } : {}) }
}

/**
 * `harness grid logout` — the grid sign-out, run as itself, so the pair a person was taught is
 * symmetric.
 *
 * A passthrough and nothing else. The serve-child teardown that runs before any credential is
 * deleted, the refusal that keeps them when a child cannot be confirmed stopped, `--force`, the
 * exit code and every word on either stream are `grid logout`'s. This function's whole job is to
 * adopt the child's exit code and to say the one thing the child cannot: that there was no child.
 *
 * ⚠️ **No cascade into the harness session, and none out of it.** Nothing here reads this
 * computer's SSO session, so no grid condition can decide whether the harness stays signed in — and
 * `harness logout` correspondingly never deletes grid credentials (see `logout` below).
 */
async function gridLogoutCommand(args: string[]): Promise<void> {
  const outcome = await passThroughToGridLogout(args)
  // On the FIELD: both outcomes are truthy objects, and testing the object would read a missing
  // `grid` as a clean sign-out.
  if (outcome.ran === false) console.error(`\n  ✗ ${outcome.message}\n`)
  process.exitCode = outcome.exitCode
}

/**
 * `harness grid env <grid>` — `grid --remote info <grid> --env` through the harness's own `grid`, so a
 * shell can `eval` a grid's relay address and key with no `grid` of its own on PATH, or an older one
 * that refuses a resting grid. The Models view's Jev pane builds its copy-paste request on it.
 *
 * A passthrough like `grid logout`: the exports, the refusals and the exit code are `grid`'s. The key
 * goes to this process's stdout only — the explicit disclosure `info --env` exists for — never a log.
 */
async function gridEnvCommand(grid: string | undefined): Promise<void> {
  if (!grid?.trim() || grid.startsWith('-')) {
    console.error('Usage: harness grid env <grid>')
    process.exitCode = 2
    return
  }
  const result = await gridExec(['--remote', 'info', grid, '--env'])
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.code === 'GRID_CLI_MISSING') console.error(`\n  ✗ ${result.message}\n`)
  process.exitCode = result.exitCode
}

/**
 * Fallback for a browser that cannot reach this machine's loopback callback (running `harness login`
 * over SSH: the user's browser is on a different box, so its own 127.0.0.1 has nothing listening).
 * Prompts on stdin until the pasted text yields `code`+`state` (or `error`) — see
 * [extractCallbackParams] for the accepted shapes — so a TTY user can complete login without waiting
 * out the 5-minute timeout. `cancel()` stops asking — called once the loopback path wins the race, or
 * on the way out either way.
 */
function promptForCallbackUrl(redirectUri: string): {
  promise: Promise<LoginCallbackParams>
  cancel: () => void
} {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let settled = false
  const promise = new Promise<LoginCallbackParams>((resolve, reject) => {
    const ask = (): void => {
      rl.question(
        '\n  If your browser could not reach back to this machine (SSH/remote), paste the URL it landed on\n' +
          '  (or just its code=...&state=... part) here:\n  ',
        (answer) => {
          if (settled) return
          const trimmed = answer.trim()
          if (!trimmed) { ask(); return }
          const { code, state, error, attribution } = extractCallbackParams(trimmed, redirectUri)
          if (error) { reject(new Error(`SSO login failed: ${error}`)); return }
          if (!code || !state) {
            console.log('  No login code found in that — paste the full callback URL or its code=...&state=... part.')
            ask()
            return
          }
          resolve({ code, state, ...(attribution ? { attribution } : {}) })
        },
      )
    }
    ask()
  })
  // rl.close() alone leaves stdin in flowing mode — a known Node quirk — and pause() alone still
  // wasn't enough to let a TTY process exit on its own (its handle stays ref'd even once nothing
  // reads from it). unref() is what actually stops it counting toward the event loop, so `harness
  // login` exits by itself once it's done instead of hanging until Ctrl+C.
  return {
    promise,
    cancel: () => { settled = true; rl.close(); process.stdin.pause(); process.stdin.unref() },
  }
}

/** Best-effort: a failed open is not a failed connect, the URL is printed above either way. */
function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    child.on('error', () => { /* no browser here (headless/ssh) — the printed URL is the fallback */ })
    child.unref()
  } catch { /* ignore */ }
}

/**
 * Start the adapter, with the saved SSO session when there is one. Missing credentials never open a
 * browser implicitly — and are no longer a refusal.
 *
 * ⚠️ **A DAEMON RUNS WITHOUT AN ACCOUNT.** Everything on this computer — discovery, terminals, hooks,
 * recaps, DSH, the cabled dial — is served by this process over the loopback and never touches the
 * backend. What an account adds is the OTHER machines (the relay, the link ceremony), the shared desk,
 * voice on the dial and the profile; those are bought at the moment they are reached for. Refusing to
 * start without one put a browser sign-in in front of every local thing the product does on day one.
 *
 * Signed out, the identity is this computer's durable id (`computerId()`, minted before any account and
 * the very value the backend binds a machine to at login) — so a later sign-in ADOPTS this machine
 * rather than replacing it.
 */
async function startCommand(foreground: boolean, repair: boolean = false): Promise<void> {
  const session = readAuthSession()
  // The session file is the ONLY thing `start` needs. It used to pull the newest bundle and resolve
  // this computer's machine against the backend before launching — so a computer that could not reach
  // the backend could not start its daemon at all (a black-holed link hung here forever, and the
  // desktop app, which spawns this command when the port is silent, hung on "Starting local service…"
  // with it). Both now belong to the daemon: it updates itself on its own tick (startSelfUpdater) and
  // it dials, retries and serves the cached machine list until the backend answers. `harness update`
  // remains for an update on demand.
  if (!foreground) {
    // A daemon that is already up is left ALONE. The desktop app re-runs `harness start` whenever its
    // 400ms probe misreads a busy daemon as down; `spawnDaemon` repeats this check under the lock, for
    // the daemon that comes up while we are waiting our turn.
    const running = readPid()
    if (running && isAlive(running)) {
      // Left alone only when it serves THIS sign-in. A daemon on another account — what a forced
      // login left behind whenever a start landed while its browser was open — is stopped here and
      // started over on the session that is on disk: "already running" is exactly what kept it
      // there, with `auth status` naming the new machine and the socket serving the old one. Asked
      // of the daemon itself; one that cannot answer (still booting, mid-update) is trusted as before.
      const serving = (await runningDaemonStatus())?.machineId
      // Signed out, the daemon serves this computer under its own id and there is no account to be on
      // the wrong one of — `wantedDaemonIdentity` is the same answer `restartDaemonForIdentity` uses.
      if (!serving || serving === wantedDaemonIdentity()) {
        // `--repair` still does its provisioning here: it touches the managed runtimes, never the
        // bundle, and the live daemon picks a grid laid down now up on its next resolve (see
        // repairManagedRuntimes). Without this, a new pin could only be followed by a restart.
        if (repair) await repairManagedRuntimes(false)
        console.log(`machine already running (pid ${running}) — it auto-reconnects.`)
        console.log('  check: harness status   ·   stop: harness stop   ·   update now: harness update')
        process.exit(0)
      }
      console.log(`machine running (pid ${running}) as another account — restarting it on this sign-in`)
      await stopDaemonProcess()
    }
    await withSpawnLock('start', async () => {
      if (session) await resolveMachineIfUnknown(session)
      await launch(foreground, repair)
    }, {
      onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`),
    }).catch((error: unknown) => {
      if (!(error instanceof SpawnLockBusyError)) throw error
      console.error(`\n✗ Could not start: the daemon spawn lock is ${describeSpawnLockFailure(error)}.`)
      console.error('  check   harness status   ·   stop it   harness stop')
      process.exit(1)
    })
    return
  }
  if (session) await resolveMachineIfUnknown(session)
  await launch(foreground, repair)
}

/**
 * The id a daemon started right now would serve under: the account's machine when this computer is
 * signed in, its own durable computer id when it is not.
 *
 * One function because three callers must agree on it — `start` (is the running daemon the right one?),
 * `restartDaemonForIdentity` (must it be swapped?) and the daemon itself (what does it boot as?). They
 * disagreeing is how a window ends up asking a daemon for a machine it does not serve.
 */
function wantedDaemonIdentity(): string {
  return readAuthSession()?.machineId || computerId()
}

/**
 * The one backend round trip `start` may still make, and only when the session has no machine id —
 * a file written by a build that predates login resolving it. Bounded, and never fatal: the daemon
 * runs on the computer id meanwhile (runForeground `session.machineId ?? session.computerId`; the
 * adapter dial omits the `&machine=` claim for a non-machine id and the backend pairs by `?computer=`),
 * and the next login or online start writes the id. A session that already has one costs nothing here.
 */
async function resolveMachineIfUnknown(session: AuthSession): Promise<void> {
  if (session.machineId) return
  try {
    await resolveComputerMachine(AbortSignal.timeout(RESOLVE_ON_START_TIMEOUT_MS))
  } catch (err) {
    console.log(`  (machine id not resolved yet — ${err instanceof Error ? err.message : String(err)}; starting on the computer id, resolved on the next login or online start)`)
  }
}
const RESOLVE_ON_START_TIMEOUT_MS = 10_000

/** Download + sha256-verify + canary the manifest's cli.js/notify.mjs, then atomically swap them into
 *  the installed CLI dir (dropping the .prev backups on success). The freshly-written cli.js is what the
 *  NEXT spawned daemon (`node cli.js __run`) executes — so staging here = "update, then run the new build".
 *  Runs in the short-lived CLI process, distinct from the daemon's own background `startSelfUpdater`. */
async function downloadCanaryStage(entry: UpdateEntry, dir: string, log: (m: string) => void): Promise<boolean> {
  const cliBuf = await downloadVerified(entry.cli)
  const notifyBuf = await downloadVerified(entry.notify)
  if (!await canary(cliBuf, dir, entry.version)) { log(`  ✗ the new build failed its self-check — keeping v${VERSION}`); return false }
  // Asked for by name, so a version this machine once rolled back is installed and no longer rejected.
  stage(dir, cliBuf, notifyBuf, entry.version)
  confirmUpdate(dir) // canary passed + bytes already verified ⇒ drop the .prev backups
  return true
}

/** An explicit hn update manages only the installed bundle, never a checkout or a canary. */
function isInstalledCli(): boolean {
  const installedCli = join(env.ADAPTER_CLI_DIR, 'cli.js')
  try {
    const running = statSync(SCRIPT_PATH)
    const installed = statSync(installedCli)
    return running.dev === installed.dev && running.ino === installed.ino
  } catch { return SCRIPT_PATH === installedCli }
}

/** `harness update` — force the self-update NOW instead of waiting for the daemon's
 *  background poll. Checks the manifest; if a newer build exists it stops any running daemon first (so
 *  its poller can't race our staging), swaps in the new bytes, then relaunches on them. No-op on a
 *  dev/repo build, and leaves the daemon running-on-the-old-build untouched when already up to date.
 *
 *  On a LOCAL build (`install-cli.sh`) it stops and says so: the automatic paths leave those alone
 *  (see {@link shouldAutoUpdate}), and a command that silently did the opposite would be the same
 *  lost-work trap with a human's finger on it. [force] is that human saying it anyway. */
async function updateCommand(force: boolean): Promise<void> {
  if (SCRIPT_PATH.endsWith('.ts')) {
    console.log('This is a dev/repo build (running from source) — `harness update` is a no-op. Rebuild the bundle instead.')
    process.exit(0)
  }
  if (isLocalDevBuild(VERSION) && !force) {
    console.log(`This is a local build (v${VERSION}), installed from a working tree by scripts/install-cli.sh.`)
    console.log('Updating would replace it with a published release and lose whatever it was built to test.')
    console.log('  keep it:    rebuild with `make install-cli` after you pull')
    console.log('  replace it: harness update --force')
    process.exit(0)
  }
  console.log(`▸ Checking for updates…  (current v${VERSION})`)
  // hn has its own release cadence. An already-current CLI must still refresh an installed hn;
  // a failed optional download must not stop the CLI from updating.
  if (isInstalledCli()) {
    try { await updateManagedTui(SCRIPT_PATH, force, (line) => console.log(line)) }
    catch (error) { console.warn(`  hn update failed; continuing with the CLI update: ${error instanceof Error ? error.message : error}`) }
  }
  let entry: UpdateEntry | null = null
  try { entry = await fetchManifest(env.ADAPTER_UPDATE_URL, env.ADAPTER_UPDATE_KEY) }
  catch (e) { console.error(`✗ Could not reach the update manifest: ${e instanceof Error ? e.message : e}`); process.exit(1) }
  // `--force` on a local build is the one case where "newer" is not the question. Its label carries
  // the published core (`0.1.56-dev.<sha>`), so semverGt is false against the release it was built
  // level with — the check that keeps a release from stomping the build is also the check that would
  // make the deliberate swap a no-op.
  const replacingLocalBuild = force && isLocalDevBuild(VERSION)
  if (!entry || !(semverGt(entry.version, VERSION) || replacingLocalBuild)) {
    console.log(`✓ Already on the latest version (v${VERSION}).`)
    process.exit(0)
  }

  // A newer build exists. Stop the running daemon FIRST so its own background updater can't race our
  // staging on the .prev/.tmp files, then swap the bytes and bring it back up on the new build.
  //
  // The whole stop → stage → relaunch sequence runs under the spawn lock. Between the stop and the
  // relaunch there is no pid file for several seconds, and anything that spawns `harness start` on
  // "no daemon" (the desktop app does, every few seconds) used to land a second child in that gap.
  const staged = entry
  await withSpawnLock('update', async () => {
    const running = readPid()
    const wasRunning = !!(running && isAlive(running))
    const relaunch = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 1000)) // grace for the backend to release the one-machine claim
      await launch(false) // spawns a fresh daemon on the new bytes, prints status, and exits
    }
    if (wasRunning) { console.log('  stopping the running adapter…'); await stopDaemonProcess() }

    console.log(`▸ Updating v${VERSION} → v${staged.version}…`)
    let ok = false
    try { ok = await downloadCanaryStage(staged, resolve(env.ADAPTER_CLI_DIR), (m) => console.log(m)) }
    catch (e) { console.error(`✗ Update failed: ${e instanceof Error ? e.message : e}`); ok = false }
    if (!ok) {
      if (wasRunning) await relaunch() // staging failed → bring the OLD build back so `update` never leaves it down
      process.exit(1)
    }
    console.log(`  ✓ installed v${staged.version}`)
    if (wasRunning) { await relaunch(); return }
    console.log(`✓ Updated to v${staged.version}. Run \`harness start\` to connect.`)
    process.exit(0)
  }, {
    onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`),
  }).catch((error: unknown) => {
    if (!(error instanceof SpawnLockBusyError)) throw error
    console.error(`\n✗ Could not update: the daemon spawn lock is ${describeSpawnLockFailure(error)}. Try again in a moment.`)
    process.exit(1)
  })
}

/**
 * Stop the local adapter and discard this computer's SSO session — local, and unable to fail.
 *
 * **This DOES sign the grid out too, as of the one-sign-in flow.** That reverses the rule this
 * comment used to state, so the reversal is written down rather than left to be rediscovered: one
 * sign-in creates the grid session, so one sign-out ends it. The two objections that rule was built
 * on are both answered rather than ignored —
 *
 *   * `grid logout` can refuse and exit non-zero over a serve child it cannot confirm stopped. So
 *     its refusal is REPORTED, never propagated: a grid condition must not block a harness sign-out.
 *   * the grid store may predate the harness, written by a browser sign-in this CLI knows nothing
 *     about. Ending that session is now the intended behaviour, not an overreach — and when no
 *     `grid` can be run at all, the old sentence is still printed so nothing is left behind silently.
 *
 * It runs BEFORE the harness session is cleared, because `grid logout` tears down every serve child
 * on this box first, while the token that makes their deregistration authoritative still exists.
 */
async function logout(): Promise<void> {
  // Through the lock-taking stop, not an inline kill: a logout that lands mid-handoff would otherwise
  // SIGTERM the OLD daemon, leave the new one coming up, and then delete the session under it.
  const { pid: stoppedPid } = await stopDaemonProcess()
  // Before clearAuthSession: see the note above on serve children. Its exit code is deliberately
  // dropped — this command cannot fail — and its own words have already reached the terminal.
  const gridOut = await passThroughToGridLogout([])
  clearAuthSession()
  rmSync(MACHINE_NAME_FILE, { force: true })
  // Same reason as the name above: the cached machine list describes the account that just left, and the
  // local `/api/machines` fallback would otherwise hand it to whoever signs in next on this computer.
  rmSync(machineListCachePath(), { force: true })
  // Only when there was no `grid` to run at all. A child that ran has already said what it did, and
  // repeating "your grid sign-in is still here" after a successful sign-out would be false.
  if (!gridOut.ran) warnIfGridSignInRemains()
  // A daemon that was up comes BACK, signed out. Signing out is leaving the account, not stopping the
  // agents on this computer: the desktop window is still open on them, the dial is still plugged in,
  // and tmux still holds every session. Leaving the daemon down took all of that off the screen for a
  // change that concerns the other machines.
  if (stoppedPid) {
    console.log('Signed out. Restarting the daemon for this computer only…')
    await launch(false)   // prints the guest status block and exits
    return
  }
  console.log('Signed out. Run `harness start` to serve this computer; `harness login` to reach your other machines.')
  process.exit(0)
}

/**
 * Swap a running daemon onto the identity the session file now names.
 *
 * A daemon takes its identity ONCE, at boot (`BackendSocket.machineId` is readonly, and the local
 * websocket binds every client to it). A sign-in on a computer that was running signed out therefore
 * leaves a daemon serving itself under the computer id while the session says machineId — and the app,
 * having just been told the machineId, cannot select it. Restarting is the honest swap: every other
 * route to the same end (a mutable id, a live re-bind) touches the socket, the E2EE identity and the
 * local binding at once, and the daemon already survives a restart cleanly for every update.
 *
 * No-op when nothing is running (`harness start` boots on the new session by itself) or when the daemon
 * already wears the right id (a `harness login` on a computer that was signed in all along) — unless the
 * sign-in itself stopped it (`stoppedDaemon`: `login --force` stops a signed-in daemon before switching
 * accounts). That one is started again on the new session: left down, the computer was off the account
 * until someone ran `harness start`, and the web showed it offline.
 */
async function restartDaemonForIdentity(stoppedDaemon = false): Promise<void> {
  // OUR daemon, by its pid file and private socket. A login in another HOME must never restart a
  // different OS user's daemon just because it happens to hold the default TCP port.
  const pid = readPid()
  if (!pid || !isAlive(pid)) {
    if (!stoppedDaemon) return
    console.log('  starting the daemon again on this account…')
    await launch(false)   // prints the status block and exits
    return
  }
  const daemon = await runningDaemonStatus()
  if (!daemon) return
  if (daemon.machineId === wantedDaemonIdentity()) return
  console.log('  restarting the daemon on this account…')
  await stopDaemonProcess()
  await launch(false)   // prints the status block and exits
}


// ── info block ───────────────────────────────────────────────────────────────────────────────────

/**
 * The version of the daemon that is ACTUALLY running, asked of the daemon itself.
 *
 * `VERSION` is a constant baked into whichever bundle is doing the printing, and that is not always the
 * one running: `harness update` downloads a new build, spawns it, and then prints this block — all from
 * the OLD process — so the block announced the version it was replacing (`✓ installed v0.0.22` followed
 * by `version v0.0.20`). Every other row here is a fact about the daemon (pid, sessions, dashboard); this
 * makes the version one too. Falls back to the local constant when the daemon cannot be reached, which is
 * exactly the case where the printing process IS the only build there is.
 *
 * `machineId` is the machine the daemon's backend socket is serving — fixed for its lifetime, so it is
 * the one fact that tells a daemon on THIS sign-in from one left over from the previous account (see
 * startCommand). Null when the daemon does not say.
 */
async function runningDaemonStatus(): Promise<{
  version: string; sessions: number; machineId: string | null; connected: boolean
  backendUrl: string | null; autonomousEnv: string | null; signedIn: boolean | null
  dataDir: string | null; authDir: string | null
} | null> {
  try {
    const body = await localDaemonStatus(env.ADAPTER_DATA_DIR, env.PORT)
      ?? await legacyDaemonStatus(daemonPort(), readPid(), computerId())
    if (!body) return null
    const status = body as {
      version?: unknown; sessions?: unknown; machineId?: unknown; connected?: unknown
      backendUrl?: unknown; autonomousEnv?: unknown; signedIn?: unknown; dataDir?: unknown; authDir?: unknown
    } | null
    const version = typeof status?.version === 'string' && status.version ? status.version : VERSION
    const sessions = Array.isArray(status?.sessions) ? status.sessions.length : 0
    const machineId = typeof status?.machineId === 'string' && status.machineId ? status.machineId : null
    // Missing on a daemon too old to report it — read as connected, as the desktop app does.
    const connected = status?.connected !== false
    return {
      version, sessions, machineId, connected,
      backendUrl: typeof status?.backendUrl === 'string' ? status.backendUrl : null,
      autonomousEnv: typeof status?.autonomousEnv === 'string' ? status.autonomousEnv : null,
      signedIn: typeof status?.signedIn === 'boolean' ? status.signedIn : null,
      dataDir: typeof status?.dataDir === 'string' ? status.dataDir : null,
      authDir: typeof status?.authDir === 'string' ? status.authDir : null,
    }
  } catch {
    return null
  }
}

async function runningDaemonVersion(): Promise<string> {
  return (await runningDaemonStatus())?.version ?? VERSION
}

// `status` is a definitive state — `launch` only prints this after "[backend] connected" (so it's
// "● connected", never a one-shot never-updating "connecting…"); `status` prints running/stopped.
function printInfoBlock(opts: {
  status: string; pid: number; machineId?: string; sessions: number; version: string
  /** The `device` row's text (this machine's key code and whether the account holds it); only `status` shows it. */
  device?: string
  /** Who keeps the daemon running, when launchd or systemd does (`harness service install`). */
  supervisor?: string
  connection: { backendUrl: string | null; autonomousEnv: string | null; signedIn: boolean; dataDir: string | null; authDir: string | null }
}): void {
  const row = (k: string, v: string): string => `   ${k.padEnd(10)} ${v}`
  const rule = '  ' + '─'.repeat(37)
  console.log('')
  console.log('  machine · remote machine')
  console.log(rule)
  console.log(row('status', opts.status))
  // Display name mirrored from the backend by the daemon (machine_meta) — only shown when named.
  const machineName = ((): string => {
    try { return readFileSync(MACHINE_NAME_FILE, 'utf-8').trim() } catch { return '' }
  })()
  if (machineName) console.log(row('machine', machineName))
  if (opts.device) console.log(row('device', opts.device))
  console.log(row('version', `v${opts.version}`))
  console.log(row('backend', opts.connection.signedIn ? opts.connection.backendUrl ?? 'unknown · daemon not answering' : 'not signed in · harness login'))
  console.log(row('account', opts.connection.autonomousEnv ?? 'unknown · older daemon'))
  if (opts.connection.dataDir) console.log(row('state', tildify(opts.connection.dataDir)))
  if (opts.connection.authDir) console.log(row('auth', tildify(opts.connection.authDir)))
  console.log(row('agents', `${opts.sessions} available`))
  console.log(row('pid', String(opts.pid)))
  if (opts.supervisor) console.log(row('supervisor', opts.supervisor))
  console.log(row('logs', tildify(LOG_FILE)))
  console.log(row('dial log', tildify(join(env.HARNESS_LOGS_DIR, 'dial-YYYYMMDD.log'))))
  console.log(row('dashboard', `http://127.0.0.1:${daemonPort()}`))
  console.log(rule)
  console.log('  running in background · stop with: harness stop')
  console.log('')
}

/** The log-tail readiness classifier and the two-phase wait live in lib/daemonLaunch.ts — see there.
 *  `launchDeps` binds them to this process's log file and port. */
const launchDeps = defaultLaunchDeps(LOG_FILE, daemonPort())

// ── daemon start / stop / status ───────────────────────────────────────────────────────────────

/**
 * `--repair`'s provisioning, in the open: the managed Node runtime (and the launcher that names it),
 * then the managed grid. Returns the repaired Node, or null when there was nothing to repair.
 *
 * Called for the daemon a `start` is about to spawn — and for one that is ALREADY UP. The runtimes
 * live beside the bundle, not in it, and the daemon reads `current-grid` on every resolve, so a grid
 * laid down here is the one its next spawn runs, with no restart; the daemon's own call follows the
 * pin quietly on every start (runForeground), and this is where a person watches it happen. A
 * FOREGROUND start becomes the daemon itself and runForeground's own call prints to this same
 * terminal — once is enough, so the grid step is skipped there.
 */
async function repairManagedRuntimes(foreground: boolean): Promise<string | null> {
  const repaired = await ensureManagedRuntime((m) => console.log(m))
  if (repaired) ensureLauncher(repaired, (m) => console.log(m))
  if (!foreground) await ensureManagedGrid((m) => console.log(m))
  return repaired
}

/** Daemonize (or run inline), with the saved SSO session when there is one — see startCommand. */
async function launch(foreground: boolean, repair: boolean = false): Promise<void> {
  const session = readAuthSession()
  // The installer already provisioned the managed Node runtime and pointed the launcher at it, so a
  // normal start just reads what's there (cheap: no network, no download). `--repair` re-runs that
  // provisioning explicitly, for the rare machine whose launcher predates the managed runtime.
  let runtimeNode: string | null = managedNodePath()
  if (repair) {
    const repaired = await repairManagedRuntimes(foreground)
    if (repaired) runtimeNode = repaired
  }
  // Foreground mode (supervisor) OR dev/tsx (can't cleanly spawn a .ts detached) → run inline.
  if (foreground || SCRIPT_PATH.endsWith('.ts')) {
    if (!foreground) console.log('[cli] dev mode — running in the foreground (Ctrl-C to stop)')
    await runCoreInForeground(session, SCRIPT_PATH)
    return
  }

  // ONE spawner at a time. The desktop app re-runs `harness start` every few seconds while the daemon
  // looks down — which it does for the length of an update handoff, or of `harness update` — and a
  // second child racing the first for the fixed port is how an orphan ends up holding it. Waiting is
  // the right answer: when the holder finishes, the pid file names a live daemon and the check below
  // says "already running", which is exactly what the caller wanted to hear.
  try {
    await withSpawnLock('start', () => spawnDaemon(session, runtimeNode), {
      onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`),
    })
  } catch (error) {
    if (!(error instanceof SpawnLockBusyError)) throw error
    console.error(`\n✗ Could not start: the daemon spawn lock is ${describeSpawnLockFailure(error)}.`)
    console.error('  check   harness status   ·   stop it   harness stop')
    console.error(`  logs    ${tildify(LOG_FILE)}`)
    process.exit(1)
  }
}

/** The part of `launch` that runs under the spawn lock: check, spawn, wait for bind, wait for connect. */
async function spawnDaemon(session: AuthSession | null, runtimeNode: string | null): Promise<void> {
  const running = readPid()
  if (running && isAlive(running)) {
    console.log(`machine already running (pid ${running}) — it auto-reconnects.`)
    console.log('  check: harness status   ·   stop: harness stop')
    process.exit(0)
  }

  mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true, mode: 0o700 })
  prepareLogFile(LOG_FILE, LEGACY_LOG_FILE) // adopt an older name + enforce the cap before we tail from here
  const logOffset = existsSync(LOG_FILE) ? readFileSync(LOG_FILE).length : 0
  // Opted in to launchd or systemd (`harness service install`): the platform runs the master, and one
  // spawned here would be a second supervisor beside it (lib/platformDaemon.ts).
  const platform = installedPlatform()
  if (platform) {
    const started = await startUnderPlatform(serviceDefinition({ logFile: LOG_FILE }))
    if (!started.ok) {
      const fail = connectFailure(launchDeps.readLogSlice(logOffset), daemonPort())
      console.error(`\n✗ ${fail?.detail ?? started.detail}`)
      console.error(`  logs   ${tildify(LOG_FILE)}   ·   harness service status`)
      process.exit(1)
    }
    return reportStarted(session, started.pid, platform)
  }
  const logFd = openSync(LOG_FILE, 'a')
  // The daemon starts on the managed runtime straight away rather than inheriting this process's
  // interpreter and waiting for some later restart to adopt it.
  // harnessd: a master that keeps the daemon's core running (harnessd/supervisor.ts). HARNESS_NO_MASTER=1
  // starts the core on its own, as before, for a machine where the master itself is in question.
  const entry = process.env.HARNESS_NO_MASTER === '1' ? '__run' : '__harnessd'
  // Under its own name in Activity Monitor (harnessd/processName.ts) rather than `node`.
  const child = spawn(namedNode(runtimeNode ?? process.execPath, entry === '__run' ? 'harnessd-core' : 'harnessd', env.ADAPTER_RUNTIME_DIR), [SCRIPT_PATH, entry], {
    detached: true,
    env: { ...process.env },
    stdio: ['ignore', logFd, logFd],
  })
  let childExited = false
  child.on('exit', () => { childExited = true })
  child.on('error', () => { childExited = true })
  child.unref()

  // The pid file is NOT written here. The child claims it itself, once — and only once — it has bound
  // the control port (see runForeground); that claim is the bind signal waited on below. A spawner
  // writing it first meant a child that lost the port left a file naming a corpse.
  const bind = await waitForBind(child.pid ?? -1, () => childExited, BIND_WAIT_MS, launchDeps)
  if (bind !== 'bound') {
    const fail = connectFailure(launchDeps.readLogSlice(logOffset), daemonPort())
    if (bind === 'timeout') { try { if (child.pid) process.kill(child.pid, 'SIGTERM') } catch { /* ignore */ } }
    const detail = fail?.detail ?? (bind === 'exited' ? 'the daemon exited during startup' : `the daemon did not bind within ${BIND_WAIT_MS / 1000}s`)
    console.error(`\n✗ ${detail}`)
    console.error(`  logs   ${tildify(LOG_FILE)}`)
    process.exit(1)
  }

  return reportStarted(session, child.pid ?? 0)
}

/** What `harness start` says once the daemon it started is up, and its exit. `supervisor`: launchd or
 *  systemd started it (`harness service install`). */
async function reportStarted(session: AuthSession | null, pid: number, supervisor?: string): Promise<never> {
  // Bound is started. What the daemon does next — dial the backend, retry on its own backoff, sign
  // itself out on a 401, step aside on a 409 — is its own business and is logged by it; this command
  // used to sit here for up to ten seconds watching the log for "[backend] connected", and a computer
  // with no route to the backend paid all ten before hearing that its daemon was fine. `harness
  // status` says whether the link is up; the desktop app reads the same fact off `/api/status`.
  const daemonStatus = await runningDaemonStatus()
  printInfoBlock({
    // Signed out there is no backend leg to be connecting on, and saying there is would be a promise
    // about a handshake that is never attempted. The daemon is up and serving this computer.
    status: session
      ? '● started · connecting to the backend in the background'
      : '● started · this computer only (not signed in)',
    pid,
    supervisor: supervisor && supervisorRow(supervisor),
    machineId: session?.machineId,
    sessions: daemonStatus?.sessions ?? 0,
    version: daemonStatus?.version ?? VERSION,
    connection: {
      backendUrl: daemonStatus?.backendUrl ?? env.BACKEND_WS_URL,
      autonomousEnv: daemonStatus?.autonomousEnv ?? session?.autonomousEnv ?? env.AUTONOMOUS_ENV,
      signedIn: daemonStatus?.signedIn ?? session !== null,
      dataDir: daemonStatus?.dataDir ?? env.ADAPTER_DATA_DIR,
      authDir: daemonStatus?.authDir ?? AUTH_DIR,
    },
  })
  if (!session) {
    console.log('  Agents, terminals and the cabled dial work here. `harness login` adds your other machines.')
  }
  process.exit(0)
}

/** `harness stop` — SIGTERM the background adapter, SIGKILL if it lingers. */
async function stop(): Promise<void> {
  const r = await stopDaemonProcess()
  if (!r.pid) {
    console.log('machine is not running.')
    process.exit(0)
  }
  console.log(`machine stopped (pid ${r.pid}).`)
  process.exit(0)
}

function clearAdapterState(): void {
  const dataDir = resolve(env.ADAPTER_DATA_DIR)
  const cliDir = resolve(env.ADAPTER_CLI_DIR)
  const rmStateFiles = (dir: string): void => {
    for (const name of [
      'token',
      'adapter.pid',
      'adapter.spawn.lock',
      'harness.log',
      'machine.log', // pre-rename names — still cleared so a reset leaves nothing behind
      'adapter.log',
      // NOT 'computer-id' — it no longer lives here (config/env.ts keeps it at the product root,
      // above everything this function reaches) and it must not be cleared anyway. A reset that
      // changed this computer's identity would orphan its machine and mint a fresh one on the next
      // `harness login`, which is the opposite of "start over on the same box".
      'machine-name',
      'registry.json',
      'registry-boot',
      'agent-names.json',
      'summaries.json',
      'summary-scratch',
      'e2e',
      // The session search index (lib/sessionSearch/): rebuilt from the transcripts on the next start.
      SESSION_SEARCH_FILE,
      `${SESSION_SEARCH_FILE}-wal`,
      `${SESSION_SEARCH_FILE}-shm`,
    ]) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
    // Private sockets and actual TCP port records — whichever configured ports have run here.
    try {
      for (const name of readdirSync(dir)) {
        if (isLocalSocketName(name) || /^daemon-\d+\.json$/.test(name)) rmSync(join(dir, name), { force: true })
      }
    } catch { /* no such directory */ }
  }
  if (dataDir === cliDir) rmStateFiles(dataDir)
  else rmSync(dataDir, { recursive: true, force: true })
  rmStateFiles(cliDir)
}

/** Stop the daemon and clear local state so the next login starts fresh. */
async function resetCommand(): Promise<void> {
  const r = await stopDaemonProcess()
  clearAdapterState()
  console.log(`\n  ✓ Cleared local machine CLI state at ${tildify(env.ADAPTER_DATA_DIR)}.`)
  if (r.pid) console.log(`    Stopped adapter process ${r.pid}.`)
  clearAuthSession()
  console.log('\n  Start again with: harness login, then harness start\n')
  // The SECOND door onto the sign-out `logout` performs, and it clears MORE, so somebody running it
  // is if anything likelier to believe nothing is left. Same call, so the two cannot drift.
  warnIfGridSignInRemains()
  process.exit(0)
}

/** Call the running daemon's localhost control API. Exits with a friendly message if it's not up. */
async function daemonCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ res: Response; json: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${daemonPort()}${path}`
  let res: Response
  try {
    const headers: Record<string, string> = { 'x-adapter-local': '1' } // passes the dashboard CSRF gate
    if (body) headers['content-type'] = 'application/json'
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  } catch {
    console.error('\n  ✗ The adapter is not running on this computer.')
    console.error('    Start it first:  harness start\n')
    process.exit(1)
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { res, json }
}

/** `harness pair <code>` — send a browser/device pairing code to the running daemon (localhost). */
async function pairCommand(code: string | undefined): Promise<void> {
  if (!code) {
    console.error('Usage: harness pair <code>   (the code is shown on the browser or device)')
    process.exit(1)
  }
  const { res, json } = await daemonCall('POST', '/api/pair', { code })
  const body = json as { label?: string; fingerprint?: string; error?: string }
  if (res.ok) {
    console.log(`\n  ✓ Paired  “${body.label ?? 'browser'}”`)
    console.log(`    fingerprint  ${body.fingerprint ?? '?'}   — verify it matches the browser\n`)
    process.exit(0)
  }
  const messages: Record<string, string> = {
    NO_INTENT: 'No browser or device is waiting to pair.',
    EXPIRED: 'That code expired. Use the fresh code shown on the browser or device.',
    CODE_MISMATCH: 'That code didn’t match. Use the fresh code shown on the browser or device.',
    BACKEND_DOWN: 'The adapter can’t reach the backend right now. Try again shortly.',
    RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
    BUSY: 'A pairing is already in progress.',
    TIMEOUT: 'The browser or device didn’t respond in time. Try again.',
    CANCELLED: 'Pairing was cancelled on the browser or device.',
    PAIRING_UNAVAILABLE: 'This adapter build does not support E2EE pairing.',
  }
  console.error(`\n  ✗ ${messages[body.error ?? ''] ?? `Pairing failed (${body.error ?? res.status}).`}\n`)
  process.exit(1)
}

/** `harness pairings` — list the browsers paired for end-to-end encryption. */
async function pairingsCommand(): Promise<void> {
  const { res, json } = await daemonCall('GET', '/api/pairs')
  if (!res.ok) { console.error(`\n  ✗ Could not list pairings (${json.error ?? res.status}).\n`); process.exit(1) }
  const pairs = (json.pairs ?? []) as Array<{ fingerprint: string; label: string; pairedAt: number; online: boolean }>
  if (!pairs.length) { console.log('\n  No browsers paired yet.\n  Open the agent page in a browser to get a pairing code.\n'); process.exit(0) }
  console.log('\n  Paired clients (end-to-end encrypted):\n')
  pairs.forEach((p, i) => {
    const when = new Date(p.pairedAt).toISOString().slice(0, 16).replace('T', ' ')
    console.log(`   ${String(i + 1).padStart(2)}. ${p.fingerprint}  ${p.online ? '● online ' : '○ offline'}  ${p.label}   (paired ${when})`)
  })
  console.log('\n  Unpair one:  harness unpair <#|fingerprint>     ·     Unpair all:  harness unpair --all\n')
  process.exit(0)
}

/** `harness unpair <#|fingerprint>` / `harness unpair --all` — revoke browser pairing(s). */
async function unpairCommand(id: string | undefined, all: boolean): Promise<void> {
  if (all) {
    const { res, json } = await daemonCall('POST', '/api/revoke-all')
    if (!res.ok) { console.error(`\n  ✗ Unpair-all failed (${json.error ?? res.status}).\n`); process.exit(1) }
    const count = Number(json.count ?? 0)
    console.log(`\n  ✓ Unpaired ${count} browser${count === 1 ? '' : 's'}.  Any open ones drop to the pairing screen.\n`)
    process.exit(0)
  }
  if (!id) { console.error('Usage: harness unpair <#|fingerprint>   |   harness unpair --all     (see: harness pairings)'); process.exit(1) }
  const { res, json } = await daemonCall('POST', '/api/revoke', { id })
  if (res.ok) {
    console.log(`\n  ✓ Unpaired  “${json.label ?? 'browser'}”  ${json.fingerprint ?? ''}`)
    console.log('    If that browser is open, it drops to the pairing screen; otherwise it will on next open.\n')
    process.exit(0)
  }
  const msg = json.error === 'AMBIGUOUS'
    ? 'That fingerprint prefix matches more than one browser — use more characters or the list number.'
    : json.error === 'NOT_FOUND' ? 'No paired client matches that id.  Run: harness pairings'
    : `Unpair failed (${json.error ?? res.status}).`
  console.error(`\n  ✗ ${msg}\n`)
  process.exit(1)
}

/** Read one line from stdin (used by `--stdin` password input — scripts/GUIs pipe the password in
 *  directly instead of going through the interactive masked prompt below). Resolves '' on EOF with no
 *  line, so callers must treat an empty result as "no password provided". */
function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    let settled = false
    // Order matters: rl.close() fires the 'close' listener SYNCHRONOUSLY (re-entrantly, from inside
    // this same call), so `settled` must flip to true before calling it — otherwise the 'close'
    // handler's resolve('') would run (and win, since a Promise only honors the first resolve() call)
    // before we ever reach our own resolve(line) on the next line.
    rl.once('line', (line) => { settled = true; rl.close(); resolve(line) })
    rl.once('close', () => { if (!settled) resolve('') })
  })
}

/** Prompt on stdin with masked input (echoes `*` per keystroke), for a remote password. Reads
 *  keypress-by-keypress via the PUBLIC `readline.emitKeypressEvents` + `stdin.setRawMode` APIs rather
 *  than driving a `readline.Interface` and fighting its own internal line-redraw logic through a
 *  private `_writeToOutput` hook: with both stdio streams as TTYs, `readline.Interface` runs in
 *  `terminal: true` mode, so every keystroke (and `question()`'s own setup) re-triggers an internal
 *  `_refreshLine()` redraw that clears and rewrites the current line through that same hook — which,
 *  if muted to suppress echo, wipes out a manually-written prompt before the user ever sees it and
 *  leaves nothing on screen at all. Owning the raw keystrokes here means nothing else is redrawing the
 *  line. Falls back to a plain (unmasked) single-line read when stdin isn't a TTY — there's no
 *  terminal to suppress echo on regardless; `--stdin` is the supported path for scripted/GUI callers,
 *  this only guards a caller that piped input without passing it. */
function promptPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt)
    return readStdinLine().then((line) => { process.stdout.write('\n'); return line })
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const cleanup = (): void => {
      stdin.removeListener('keypress', onKeypress)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) { cleanup(); process.stdout.write('\n'); process.exit(130) }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); process.stdout.write('\n'); resolve(value); return }
      if (key.name === 'backspace') {
        if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b') }
        return
      }
      // Anything else that isn't a single printable character — arrows, tab, escape, function keys,
      // other ctrl/meta combos — is ignored outright rather than risking its raw bytes landing in the
      // password buffer.
      if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 0x20) {
        value += str
        process.stdout.write('*')
      }
    }
    stdin.on('keypress', onKeypress)
  })
}

/** `harness remote-password set` — set/rotate this machine's persistent "remote password": the
 *  shared secret `harness link connect <machineId>` on another machine proves knowledge of, to link
 *  to this one. Not single-use and does not expire — stays valid until explicitly changed/cleared.
 *  Prefers the running daemon (so an in-progress `link connect` from elsewhere sees it immediately);
 *  falls back to writing the disk-backed store directly when no daemon is running. `--stdin` reads
 *  one line with no confirmation (for scripts/GUIs); interactively it prompts twice (masked) and requires the two to match. */
async function remotePasswordSetCommand(json: boolean, stdin: boolean): Promise<void> {
  const session = readAuthSession()
  if (!session?.machineId) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'NOT_SIGNED_IN' }))
    else console.error('\n  ✗ This computer is not signed in. Run: harness login\n')
    process.exit(1)
    return
  }
  let password: string
  if (stdin) {
    password = (await readStdinLine()).trim()
    if (!password) {
      if (json) console.log(JSON.stringify({ ok: false, error: 'EMPTY_PASSWORD' }))
      else console.error('\n  ✗ No password read from stdin.\n')
      process.exit(1)
      return
    }
  } else {
    console.log(`\n  Set this machine's remote password. Another machine will use it to link here via`)
    console.log(`  \`harness link connect ${session.machineId}\` — nothing needs approving on this side.\n`)
    const a = await promptPassword('  New remote password: ')
    const b = await promptPassword('  Confirm remote password: ')
    if (!a || a !== b) {
      if (json) console.log(JSON.stringify({ ok: false, error: 'MISMATCH' }))
      else console.error('\n  ✗ Passwords did not match (or were empty). Nothing changed.\n')
      process.exit(1)
      return
    }
    password = a
  }
  let result: { fingerprint: string } | null = null
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/remote-password/set`, {
      method: 'POST',
      headers: { 'x-adapter-local': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { fingerprint?: unknown } | null
      if (typeof body?.fingerprint === 'string') result = { fingerprint: body.fingerprint }
    }
  } catch { /* fall back to the disk-backed store below */ }
  if (!result) {
    const store = new E2eeStore()
    store.init()
    result = await store.setRemotePassword(session.machineId, password)
  }
  if (json) { console.log(JSON.stringify({ ok: true, fingerprint: result.fingerprint })); process.exit(0) }
  console.log(`\n  ✓ Remote password set for this machine (${session.machineId}).`)
  console.log(`    fingerprint  ${result.fingerprint}   — verify it matches on the joining machine after \`harness link connect\`\n`)
  console.log(`  ▸ Run this on the OTHER machine:  harness link connect ${session.machineId}`)
  console.log('  ⚠ Anyone with this password can link a machine to this one. Keep it private.\n')
  if (!readPid()) console.log('  Start the adapter with `harness start` if joins are being rejected.\n')
  process.exit(0)
}

/** `harness remote-password clear` — remove the persistent remote password. Until a new one is set,
 *  `harness link connect` against this machine always fails with NO_REMOTE_PASSWORD. */
async function remotePasswordClearCommand(json: boolean): Promise<void> {
  let cleared = false
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/remote-password/clear`, {
      method: 'POST',
      headers: { 'x-adapter-local': '1' },
    })
    if (res.ok) cleared = true
  } catch { /* fall back to the disk-backed store below */ }
  if (!cleared) {
    const store = new E2eeStore()
    store.init()
    store.clearRemotePassword()
  }
  if (json) { console.log(JSON.stringify({ ok: true })); process.exit(0) }
  console.log('\n  ✓ Remote password cleared. This machine can no longer be linked by password until a new one is set.')
  console.log('  ▸ Run `harness remote-password set` to set a new one.\n')
  process.exit(0)
}

/** `harness remote-password status` — whether a remote password is set, and its fingerprint. */
async function remotePasswordStatusCommand(json: boolean): Promise<void> {
  let status: { hasPassword: boolean; fingerprint: string | null; setAt: number | null } | null = null
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/remote-password/status`, { headers: { 'x-adapter-local': '1' } })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { hasPassword?: unknown; fingerprint?: unknown; setAt?: unknown } | null
      if (typeof body?.hasPassword === 'boolean') {
        status = {
          hasPassword: body.hasPassword,
          fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : null,
          setAt: typeof body.setAt === 'number' ? body.setAt : null,
        }
      }
    }
  } catch { /* fall back to the disk-backed store below */ }
  if (!status) {
    const store = new E2eeStore()
    store.init()
    status = { hasPassword: store.hasRemotePassword(), fingerprint: store.remotePasswordFingerprint(), setAt: store.remotePasswordSetAt() }
  }
  if (json) { console.log(JSON.stringify(status)); process.exit(0) }
  if (!status.hasPassword) {
    console.log('\n  No remote password set.')
    console.log('  ▸ Run `harness remote-password set` to allow another machine to link to this one.\n')
    process.exit(0)
  }
  console.log('\n  Remote password is set.')
  console.log(`    fingerprint  ${status.fingerprint}\n`)
  process.exit(0)
}

/** `harness link connect <machineId>` — join another machine using ITS persistent remote password
 *  (`harness remote-password set` on that machine), proving knowledge of the password rather than
 *  possession of a signed token. Needs only this computer's own SSO session and network — no running
 *  daemon required, same as the old `link import`. On success this machine can relay through to that
 *  machine's data plane with the CLI (not the app) terminating E2EE — see lib/remoteRelay.ts. Fully
 *  automatic on success: no approval step runs on the target machine beyond having set the password. */
/** Turn a `connectWithPassword` failure code into a full instructive sentence — mirrors `pairCommand`'s
 *  `messages` map above, extended to handle the two codes that carry extra data (`RATE_LIMITED`'s
 *  `retryAt`, `CONNECTION_CLOSED:<code>`'s embedded close code). Every branch, including the fallback,
 *  sentence-wraps the code — a bare code must never reach the terminal. */
/** `machine` is how the caller refers to the target — its display name when the caller knows one
 *  (`--name=`), else the raw id, which is all a terminal user has. */
function humanizeLinkError(error: string, machine: string, retryAt?: number): string {
  if (error === 'RATE_LIMITED') {
    if (typeof retryAt === 'number') {
      const minutes = Math.ceil((retryAt - Date.now()) / 60_000)
      return minutes > 0
        ? `Too many wrong attempts on ${machine}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : `Too many wrong attempts on ${machine}. Try again now.`
    }
    return `Too many wrong attempts on ${machine}. Wait a few minutes and try again.`
  }
  if (error.startsWith('CONNECTION_CLOSED:')) {
    return `The connection closed unexpectedly (code ${error.slice('CONNECTION_CLOSED:'.length)}) before linking finished. Try again.`
  }
  const messages: Record<string, string> = {
    NO_REMOTE_PASSWORD: `Machine ${machine} has no remote password set. Ask its operator to run \`harness remote-password set\` there first.`,
    BAD_INTENT: 'The connection request was malformed — this usually means a version mismatch. Update harness on both machines and try again.',
    WRONG_PASSWORD: 'That password is wrong. Check it against the other machine and try again.',
    BUSY: `Machine ${machine} is already handling another link attempt. Wait a moment and try again.`,
    TIMEOUT: `Machine ${machine} didn't respond in time. Make sure it's running \`harness start\` and reachable, then try again.`,
    SEND_FAILED: 'Could not reach the relay to start linking. Check your network connection and try again.',
    DERIVE_FAILED: 'Could not process the password locally. Try again; if it persists, restart harness and retry.',
    SELECT_FAILED: `Could not find machine ${machine}, or it isn't reachable right now. Check the id and that it has run \`harness start\`.`,
    PAIR_FAILED: `Linking failed on ${machine}'s side. Try again; if it persists, check its status there with \`harness status\`.`,
    PROTOCOL_ERROR: 'Something unexpected happened during the handshake. Try again; if it persists, update harness on both machines.',
    CONNECTION_ERROR: 'Could not reach the relay. Check your network connection and try again.',
  }
  return messages[error] ?? `Linking failed (${error}). Try again; if it persists, check both machines are on the latest harness version.`
}

async function linkConnectCommand(machineId: string | undefined, stdin: boolean, json: boolean, displayName?: string): Promise<void> {
  if (!machineId) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'MISSING_MACHINE_ID' }))
    else console.error('Usage: harness link connect <machineId>   (the remote password is set on that machine via harness remote-password set)')
    process.exit(1)
    return
  }
  const session = readAuthSession()
  if (!session) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'NOT_SIGNED_IN' }))
    else console.error('\n  ✗ Not signed in. Run: harness login\n')
    process.exit(1)
    return
  }
  let password: string
  if (stdin) {
    password = (await readStdinLine()).trim()
    if (!password) {
      if (json) console.log(JSON.stringify({ ok: false, error: 'EMPTY_PASSWORD' }))
      else console.error('\n  ✗ No password read from stdin.\n')
      process.exit(1)
      return
    }
  } else {
    console.log(`\n  Linking to machine ${machineId}.`)
    console.log('  Enter the remote password set on THAT machine (`harness remote-password set`) —')
    console.log('  this proves you know it; nothing needs approving there.\n')
    password = await promptPassword(`  Remote password for ${machineId}: `)
  }
  const result = await linkMachineWithPassword(machineId, password, displayName, json ? (stage) => console.log(JSON.stringify({ stage })) : undefined)
  if (!result.ok) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: result.error, message: result.message, ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}) }))
    } else {
      console.error(`\n  ✗ ${result.message}\n`)
    }
    process.exit(1)
    return
  }
  if (json) { console.log(JSON.stringify({ ok: true, fingerprint: result.fingerprint, machineId, mutual: result.mutual })); process.exit(0) }
  console.log(`\n  ✓ Linked machine ${machineId}${result.mutual ? ' — both ways' : ''}`)
  console.log(`    fingerprint  ${result.fingerprint}   — verify it matches \`harness remote-password status\`'s output on the other machine`)
  if (!result.mutual) console.log(`    ${machineId} runs an older harness: it can't reach this machine back until it is updated and linked again.`)
  console.log('')
  process.exit(0)
}

/**
 * The link itself, as `harness link connect` and `harness remote` both do it: this computer's SSO
 * token and identity, the remote password proved against THAT machine, and its peer pinned here.
 * This machine says who it is inside the handshake, so a target that understands it pins it back;
 * when it did (`mutual`), that machine is trusted here as a client too — one link, both directions.
 */
async function linkMachineWithPassword(
  machineId: string,
  password: string,
  displayName?: string,
  onProgress?: (stage: PwConnectProgress) => void,
): Promise<{ ok: true; fingerprint: string; mutual: boolean } | { ok: false; error: string; message: string; retryAt?: number }> {
  const session = readAuthSession()
  if (!session) return { ok: false, error: 'NOT_SIGNED_IN', message: 'Not signed in. Run: harness login' }
  const auth = new AuthSessionManager(backendHttpBase())
  let accessToken: string
  try {
    accessToken = await auth.accessToken()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, error: 'AUTH_FAILED', message: `Could not refresh this computer's SSO session (${detail}). Run: harness login` }
  }
  const store = new E2eeStore()
  store.init()
  const result = await connectWithPassword({
    targetMachineId: machineId,
    password,
    selfIdentity: store.getIdentity(),
    accessToken,
    backendWsBase: env.BACKEND_WS_URL.replace(/\/$/, ''),
    autonomousEnv: session.autonomousEnv,
    onProgress,
    self: { kind: 'machine', label: hostname(), ...(session.machineId ? { machineId: session.machineId } : {}) },
  })
  if (!result.ok) return { ok: false, error: result.error, message: humanizeLinkError(result.error, displayName || machineId, result.retryAt), retryAt: result.retryAt }
  const label = displayName || machineId
  new MachinePeerStore().pin(machineId, b64e(result.peerPub), label, Date.now())
  const mutual = result.mutual && !!session.machineId
  if (mutual) await trustLinkedMachine({ pub: b64e(result.peerPub), machineId, kind: 'machine', label })
  return { ok: true, fingerprint: result.fingerprint, mutual }
}

/** Trust a just-linked machine as a client of THIS one. The running daemon holds paired.json in memory
 *  (and rewrites it whole), so the write has to go through it; with no daemon, the file is written directly. */
async function trustLinkedMachine(peer: LinkedPeer): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/link/trust-peer`, {
      method: 'POST',
      headers: { 'x-adapter-local': '1', 'content-type': 'application/json' },
      body: JSON.stringify(peer),
    })
    if (res.ok) return
  } catch { /* fall back to the disk-backed store below */ }
  const store = new E2eeStore()
  store.init()
  if (!store.isPaired(peer.pub)) store.addPaired(peer.pub, peer.label, Date.now(), 'web', { machineId: peer.machineId, kind: peer.kind })
  // The daemon seeds the group from this pin and pairing when it next starts, and syncs from there.
}


/** `harness link list` — machines this one has linked (CLI-to-CLI/machine-node trust, not browsers). */
async function linkListCommand(): Promise<void> {
  const peers = new MachinePeerStore().list()
  if (!peers.length) {
    console.log('\n  No machines linked yet.')
    console.log('  ▸ Run `harness remote-password set` on the other machine, then `harness link connect <machineId>` here.\n')
    process.exit(0)
  }
  console.log('\n  Linked machines:\n')
  peers.forEach((p, i) => {
    const when = new Date(p.linkedAt).toISOString().slice(0, 16).replace('T', ' ')
    console.log(`   ${String(i + 1).padStart(2)}. ${p.machineId}  ${p.fingerprint}  (linked ${when})`)
  })
  process.exit(0)
}

/** `harness link unlink <machineId>` — remove a linked machine's trust pin. */
async function linkUnlinkCommand(machineId: string | undefined): Promise<void> {
  if (!machineId) { console.error('Usage: harness link unlink <machineId>   (see: harness link list)'); process.exit(1) }
  // Through the daemon: the machine leaves the trust group, so every other member drops it too.
  const viaGroup = await daemonGroupRemove(machineId as string)
  const removed = new MachinePeerStore().unlink(machineId as string) || viaGroup
  if (!removed) {
    console.error(`\n  ✗ No linked machine matches "${machineId}".`)
    console.error('  ▸ Run `harness link list` to see what\'s linked.\n')
    process.exit(1)
    return
  }
  console.log(`\n  ✓ Unlinked ${machineId}${viaGroup ? ' — and removed from your trust group' : ''}\n`)
  process.exit(0)
}

/** Ask the running daemon to remove a trust-group member; false when there is no daemon or no match. */
async function daemonGroupRemove(selector: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/group/remove`, {
      method: 'POST',
      headers: { 'x-adapter-local': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ selector }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** `harness group list|sync|remove` — every machine and phone that trusts every other through links. */
async function groupCommand(sub: string | undefined, arg: string | undefined, json: boolean): Promise<void> {
  if (!sub || sub === 'list') {
    const members = new TrustGroupStore().list()
    if (json) { console.log(JSON.stringify({ members })); process.exit(0) }
    if (!members.length) {
      console.log('\n  No trust group yet. Link another machine (`harness link connect <machineId>`) or a phone to start one.\n')
      process.exit(0)
    }
    console.log('\n  Trust group — each of these reaches every other:\n')
    members.forEach((m, i) => {
      const id = m.kind === 'machine' ? m.machineId : 'viewer app'
      console.log(`   ${String(i + 1).padStart(2)}. ${m.label}  ${id}  ${m.fingerprint}`)
    })
    console.log('')
    process.exit(0)
  }
  if (sub === 'sync') {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/group/sync`, { method: 'POST', headers: { 'x-adapter-local': '1' } })
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      console.error('\n  ✗ Harness is not running here. Run: harness start\n')
      process.exit(1)
    }
    console.log('\n  ✓ Comparing with every reachable member now.\n')
    process.exit(0)
  }
  if (sub === 'remove') {
    if (!arg) { console.error('Usage: harness group remove <machineId|#|fingerprint>   (see: harness group list)'); process.exit(1) }
    if (!(await daemonGroupRemove(arg as string))) {
      console.error(`\n  ✗ Could not remove "${arg}" — no member matches, or harness is not running here (harness start).\n`)
      process.exit(1)
    }
    console.log(`\n  ✓ Removed ${arg} from the trust group. Every member drops it as they sync.\n`)
    process.exit(0)
  }
  console.error(`Unknown command: group ${sub}`)
  process.exit(1)
}

/** `harness devices list|show|remove|history|dismiss|rebaseline` — the account's device key log, as this machine verified it. */
async function devicesCommand(sub: string | undefined, arg: string | undefined, flags: string[]): Promise<void> {
  const json = flags.includes('--json')
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    try {
      const { res, json: out } = await daemonCall(method, path, body)
      return { status: res.status, json: out }
    } catch {
      console.error('\n  ✗ Harness is not running here. Run: harness start\n')
      process.exit(1)
    }
  }
  /** A route an older running daemon does not have answers 404: it needs restarting onto this version. */
  const needsNewerDaemon = (status: number): void => {
    if (status !== 404) return
    console.error('\n  ✗ This needs a newer Harness running here. Restart it: harness stop && harness start\n')
    process.exit(1)
  }
  type Row = { pub: string; label: string; kind: string; machineId: string; addedAt: number; fingerprint: string; self: boolean; seq?: number; firstSeen?: number; pending?: boolean; suspended?: boolean }
  const listing = async (): Promise<{
    members: Row[]; frozen: { reason: string } | null; frozenPeers: string[]; lastSeen?: Record<string, number>
    pending?: string[]; suspended?: string[]; conflict?: { pub: string; label: string; fingerprint: string; addedAt: number; afterJoin: boolean } | null
    departed?: Array<{ pub: string; label: string; fingerprint: string; removedBy: string; removedByLabel: string; selfRemoved: boolean }>
  }> => {
    const { status, json: out } = await call('GET', '/api/devices')
    if (status !== 200) { console.error('\n  ✗ The device list is not available (is this machine signed in?).\n'); process.exit(1) }
    return out as never
  }
  if (!sub || sub === 'list') {
    const out = await listing()
    if (json) { console.log(JSON.stringify(out)); process.exit(0) }
    if (out.frozen) console.log(`\n  ⚠ FROZEN (${out.frozen.reason}): the backend served a device list that does not match what this machine verified. No device is added until you review it: harness devices rebaseline`)
    if (out.frozenPeers.length) console.log(`\n  ⚠ Frozen on: ${out.frozenPeers.join(', ')}`)
    // This machine's own code is shown even before the log holds it, from the key on disk (read-only).
    const pub = peekIdentityPub()
    const selfFp = pub ? thisDeviceFingerprint(false) : null
    for (const line of formatDeviceList(out, Date.now(), selfFp ? { label: thisDeviceLabel(), fp: selfFp } : undefined)) console.log(line)
    process.exit(0)
  }
  /** A key code or selector as matched: upper case, spaces and separators dropped. */
  const norm = (v: string): string => v.toUpperCase().replace(/[·\s-]/g, '')
  // A device by its number in the list (its place in the log, which `list` prints on each row and
  // which only shifts when a device is removed) or by the start of its fingerprint; `show` and
  // `remove` resolve it the same way. The number is NOT the display position: that moves with activity.
  //
  // An all-digit argument is a list number, never a key-code prefix, unless it has 4 or more digits and
  // names no device in the list: then it is the start of a key code ("1111·2222" typed as 1111). A short
  // number out of range is an error rather than a prefix match, because `remove` cannot be undone and
  // `remove 4` must not take out whichever device's key code happens to start with 4.
  // Decided on the selector as matched (spaces and separators dropped), so " 1" is #1 and not the
  // key code starting with 1. `key` is what `remove` echoes when it is a number.
  const resolve = (arg: string, members: Row[]): { row: Row; byNumber: boolean; key: string } => {
    const key = norm(arg)
    // Only spaces and separators: an empty prefix would match every device.
    if (key === '') { console.error('Usage: harness devices show|remove <#|fingerprint>   (see: harness devices list)'); process.exit(1) }
    const ordered = logOrder(members)
    if (/^\d+$/.test(key)) {
      const byIndex = ordered[Number(key) - 1]
      if (byIndex) return { row: byIndex, byNumber: true, key }
      if (key.length < 4) { console.error(`\n  ✗ No device #${key} (see: harness devices list)\n`); process.exit(1) }
    }
    const matches = ordered.filter((m) => norm(m.fingerprint).startsWith(key))
    if (matches.length !== 1) { console.error(`\n  ✗ ${matches.length ? 'More than one device matches' : 'No device matches'} "${arg}".\n`); process.exit(1) }
    return { row: matches[0], byNumber: false, key }
  }
  if (sub === 'show') {
    if (!arg) { console.error('Usage: harness devices show|remove <#|fingerprint>   (see: harness devices list)'); process.exit(1) }
    const { members, lastSeen } = await listing()
    const { row: target } = resolve(arg, members)
    if (json) { console.log(JSON.stringify({ ...target, lastSeen: lastSeen?.[target.pub] })); process.exit(0) }
    for (const line of formatDeviceDetail(target, lastSeen?.[target.pub], Date.now())) console.log(line)
    process.exit(0)
  }
  if (sub === 'remove') {
    if (!arg) { console.error('Usage: harness devices show|remove <#|fingerprint>   (see: harness devices list)'); process.exit(1) }
    const { members } = await listing()
    const { row: target, byNumber, key } = resolve(arg, members)
    if (target.self) { console.error('\n  ✗ That is this machine. Sign out with: harness logout\n'); process.exit(1) }
    // A number or a short (under 4) key-code start is echoed and confirmed first (see removeConfirmation);
    // a longer start of the key code needs no echo.
    const confirm = removeConfirmation({ byNumber, key }, { yes: flags.includes('--yes'), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) })
    if (confirm === 'refuse') {
      console.error(`\n  ✗ Not removing "${arg}" without a terminal to confirm. Use the key code instead: harness devices remove ${target.fingerprint}\n`)
      process.exit(1)
    }
    if (confirm === 'ask') {
      const answer = await askLine(`\n  Remove "${target.label || '(no name)'}"  ${target.fingerprint}?  It is signed out and its key is spent. [y/N] `)
      if (!confirmsRemoval(answer)) { console.log('\n  Cancelled — nothing removed.\n'); process.exit(0) }
    }
    const { status, json: out } = await call('POST', '/api/devices/remove', { pub: target.pub })
    if (status !== 200) { console.error(`\n  ✗ Could not remove ${target.label}: ${String(out.error ?? status)}${out.detail ? ` (${String(out.detail)})` : ''}\n`); process.exit(1) }
    console.log(`\n  ✓ Removed ${target.label}. Every device stops trusting it; it is signed out.\n`)
    process.exit(0)
  }
  if (sub === 'history') {
    const { status, json: out } = await call('GET', '/api/devices/history')
    needsNewerDaemon(status)
    if (status !== 200) { console.error('\n  ✗ The device history is not available (is this machine signed in?).\n'); process.exit(1) }
    if (json) { console.log(JSON.stringify(out)); process.exit(0) }
    for (const line of formatDeviceHistory(out as never)) console.log(line)
    process.exit(0)
  }
  if (sub === 'dismiss') {
    let target: { pub: string; label: string } | null = null
    if (arg) {
      const out = await listing()
      // A key that joined and left before anyone looked is no longer in the list: named by its key code.
      const key = norm(arg)
      const gone = key.length >= 4 ? (out.departed ?? []).filter((d) => norm(d.fingerprint).startsWith(key)) : []
      const listed = out.members.some((m) => norm(m.fingerprint).startsWith(key))
      target = gone.length === 1 && !listed ? gone[0] : resolve(arg, out.members).row
    }
    const { status } = await call('POST', '/api/devices/dismiss', target ? { pub: target.pub } : {})
    needsNewerDaemon(status)
    if (status !== 200) { console.error(`\n  ✗ Could not mark ${target ? 'it' : 'them'} as seen (is this machine signed in?).\n`); process.exit(1) }
    console.log(target ? `\n  ✓ Marked ${target.label || '(no name)'} as seen.\n` : '\n  ✓ Marked every device as seen.\n')
    process.exit(0)
  }
  if (sub === 'rebaseline') {
    const confirm = flags.includes('--yes')
    // Always preview first: --yes confirms with the head that was shown, so what gets trusted is what
    // was listed (a backend that swaps the list in between is refused).
    // The backend serves another account's list under this sign-in: a review does not switch accounts.
    const otherAccount = (s: number, body: unknown): boolean => s === 409 && (body as { error?: unknown } | null)?.error === 'OTHER_ACCOUNT'
    const OTHER_ACCOUNT = '\n  ✗ The device list now belongs to a different account than the one you signed in with. Sign in again (harness login) to switch accounts.\n'
    const { status, json: out } = await call('POST', '/api/devices/rebaseline', { confirm: false })
    if (otherAccount(status, out)) { console.error(OTHER_ACCOUNT); process.exit(1) }
    if (status !== 200) { console.error('\n  ✗ Could not read a valid device list from the backend.\n'); process.exit(1) }
    const r = out as { head?: { seq: number; hash: string }; added: Row[]; removed: Row[] }
    if (!confirm) {
      if (json) { console.log(JSON.stringify(out)); process.exit(0) }
      console.log('\n  Trusting the backend\'s device list again would:')
      for (const m of r.added) console.log(`    + add     ${m.label || '(no name)'}  ${m.kind}`)
      for (const m of r.removed) console.log(`    − remove  ${m.label || '(no name)'}  ${m.kind}`)
      if (!r.added.length && !r.removed.length) console.log('    (change no device)')
      console.log('\n  Only if every device listed is yours: harness devices rebaseline --yes\n')
      process.exit(0)
    }
    const done = await call('POST', '/api/devices/rebaseline', { confirm: true, ...(r.head ? { head: r.head } : {}) })
    if (otherAccount(done.status, done.json)) { console.error(OTHER_ACCOUNT); process.exit(1) }
    if (done.status === 409) { console.error('\n  ✗ The device list changed while you were reviewing it. Run it again.\n'); process.exit(1) }
    if (done.status !== 200) { console.error('\n  ✗ Could not read a valid device list from the backend.\n'); process.exit(1) }
    if (json) { console.log(JSON.stringify(done.json)); process.exit(0) }
    console.log('\n  Trusting the backend\'s device list again:')
    for (const m of r.added) console.log(`    + added    ${m.label || '(no name)'}  ${m.kind}`)
    for (const m of r.removed) console.log(`    − removed  ${m.label || '(no name)'}  ${m.kind}`)
    if (!r.added.length && !r.removed.length) console.log('    (no device changed)')
    console.log('\n  ✓ Done.\n')
    process.exit(0)
  }
  console.error(`Unknown command: devices ${sub}`)
  process.exit(1)
}

/** One row of `GET /api/machines`. Only the fields this CLI shows are declared. */
interface OwnerMachineRow {
  machineId: string
  name: string | null
  hostname: string | null
  status: string
  agentCount: number
}

/** The caller's machines, newest first. The backend already excludes deleted ones. */
async function fetchMachines(headers: Record<string, string>): Promise<OwnerMachineRow[]> {
  const data = await requestJson<{ machines?: OwnerMachineRow[] }>('GET', '/api/machines', undefined, headers)
  return data.machines ?? []
}

/** A machine's own name, else the hostname of the computer that last connected it. */
function machineLabel(machine: OwnerMachineRow): string {
  return machine.name?.trim() || machine.hostname?.trim() || '(unnamed)'
}

/** True when `id` names this machine — accepts the short prefix the list prints, not just the full id. */
function matchesMachineId(machineId: string, id: string): boolean {
  return machineId === id || machineId.startsWith(id)
}

/** `harness machines` — every machine on this account, with this computer's own marked. */
async function machinesListCommand(json: boolean): Promise<void> {
  const { session, headers } = await controlPlaneAuth()
  const machines = await fetchMachines(headers)
  if (json) {
    for (const machine of machines) {
      console.log(JSON.stringify({ ...machine, current: machine.machineId === session.machineId }))
    }
    process.exit(0)
  }
  if (!machines.length) {
    console.log('\n  No machines on this account yet.\n  Run `harness start` to connect this computer as one.\n')
    process.exit(0)
  }
  const rows = machines.map((machine) => ({
    id: machine.machineId.slice(0, 8),
    name: machineLabel(machine),
    status: machine.status || 'unknown',
    agents: String(machine.agentCount ?? 0),
    current: machine.machineId === session.machineId,
  }))
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length))
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length))
  console.log('')
  console.log(`  ${'MACHINE'.padEnd(8)}  ${'NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  AGENTS`)
  for (const row of rows) {
    const line = `  ${row.id.padEnd(8)}  ${row.name.padEnd(nameWidth)}  ${row.status.padEnd(statusWidth)}  ${row.agents.padStart(6)}`
    console.log(row.current ? `${line}   ← this computer` : line)
  }
  console.log('\n  Delete one:  harness machines delete <machine>\n')
  process.exit(0)
}

/**
 * `harness machines delete <machine>` — remove ANOTHER of your machines from this account.
 *
 * Deleting the machine this CLI is running as is refused, and refused BEFORE any network call. That
 * delete revokes the very credential the command is authenticating with: the daemon would be told to
 * wipe its session and stop while the command that asked for it is still running, and the operation
 * the user actually wants there has its own name — `harness logout` detaches this computer and stops
 * the daemon cleanly. The web UI can still delete this machine; that path is the one the daemon's
 * revoke handling exists for.
 */
async function machinesDeleteCommand(id: string | undefined, assumeYes: boolean): Promise<void> {
  if (!id) {
    console.error('Usage: harness machines delete <machine>   (see: harness machines)')
    process.exit(1)
    return
  }
  // Read the session straight off disk for this first check: refusing THIS machine must not depend on
  // a token refresh, which is a network round trip that can fail or hang. The refusal is a local fact.
  const local = readAuthSession()
  const refuseSelf = (): never => {
    console.error('\n  ✗ That is THIS computer\'s machine — refusing to delete it from here.')
    console.error('  ▸ To sign this computer out:      harness logout')
    console.error('  ▸ To also clear its local state:  harness reset\n')
    process.exit(1)
  }
  if (local?.machineId && matchesMachineId(local.machineId, id)) refuseSelf()

  const { session, headers } = await controlPlaneAuth()
  const machines = await fetchMachines(headers)
  const matches = machines.filter((machine) => matchesMachineId(machine.machineId, id))
  if (!matches.length) {
    console.error(`\n  ✗ No machine matches "${id}".`)
    console.error('  ▸ Run `harness machines` to see them.\n')
    process.exit(1)
    return
  }
  if (matches.length > 1) {
    console.error(`\n  ✗ "${id}" matches ${matches.length} machines:\n`)
    for (const machine of matches) console.error(`     ${machine.machineId.slice(0, 8)}  ${machineLabel(machine)}`)
    console.error('\n  ▸ Use more characters of the id.\n')
    process.exit(1)
    return
  }
  const target = matches[0]
  // Re-checked against the RESOLVED id: a short prefix that missed the session's machineId above can
  // still resolve to this computer's machine here.
  if (session.machineId === target.machineId) refuseSelf()

  if (!assumeYes) {
    process.stdout.write(
      `\n  Delete machine ${target.machineId.slice(0, 8)} (${machineLabel(target)})?`
      + ' Its agents stop being reachable and the computer running it signs out.'
      + '\n  Type the short id to confirm: ',
    )
    const answer = (await readStdinLine()).trim()
    if (answer !== target.machineId.slice(0, 8)) {
      console.log('\n  Cancelled — nothing was deleted.\n')
      process.exit(1)
    }
  }
  await requestJson('DELETE', `/api/machines/${target.machineId}`, undefined, headers)
  console.log(`\n  ✓ Deleted ${target.machineId.slice(0, 8)} (${machineLabel(target)}).`)
  console.log('    If that computer is running the daemon it signs out and stops on its own.\n')
  process.exit(0)
}

/** `harness status` — print the info block with the current running state. */
async function status(): Promise<void> {
  const pid = readPid()
  const alive = pid != null && isAlive(pid)
  const session = readAuthSession()
  const daemonStatus = alive ? await runningDaemonStatus() : null
  const signedIn = daemonStatus?.signedIn ?? session !== null
  if (!alive) registry.load()
  // A daemon whose start-up failed is alive and answering, but nothing on this machine works. Say so
  // in the one line a person reads, rather than leaving it looking like an ordinary slow start.
  const safeMode = alive ? readSafeModeMarker(env.ADAPTER_DATA_DIR, isAlive) : null
  // A core that cannot answer — restarting, starting, crash-looping — is described by its master.
  const masterStatus = alive ? readStatusFile(HARNESSD_STATUS_FILE, pid) : null
  const master = daemonStatus == null ? describeMasterStatus(masterStatus) : null
  printInfoBlock({
    // The backend link is the daemon's own business, so `status` is where it is read — `start` no
    // longer waits to see it, and a daemon with no backend is still serving every local agent.
    // Signed out is a WAY OF RUNNING, not a reason to say nothing: the daemon serves this computer,
    // and `machine: not signed in` in place of the whole block hid a running daemon and its agents.
    status: !alive
      ? '○ stopped'
      : master
        ? master
      : safeMode
        ? `◍ safe mode · start-up failed on v${safeMode.version} — waiting for a fixed build (${safeMode.error.split('\n')[0]})`
      : !signedIn
        ? '● running · this computer only (not signed in)'
        : daemonStatus == null
          ? '● running · not answering yet'
          : daemonStatus.connected
            ? '● running · backend connected'
            : '● running · backend offline — retrying in the background',
    pid: pid ?? 0,
    supervisor: masterStatus?.platform && supervisorRow(masterStatus.platform),
    machineId: session?.machineId,
    sessions: daemonStatus?.sessions ?? 0,
    // A stopped daemon answers nothing, so this falls back to the local build — which is what will run.
    version: daemonStatus?.version ?? VERSION,
    // Read from disk, not the daemon: it answers the same with the daemon stopped.
    // Signed out, devlog.json is the last account's copy: claiming membership from it would be wrong.
    // It is left on disk at logout on purpose: clearing it would drop the freeze and the rollback
    // protection with it. The stale window is after signing in again, possibly to a different account:
    // devlog.json still holds the previous account's log until the devlog syncer replaces it, so
    // `status` can say "(in your account)" from it for a while; that window is accepted.
    // A retired key with none in its place still says something, though: being removed from the
    // account is itself what signs a machine out (the daemon clears the session as it spends the key).
    device: (() => {
      const devlog = new DeviceLogStore().read()
      return deviceStatusValue(
        thisDeviceFingerprint(false),
        session
          ? deviceRegistration(peekIdentityPub(), devlog, identitySpent())
          : !peekIdentityPub() && identitySpent() ? 'removed' : null,
        devlog.conflict?.fingerprint,
      ) ?? undefined
    })(),
    // A status command can run with different shell settings from the daemon. Report the daemon's
    // connection, not those of this short-lived caller; missing fields on older daemons stay unknown.
    connection: {
      backendUrl: alive ? daemonStatus?.backendUrl ?? null : env.BACKEND_WS_URL,
      autonomousEnv: alive ? daemonStatus?.autonomousEnv ?? null : session?.autonomousEnv ?? env.AUTONOMOUS_ENV,
      signedIn,
      dataDir: alive ? daemonStatus?.dataDir ?? null : env.ADAPTER_DATA_DIR,
      authDir: alive ? daemonStatus?.authDir ?? null : AUTH_DIR,
    },
  })
  process.exit(0)
}

/**
 * `harness logs export [--to <dir>] [--days N] [--json]` — the last week of every log this product
 * writes, zipped to the Desktop (or `--to`), secrets blanked. The file a bug report is made of; the
 * desktop app's Settings ▸ Debug ▸ Export logs runs this same command.
 */
async function logsExportCommand(json: boolean): Promise<void> {
  const flagValue = (name: string): string | undefined => {
    const at = process.argv.indexOf(name)
    return at >= 0 ? process.argv[at + 1] : undefined
  }
  const days = Math.max(1, Number(flagValue('--days') ?? 7) || 7)
  const desktop = join(homedir(), 'Desktop')
  const to = flagValue('--to') ?? (existsSync(desktop) ? desktop : process.cwd())
  const now = new Date()
  const notes = [`machine: ${readAuthSession()?.machineId ?? 'not signed in'}`]
  const { zip, included } = buildLogBundle({
    logsDir: env.HARNESS_LOGS_DIR, dataDir: env.ADAPTER_DATA_DIR, days, now, version: VERSION, notes,
    redact: redactSecretsInText,
  })
  mkdirSync(to, { recursive: true })
  const path = join(to, bundleFileName(now))
  writeFileSync(path, zip)
  if (json) console.log(JSON.stringify({ path, included, bytes: zip.length }))
  else {
    console.log(`wrote ${tildify(path)} (${Math.round(zip.length / 1024)} KB)`)
    for (const name of included) console.log(`  ${name}`)
    if (!included.length) console.log('  (no logs found)')
  }
  process.exit(0)
}

import { orchestratorCommand } from './orchestrator/command.js'
import { teamCommand } from './teams/command.js'
import { channelCommand } from './teams/channelCommand.js'

// ── arg parse ──────────────────────────────────────────────────────────────────────────────────
// `hn` is the terminal client's short name (like tmux, fzf): the same CLI, entered at `tui`. A call
// back into this CLI from `hn` (login, start) is marked and runs as plain `harness`.
if (/^hn(\.js)?$/.test(process.argv[1]?.split(/[\\/]/).pop() ?? '') && process.env.HARNESS_SELF !== '1') process.argv.splice(2, 0, 'tui')
const [, , cmd, ...rest] = process.argv
const flags = rest.filter((a) => a.startsWith('-'))
const args = rest.filter((a) => !a.startsWith('-'))
const foreground = flags.includes('--foreground') || flags.includes('-f')
/** `--entry-point=<key>`: one token, so a build of this CLI that predates the flag drops it with
 *  every other unknown flag instead of mistaking `<key>` for a subcommand word. */
const entryPointFlag = (): string | undefined =>
  flags.find((f) => f.startsWith('--entry-point='))?.slice('--entry-point='.length) || undefined
const repair = flags.includes('--repair')

/** `argv` with the first occurrence of `token` removed, order otherwise untouched — how a subcommand
 *  word is dropped from an argv that is otherwise passed straight to a child. Flags typed BEFORE the
 *  word survive, which a slice from its index would discard. */
function withoutFirst(argv: string[], token: string): string[] {
  const at = argv.indexOf(token)
  return at < 0 ? argv : [...argv.slice(0, at), ...argv.slice(at + 1)]
}

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') usage()
if (cmd === 'version' || cmd === '--version' || cmd === '-v') { console.log(VERSION); process.exit(0) }


switch (cmd) {
  case 'team':
    teamCommand(rest).then(code => { process.exitCode = code }).catch(onError)
    break
  case 'channel':
    channelCommand(rest).then(code => { process.exitCode = code }).catch(onError)
    break
  case 'orchestrator':
    orchestratorCommand(rest).then(code => { process.exitCode = code }).catch(onError)
    break
  case 'login':
    // The result line goes out FIRST (loginCommand prints it), then the daemon is swapped onto the
    // account: the desktop app reads that line and does not wait for a restart it observes anyway.
    loginCommand(foreground, flags.includes('--force'), flags.includes('--json'), {
      entryPoint: entryPointFlag(),
      method: signInMethodFlag(flags) ?? (flags.includes('--json') || !process.stdin.isTTY ? undefined : 'ask'),
    })
      .then((outcome) => outcome.signedIn ? restartDaemonForIdentity(outcome.stoppedDaemon) : undefined)
      .catch(onError)
    break
  case 'auth':
    if (args[0] !== 'status') { console.error('Unknown command: auth ' + (args[0] ?? '')); usage(1) }
    else authStatusCommand(flags.includes('--json')).catch(onError)
    break
  case 'logout':
    logout().catch(onError)
    break
  case 'start': {
    // `--device-dump[=<file>]`: the daemon (this process with -f, else the detached child, which inherits
    // the environment) records every frame to/from a paired Autonomous device — see lib/autonomous-device/dump.ts.
    const dump = flags.find((f) => f === '--device-dump' || f.startsWith('--device-dump='))
    if (dump) process.env.HARNESS_DEVICE_DUMP = dump === '--device-dump' ? '1' : resolve(dump.slice('--device-dump='.length))
    startCommand(foreground, repair).catch(onError)
    break
  }
  case 'join':
    console.error('`harness join` has been removed. Run `harness login`, then `harness start`.')
    process.exit(1)
  // The bundle starts these three without loading this file (entry.ts); from the sources they come here.
  case '__harnessd': // internal: the master `harness start` launches; it runs and supervises `__run`
    startMaster({ scriptPath: SCRIPT_PATH })
    break
  case '__harnessd-probe': // internal: a master about to re-execute on this bundle asks it first (harnessd/reexec.ts)
    process.exitCode = probeThisMaster()
    break
  case '__service': // internal: a service harnessd's master runs in its own process (serviceProcess.ts)
    void startServiceProcess(rest[0])
    break
  case '__run': // internal: the detached daemon child reads the durable SSO session — or runs without one
    runCore(SCRIPT_PATH)
    break
  case 'autonomous-device':
    runAutonomousDeviceCommand(rest, env.ADAPTER_DATA_DIR, daemonPort()).then(code => { process.exitCode = code }).catch(onError)
    break
  case 'hardware':
    runDevicesCommand(rest, {
      port: daemonPort(),
      machineId: async () => (await runningDaemonStatus())?.machineId ?? null,
      connect: (url) => new NewCommandSocket(url),
    }).then(code => { process.exitCode = code }).catch(onError)
    break
  case 'pair':
    pairCommand(args[0]).catch(onError)
    break
  case 'browser-link':
  case 'e2ee-link':
    // Browser setup links served the retired web client. Said plainly rather than falling to "unknown
    // command", for anyone following an old doc.
    console.error(`\n  ✗ harness ${cmd} was removed: the web client is retired. Use the desktop or phone app.\n`)
    process.exit(1)
  case 'pairings':
    pairingsCommand().catch(onError)
    break
  case 'grid':
    if (args[0] === 'login') gridLoginCommand(flags.includes('--force'), flags.includes('--json')).catch(onError)
    else if (args[0] === 'setup') {
      gridSetupCommand({
        port: daemonPort(),
        localMachineId: readAuthSession()?.machineId ?? null,
        daemonRunning: isDaemonRunning,
        connect: (url) => new NewCommandSocket(url),
        output: (line) => console.log(line),
        error: (line) => console.error(line),
      }).then((code) => { process.exitCode = code }).catch(onError)
    }
    // Everything but the verb, in the order it was typed — a passthrough that allow-listed flags
    // would be a second place that has to know what `grid logout` accepts. Only the FIRST `logout`
    // token goes: filtering by value instead would eat an option's *value* the day `grid logout`
    // takes one, forwarding the flag with nothing behind it.
    else if (args[0] === 'logout') gridLogoutCommand(withoutFirst(rest, 'logout')).catch(onError)
    else if (args[0] === 'env') gridEnvCommand(args[1]).catch(onError)
    else { console.error(`Unknown command: grid ${args[0] ?? ''}`); usage(1) }
    break
  case 'dsh':
    dshCommand(args[0], args[0] === undefined ? rest : withoutFirst(rest, args[0]))
      .then((code) => { process.exitCode = code })
      .catch(onError)
    break
  case 'api':
    apiCommand(rest, new ApiConnections(env.ADAPTER_DATA_DIR))
      .then(code => { process.exitCode = code }).catch(onError)
    break
  case 'new':
    // `rest`, not args/flags: a first message and a folder are words in the order they were typed.
    newCommand({
      argv: rest,
      cwd: process.cwd(),
      home: homedir(),
      port: daemonPort(),
      localMachineId: readAuthSession()?.machineId ?? null,
      daemonRunning: isDaemonRunning,
      listMachines: async () => {
        const { session, headers } = await controlPlaneAuth()
        return (await fetchMachines(headers)).map((machine) => ({
          machineId: machine.machineId,
          label: machineLabel(machine),
          status: machine.status || 'unknown',
          current: machine.machineId === session.machineId,
        }))
      },
      connect: (url) => new NewCommandSocket(url),
      output: (line) => console.log(line),
      error: (line) => console.error(line),
    }).then((code) => { process.exitCode = code }).catch(onError)
    break
  case 'tui':
    tuiCommand(rest, { port: env.PORT, dataDir: env.ADAPTER_DATA_DIR, identity: wantedDaemonIdentity }).then((code) => { process.exitCode = code }).catch(onError)
    break
  case 'remote':
    remoteCommand({
      tmuxPane: process.env.TMUX_PANE,
      localMachineId: readAuthSession()?.machineId ?? null,
      port: daemonPort(),
      daemonRunning: isDaemonRunning,
      listMachines: async () => {
        const { session, headers } = await controlPlaneAuth()
        return (await fetchMachines(headers)).map((machine) => ({
          machineId: machine.machineId,
          label: machineLabel(machine),
          status: machine.status || 'unknown',
          current: machine.machineId === session.machineId,
        }))
      },
      isLinked: (machineId) => new MachinePeerStore().get(machineId) !== null,
      link: (machineId, password) => linkMachineWithPassword(machineId, password),
      promptPassword,
      input: process.stdin,
      output: process.stdout,
      error: (line) => console.error(line),
    }).then((code) => { process.exitCode = code }).catch(onError)
    break
  case 'search':
    process.exitCode = searchCommand({
      argv: rest,
      dataDir: env.ADAPTER_DATA_DIR,
      output: (line) => console.log(line),
      error: (line) => console.error(line),
      color: process.stdout.isTTY === true,
    })
    break
  case 'machines':
    if (!args[0]) machinesListCommand(flags.includes('--json')).catch(onError)
    else if (args[0] === 'list') machinesListCommand(flags.includes('--json')).catch(onError)
    else if (args[0] === 'delete' || args[0] === 'rm') {
      machinesDeleteCommand(args[1], flags.includes('--yes')).catch(onError)
    } else { console.error(`Unknown command: machines ${args[0]}`); usage(1) }
    break
  case 'link':
    // `--name=<label>` as one token: the argv split above would take a space-separated value for
    // the positional machine id, and a machine's display name routinely contains spaces.
    if (args[0] === 'connect') {
      const displayName = flags.find((flag) => flag.startsWith('--name='))?.slice('--name='.length)
      linkConnectCommand(args[1], flags.includes('--stdin'), flags.includes('--json'), displayName).catch(onError)
    }
    else if (args[0] === 'list') linkListCommand().catch(onError)
    else if (args[0] === 'unlink') linkUnlinkCommand(args[1]).catch(onError)
    else { console.error(`Unknown command: link ${args[0] ?? ''}`); usage(1) }
    break
  case 'group':
    groupCommand(args[0], args[1], flags.includes('--json')).catch(onError)
    break
  case 'devices':
    devicesCommand(args[0], args[1], flags).catch(onError)
    break
  case 'remote-password':
    if (args[0] === 'set') remotePasswordSetCommand(flags.includes('--json'), flags.includes('--stdin')).catch(onError)
    else if (args[0] === 'clear') remotePasswordClearCommand(flags.includes('--json')).catch(onError)
    else if (args[0] === 'status') remotePasswordStatusCommand(flags.includes('--json')).catch(onError)
    else { console.error(`Unknown command: remote-password ${args[0] ?? ''}`); usage(1) }
    break
  case 'unpair':
    unpairCommand(args[0], flags.includes('--all') || flags.includes('-a')).catch(onError)
    break
  // Hidden deprecated aliases (superseded by pairings / unpair) — kept so early scripts don't break.
  case 'pairs':
  case 'list-pairs':
    console.error(`(note: "${cmd}" is deprecated — use "harness pairings")`)
    pairingsCommand().catch(onError)
    break
  case 'revoke':
    console.error('(note: "revoke" is deprecated — use "harness unpair <#|fingerprint>")')
    unpairCommand(args[0], false).catch(onError)
    break
  case 'revoke-all':
    console.error('(note: "revoke-all" is deprecated — use "harness unpair --all")')
    unpairCommand(undefined, true).catch(onError)
    break
  case 'stop':
    stop().catch(onError)
    break
  case 'service':
    serviceCommand(rest, serviceCommandDeps({ relaunch: () => launch(false), tildify }))
      .then((code) => { process.exitCode = code }).catch(onError)
    break
  case 'reset':
    resetCommand().catch(onError)
    break
  case 'status':
    status().catch(onError)
    break
  case 'logs':
    if (args[0] === 'export') logsExportCommand(flags.includes('--json')).catch(onError)
    else { console.error(`Unknown command: logs ${args[0] ?? ''}`); usage(1) }
    break
  case 'update':
    updateCommand(flags.includes('--force')).catch(onError)
    break
  case 'flash':
    // Everything after `flash` belongs to the flasher, not to us — see lib/flash.ts on why the flags
    // are not parsed here. Its exit code is ours, so `harness flash --detect-only` works in a script.
    flashCommand(process.argv.slice(3))
      .then((code) => { process.exitCode = code })
      .catch(onError)
    break
  default:
    console.error(`Unknown command: ${cmd}`)
    usage(1)
}
