/**
 * The pane inboxes Agent Messages hands messages through to an agent at its next tool call
 * (hook/messages.mjs). One folder per tmux pane, one file per waiting item; the folder exists only while
 * something waits in it, which is all the installed hook's shell test looks at before it starts Node.
 *
 * Who delivers an item is decided by one atomic rename, so it is never delivered twice:
 * - the hook claims a file by renaming it into `claimed/` and prints it as the model's context;
 * - the service reclaims a file into `typing/` before it lets the core type it into an idle agent, and puts it
 *   back when the agent turns out to be working.
 * A file the hook took leaves its name in `claimed/`, which is how the service hears it was delivered.
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What one inbox file holds: the text, and the engine conversation it is for. A hook in any other conversation
 *  (a Codex sub-agent runs its hooks from its parent's pane) leaves it. */
export interface InboxItem { session: string; text: string }

const PANE = /^%(\d{1,9})$/
const KEY = /^[0-9a-z._-]{1,120}$/

export class PaneInbox {
  constructor(readonly root: string) {}

  /** The folder of a tmux pane (`%12`), or null for anything that is not one. */
  paneDir(pane: string): string | null {
    const match = PANE.exec(pane)
    return match ? join(this.root, 'inbox', match[1]) : null
  }

  private dir(name: 'claimed' | 'typing'): string {
    const dir = join(this.root, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  private key(pane: string, key: string): string {
    if (!KEY.test(key)) throw new Error(`invalid inbox key ${key}`)
    return `${PANE.exec(pane)![1]}-${key}`
  }

  /** Put an item in a pane's inbox; the hook may take it from now on. */
  put(pane: string, key: string, item: InboxItem): void {
    const dir = this.paneDir(pane)
    if (!dir) throw new Error(`not a tmux pane: ${pane}`)
    if (!KEY.test(key)) throw new Error(`invalid inbox key ${key}`)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    const temporary = join(this.dir('typing'), `.${this.key(pane, key)}.${process.pid}.tmp`)
    writeFileSync(temporary, JSON.stringify(item), { mode: 0o600 })
    // The hook removes an emptied folder: made again if it went between the two.
    for (let tries = 0; ; tries++) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { renameSync(temporary, join(dir, `${key}.json`)); return } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || tries >= 3) { rmSync(temporary, { force: true }); throw error }
      }
    }
  }

  /** Take an item back from the hook before typing it: true when it was still waiting, false when the hook
   *  already took it (or it was never there). */
  reclaim(pane: string, key: string): boolean {
    const dir = this.paneDir(pane)
    if (!dir) return false
    try {
      renameSync(join(dir, `${key}.json`), join(this.dir('typing'), `${this.key(pane, key)}.json`))
    } catch { return false }
    this.tidy(dir)
    return true
  }

  /** Give a reclaimed item back to the hook: the agent was working, or the typing was refused. */
  restore(pane: string, key: string): void {
    const dir = this.paneDir(pane)
    if (!dir) return
    for (let tries = 0; ; tries++) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { renameSync(join(this.dir('typing'), `${this.key(pane, key)}.json`), join(dir, `${key}.json`)); return } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || tries >= 3) return
      }
    }
  }

  /** A reclaimed item that was typed: nothing more to give back. */
  typed(pane: string, key: string): void {
    if (this.paneDir(pane)) rmSync(join(this.dir('typing'), `${this.key(pane, key)}.json`), { force: true })
  }

  /** Whether the hook took an item, forgetting the record of it once read. */
  claimed(pane: string, key: string): boolean {
    if (!this.paneDir(pane)) return false
    try {
      rmSync(join(this.dir('claimed'), `${this.key(pane, key)}.json`))
      return true
    } catch { return false }
  }

  /** What the hook has taken, by `<pane number>-<key>`: read once for a whole pump. */
  claimedNames(): Set<string> {
    try { return new Set(readdirSync(join(this.root, 'claimed')).map((name) => name.replace(/\.json$/, ''))) } catch { return new Set() }
  }

  /** The keys waiting in one pane's inbox: read once per pane for a whole pump. */
  keys(pane: string): Set<string> {
    const dir = this.paneDir(pane)
    if (!dir) return new Set()
    try { return new Set(readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length))) } catch { return new Set() }
  }

  /** Whether an item still waits for the hook. */
  waiting(pane: string, key: string): boolean {
    const dir = this.paneDir(pane)
    if (!dir) return false
    try { return readdirSync(dir).includes(`${key}.json`) } catch { return false }
  }

  /** Withdraw an item from wherever it waits: the hook's inbox or a reclaim. */
  withdraw(pane: string, key: string): void {
    const dir = this.paneDir(pane)
    if (!dir) return
    rmSync(join(dir, `${key}.json`), { force: true })
    rmSync(join(this.dir('typing'), `${this.key(pane, key)}.json`), { force: true })
    this.tidy(dir)
  }

  /** Items a service that stopped mid-typing left reclaimed, as `[pane, key]`: given back as it starts. */
  reclaimed(): [string, string][] {
    let names: string[] = []
    try { names = readdirSync(this.dir('typing')) } catch { /* nothing reclaimed */ }
    return names.flatMap((name) => {
      const match = /^(\d+)-(.+)\.json$/.exec(name)
      return match ? [[`%${match[1]}`, match[2]] as [string, string]] : []
    })
  }

  /** Everything waiting in every pane's inbox, with when it was put there: what a sweep looks at. */
  entries(): Array<{ pane: string; key: string; at: number }> {
    const out: Array<{ pane: string; key: string; at: number }> = []
    let panes: string[] = []
    try { panes = readdirSync(join(this.root, 'inbox')) } catch { return out }
    for (const number of panes) {
      if (!/^\d{1,9}$/.test(number)) continue
      let names: string[] = []
      try { names = readdirSync(join(this.root, 'inbox', number)) } catch { continue }
      for (const name of names) {
        const match = /^(.+)\.json$/.exec(name)
        if (!match || !KEY.test(match[1])) continue
        try { out.push({ pane: `%${number}`, key: match[1], at: statSync(join(this.root, 'inbox', number, name)).mtimeMs }) } catch { /* taken meanwhile */ }
      }
    }
    return out
  }

  private tidy(dir: string): void {
    try { rmdirSync(dir) } catch { /* not empty, or already gone */ }
  }
}
