/**
 * One container per agent, with its profile volume, its own network and its proxy secret, all named
 * `harness-browser-<agentId>` (the secret `harness-proxy-<agentId>`) and labelled with this daemon, so a dev or test
 * daemon on the same Podman never touches another's (spec § The container).
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

// Podman lists `Labels: null` for a container with none.
interface Listed { Image: string; State: string; ExitCode: number; Labels: Record<string, string> | null }

const nameOf = (agentId: string) => `harness-browser-${agentId}`
const secretOf = (agentId: string) => `harness-proxy-${agentId}`

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
   * The label holds the settings as applied, the resolved zone included, so an Auto zone that moved with the proxy's
   * exit address creates the container again too.
   */
  async start(agentId: string, image: string, settings: BrowserSettings, timeZone: string): Promise<{ limitsDropped: string[] }> {
    const name = nameOf(agentId)
    const labels = ['--label', `harness.agent=${agentId}`, '--label', `harness.daemon=${this.daemonId}`]
    await this.podman.run(['network', 'create', '--ignore', ...labels, name])
    await this.podman.run(['volume', 'create', '--ignore', ...labels, name])
    const hash = settingsHash({ ...settings, timeZone })
    const existing = await this.find(agentId)
    // A locally built image is listed under Podman's `localhost/` prefix.
    if (existing && [image, `localhost/${image}`].includes(existing.Image) && existing.Labels?.['harness.settings'] === hash) {
      if (existing.State !== 'running') await this.podman.run(['start', name])
      return { limitsDropped: [] }
    }
    if (existing) await this.removeContainer(name)
    if (settings.proxy) {
      // The password goes on stdin only: never an argument or an environment variable.
      await this.podman.run(['secret', 'create', '--replace', secretOf(agentId), '-'], { stdin: JSON.stringify(settings.proxy) })
    } else {
      // A proxy taken out of the settings must not leave its password in Podman.
      await unlessGone(this.podman.run(['secret', 'rm', secretOf(agentId)]))
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
      ...(settings.proxy ? ['--secret', `${secretOf(agentId)},target=harness-proxy`, '-e', 'PROXY=1'] : []),
      ...(settings.device ? ['-e', `DEVICE=${JSON.stringify(settings.device)}`] : []),
      image,
    ]
    const kept: Array<(typeof LIMITS)[number]> = [...LIMITS]
    const limitsDropped: string[] = []
    // Each refusal drops one limit, so this ends.
    for (;;) {
      try {
        await this.podman.run(['create', ...kept.flatMap(limit => limit.args), '--shm-size', '1g', ...rest])
        // crun can take a limit at create and refuse it at start.
        await this.podman.run(['start', name])
        return { limitsDropped }
      } catch (error) {
        // The agent id and the image are names, not Podman's words: an agent called "cpu-bot" is no cpu refusal.
        const said = (error as Error).message.split(agentId).join('<agent>').split(image).join('<image>')
        const limit = kept.find(candidate => candidate.refused.test(said))
        if (!limit) throw error
        await this.removeContainer(name)
        kept.splice(kept.indexOf(limit), 1)
        limitsDropped.push(limit.label)
        this.log(`agent browser ${agentId}: Podman refused the ${limit.label} limit; the browser runs without it`)
      }
    }
  }

  /** The container goes with its network: Podman will not remove a network any container, even a stopped one, uses. */
  async stop(agentId: string): Promise<void> {
    await this.removeContainer(nameOf(agentId))
    await unlessGone(this.podman.run(['network', 'rm', nameOf(agentId)]))
  }

  async remove(agentId: string): Promise<void> {
    await this.stop(agentId)
    await unlessGone(this.podman.run(['volume', 'rm', nameOf(agentId)]))
    await unlessGone(this.podman.run(['secret', 'rm', secretOf(agentId)]))
  }

  /** Volumes are never swept: an unlisted one may still hold a person's login. */
  async sweep(listedAgentIds: Set<string>): Promise<number> {
    const strays = (await this.mine(['-a'])).map(container => container.Labels!['harness.agent']!).filter(agentId => !listedAgentIds.has(agentId))
    for (const agentId of strays) await this.stop(agentId)
    return strays.length
  }

  async running(): Promise<string[]> {
    return (await this.mine([])).filter(container => container.State === 'running').map(container => container.Labels!['harness.agent']!)
  }

  async ready(agentId: string): Promise<boolean> {
    return await this.podman.run(['exec', nameOf(agentId), 'test', '-f', READY_MARKER]).then(() => true, () => false)
  }

  /** null while it runs, and when there is none. */
  async exitCode(agentId: string): Promise<number | null> {
    const container = await this.find(agentId)
    return !container || container.State === 'running' ? null : container.ExitCode
  }

  execArgs(agentId: string, cmd: string[]): string[] {
    return ['exec', '-i', nameOf(agentId), ...cmd]
  }

  private async removeContainer(name: string): Promise<void> {
    await unlessGone(this.podman.run(['rm', '--force', '--time', STOP_SECONDS, name]))
  }

  private async find(agentId: string): Promise<Listed | undefined> {
    return (await this.list(['-a', '--filter', `label=harness.agent=${agentId}`])).find(container => container.Labels?.['harness.agent'] === agentId)
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
