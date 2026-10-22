/**
 * The pane inboxes Agent Messages hands messages through to an agent at its next tool call
 * (hook/messages.mjs). One folder per pane, one file per waiting item; the folder exists only while
 * something waits in it, which is all the installed hook's shell test looks at before it starts Node.
 *
 * A pane is named by its route key (`terminalRouteKey`), so `%3` on tmux and `%3` on a pty host are two
 * inboxes. A tmux pane's folder is its number, which the installed hook finds by `$TMUX_PANE`; a pty host
 * pane's is `ptyhost.<instance>.<number>`, which no hook reads yet (it knows only `$TMUX_PANE`): what waits
 * there is typed into the agent once it is idle. A bare `%N`, as state written before other backends names a
 * pane, is the tmux pane it was (`inboxPaneKey`).
 *
 * Who delivers an item is decided by one atomic rename, so it is never delivered twice:
 * - the hook claims a file by renaming it into `claimed/` and prints it as the model's context;
 * - the service reclaims a file into `typing/` before it lets the core type it into an idle agent, and puts it
 *   back when the agent turns out to be working.
 * A file the hook took leaves its name in `claimed/`, which is how the service hears it was delivered.
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PTY_HOST_INSTANCE_SOURCE } from '../lib/ptyHost/instance.js'

/** What one inbox file holds: the text, and the engine conversation it is for. A hook in any other conversation
 *  (a Codex sub-agent runs its hooks from its parent's pane) leaves it. `notice` is the line the pane shows the
 *  person when the hook takes it, never given to the model. */
export interface InboxItem { session: string; text: string; notice?: string }

const LEGACY_PANE = /^%(\d{1,9})$/
const TMUX_PANE = /^tmux\u0000%(\d{1,9})$/
const PTY_PANE = new RegExp(`^ptyhost\\u0000(${PTY_HOST_INSTANCE_SOURCE})\\u0000%(\\d{1,9})$`)
const KEY = /^[0-9a-z._-]{1,120}$/
/** What a folder name (or a typing/claimed name's prefix) says the pane is: a tmux pane's number, or a pty host's. */
const TMUX_FOLDER = /^(\d{1,9})$/
// A versioned instance has dots of its own (`p2-0.4.21`): the pane is the number after the last one.
const PTY_FOLDER = new RegExp(`^ptyhost\\.(${PTY_HOST_INSTANCE_SOURCE})\\.(\\d{1,9})$`)
/**
 * A reclaimed item's name, `<pane folder>-<key>`. An instance may have a `-` in it, as a key does: the folder ends at
 * the last `.<pane number>-`, since no key (a message id and a hash, or `0note-<hash>`) has a `.` in it.
 */
const RECLAIMED = new RegExp(`^(\\d{1,9}|ptyhost\\.${PTY_HOST_INSTANCE_SOURCE}\\.\\d{1,9})-(.+)\\.json$`)

/** A pane as Agent Messages keys it: its route key, with a legacy bare `%N` read as the tmux pane it was. */
export function inboxPaneKey(pane: string): string {
  const legacy = LEGACY_PANE.exec(pane)
  return legacy ? `tmux\u0000%${legacy[1]}` : pane
}

/** The folder name of [pane]'s inbox, or null for anything that is not a pane. */
function folderOf(pane: string): string | null {
  const key = inboxPaneKey(pane)
  const tmux = TMUX_PANE.exec(key)
  if (tmux) return tmux[1]
  const pty = PTY_PANE.exec(key)
  return pty ? `ptyhost.${pty[1]}.${pty[2]}` : null
}

/** The pane a folder name stands for, as its route key, or null for a name this never writes. */
function paneOfFolder(folder: string): string | null {
  const tmux = TMUX_FOLDER.exec(folder)
  if (tmux) return `tmux\u0000%${tmux[1]}`
  const pty = PTY_FOLDER.exec(folder)
  return pty ? `ptyhost\u0000${pty[1]}\u0000%${pty[2]}` : null
}

export class PaneInbox {
  constructor(readonly root: string) {}

  /** The folder of a pane (its route key, or a legacy tmux `%12`), or null for anything that is not one. */
  paneDir(pane: string): string | null {
    const folder = folderOf(pane)
    return folder ? join(this.root, 'inbox', folder) : null
  }

  private dir(name: 'claimed' | 'typing'): string {
    const dir = join(this.root, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  private key(pane: string, key: string): string {
    if (!KEY.test(key)) throw new Error(`invalid inbox key ${key}`)
    return `${folderOf(pane)!}-${key}`
  }

  /** The name an item taken by the hook leaves in `claimed/` (`claimedNames`), or null for no pane or key. */
  claimName(pane: string, key: string): string | null {
    const folder = folderOf(pane)
    return folder && KEY.test(key) ? `${folder}-${key}` : null
  }

  /** Put an item in a pane's inbox; the hook may take it from now on. */
  put(pane: string, key: string, item: InboxItem): void {
    const dir = this.paneDir(pane)
    if (!dir) throw new Error(`not a terminal pane: ${JSON.stringify(pane)}`)
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

  /** What the hook has taken, by `<pane folder>-<key>` (`claimName`): read once for a whole pump. */
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

  /** Items a service that stopped mid-typing left reclaimed, as `[pane route key, key]`: given back as it starts. */
  reclaimed(): [string, string][] {
    let names: string[] = []
    try { names = readdirSync(this.dir('typing')) } catch { /* nothing reclaimed */ }
    return names.flatMap((name) => {
      const match = RECLAIMED.exec(name)
      return match ? [[paneOfFolder(match[1])!, match[2]] as [string, string]] : []
    })
  }

  /** Everything waiting in every pane's inbox, with when it was put there: what a sweep looks at. */
  entries(): Array<{ pane: string; key: string; at: number }> {
    const out: Array<{ pane: string; key: string; at: number }> = []
    let panes: string[] = []
    try { panes = readdirSync(join(this.root, 'inbox')) } catch { return out }
    for (const folder of panes) {
      const pane = paneOfFolder(folder)
      if (!pane) continue
      let names: string[] = []
      try { names = readdirSync(join(this.root, 'inbox', folder)) } catch { continue }
      for (const name of names) {
        const match = /^(.+)\.json$/.exec(name)
        if (!match || !KEY.test(match[1])) continue
        try { out.push({ pane, key: match[1], at: statSync(join(this.root, 'inbox', folder, name)).mtimeMs }) } catch { /* taken meanwhile */ }
      }
    }
    return out
  }

  private tidy(dir: string): void {
    try { rmdirSync(dir) } catch { /* not empty, or already gone */ }
  }
}
