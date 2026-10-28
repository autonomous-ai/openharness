/**
 * The privileged scripts behind `harness team setup` and `harness team remove`, and the LaunchDaemon that runs the
 * team daemon (docs/plans/2026-10-24-swarm-team-account.md, Task 2). Each is built here as text, checked by its
 * spec, and run once as root behind the macOS administrator prompt (./admin.ts).
 *
 * Rules every line follows:
 * - Every value is checked against a strict pattern first (./layout.ts) and goes into the script single-quoted.
 *   Nothing a person typed reaches the shell unquoted, and nothing reaches it that the pattern did not allow.
 * - Root never writes inside the team account's home. That account may run a teammate's agent, which could plant a
 *   symbolic link where root is about to write and turn the write into one anywhere on disk. Root makes the home
 *   folder itself (its parent, /Users, is root's) and stages files in a folder only root can change; the team
 *   account copies them in itself (`as_team`). Likewise the sentinel in the owner's home is written as the owner.
 * - Every step checks what is there, so a second run repairs a first one that stopped part-way.
 */
import { TEAM_ENGINES } from './engines.js'
import {
  SENTINEL_NAME, TEAM_CONFIG_FILE, TEAM_LABEL, TEAM_PLIST, TEAM_SHARED_DIR, TEAM_SHARED_MARK, TEAM_STATUS_DIR,
  checkName, checkPath, checkPort, checkUser, teamLayout, teamPaths,
} from './layout.js'

/** POSIX single quotes: the one quoting with no special characters inside. */
export function sh(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function checkEnv(env: Record<string, string>): Record<string, string> {
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || CONTROL.test(value) || value.length > 1024) {
      throw new Error(`the team daemon cannot carry ${JSON.stringify(name)}=${JSON.stringify(value)}`)
    }
  }
  return env
}

/** What `team __start` is run with before the master, as the team account: redeem a handed-over sign-in code if
 *  there is one, run the privacy check, then the daemon. Positional, so no path is ever part of the shell source. */
export const TEAM_JOB_WRAPPER = '"$1" "$2" team __start "$3" >>"$4" 2>&1; exec "$1" "$2" __harnessd >>"$4" 2>&1'

export interface TeamPlistInput {
  label?: string
  user: string
  home: string
  /** The team account's own Node and CLI. */
  node: string
  cli: string
  port: number
  /** Backend settings carried from the owner's environment (./layout.ts `carriedBackendEnv`). */
  env: Record<string, string>
}

/**
 * The LaunchDaemon: launchd runs the team daemon as the team account from boot, and again if it crashes.
 *
 * No StandardOutPath: launchd may open it as root, inside a home the team account controls. The wrapper opens the
 * log itself, as the team account. No HARNESSD_PLATFORM either: that names the owner's own launchd agent
 * (harnessd/platform.ts), which `harness stop` inside the team account would otherwise try to stop.
 */
