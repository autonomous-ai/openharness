/**
 * One container per agent, with its profile volume, its own network and its proxy secret, all named
 * `harness-browser-<profile>` (the secret `harness-proxy-<profile>`), and labelled with its agent and this daemon, so a
 * dev or test daemon on the same Podman never touches another's (spec § The container). The profile is the agent's id
 * until its browser moves with its pane to another agent (decision 19): the names stay, the label is the new agent's.
 */
import { PodmanError, type Podman } from './podman.js'
import { settingsHash, type BrowserSettings } from './settings.js'

const GiB = 1024 ** 3
const PROFILE = '/var/lib/harness-browser-profile'
const READY_MARKER = '/tmp/harness-ready'
// Inside the 30 s every podman call gets.
const STOP_SECONDS = '10'

/**
 * Podman refuses a limit on rootless cgroup v1. The patterns are
 * the prior art's (ai-assitant-sanbox gateway-source/src/agents/sandbox/docker.ts:736-800, LIMIT_FALLBACKS), plus
 * crun's "requested cgroup controller `<name>` is not available", which names the controller in backticks. macOS
 * refused none in the spike, so no refusal text was measured. They come first in the argv so a spec's fake can
 * refuse one of them by prefix.
 */
const LIMITS = [
  { label: 'memory', args: ['--memory', '2g'], refused: /memory (controller|limit|cgroup)|memory\.max|kernel memory|controller `memory`/i },
  { label: 'cpus', args: ['--cpus', '2'], refused: /\bcpus?\b|nanocpus|cpu (controller|quota|cfs)|cfs_quota|cpu\.max/i },
  { label: 'pids-limit', args: ['--pids-limit', '512'], refused: /pids/i },
] as const

// Podman's own error texts for a thing that is not there (libpod define.ErrNoSuch*, ErrNoSuchNetwork).
const GONE = /no such (container|volume|secret)|network not found/i

// Another container holds the name a new one is made under (containers/storage's ErrDuplicateName, as Podman words
// it: `the container name "…" is already in use by …`).
const IN_USE = /already in use/i

// Podman lists `Labels: null` for a container with none.
interface Listed { Names: string[]; Image: string; State: string; ExitCode: number; Labels: Record<string, string> | null }

const NAME = 'harness-browser-'
const nameOf = (profile: string) => `${NAME}${profile}`
const secretOf = (profile: string) => `harness-proxy-${profile}`

async function unlessGone(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch (error) {
    if (!GONE.test((error as Error).message)) throw error
  }
}

/** How many browsers may run at once: each is capped at 2 GiB, and Podman keeps 1 GiB for itself. */
export function browserLimit(podmanMemoryBytes: number): number {
  return Math.max(1, Math.min(8, Math.floor((podmanMemoryBytes - GiB) / (2 * GiB))))
}

export class Containers {
  constructor(private readonly podman: Podman, private readonly daemonId: string, private readonly log: (line: string) => void) {}

  /**
   * `secretId` is the proxy's random id, which changes with its password ('' without a proxy). A start that fails removes what it made, so
   * nothing it left runs, holds a network or keeps the password in Podman.
   */
  async start(agentId: string, profile: string, image: string, settings: BrowserSettings, timeZone: string, secretId: string): Promise<{ limitsDropped: string[] }> {
    const labels = ['--label', `harness.agent=${agentId}`, '--label', `harness.daemon=${this.daemonId}`]
    await this.podman.run(['network', 'create', '--ignore', ...labels, nameOf(profile)])
    try {
      return await this.create(agentId, profile, image, settings, timeZone, secretId, labels)
    } catch (error) {
      await this.stop(profile).catch((cleanup: unknown) => {
        this.log(`agent browser ${agentId}: a failed start was not cleaned up: ${(cleanup as Error).message}`)
      })
      throw error
    }
  }

  /** The container goes with its network: Podman will not remove a network any container, even a stopped one, uses. */
  async stop(profile: string): Promise<void> {
    await this.removeContainer(nameOf(profile))
    await unlessGone(this.podman.run(['network', 'rm', nameOf(profile)]))
    // Every start makes the secret again, so the password is in Podman only while its container is.
    await unlessGone(this.podman.run(['secret', 'rm', secretOf(profile)]))
  }

  async remove(profile: string): Promise<void> {
    await this.stop(profile)
    await unlessGone(this.podman.run(['volume', 'rm', nameOf(profile)]))
  }

