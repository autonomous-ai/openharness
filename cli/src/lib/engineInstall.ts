/**
 * Official install recipes for every engine Harness can launch.
 *
 * The command is shown in Desktop before Create is pressed, then runs inside the tmux pane on the
 * target machine. Keep every line tied to first-party documentation: a plausible package name that
 * installs successfully but does not provide the expected executable is worse than no recipe.
 */

import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { isTerminalEngine, type AgentEngine, type ProcessEngine } from '../engines/types.js'

/** How to find the executable after the installer returns. */
export interface EngineInstallExecutable {
  /** Executable names published by the vendor, in preference order. */
  readonly names: readonly string[]
  /** Paths relative to the target user's home, used before a freshly edited PATH can be reloaded. */
  readonly homeRelativePaths?: readonly string[]
  /** Fixed system paths used by a vendor installer in a special mode, such as a root install. */
  readonly absolutePaths?: readonly string[]
  /** Resolve each name below `npm prefix -g` when the install method is npm. */
  readonly npmGlobal?: boolean
}

export interface EngineInstallRecipe {
  /** The first-party line a person would paste into a POSIX shell. */
  readonly command: string
  /**
   * A second first-party line, run only when [command] leaves no executable behind. For a vendor
   * whose native installer depends on one download host that some networks cannot reach.
   */
  readonly fallback?: string
  /** First-party documentation used to verify the command. */
  readonly source: string
  /** Ordered, source-owned ways to locate the binary after installation. */
  readonly executable: EngineInstallExecutable
}

/**
 * Exhaustive on purpose. Adding an engine without deciding how it is installed must fail typecheck
 * rather than silently creating another unsupported row in Desktop.
 */
export const ENGINE_INSTALL: Readonly<Record<ProcessEngine, EngineInstallRecipe>> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    source: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    executable: { names: ['claude'], npmGlobal: true, homeRelativePaths: ['.local/bin/claude'] },
  },
  codex: {
    command: 'npm install -g @openai/codex',
    source: 'https://github.com/openai/codex',
    executable: { names: ['codex'], npmGlobal: true, homeRelativePaths: ['.local/bin/codex'] },
  },
  cursor: {
    command: 'curl https://cursor.com/install -fsS | bash',
    source: 'https://docs.cursor.com/en/cli/installation',
    // `cursor-agent` is deliberately the canonical name. Grok also installs `agent`; using that
    // shared alias here could turn a requested Cursor pane into a Grok pane.
    executable: { names: ['cursor-agent'], homeRelativePaths: ['.local/bin/cursor-agent'] },
  },
  opencode: {
    // The native installer downloads one matching binary. npm installs both the
    // baseline and AVX2 Linux packages, doubling the installed footprint.
    command: 'curl -fsSL https://opencode.ai/install | bash',
    // OpenCode is the default agent, and its installer downloads the binary from GitHub Releases.
    // From a Vietnamese network on 2026-10-08, release-assets.githubusercontent.com timed out while
    // the npm registry answered, so a fresh user there could not start a first harness. The npm
    // package carries the same binaries as optional dependencies and needs no GitHub download.
    fallback: 'npm install -g opencode-ai',
    source: 'https://opencode.ai/docs',
    executable: { names: ['opencode'], npmGlobal: true, homeRelativePaths: ['.opencode/bin/opencode'] },
  },
  pi: {
    // pi.dev publishes the scoped package with --ignore-scripts. The unscoped package is unrelated
    // and does not provide the `pi` executable.
    command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    source: 'https://pi.dev/',
    executable: { names: ['pi'], npmGlobal: true },
  },
  omp: {
    command: 'curl -fsSL https://omp.sh/install | sh',
    source: 'https://github.com/can1357/oh-my-pi',
    executable: { names: ['omp'], homeRelativePaths: ['.local/bin/omp'] },
  },
  hermes: {
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    source: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/quickstart.md',
    executable: {
      names: ['hermes'],
      homeRelativePaths: ['.local/bin/hermes'],
      absolutePaths: ['/usr/local/bin/hermes'],
    },
  },
  commandcode: {
    command: 'npm i -g command-code',
    source: 'https://commandcode.ai/docs',
    executable: { names: ['cmd', 'command-code'], npmGlobal: true },
  },
  devin: {
    command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    source: 'https://cli.devin.ai/reference/commands',
    executable: { names: ['devin'], homeRelativePaths: ['.local/bin/devin'] },
  },
  muse: {
    command: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    source: 'https://ai.meta.com/llama/',
    executable: { names: ['muse'], homeRelativePaths: ['.local/bin/muse'] },
  },
  amp: {
    command: 'curl -fsSL https://ampcode.com/install.sh | bash',
    source: 'https://ampcode.com/docs/cli',
    executable: { names: ['amp'], homeRelativePaths: ['.local/bin/amp', '.amp/bin/amp'] },
  },
  kilo: {
    command: 'npm install -g @kilocode/cli',
    source: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    executable: {
      names: ['kilo', 'kilocode'],
      npmGlobal: true,
      homeRelativePaths: ['.kilo/bin/kilo', '.local/bin/kilo'],
    },
  },
  grok: {
    command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    source: 'https://docs.x.ai/build/overview',
    executable: { names: ['grok'], homeRelativePaths: ['.grok/bin/grok', '.local/bin/grok'] },
  },
  agy: {
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    source: 'https://antigravity.google/docs/cli/install/',
    executable: { names: ['agy'], homeRelativePaths: ['.local/bin/agy'] },
  },
  copilot: {
    command: 'npm install -g @github/copilot',
    source: 'https://docs.github.com/en/copilot/get-started/cli-quickstart',
    executable: { names: ['copilot'], npmGlobal: true, homeRelativePaths: ['.local/bin/copilot'] },
  },
}

