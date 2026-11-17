import { ENV_FIELD_NAMES } from '../config/env.js'
import { isAgentSessionVariable } from './agentSessionEnv.js'

/**
 * The environment a start gives the daemon: on macOS and Linux, only the shell's variables an explicit allowlist names
 * (docs/plans/2026-11-17-daemon-minimal-env-design.md).
 *
 * The daemon gives its environment to every process it starts: the core, the services, the tmux server (which copies
 * its own into every new pane), and every agent, terminal tile and hook. A start that handed on the whole environment
 * of whatever ran it handed on every other program's session secrets with it: a CI or IDE shell's GH_TOKEN, a VS Code
 * terminal's NODE_OPTIONS bootloader, a new Claude Code or Orca variable the agent-session denylist does not name yet
 * (agentSessionEnv.ts). The daemon needs none of them. Under `harness service install` it already runs from launchd's
 * or systemd's own environment, and every pane runs its engine through the person's login shell (engineLaunch.ts
 * `interactiveEngineShell`), so their rc files reach their agents anyway. Anything else the daemon or its agents should
 * have goes in the file HARNESS_ENV_FILE names.
 *
 * On Windows a start keeps the whole environment, as a copy (the design's decision 5): a pane there has no login shell
 * and starts from the core's environment (ptyHost/launch.ts), so it is the only way a person's own variables (JAVA_HOME,
 * GOPATH, …) reach an agent. Narrowing it waits for a start that reads the user's durable variables from the registry.
 *
 * `__harnessd` and `__run` are not narrowed: their caller chose the environment already (the launchd plist, the
 * systemd unit, a narrowed `harness start`, a master's re-exec, the end-to-end suite and its NODE_OPTIONS preloads).
 */

/** The names a start keeps as spelled, grouped as the design's table groups them. */
export const START_ENV_NAMES: readonly string[] = [
  // System. What launchd and systemd give a user agent; the locale (childLocale.ts); git over SSH in panes; a daemon
  // started over SSH asks for no password dialog nobody sees (agentBrowser/setup.ts); tmux's socket folder; the
  // person's zsh startup folder; WSL detection.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG', 'LANGUAGE', 'SSH_AUTH_SOCK', 'SSH_CONNECTION',
  '__CF_USER_TEXT_ENCODING', 'TMUX_TMPDIR', 'ZDOTDIR', 'WSL_DISTRO_NAME',
  // Linux desktop. The clipboard (osClipboard.ts), X11's beside DISPLAY, and the guest helpers.
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  // Network. A machine behind a proxy or a private CA reaches the backend, and its engines reach theirs.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Harness. Its own settings; the rest of them are config/env.ts' fields, at the end.
  'DOTENV_CONFIG_PATH', 'NODE_ENV',
  // Harness OS. Its unit sets these for the daemon's own children.
  'npm_config_prefix', 'BROWSER',
  // Engine settings. Where each engine and runtime keeps its state, which the daemon reads to find sessions (the
  // design's decisions 3 and 9). Settings, not secrets.
  'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'OPENCLAW_HOME', 'CODEX_PATH',
  'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'KILO_DB',
  'GRID_HOME', 'GRID_CONTROL_PLANE_URL', 'LLAMA_SERVER', 'HC_SOCKET',
  // Provider credentials, for now: Claude Code on Vertex reads its region here (the prefixes hold the rest).
  'CLOUD_ML_REGION',
  // Every variable config/env.ts reads: Harness's settings, and the engine homes and paths.
  ...ENV_FIELD_NAMES,
]

/** The prefixes a start keeps, each with its underscore, as spelled. */
export const START_ENV_PREFIXES: readonly string[] = [
  // System: the locale's categories.
  'LC_',
  // Linux desktop: the config and runtime folders.
  'XDG_',
  // Harness's own settings. HARNESSD_* is still held by each process as harnessdEnv.ts says.
  'HARNESS_', 'HARNESSD_', 'ADAPTER_',
  // Provider credentials, kept for now so that nobody who exports an API key in the shell they start from loses
  // their agents (the design's decision 2): what the engines Harness launches read to reach their provider (Claude
  // Code on Bedrock or Vertex, Codex, Gemini, Grok). One provider at a time, never a pattern for whatever looks like a
  // secret. They move to HARNESS_ENV_FILE next.
  'ANTHROPIC_', 'OPENAI_', 'AWS_', 'GOOGLE_', 'GEMINI_', 'AZURE_', 'OPENROUTER_', 'XAI_', 'CLAUDE_CODE_USE_',
]

/**
 * Names a start leaves out though Harness or a shell knows them, each with why. No group above names them, which is
 * what drops them; this list is the record that someone decided. An agent's session variables are not listed again:
 * `isAgentSessionVariable` drops them, under an allowed prefix too.
 */
export const DROPPED_ON_PURPOSE: Readonly<Record<string, string>> = {
  TERM: 'tmux sets a pane its own, and a daemon under launchd or systemd has none',
  COLORTERM: 'the terminal the start was typed in, as TERM: tmux sets a pane its own',
  NODE_OPTIONS: 'an IDE terminal\'s debugger bootloader would run in every daemon process',
  TMUX: 'the pane the start was typed in, never the daemon\'s',
  TMUX_PANE: 'the pane the start was typed in, as TMUX',
  HC_SESSION: 'the calling shell\'s Herdr session, not the daemon\'s; put it in HARNESS_ENV_FILE to keep it',
  TYPESAFE_CREDENTIALS: 'a credential; put it in HARNESS_ENV_FILE to keep it',
  GIT_SSH_COMMAND: 'a command line every git in every pane would run; put it in HARNESS_ENV_FILE to keep it',
}

const names: ReadonlySet<string> = new Set(START_ENV_NAMES)

/** Whether a start keeps [name]: an agent's session never, whatever an allowed prefix says. */
function isStartVariable(name: string): boolean {
  if (isAgentSessionVariable(name)) return false
  return names.has(name) || START_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** What a start on [platform] gives the daemon of [env]: a new object, by name only, values as they are. */
export function startEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === 'win32') return { ...env }
  return Object.fromEntries(Object.entries(env).filter(([name]) => isStartVariable(name)))
}

/** The daemon log's line on a start: how many variables it kept and left out, never which (code standard 7). */
export function startEnvLine(given: NodeJS.ProcessEnv, kept: NodeJS.ProcessEnv): string {
  const count = Object.keys(kept).length
  return `[env] started with ${count} variables; ${Object.keys(given).length - count} left out (docs/cli.md#the-daemons-environment)`
}