  /**
   * The label holds the settings as applied, the resolved zone included, so an Auto zone that moved with the proxy's
   * exit address creates the container again too. The proxy's random id stands in for its password: a hash of the
   * password on argv and a label could be tried against guesses (review, 2026-11-10).
   */
  private async create(agentId: string, profile: string, image: string, settings: BrowserSettings, timeZone: string, secretId: string, labels: string[]): Promise<{ limitsDropped: string[] }> {
    const name = nameOf(profile)
    await this.podman.run(['volume', 'create', '--ignore', ...labels, name])
    const hash = settingsHash({ ...settings, timeZone, proxy: settings.proxy && { ...settings.proxy, password: secretId } })
    // Only a container of this name is this browser: the agent's own under another name, which a move's failed stop
    // left, is not.
    const existing = await this.find(agentId, name)
    // A locally built image is listed under Podman's `localhost/` prefix.
    if (existing && [image, `localhost/${image}`].includes(existing.Image) && existing.Labels?.['harness.settings'] === hash) {
      if (existing.State !== 'running') await this.podman.run(['start', name])
      return { limitsDropped: [] }
    }
    if (existing) await this.removeContainer(name)
    if (settings.proxy) {
      // Removed, then made: `secret create --replace` came in Podman 4.7, and 4.6 is supported.
      await unlessGone(this.podman.run(['secret', 'rm', secretOf(profile)]))
      // The password goes on stdin only: never an argument or an environment variable.
      await this.podman.run(['secret', 'create', secretOf(profile), '-'], { stdin: JSON.stringify(settings.proxy) })
    } else {
      // A proxy taken out of the settings must not leave its password in Podman.
      await unlessGone(this.podman.run(['secret', 'rm', secretOf(profile)]))
    }
    const rest = [
      '--name', name, ...labels, '--label', `harness.settings=${hash}`,
      '--network', name,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      // HOME's tmpfs is root's alone without the mode, and Chromium crashes at start (measured in the spike).
      '--tmpfs', '/tmp:rw,size=256m', '--tmpfs', '/home/browser:rw,size=256m,mode=1777',
      '--tmpfs', '/var/tmp:rw,size=16m', '--tmpfs', '/run:rw,size=16m',
      '-v', `${name}:${PROFILE}`,
      '-e', `TZ=${timeZone}`, '-e', `ACCEPT_LANG=${settings.languages}`, '-e', `SCREEN=${settings.screen}`,
      ...(settings.proxy ? ['--secret', `${secretOf(profile)},target=harness-proxy`, '-e', 'PROXY=1'] : []),
      ...(settings.device ? ['-e', `DEVICE=${JSON.stringify(settings.device)}`] : []),
      image,
    ]
    const kept: Array<(typeof LIMITS)[number]> = [...LIMITS]
    const limitsDropped: string[] = []
    let inUseRemoved = false
    // Each refusal drops one limit, and a name in use is removed once, so this ends.
    for (;;) {
      try {
        await this.podman.run(['create', ...kept.flatMap(limit => limit.args), '--shm-size', '1g', ...rest])
        // crun can take a limit at create and refuse it at start.
        await this.podman.run(['start', name])
        return { limitsDropped }
      } catch (error) {
        // The agent id, the profile and the image are names, not Podman's words: an agent called "cpu-bot" is no cpu
        // refusal.
        const said = (error as Error).message.split(agentId).join('<agent>').split(profile).join('<profile>').split(image).join('<image>')
        // The previous agent's container, which its stop at a move left under this name and that agent's label.
        if (!inUseRemoved && IN_USE.test(said)) {
          inUseRemoved = true
          await this.removeContainer(name)
          continue
        }
        const limit = kept.find(candidate => candidate.refused.test(said))
        if (!limit) throw error
        await this.removeContainer(name)
        kept.splice(kept.indexOf(limit), 1)
        limitsDropped.push(limit.label)
        this.log(`agent browser ${agentId}: Podman refused the ${limit.label} limit; the browser runs without it`)
      }
    }
  }

  /**
   * Volumes are never swept: an unlisted one may still hold a person's login. A stray is stopped by the name Podman
   * lists for it, never one made from its label: after a move, `harness-browser-<its agent>` can be another agent's
   * running browser.
   */
  async sweep(listedAgentIds: Set<string>): Promise<number> {
    const strays = (await this.mine(['-a'])).filter(container => !listedAgentIds.has(container.Labels!['harness.agent']!))
    for (const stray of strays) await this.stop(stray.Names[0]!.slice(NAME.length))
    return strays.length
  }

  async running(): Promise<string[]> {
    return (await this.mine([])).filter(container => container.State === 'running').map(container => container.Labels!['harness.agent']!)
  }

  async ready(profile: string): Promise<boolean> {
    return await this.podman.run(['exec', nameOf(profile), 'test', '-f', READY_MARKER]).then(() => true, () => false)
  }

  /** null while it runs, and when there is none. */
  async exitCode(agentId: string): Promise<number | null> {
    const container = await this.find(agentId)
    return !container || container.State === 'running' ? null : container.ExitCode
  }

  execArgs(profile: string, cmd: string[]): string[] {
    return ['exec', '-i', nameOf(profile), ...cmd]
  }

  private async removeContainer(name: string): Promise<void> {
    await unlessGone(this.podman.run(['rm', '--force', '--time', STOP_SECONDS, name]))
  }

  /** The agent's container, by its label; with [name], only one of that name. */
  private async find(agentId: string, name?: string): Promise<Listed | undefined> {
    return (await this.list(['-a', '--filter', `label=harness.agent=${agentId}`]))
      .find(container => container.Labels?.['harness.agent'] === agentId && (name === undefined || container.Names[0] === name))
  }

  /** The label is checked here as well as filtered by Podman: another daemon's container is never ours to touch. */
  private async mine(flags: string[]): Promise<Listed[]> {
    return (await this.list(flags)).filter(container => typeof container.Labels?.['harness.agent'] === 'string')
  }

  private async list(flags: string[]): Promise<Listed[]> {
    const { stdout } = await this.podman.run(['ps', ...flags, '--filter', `label=harness.daemon=${this.daemonId}`, '--format', 'json'])
    let listed: Listed[] | null
    try {
      listed = JSON.parse(stdout) as Listed[] | null
    } catch {
      throw new PodmanError('podman_failed', 'podman ps did not answer in JSON')
    }
    return (listed ?? []).filter(container => container.Labels?.['harness.daemon'] === this.daemonId)
  }
}