/**
 * How Windows installs an engine (engines/kit/windowsInstall.ts). An npm package, into the person's own `.local`, or the
 * vendor's own PowerShell installer, whose [programs] are where it leaves the engine, without an extension: under
 * %LOCALAPPDATA%, or the profile when they start `~\`. [args] are the vendor's flags; [armArgs], npm's on Windows on Arm.
 */
export type WindowsInstall =
  | { readonly npm: string; readonly args?: readonly string[]; readonly armArgs?: readonly string[] }
  | { readonly powershell: string; readonly args?: readonly string[]; readonly programs: readonly string[] }

/**
 * Exhaustive as ENGINE_INSTALL is, and beside it rather than in it: a recipe's fingerprint is in every Mac's and Linux
 * computer's install journal (kit/nativeInstall.ts). Each is the vendor's own Windows install, read 2026-11-04.
 */
export const ENGINE_WINDOWS_INSTALL: Readonly<Record<ProcessEngine, WindowsInstall>> = {
  claude: { npm: '@anthropic-ai/claude-code' },
  codex: { npm: '@openai/codex' },
  cursor: { powershell: 'https://cursor.com/install?win32=true', programs: ['cursor-agent\\cursor-agent'] },
  // Its Windows Arm build stops before its screen opens (lib/windows/launch.ts): the x64 build runs under emulation.
  opencode: { npm: 'opencode-ai', armArgs: ['--cpu=x64'] },
  pi: { npm: '@earendil-works/pi-coding-agent', args: ['--ignore-scripts'] },
  omp: { powershell: 'https://omp.sh/install.ps1', programs: ['omp\\omp'] },
  hermes: { powershell: 'https://hermes-agent.nousresearch.com/install.ps1', args: ['-NonInteractive'], programs: ['hermes\\bin\\hermes'] },
  commandcode: { npm: 'command-code' },
  devin: { powershell: 'https://cli.devin.ai/install.ps1', programs: ['devin\\cli\\bin\\devin'] },
  muse: { powershell: 'https://dev.meta.ai/install.ps1', programs: ['Programs\\muse\\muse'] },
  amp: { powershell: 'https://ampcode.com/install.ps1', programs: ['~\\.amp\\bin\\amp'] },
  kilo: { npm: '@kilocode/cli' },
  grok: { powershell: 'https://x.ai/cli/install.ps1', programs: ['~\\.grok\\bin\\grok'] },
  agy: { powershell: 'https://antigravity.google/cli/install.ps1', programs: ['agy\\bin\\agy'] },
  copilot: { npm: '@github/copilot' },
}

const WINDOWS_OF = new Map((Object.keys(ENGINE_INSTALL) as ProcessEngine[]).map((engine) => [ENGINE_INSTALL[engine], ENGINE_WINDOWS_INSTALL[engine]]))

/** What a person is shown before Harness installs [recipe] on [platform]: the line that really runs there. */
export function engineInstallLine(recipe: EngineInstallRecipe, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const windows = platform === 'win32' ? WINDOWS_OF.get(recipe) : undefined
  if (!windows) return recipe.command
  if ('powershell' in windows) return [`irm ${windows.powershell} | iex`, ...windows.args ?? []].join(' ')
  return ['npm install -g', ...windows.args ?? [], ...(arch === 'arm64' ? windows.armArgs ?? [] : []), windows.npm].join(' ')
}

/** Where Windows leaves [recipe]'s engine: npm's commands sit in the prefix itself, not in its bin folder. */
function windowsInstallPaths(recipe: EngineInstallRecipe, home: string, localAppData: string | undefined): string[] {
  const windows = WINDOWS_OF.get(recipe)
  if (!windows) return []
  if ('powershell' in windows) {
    const local = localAppData ?? win32.join(home, 'AppData', 'Local')
    return windows.programs.map((program) => program.startsWith('~\\') ? win32.join(home, program.slice(2)) : win32.join(local, program))
  }
  // Never `cmd`, which names the command processor there (kit/launchExecutable.ts `launchSearchNames`).
  return recipe.executable.names.filter((name) => name !== 'cmd').map((name) => win32.join(home, '.local', name))
}

/** A terminal has nothing to install — the login shell is already there — hence `undefined`. */
export function engineInstallRecipe(engine: AgentEngine): EngineInstallRecipe | undefined {
  return isTerminalEngine(engine) ? undefined : ENGINE_INSTALL[engine]
}

/** Stable across managed Node upgrades and writable by this OS user, unlike shared Homebrew. */
export function npmEnginePrefix(): string {
  return join(homedir(), '.local')
}

/** The same candidates are used by launch, availability checks, and process discovery. */
export function engineInstallPaths(recipe: EngineInstallRecipe, home = homedir(), platform: NodeJS.Platform = process.platform,
  localAppData: string | undefined = process.env.LOCALAPPDATA): string[] {
  return [...new Set([
    ...(platform === 'win32' ? windowsInstallPaths(recipe, home, localAppData) : []),
    ...(recipe.executable.homeRelativePaths ?? []).map((path) => join(home, path)),
    ...(recipe.executable.absolutePaths ?? []),
    ...(recipe.executable.npmGlobal
      ? recipe.executable.names.map((name) => join(home, '.local', 'bin', name))
      : []),
  ])]
}

export const INSTALLABLE_ENGINES: ReadonlySet<AgentEngine> = new Set(
  Object.keys(ENGINE_INSTALL) as AgentEngine[],
)
