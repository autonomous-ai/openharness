/**
 * `<data dir>/agent-browser.json`: every browser this daemon created with its settings and the profile its names come
 * from, any delete in progress, the setup step (spec § Lifecycle), and the agents told their browser is ready. It holds
 * proxy passwords, so it is the person's alone (0600).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { PodmanError } from './podman.js'
import type { BrowserSettings } from './settings.js'
import type { SetupStep } from './setup.js'

/**
 * An agent's entry. `profile`: the id its browser's container, network, volume and proxy secret are named by, which a
 * move with its pane keeps (decision 19). Absent, it is the agent's own id: every browser that never moved, and every
 * one made before this field, so their file is what an older CLI writes and reads.
 */
export type SavedBrowser = BrowserSettings & { profile?: string }

export interface BrowserStateData {
  browsers: Record<string, SavedBrowser>
  deleting: string[]
  setup: { step: SetupStep } | null
  /** Harness's own Podman machine's connection, once setup made one (spec § Podman); absent for the person's. */
  connection?: string | null
  /** The agents typed the ready line since their person's last Start (notices.ts); absent in a file from before it. */
  told?: Record<string, true>
}

export class StateFile {
  constructor(private readonly path: string) {}

  /** A broken file is never read as an empty one: that would delete every browser's login. */
  read(): BrowserStateData {
    if (!existsSync(this.path)) return { browsers: {}, deleting: [], setup: null }
    let data: Partial<BrowserStateData> | null
    try {
      data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<BrowserStateData> | null
    } catch (error) {
      throw new PodmanError('state_unreadable', `${this.path} cannot be read: ${(error as Error).message}`)
    }
    if (typeof data?.browsers !== 'object' || data.browsers === null || Array.isArray(data.browsers)
      || !Array.isArray(data.deleting) || typeof data.setup !== 'object') {
      throw new PodmanError('state_unreadable', `${this.path} is not a browser state file`)
    }
    return data as BrowserStateData
  }

  /** Written beside and renamed over, so a crash leaves the old file or the new one, never half of one. */
  update(change: (s: BrowserStateData) => void): void {
    const data = this.read()
    change(data)
    const next = `${this.path}.${process.pid}.tmp`
    writeFileSync(next, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(next, this.path)
  }
}