export function teamLaunchdPlist(input: TeamPlistInput): string {
  const user = checkUser(input.user)
  const home = checkPath(input.home, 'team home')
  const node = checkPath(input.node, 'team Node')
  const cli = checkPath(input.cli, 'team CLI')
  const port = checkPort(input.port)
  const paths = teamPaths(home)
  const environment = {
    HOME: home, USER: user, LOGNAME: user, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
    PATH: `${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ADAPTER_DATA_DIR: paths.data, PORT: String(port),
    ...checkEnv(input.env),
  }
  const vars = Object.entries(environment).map(([name, value]) => `\t\t<key>${xml(name)}</key>\n\t\t<string>${xml(value)}</string>`).join('\n')
  const args = ['/bin/sh', '-c', TEAM_JOB_WRAPPER, 'harness-team', node, cli, paths.handoff, paths.log]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The Harness Team account's daemon: Swarm work on this Mac runs as the separate user "${xml(user)}", which cannot
     read the owner's files. Written by "harness team setup"; "harness team status" shows it, "harness team remove"
     removes it with the account. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(input.label ?? TEAM_LABEL)}</string>
	<key>UserName</key>
	<string>${xml(user)}</string>
	<key>GroupName</key>
	<string>staff</string>
	<key>InitGroups</key>
	<true/>
	<key>ProgramArguments</key>
	<array>
${args.map((arg) => `\t\t<string>${xml(arg)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${vars}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xml(home)}</string>
	<key>RunAtLoad</key>
	<true/>
	<!-- Again after a crash, not after a clean exit: a clean exit is a stop someone asked for, or a sign-in that ended. -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
		<key>Crashed</key>
		<true/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>10</integer>
	<!-- The agents live in tmux and outlive the daemon, as they do for the owner's. -->
	<key>AbandonProcessGroup</key>
	<true/>
	<!-- Not Interactive like the owner's own daemon: the person at this Mac comes first. -->
	<key>ProcessType</key>
	<string>Standard</string>
</dict>
</plist>
`
}

export interface SetupScriptInput {
  user: string
  realName: string
  home: string
  owner: string
  ownerHome: string
  /** The owner's private staging folder, holding `team.json` and `team.plist`. */
  stageDir: string
  /** The owner's managed Node runtime folder (`~/.harness/runtime/node-…`), copied for the team account. */
  nodeRuntimeDir: string
  /** The owner's managed tmux folder, when the installer put one under ~/.harness/runtime; else Homebrew's serves. */
  tmuxRuntimeDir: string | null
  /** The owner's installed CLI folder (`~/.harness/cli`): cli.js, notify.mjs, package.json. */
  cliDir: string
  /** The owner's Node and CLI, run as the owner to mint the team sign-in code at the moment it is handed over. */
  ownerNode: string
  ownerCli: string
  /** Settings for that run: which backend, which sign-in folder. */
  mintEnv: Record<string, string>
  /** `missing`: hand over a sign-in only when the team account has none. `always`: a new one regardless. */
  signIn: 'missing' | 'always'
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The team account copies the staged runtime into its own home: run as that account, never as root. */
export const TEAM_COPY = [
  'set -eu',
  'umask 077',
  'stage=$1; home=$2; node_name=$3; tmux_name=$4',
  'rt="$home/.harness/runtime"; cli="$home/.harness/cli"; bin="$home/.local/bin"',
  'mkdir -p "$rt" "$cli/data" "$home/.harness/auth" "$bin"',
  'chmod 700 "$home/.harness" "$cli/data" "$home/.harness/auth"',
  'put_dir() { rm -rf "$2.next"; cp -R "$1" "$2.next"; rm -rf "$2"; mv "$2.next" "$2"; }',
  'put_dir "$stage/node" "$rt/$node_name"',
  `printf '%s\\n' "$rt/$node_name/bin/node" > "$rt/current-node.next" && mv -f "$rt/current-node.next" "$rt/current-node"`,
  // Its Node on its own PATH, as tmux is: Codex's launcher is `#!/usr/bin/env node`, and the account has no other Node, so
  // `codex login` in a terminal on its machine would not start. ~/.local/bin is last on a login shell's PATH: a Node the
  // system has wins.
  'ln -sfn "$rt/$node_name/bin/node" "$bin/node"',
  // And its npm and npx, so a teammate's Builder can install a project's packages and run its tests (team/nodeTools.ts).
  'for tool in npm npx; do [ ! -e "$rt/$node_name/bin/$tool" ] || ln -sfn "$rt/$node_name/bin/$tool" "$bin/$tool"; done',
  'if [ -n "$tmux_name" ]; then',
  '  put_dir "$stage/tmux" "$rt/$tmux_name"',
  `  printf '%s\\n' "$rt/$tmux_name/bin/tmux" > "$rt/current-tmux.next" && mv -f "$rt/current-tmux.next" "$rt/current-tmux"`,
  '  ln -sfn "$rt/$tmux_name/bin/tmux" "$bin/tmux"',
  'fi',
  'for f in cli.js notify.mjs package.json; do',
  '  [ ! -e "$stage/cli/$f" ] || { cp "$stage/cli/$f" "$cli/.$f.next" && mv -f "$cli/.$f.next" "$cli/$f"; }',
  'done',
  // The same launcher the installer writes, so `harness` works in the team account's own terminals.
  `printf '#!/bin/sh\\nexec "%s" "%s" "$@"\\n' "$rt/$node_name/bin/node" "$cli/cli.js" > "$bin/harness.next"`,
  'chmod 755 "$bin/harness.next" && mv -f "$bin/harness.next" "$bin/harness"',
].join('\n')

/**
 * Claude Code and Codex for the team account (./engines.ts), installed by that account itself, never by root: the vendors'
 * npm packages, with its own copy of Harness's Node and npm, under its own home (`~/.local`, whose bin folder is on its
 * daemon's PATH). Positional: the home, the Node folder's name, then the packages. A package that fails is said and left,
 * never failing setup: running setup again tries again, and `harness team status` shows what is missing.
 */
export const TEAM_ENGINES_INSTALL = [
  'set -u',
  'umask 022',
  'home=$1; node_name=$2; shift 2',
  'bin="$home/.harness/runtime/$node_name/bin"',
  `[ -x "$bin/npm" ] || { printf 'harness: %s\\n' "the team account's Node has no npm; Claude Code and Codex were not installed" >&2; exit 0; }`,
  'PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH',
  'cd "$home" || exit 0',
  'for pkg in "$@"; do',
  '  if "$bin/npm" install --global --prefix "$home/.local" --no-fund --no-audit --loglevel=error "$pkg" >/dev/null 2>&1; then',
  `    printf 'harness: installed %s for the team account\\n' "$pkg"`,
  `  else printf 'harness: could not install %s for the team account; harness team setup tries again\\n' "$pkg" >&2; fi`,
  'done',
].join('\n')

/**
 * The team account's password. macOS lists only an account with one: macOS 26 hides an account whose password is `*`
 * from Users & Groups. A random one, made here and forgotten: never printed, logged or stored, and never a process's
 * argument, where `ps` shows it to every account. `printf` is the shell's own, and dscl reads the command from its
 * input. Once: a repair run keeps the password there, and gives one to an account made before this (`*`). Set by root,
 * so the account gets no secure token. Run inside the setup script, with $TEAM and die().
 */
export const TEAM_PASSWORD = [
  'if ! dscl . -read "/Users/$TEAM" AuthenticationAuthority 2>/dev/null | grep -q ";ShadowHash;"; then',
  `  pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)`,
  '  [ "${#pw}" -eq 40 ] || die "could not make a password for the account $TEAM" 4',
  `  printf 'passwd /Users/%s %s\\n' "$TEAM" "$pw" | dscl . >/dev/null 2>&1 || true`,
  '  pw=',
  '  dscl . -read "/Users/$TEAM" AuthenticationAuthority 2>/dev/null | grep -q ";ShadowHash;" \\',
  '    || die "macOS did not take a password for the account $TEAM, so Users & Groups would not list it" 4',
  'fi',
].join('\n')

/** Stdin to a file, as whoever runs it: the next name first, then a rename, so a reader never sees half of it. */
export const WRITE_PRIVATE = 'umask 077 && cat > "$1.next" && mv -f "$1.next" "$1"'
export const WRITE_PUBLIC = 'umask 022 && cat > "$1.next" && chmod 644 "$1.next" && mv -f "$1.next" "$1"'

export const SENTINEL_TEXT = 'Harness Team privacy check. The Harness Team account on this Mac must not be able to read this file:'
  + ' if it can, your home folder is not private. It is removed with the account (harness team remove).'

/** Step 7 of every setup script, with its $SIGN_IN, $TEAM_SESSION, $HANDOFF, as_owner and as_team. */
const signInStep = (mintEnv: string): string[] => [
  'no_sign_in=',
  'if [ "$SIGN_IN" = always ] || [ ! -s "$TEAM_SESSION" ]; then',
  `  if minted=$(as_owner /usr/bin/env ${mintEnv ? `${mintEnv} ` : ''}"$OWNER_NODE" "$OWNER_CLI" team __handoff); then`,
  // Its last line: a warning the CLI printed first must not become part of the code.
  '    code=$(printf \'%s\\n\' "$minted" | tail -n 1)',
  // The shell's own check of what ./layout.ts HANDOFF_CODE allows: token characters, 16 to 256 of them.
  '    case $code in \'\'|*[!A-Za-z0-9_-]*) no_sign_in="the sign-in code was not in the form Harness expects" ;; esac',
  '    [ -n "$no_sign_in" ] || { [ "${#code}" -ge 16 ] && [ "${#code}" -le 256 ]; } || no_sign_in="the sign-in code was not in the form Harness expects"',
  '  else',
  '    no_sign_in="could not get a sign-in code from your Harness sign-in"',
  '  fi',
  '  if [ -z "$no_sign_in" ]; then',
  `    printf '%s\\n' "$code" | as_team /bin/sh -c ${sh(WRITE_PRIVATE)} sh "$HANDOFF"`,
  '    say "handed a sign-in to the team account"',
  '  fi',
  'fi',
]

/** Every value of a setup script, checked; the same checks on every platform. */
function checkedSetup(input: SetupScriptInput) {
  const user = checkUser(input.user, 'team account')
  const owner = checkUser(input.owner, 'owner account')
  if (user === owner) throw new Error('the team account must be a different account from the owner')
  if (!/^[A-Za-z0-9 ]{1,40}$/.test(input.realName)) throw new Error(`not a usable full name: ${JSON.stringify(input.realName)}`)
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  if (home === ownerHome || home.startsWith(`${ownerHome}/`) || ownerHome.startsWith(`${home}/`)) throw new Error('the team home and the owner home must be apart')
  const nodeDir = checkPath(input.nodeRuntimeDir, 'Node runtime')
  const tmuxDir = input.tmuxRuntimeDir === null ? null : checkPath(input.tmuxRuntimeDir, 'tmux runtime')
  return {
    user, owner, home, ownerHome, nodeDir, tmuxDir,
    stage: checkPath(input.stageDir, 'staging folder'),
    nodeName: checkName(basename(nodeDir), 'Node runtime folder'),
    tmuxName: tmuxDir === null ? '' : checkName(basename(tmuxDir), 'tmux runtime folder'),
    cliDir: checkPath(input.cliDir, 'installed CLI'),
    ownerNode: checkPath(input.ownerNode, 'owner Node'),
    ownerCli: checkPath(input.ownerCli, 'owner CLI'),
    mintEnv: Object.entries(checkEnv(input.mintEnv)).map(([name, value]) => sh(`${name}=${value}`)).join(' '),
    paths: teamPaths(home),
  }
}

export function buildSetupScript(input: SetupScriptInput): string {
  const { user, owner, home, ownerHome, stage, nodeDir, nodeName, tmuxDir, tmuxName, cliDir, ownerNode, ownerCli, mintEnv, paths } = checkedSetup(input)
  const lines = [
    '#!/bin/sh',
    '# Harness Team account setup (cli/src/team/script.ts), run once as root behind the macOS administrator prompt.',
    '# Running it again repairs what is there; `harness team remove` undoes it.',
    'set -eu',
    'umask 022',
    'cd /',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_NAME=${sh(input.realName)}`,
    `TEAM_HOME=${sh(home)}`,
    `OWNER=${sh(owner)}`,
    `OWNER_HOME=${sh(ownerHome)}`,
    `STAGE=${sh(stage)}`,
    `NODE_SRC=${sh(nodeDir)}`,
    `NODE_NAME=${sh(nodeName)}`,
    `TMUX_SRC=${sh(tmuxDir ?? '')}`,
    `TMUX_NAME=${sh(tmuxName)}`,
    `CLI_SRC=${sh(cliDir)}`,
    `OWNER_NODE=${sh(ownerNode)}`,
    `OWNER_CLI=${sh(ownerCli)}`,
    `SHARED=${sh(TEAM_SHARED_DIR)}`,
    `SHARED_MARK=${sh(TEAM_SHARED_MARK)}`,
    `CONFIG=${sh(TEAM_CONFIG_FILE)}`,
    `STATUS_DIR=${sh(TEAM_STATUS_DIR)}`,
    `LABEL=${sh(TEAM_LABEL)}`,
    `PLIST=${sh(TEAM_PLIST)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    `HANDOFF=${sh(paths.handoff)}`,
    `TEAM_SESSION=${sh(paths.session)}`,
    `SIGN_IN=${sh(input.signIn)}`,
    'as_team() { /usr/bin/sudo -n -H -u "$TEAM" "$@"; }',
    'as_owner() { /usr/bin/sudo -n -H -u "$OWNER" "$@"; }',
    // A folder root relies on must be root's alone, and not a link: another account could swap what it holds.
    'owned_by_root() {',
    '  [ -e "$1" ] || return 0',
    '  [ ! -L "$1" ] || die "$1 is a symbolic link" 6',
    '  [ "$(stat -f %u "$1")" = 0 ] || die "$1 is not owned by root" 6',
    '  mode=$(stat -f %Lp "$1")',
    '  [ $((0$mode & 022)) -eq 0 ] || die "$1 can be written by others" 6',
    '}',
    '# The first free user id at or above 600, as the guest helper picks one.',
    'free_id() {',
    "  used=$(dscl . -list /Users UniqueID | awk '{print $2}')",
    '  candidate=600',
    '  while printf \'%s\\n\' "$used" | grep -qx "$candidate"; do candidate=$((candidate + 1)); done',
    "  printf '%s' \"$candidate\"",
    '}',
    '',
    '[ "$(id -u)" = 0 ] || die "run as root"',
    '[ "$(uname -s)" = Darwin ] || die "the Harness Team account is for macOS"',
    'for dir in / /Users /Library "/Library/Application Support" /Library/LaunchDaemons; do owned_by_root "$dir"; done',
    'owner_uid=$(id -u "$OWNER") || die "no such account: $OWNER"',
    '[ "$owner_uid" != 0 ] || die "the owner cannot be root"',
    '[ -d "$OWNER_HOME" ] && [ ! -L "$OWNER_HOME" ] || die "$OWNER_HOME is not a folder"',
    '[ "$(stat -f %u "$OWNER_HOME")" = "$owner_uid" ] || die "$OWNER_HOME does not belong to $OWNER"',
    '[ -f "$CLI_SRC/cli.js" ] || die "no installed Harness CLI at $CLI_SRC"',
    '[ -x "$NODE_SRC/bin/node" ] || die "no Harness Node runtime at $NODE_SRC"',
    '',
    '# 1. The account: a standard user named Harness Team, listed in System Settings > Users & Groups. Its password is',
    '#    random and nobody knows it, so nobody can sign in to it. An account by this name that is not ours is left alone.',
    'if dscl . -read "/Users/$TEAM" UniqueID >/dev/null 2>&1; then',
    "  existing=$(dscl . -read \"/Users/$TEAM\" NFSHomeDirectory 2>/dev/null | awk '{print $2}')",
    '  [ "$existing" = "$TEAM_HOME" ] || die "an account named $TEAM already exists and is not the Harness Team account; nothing was changed" 4',
    'else',
    '  say "creating the account $TEAM_NAME ($TEAM)"',
    '  uid=$(free_id)',
    '  dscl . -create "/Users/$TEAM"',
    // No way in while the record is being made: the random password below replaces this.
    "  dscl . -create \"/Users/$TEAM\" Password '*'",
    '  dscl . -create "/Users/$TEAM" UniqueID "$uid"',
    '  dscl . -create "/Users/$TEAM" NFSHomeDirectory "$TEAM_HOME"',
    'fi',
    'dscl . -create "/Users/$TEAM" RealName "$TEAM_NAME"',
    'dscl . -create "/Users/$TEAM" PrimaryGroupID 20',
    'dscl . -create "/Users/$TEAM" UserShell /bin/zsh',
    TEAM_PASSWORD,
    // Visible on purpose (see layout.ts): an earlier hidden setup is made visible again.
    'dscl . -delete "/Users/$TEAM" IsHidden >/dev/null 2>&1 || true',
    'if dseditgroup -o checkmember -m "$TEAM" admin >/dev/null 2>&1; then dseditgroup -o edit -d "$TEAM" -t user admin; fi',
    'team_uid=$(id -u "$TEAM")',
    '',
    '# 2. Its home folder, private to it.',
    '[ ! -L "$TEAM_HOME" ] || die "$TEAM_HOME is a symbolic link" 4',
    'if [ ! -d "$TEAM_HOME" ]; then',
    '  createhomedir -c -u "$TEAM" >/dev/null 2>&1 || true',
    '  [ -d "$TEAM_HOME" ] || mkdir "$TEAM_HOME"',
    'fi',
    'home_uid=$(stat -f %u "$TEAM_HOME")',
    '[ "$home_uid" = "$team_uid" ] || [ "$home_uid" = 0 ] || die "$TEAM_HOME belongs to another account" 4',
    'chown "$TEAM:staff" "$TEAM_HOME"',
    'chmod 700 "$TEAM_HOME"',
    '',
    '# 3. The owner\'s home folder, private: every account on a Mac is in the group staff, and a home folder is',
    '#    readable by that group by default. The sentinel inside is readable by everyone on purpose, so the',
    '#    privacy check proves the folder\'s own mode keeps it out.',
    'say "making $OWNER_HOME private (mode 700)"',
    'chmod 700 "$OWNER_HOME"',
    `printf '%s\\n' ${sh(SENTINEL_TEXT)} | as_owner /bin/sh -c ${sh(WRITE_PUBLIC)} sh "$SENTINEL"`,
    '',
    '# 4. The team daemon stops while its files are replaced. Its agents keep running in tmux.',
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    '',
    '# 5. The Harness runtime, staged where only root can change it, then copied in by the team account itself.',
    'RT=$(mktemp -d /private/var/tmp/harness-team.XXXXXX)',
    'trap \'rm -rf "$RT"\' EXIT',
    'mkdir "$RT/node" "$RT/cli"',
    'for part in bin lib include; do [ ! -e "$NODE_SRC/$part" ] || cp -R "$NODE_SRC/$part" "$RT/node/"; done',
    'for f in cli.js notify.mjs package.json; do [ ! -e "$CLI_SRC/$f" ] || cp "$CLI_SRC/$f" "$RT/cli/"; done',
    'if [ -n "$TMUX_NAME" ]; then cp -R "$TMUX_SRC" "$RT/tmux"; fi',
    'chmod -R a+rX,go-w "$RT"',
    'chmod 755 "$RT"',
    `as_team /bin/sh -c ${sh(TEAM_COPY)} sh "$RT" "$TEAM_HOME" "$NODE_NAME" "$TMUX_NAME"`,
    '',
    '# 5b. Claude Code and Codex, installed by the team account itself into its own home: the owner\'s copies are inside the',
    '#     owner\'s private home. None of the owner\'s sign-ins is copied; the owner signs them in once (harness team status).',
    `as_team /bin/sh -c ${sh(TEAM_ENGINES_INSTALL)} sh "$TEAM_HOME" "$NODE_NAME" ${TEAM_ENGINES.map((e) => sh(e.packageName)).join(' ')} || true`,
    '',
    '# 6. What setup made (root\'s), and the team account\'s status folder, which the owner can read.',
    // A folder setup made says so, so that removal takes it away again once it is empty, and never one made by anything else.
    'made_shared=',
    'if [ ! -d "$SHARED" ]; then mkdir "$SHARED"; chown 0:0 "$SHARED"; chmod 755 "$SHARED"; made_shared=1; fi',
    'owned_by_root "$SHARED"',
    '[ -z "$made_shared" ] || : > "$SHARED_MARK"',
    'install -o 0 -g 0 -m 0644 "$STAGE/team.json" "$CONFIG"',
    '[ ! -L "$STATUS_DIR" ] || die "$STATUS_DIR is a symbolic link" 6',
    '[ -d "$STATUS_DIR" ] || mkdir "$STATUS_DIR"',
    'chown "$TEAM:staff" "$STATUS_DIR"',
    'chmod 755 "$STATUS_DIR"',
    '',
    '# 7. Sign-in: a single-use code minted from the owner\'s own sign-in now, so its 90 seconds start here, and',
    '#    written where only the team account can read it. The team daemon redeems it as it starts and deletes it.',
    '#    A code that cannot be had is reported after step 8: step 4 stopped the daemon, and it must start again,',
    '#    with the sign-in it had or none, rather than stay stopped until the next successful setup or restart.',
    ...signInStep(mintEnv),
    '',
    '# 8. The LaunchDaemon, root\'s, which runs the team daemon as the team account from boot.',
    'install -o 0 -g 0 -m 0644 "$STAGE/team.plist" "$PLIST"',
    'plutil -lint "$PLIST" >/dev/null || die "the team daemon\'s definition is not valid" 8',
    'launchctl enable "system/$LABEL" >/dev/null 2>&1 || true',
    'tries=0',
    'until launchctl bootstrap system "$PLIST" >/dev/null 2>&1; do',
    '  tries=$((tries + 1))',
    '  [ "$tries" -lt 5 ] || die "launchd would not start the team daemon" 8',
    '  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    '  sleep 1',
    'done',
    'say "the team daemon runs as $TEAM ($LABEL)"',
    '[ -z "$no_sign_in" ] || die "$no_sign_in; the team daemon runs without a new sign-in" 7',
    '',
  ]
  return lines.join('\n')
}

export interface RemoveScriptInput {
  user: string
  home: string
  ownerHome: string
  /** The owner's account name, whose relay folder setup made (Linux; on a Mac the owner's daemon makes it). */
  owner?: string
}

/** The exit status of a removal that deleted nothing because macOS kept the account: the team daemon runs again. */
export const REMOVE_REFUSED = 9

/** What the removal says last on success when it read the team account's computer id: `harness team remove` then takes
 *  that computer off the owner's Harness account, which ends its team sign-in (./command.ts). */
export const TEAM_COMPUTER_LINE = /^harness: team computer ([A-Za-z0-9_-]{1,128})$/m

export function buildRemoveScript(input: RemoveScriptInput): string {
  const user = checkUser(input.user, 'team account')
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  const paths = teamPaths(home)
  return [
    '#!/bin/sh',
    '# Harness Team account removal (cli/src/team/script.ts), run once as root: behind the macOS administrator prompt, or',
    '# with sudo in a terminal. It leaves the owner\'s home folder private, as setup made it.',
    '#',
    '# The account goes first, before anything that cannot be undone. macOS 26 deletes an account only for an app the',
    '# person allowed to administer the computer (Privacy & Security\'s "administer your computer"). It cannot ask that',
    '# for the administrator prompt\'s own process, or for a LaunchDaemon, and refuses them (eDSPermissionError); it',
    '# asks it for a terminal app. When it refuses, the team daemon runs again and nothing else has changed.',
    'set -eu',
    'cd /',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_HOME=${sh(home)}`,
    `LABEL=${sh(TEAM_LABEL)}`,
    `PLIST=${sh(TEAM_PLIST)}`,
    `CONFIG=${sh(TEAM_CONFIG_FILE)}`,
    `STATUS_DIR=${sh(TEAM_STATUS_DIR)}`,
    `SHARED=${sh(TEAM_SHARED_DIR)}`,
    `SHARED_MARK=${sh(TEAM_SHARED_MARK)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    `COMPUTER_ID=${sh(paths.computerId)}`,
    // What Users & Groups leaves when the account is deleted there with "Don't change the home folder".
    `DELETED_HOME=${sh(`${home} (Deleted)`)}`,
    '[ "$(id -u)" = 0 ] || die "run as root"',
    'exists=',
    'team_uid=',
    'if dscl . -read "/Users/$TEAM" UniqueID >/dev/null 2>&1; then',
    '  exists=1',
    "  existing=$(dscl . -read \"/Users/$TEAM\" NFSHomeDirectory 2>/dev/null | awk '{print $2}')",
    '  [ "$existing" = "$TEAM_HOME" ] || die "the account $TEAM is not the Harness Team account (its home is $existing); nothing was removed" 4',
    '  team_uid=$(id -u "$TEAM")',
    'fi',
    // A home left by a team account deleted earlier (in Users & Groups, say) is owned by a bare user id; anyone else's is
    // not ours to delete. That id has no account, so whatever still runs under it was the team account's. By number:
    // `stat -f %Su` prints such an owner as "(600)" on macOS 26.
    'for left in "$TEAM_HOME" "$DELETED_HOME"; do',
    '  [ -e "$left" ] && [ ! -L "$left" ] || continue',
    '  holder_uid=$(stat -f %u "$left")',
    '  holder=$(id -un "$holder_uid" 2>/dev/null) || holder=',
    '  case $holder in',
    '    "$TEAM"|root) ;;',
    '    \'\') [ -n "$team_uid" ] || team_uid=$holder_uid ;;',
    '    *) die "$left belongs to $holder; nothing was removed" 4 ;;',
    '  esac',
    'done',
    // Read as the team account, never followed as root, and only in the form a computer id has.
    'computer=',
    'if [ -n "$exists" ]; then',
    '  computer=$(/usr/bin/sudo -n -u "$TEAM" /bin/cat "$COMPUTER_ID" 2>/dev/null | head -n 1) || computer=',
    '  case $computer in \'\'|*[!A-Za-z0-9_-]*) computer= ;; esac',
    '  [ "${#computer}" -le 128 ] || computer=',
    'fi',
    '',
    '# 1. The team daemon stops, so it starts nothing while the account goes. Its agents keep running in tmux.',
    'launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true',
    '',
    '# 2. The account. When macOS keeps it, the daemon starts again, as setup starts it, and nothing else was changed.',
    'if [ -n "$exists" ]; then',
    '  if ! why=$(dscl . -delete "/Users/$TEAM" 2>&1); then',
    '    why=$(printf \'%s\\n\' "$why" | tail -n 1)',
    '    again=no',
    '    if [ -f "$PLIST" ]; then',
    '      tries=0',
    '      until launchctl bootstrap system "$PLIST" >/dev/null 2>&1; do',
    '        tries=$((tries + 1)); [ "$tries" -lt 5 ] || break',
    '        launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true; sleep 1',
    '      done',
    '      launchctl print "system/$LABEL" >/dev/null 2>&1 && again=yes',
    '    fi',
    '    case $why in *eDSPermissionError*) why="macOS did not allow it (eDSPermissionError)" ;; esac',
    `    [ "$again" = yes ] || die "could not delete the account $TEAM: $why. Nothing was removed, but the team daemon did not start again: harness team setup starts it" ${REMOVE_REFUSED}`,
    `    die "could not delete the account $TEAM: $why. Nothing was removed: the Harness Team account and its daemon run as before" ${REMOVE_REFUSED}`,
    '  fi',
    '  say "deleted the account $TEAM"',
    'fi',
    '',
    '# 3. What it left: its processes, its daemon\'s definition, its home, what setup made and the privacy sentinel.',
    'if [ -n "$team_uid" ] && [ "$team_uid" -gt 500 ]; then pkill -KILL -u "$team_uid" >/dev/null 2>&1 || true; sleep 1; fi',
    // An account deleted elsewhere cannot be asked for its computer id: read it from the home it left, now that nothing
    // runs under its id, only from a plain file that id owns, never through a link.
    'if [ -z "$exists" ] && [ -n "$team_uid" ]; then',
    '  for left in "$TEAM_HOME" "$DELETED_HOME"; do',
    '    f="$left/.harness/computer-id"',
    '    [ ! -L "$left" ] && [ ! -L "$left/.harness" ] && [ ! -L "$f" ] && [ -f "$f" ] || continue',
    '    [ "$(stat -f %u "$f")" = "$team_uid" ] || continue',
    '    computer=$(head -n 1 "$f") || computer=',
    '    case $computer in \'\'|*[!A-Za-z0-9_-]*) computer= ;; esac',
    '    [ "${#computer}" -le 128 ] || computer=',
    '    [ -z "$computer" ] || break',
    '  done',
    'fi',
    'rm -f "$PLIST"',
    'rm -rf "$TEAM_HOME" "$STATUS_DIR"',
    '[ ! -e "$DELETED_HOME" ] || [ -L "$DELETED_HOME" ] || rm -rf "$DELETED_HOME"',
    'rm -f "$CONFIG" "$SENTINEL"',
    // The shared folder, only when setup made it and nothing else has been put in it since.
    `if [ -f "$SHARED_MARK" ] && [ ! -L "$SHARED" ] && [ -z "$(ls -A "$SHARED" | grep -vx ${sh(basename(TEAM_SHARED_MARK))} || true)" ]; then`,
    '  rm -f "$SHARED_MARK"',
    '  rmdir "$SHARED" 2>/dev/null || true',
    'fi',
    '[ -z "$computer" ] || say "team computer $computer"',
    'say "removed the Harness Team account, its home folder and its daemon"',
    '',
  ].join('\n')
}

// ── Linux ─────────────────────────────────────────────────────────────────────────────────────
//
// The same account and the same rules, built from what Harness already uses on Linux: useradd and setfacl, as the guest
// helper does (assets/guest-helper/guest-helper.sh), and systemd, which supervises the owner's daemon there too
// (harnessd/platform.ts). docs/superpowers/plans/2026-10-28-harness-team-account-linux.md.

const LINUX = teamLayout('linux')!

/** Why setup stops on a Linux computer that systemd does not run (a container, WSL1): exit 3, before anything is made. */
export const LINUX_NO_SYSTEMD = 'systemd does not run this computer, and the Harness Team account needs it to run its daemon'
/** Why it stops without a tmux every account can run: the team account has no managed tmux on Linux, it uses the system's. */
export const LINUX_NO_TMUX = 'no tmux every account can run: install it (apt install tmux / dnf install tmux)'

/** A value inside a systemd unit's double quotes: systemd reads `%` and `\` there itself, and `$` in ExecStart. Never
 *  needed by a checked path or a carried backend address, so refused rather than escaped. */
function unitWord(value: string): string {
  for (const special of ['"', '\\', '%', '$', "'"]) {
    if (value.includes(special)) throw new Error(`the team daemon's unit cannot carry ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The systemd system unit: systemd runs the team daemon as the team account from boot, and again if it fails. The
 * LaunchDaemon's twin (`teamLaunchdPlist`), with the same command, environment and choices.
 */
export function teamSystemdUnit(input: TeamPlistInput): string {
  const user = checkUser(input.user)
  const home = checkPath(input.home, 'team home')
  const node = checkPath(input.node, 'team Node')
  const cli = checkPath(input.cli, 'team CLI')
  const port = checkPort(input.port)
  const paths = teamPaths(home)
  const environment = {
    HOME: home, USER: user, LOGNAME: user, SHELL: '/bin/bash', LANG: 'C.UTF-8',
    PATH: `${paths.bin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ADAPTER_DATA_DIR: paths.data, PORT: String(port),
    ...checkEnv(input.env),
  }
  const vars = Object.entries(environment).map(([name, value]) => `Environment="${name}=${unitWord(value)}"`).join('\n')
  // systemd expands `$NAME` in ExecStart itself, even inside quotes: `$$` is a plain `$` for the shell.
  const wrapper = TEAM_JOB_WRAPPER.replaceAll('$', '$$')
  const args = [node, cli, paths.handoff, paths.log].map((arg) => `'${unitWord(arg)}'`).join(' ')
  return `# The Harness Team account's daemon: Swarm work on this computer runs as the separate user "${user}", which cannot
# read the owner's files. Written by "harness team setup"; "harness team status" shows it, "harness team remove"
# removes it with the account.
[Unit]
Description=Harness Team daemon (Swarm work as ${user})
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${user}
Group=${LINUX.group}
WorkingDirectory=${unitWord(home)}
${vars}
# The wrapper opens the log itself, as the team account, inside its own home: systemd never opens it as root.
ExecStart=/bin/sh -c '${wrapper}' harness-team ${args}
# Again after a failure, not after a clean exit: a clean exit is a stop someone asked for, or a sign-in that ended.
Restart=on-failure
RestartSec=10
TimeoutStopSec=10
# The agents live in tmux and outlive the daemon, as they do for the owner's.
KillMode=process

[Install]
WantedBy=multi-user.target
`
}

/** A folder root relies on must be root's alone, and not a link: another account could swap what it holds. GNU stat. */
const LINUX_OWNED_BY_ROOT = [
  'owned_by_root() {',
  '  [ -e "$1" ] || return 0',
  '  [ ! -L "$1" ] || die "$1 is a symbolic link" 6',
  '  [ "$(stat -c %u "$1")" = 0 ] || die "$1 is not owned by root" 6',
  '  mode=$(stat -c %a "$1")',
  '  [ $((0$mode & 022)) -eq 0 ] || die "$1 can be written by others" 6',
  '}',
]

export function buildLinuxSetupScript(input: SetupScriptInput): string {
  const { user, owner, home, ownerHome, stage, nodeDir, nodeName, cliDir, ownerNode, ownerCli, mintEnv, paths } = checkedSetup(input)
  const state = LINUX.statusDir.slice(0, LINUX.statusDir.lastIndexOf('/'))
  const lines = [
    '#!/bin/sh',
    '# Harness Team account setup for Linux (cli/src/team/script.ts), run once as root through pkexec or sudo.',
    '# Running it again repairs what is there; `harness team remove` undoes it.',
    'set -eu',
    'umask 022',
    'cd /',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_GROUP=${sh(LINUX.group)}`,
    `TEAM_NAME=${sh(input.realName)}`,
    `TEAM_HOME=${sh(home)}`,
    `OWNER=${sh(owner)}`,
    `OWNER_HOME=${sh(ownerHome)}`,
    `STAGE=${sh(stage)}`,
    `NODE_SRC=${sh(nodeDir)}`,
    `NODE_NAME=${sh(nodeName)}`,
    `CLI_SRC=${sh(cliDir)}`,
    `OWNER_NODE=${sh(ownerNode)}`,
    `OWNER_CLI=${sh(ownerCli)}`,
    `SHARED=${sh(LINUX.sharedDir)}`,
    `SHARED_MARK=${sh(LINUX.sharedMark)}`,
    `CONFIG=${sh(LINUX.configFile)}`,
    `STATE=${sh(state)}`,
    `STATE_MARK=${sh(`${state}/${basename(LINUX.sharedMark)}`)}`,
    `STATUS_DIR=${sh(LINUX.statusDir)}`,
    `RELAY_DIR=${sh(LINUX.relayDir(owner))}`,
    `UNIT_NAME=${sh(LINUX.service.label)}`,
    `UNIT=${sh(LINUX.service.file)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    `HANDOFF=${sh(paths.handoff)}`,
    `TEAM_SESSION=${sh(paths.session)}`,
    `SIGN_IN=${sh(input.signIn)}`,
    // util-linux's, wherever systemd runs; sudo may not be installed (pkexec asked for root).
    'as_team() { runuser -u "$TEAM" -- "$@"; }',
    'as_owner() { runuser -u "$OWNER" -- "$@"; }',
    ...LINUX_OWNED_BY_ROOT,
    '',
    '[ "$(id -u)" = 0 ] || die "run as root"',
    '[ "$(uname -s)" = Linux ] || die "this Harness Team account setup is for Linux"',
    // Before anything is made: without systemd nothing would run the team daemon, and a half-made account would stay.
    `[ -d /run/systemd/system ] || die ${sh(LINUX_NO_SYSTEMD)} 3`,
    'for tool in setfacl useradd userdel groupadd gpasswd runuser systemctl; do',
    '  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing on this computer: the Harness Team account needs it" 3',
    'done',
    // The system's tmux, run as an account with nothing of its own, as the team account will run it.
    `runuser -u nobody -- tmux -V >/dev/null 2>&1 || die ${sh(LINUX_NO_TMUX)} 3`,
    'for dir in / /home /etc /var/lib /etc/systemd/system; do owned_by_root "$dir"; done',
    'owner_uid=$(id -u "$OWNER") || die "no such account: $OWNER"',
    'owner_gid=$(id -g "$OWNER")',
    '[ "$owner_uid" != 0 ] || die "the owner cannot be root"',
    '[ -d "$OWNER_HOME" ] && [ ! -L "$OWNER_HOME" ] || die "$OWNER_HOME is not a folder"',
    '[ "$(stat -c %u "$OWNER_HOME")" = "$owner_uid" ] || die "$OWNER_HOME does not belong to $OWNER"',
    '[ -f "$CLI_SRC/cli.js" ] || die "no installed Harness CLI at $CLI_SRC"',
    '[ -x "$NODE_SRC/bin/node" ] || die "no Harness Node runtime at $NODE_SRC"',
    '',
    '# 1. The account: a standard user named Harness Team, with a user id from 1000 up like a person\'s, so it is listed.',
    '#    Its password is locked: nobody can sign in to it. An account by this name that is not ours is left alone.',
    'if entry=$(getent passwd "$TEAM"); then',
    '  existing=$(printf \'%s\\n\' "$entry" | cut -d: -f6)',
    '  [ "$existing" = "$TEAM_HOME" ] || die "an account named $TEAM already exists and is not the Harness Team account; nothing was changed" 4',
    'else',
    '  say "creating the account $TEAM_NAME ($TEAM)"',
    '  groupadd -f "$TEAM_GROUP"',
    '  useradd -m -d "$TEAM_HOME" -g "$TEAM_GROUP" -s /bin/bash -c "$TEAM_NAME" "$TEAM"',
    'fi',
    'passwd -l "$TEAM" >/dev/null 2>&1 || die "could not lock the password of the account $TEAM" 4',
    'for group in sudo wheel admin; do',
    '  if id -nG "$TEAM" | tr \' \' \'\\n\' | grep -qx "$group"; then gpasswd -d "$TEAM" "$group" >/dev/null; fi',
    'done',
    'team_uid=$(id -u "$TEAM")',
    '',
    '# 2. Its home folder, private to it.',
    '[ ! -L "$TEAM_HOME" ] || die "$TEAM_HOME is a symbolic link" 4',
    '[ -d "$TEAM_HOME" ] || mkdir "$TEAM_HOME"',
    'home_uid=$(stat -c %u "$TEAM_HOME")',
    '[ "$home_uid" = "$team_uid" ] || [ "$home_uid" = 0 ] || die "$TEAM_HOME belongs to another account" 4',
    'chown "$TEAM:$TEAM_GROUP" "$TEAM_HOME"',
    'chmod 700 "$TEAM_HOME"',
    '',
    '# 3. The owner\'s home folder, private: Debian, and Ubuntu before 21.04, make home folders readable by everyone. The',
    '#    sentinel inside is readable by everyone on purpose, so the privacy check proves the folder\'s own mode keeps it out.',
    'say "making $OWNER_HOME private (mode 700)"',
    'chmod 700 "$OWNER_HOME"',
    `printf '%s\\n' ${sh(SENTINEL_TEXT)} | as_owner /bin/sh -c ${sh(WRITE_PUBLIC)} sh "$SENTINEL"`,
    '',
    '# 4. The team daemon stops while its files are replaced. Its agents keep running in tmux (KillMode=process).',
    'systemctl stop "$UNIT_NAME" >/dev/null 2>&1 || true',
    '',
    '# 5. The Harness runtime, staged where only root can change it, then copied in by the team account itself.',
    'RT=$(mktemp -d /var/tmp/harness-team.XXXXXX)',
    'trap \'rm -rf "$RT"\' EXIT',
    'mkdir "$RT/node" "$RT/cli"',
    'for part in bin lib include; do [ ! -e "$NODE_SRC/$part" ] || cp -R "$NODE_SRC/$part" "$RT/node/"; done',
    'for f in cli.js notify.mjs package.json; do [ ! -e "$CLI_SRC/$f" ] || cp "$CLI_SRC/$f" "$RT/cli/"; done',
    'chmod -R a+rX,go-w "$RT"',
    'chmod 755 "$RT"',
    // No tmux of its own: the system's serves every account (checked above).
    `as_team /bin/sh -c ${sh(TEAM_COPY)} sh "$RT" "$TEAM_HOME" "$NODE_NAME" ''`,
    '',
    '# 5b. Claude Code and Codex, installed by the team account itself into its own home: the owner\'s copies are inside the',
    '#     owner\'s private home. None of the owner\'s sign-ins is copied.',
    `as_team /bin/sh -c ${sh(TEAM_ENGINES_INSTALL)} sh "$TEAM_HOME" "$NODE_NAME" ${TEAM_ENGINES.map((e) => sh(e.packageName)).join(' ')} || true`,
    '',
    '# 6. What setup made (root\'s), the team account\'s status folder, which the owner can read, and the owner\'s relay folder.',
    'made_shared=',
    'if [ ! -d "$SHARED" ]; then mkdir "$SHARED"; chown 0:0 "$SHARED"; chmod 755 "$SHARED"; made_shared=1; fi',
    'owned_by_root "$SHARED"',
    '[ -z "$made_shared" ] || : > "$SHARED_MARK"',
    'install -o 0 -g 0 -m 0644 "$STAGE/team.json" "$CONFIG"',
    'made_state=',
    'if [ ! -d "$STATE" ]; then mkdir "$STATE"; chown 0:0 "$STATE"; chmod 755 "$STATE"; made_state=1; fi',
    'owned_by_root "$STATE"',
    '[ -z "$made_state" ] || : > "$STATE_MARK"',
    '[ ! -L "$STATUS_DIR" ] || die "$STATUS_DIR is a symbolic link" 6',
    '[ -d "$STATUS_DIR" ] || mkdir "$STATUS_DIR"',
    'chown "$TEAM:$TEAM_GROUP" "$STATUS_DIR"',
    'chmod 755 "$STATUS_DIR"',
    // Nobody but root can make a folder in $STATE, so setup makes the owner's: the owner's daemon then lets the team account
    // read it with an ACL (./relay.ts).
    '[ ! -L "$RELAY_DIR" ] || die "$RELAY_DIR is a symbolic link" 6',
    '[ -d "$RELAY_DIR" ] || mkdir "$RELAY_DIR"',
    'chown "$owner_uid:$owner_gid" "$RELAY_DIR"',
    'chmod 700 "$RELAY_DIR"',
    '',
    '# 7. Sign-in: a single-use code minted from the owner\'s own sign-in now, so its 90 seconds start here, and',
    '#    written where only the team account can read it. The team daemon redeems it as it starts and deletes it.',
    '#    A code that cannot be had is reported after step 8, once the daemon step 4 stopped runs again.',
    ...signInStep(mintEnv),
    '',
    '# 8. The systemd unit, root\'s, which runs the team daemon as the team account from boot.',
    'install -o 0 -g 0 -m 0644 "$STAGE/team.service" "$UNIT"',
    'systemctl daemon-reload || die "systemd would not read the team daemon\'s unit" 8',
    'tries=0',
    'until systemctl enable --now "$UNIT_NAME" >/dev/null 2>&1; do',
    '  tries=$((tries + 1))',
    '  [ "$tries" -lt 5 ] || die "systemd would not start the team daemon" 8',
    '  systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true',
    '  sleep 1',
    'done',
    'say "the team daemon runs as $TEAM ($UNIT_NAME)"',
    '[ -z "$no_sign_in" ] || die "$no_sign_in; the team daemon runs without a new sign-in" 7',
    '',
  ]
  return lines.join('\n')
}

export function buildLinuxRemoveScript(input: RemoveScriptInput): string {
  const user = checkUser(input.user, 'team account')
  const home = checkPath(input.home, 'team home')
  const ownerHome = checkPath(input.ownerHome, 'owner home')
  if (input.owner === undefined) throw new Error('the Linux removal needs the owner, whose relay folder setup made')
  const owner = checkUser(input.owner, 'owner account')
  const paths = teamPaths(home)
  const state = LINUX.statusDir.slice(0, LINUX.statusDir.lastIndexOf('/'))
  const mark = basename(LINUX.sharedMark)
  /** A folder setup made, removed only when nothing but its mark is left in it. */
  const removeMarked = (dir: string, markVar: string) => [
    `if [ -f "$${markVar}" ] && [ ! -L "$${dir}" ] && [ -z "$(ls -A "$${dir}" | grep -vx ${sh(mark)} || true)" ]; then`,
    `  rm -f "$${markVar}"`,
    `  rmdir "$${dir}" 2>/dev/null || true`,
    'fi',
  ]
  const startAgain = [
    '      tries=0',
    '      until systemctl enable --now "$UNIT_NAME" >/dev/null 2>&1; do',
    '        tries=$((tries + 1)); [ "$tries" -lt 5 ] || break',
    '        systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true; sleep 1',
    '      done',
    '      systemctl is-active --quiet "$UNIT_NAME" && again=yes',
  ]
  return [
    '#!/bin/sh',
    '# Harness Team account removal for Linux (cli/src/team/script.ts), run once as root: through pkexec, or with sudo in',
    '# a terminal. It leaves the owner\'s home folder private, as setup made it.',
    '#',
    '# The daemon and every process of the account stop first: userdel refuses a user that still runs something. When it',
    '# refuses all the same, the team daemon runs again and nothing else has changed.',
    'set -eu',
    'cd /',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `die() { printf 'harness: %s\\n' "$1" >&2; exit "\${2:-1}"; }`,
    `say() { printf 'harness: %s\\n' "$1"; }`,
    `TEAM=${sh(user)}`,
    `TEAM_GROUP=${sh(LINUX.group)}`,
    `TEAM_HOME=${sh(home)}`,
    `UNIT_NAME=${sh(LINUX.service.label)}`,
    `UNIT=${sh(LINUX.service.file)}`,
    `CONFIG=${sh(LINUX.configFile)}`,
    `STATUS_DIR=${sh(LINUX.statusDir)}`,
    `RELAY_DIR=${sh(LINUX.relayDir(owner))}`,
    `SHARED=${sh(LINUX.sharedDir)}`,
    `SHARED_MARK=${sh(LINUX.sharedMark)}`,
    `STATE=${sh(state)}`,
    `STATE_MARK=${sh(`${state}/${mark}`)}`,
    `SENTINEL=${sh(`${ownerHome}/${SENTINEL_NAME}`)}`,
    `COMPUTER_ID=${sh(paths.computerId)}`,
    '[ "$(id -u)" = 0 ] || die "run as root"',
    'exists=',
    'team_uid=',
    'if entry=$(getent passwd "$TEAM"); then',
    '  exists=1',
    '  existing=$(printf \'%s\\n\' "$entry" | cut -d: -f6)',
    '  [ "$existing" = "$TEAM_HOME" ] || die "the account $TEAM is not the Harness Team account (its home is $existing); nothing was removed" 4',
    '  team_uid=$(id -u "$TEAM")',
    'fi',
    // A home left by a team account deleted earlier is owned by a bare user id; anyone else's is not ours to delete.
    'if [ -e "$TEAM_HOME" ] && [ ! -L "$TEAM_HOME" ]; then',
    '  holder_uid=$(stat -c %u "$TEAM_HOME")',
    '  holder=$(id -un "$holder_uid" 2>/dev/null) || holder=',
    '  case $holder in',
    '    "$TEAM"|root) ;;',
    '    \'\') [ -n "$team_uid" ] || team_uid=$holder_uid ;;',
    '    *) die "$TEAM_HOME belongs to $holder; nothing was removed" 4 ;;',
    '  esac',
    'fi',
    // Read as the team account, never followed as root, and only in the form a computer id has.
    'computer=',
    'if [ -n "$exists" ]; then',
    '  computer=$(runuser -u "$TEAM" -- cat "$COMPUTER_ID" 2>/dev/null | head -n 1) || computer=',
    '  case $computer in \'\'|*[!A-Za-z0-9_-]*) computer= ;; esac',
    '  [ "${#computer}" -le 128 ] || computer=',
    'fi',
    '',
    '# 1. The team daemon stops and stays off, so it starts nothing while the account goes.',
    'systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true',
    '',
    '# 2. Everything the account still runs: teammates\' agents in its tmux.',
    'if [ -n "$team_uid" ] && [ "$team_uid" -ge 1000 ]; then pkill -KILL -u "$team_uid" >/dev/null 2>&1 || true; sleep 1; fi',
    '',
    '# 3. The account and its home. When userdel keeps the user, the daemon starts again, as setup starts it.',
    'if [ -n "$exists" ]; then',
    // userdel -r exits 12 when it removed the user but not all of its home: that is not a refusal.
    '  if ! why=$(userdel -r "$TEAM" 2>&1) && getent passwd "$TEAM" >/dev/null; then',
    '    why=$(printf \'%s\\n\' "$why" | tail -n 1)',
    '    again=no',
    '    if [ -f "$UNIT" ]; then',
    ...startAgain,
    '    fi',
    `    [ "$again" = yes ] || die "could not delete the account $TEAM: $why. Nothing was removed, but the team daemon did not start again: harness team setup starts it" ${REMOVE_REFUSED}`,
    `    die "could not delete the account $TEAM: $why. Nothing was removed: the Harness Team account and its daemon run as before" ${REMOVE_REFUSED}`,
    '  fi',
    '  say "deleted the account $TEAM"',
    'fi',
    // useradd made the group for the account alone; userdel removes it on most systems, and here on the others.
    'if getent group "$TEAM_GROUP" >/dev/null && [ -z "$(getent group "$TEAM_GROUP" | cut -d: -f4)" ]; then groupdel "$TEAM_GROUP" >/dev/null 2>&1 || true; fi',
    '',
    '# 4. What it left: its home when the account was deleted elsewhere, its unit, what setup made and the sentinel.',
    // An account deleted elsewhere cannot be asked for its computer id: read it from the home it left, only from a plain file
    // that id owns, never through a link.
    'if [ -z "$exists" ] && [ -n "$team_uid" ]; then',
    '  f="$TEAM_HOME/.harness/computer-id"',
    '  if [ ! -L "$TEAM_HOME" ] && [ ! -L "$TEAM_HOME/.harness" ] && [ ! -L "$f" ] && [ -f "$f" ] && [ "$(stat -c %u "$f")" = "$team_uid" ]; then',
    '    computer=$(head -n 1 "$f") || computer=',
    '    case $computer in \'\'|*[!A-Za-z0-9_-]*) computer= ;; esac',
    '    [ "${#computer}" -le 128 ] || computer=',
    '  fi',
    'fi',
    'rm -f "$UNIT"',
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    'systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true',
    'rm -rf "$TEAM_HOME" "$STATUS_DIR" "$RELAY_DIR"',
    'rm -f "$CONFIG" "$SENTINEL"',
    // The shared folders, only when setup made them and nothing else has been put in them since.
    ...removeMarked('SHARED', 'SHARED_MARK'),
    ...removeMarked('STATE', 'STATE_MARK'),
    '[ -z "$computer" ] || say "team computer $computer"',
    'say "removed the Harness Team account, its home folder and its daemon"',
    '',
  ].join('\n')
}
