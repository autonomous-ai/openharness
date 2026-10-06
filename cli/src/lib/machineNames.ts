/**
 * The names this machine has gone by while this daemon has run: a pane title that is one of them says
 * nothing about the agent, and is refused as its name (`titleDisplayName` in lib/registry.ts).
 *
 * tmux titles every new pane with the machine's name as it is at that moment (`gethostname`), and an
 * engine that sets no title of its own keeps it; Hermes sets its title to the hostname itself. A
 * laptop's name follows its network (`MacBook.lan` at home, `MacBook.local` where the network names
 * nothing). The daemon read the name once, at start, so after a change every pane made under the new
 * name gave its agent the machine's name: found comparing with v0.3.58 (e2e/compat.e2e.ts), when the
 * name changed during a run.
 *
 * So the name is read again on every title sweep and whenever the daemon has tmux make a pane, both a
 * syscall, and every name read is kept: a pane made under the old name still carries it after the
 * machine has moved on. A daemon started since knows none of the old names, so a host name is also
 * the machine's when its first part is: the same laptop, on another network. Kept to the last MACHINE_NAMES_KEPT names seen, so a machine that roams many
 * networks over weeks holds a few dozen strings, not one per network forever.
 */
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

export const MACHINE_NAMES_KEPT = 16

/** A host name with a domain: `macbook-pro.lan`, `studio.local`, `box.example.com`. */
const HOST_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/

export interface MachineNames {
  /** Reads the machine's name now and keeps it among the names it has had. */
  observe(): void
  /** Whether `title` is one of the machine's names, or the first part of one, in any case. */
  owns(title: string): boolean
}

export function createMachineNames(read: () => string, kept = MACHINE_NAMES_KEPT): MachineNames {
  // Each name in full and lower-cased, least recently seen first; and every form a title carries it in.
  const names = new Set<string>()
  let forms = new Set<string>()
  const observe = (): void => {
    let name = ''
    try {
      name = read().trim().toLowerCase()
    } catch {
      // No name now is no reason to forget the ones already seen.
    }
    if (!name) return
    // Seen again: the most recent once more, so it is the last to go.
    if (names.delete(name)) { names.add(name); return }
    names.add(name)
    for (const oldest of names) {
      if (names.size <= kept) break
      names.delete(oldest)
    }
    // `MacBookPro2021.local` and `MacBookPro2021` are the same machine wearing two names, and an
    // engine may print either.
    forms = new Set([...names].flatMap((full) => [full, full.split('.')[0]!]).filter(Boolean))
  }
  observe()
  return {
    observe,
    owns: (title) => {
      const name = title.toLowerCase()
      // The same machine on another network than any this daemon has seen it on: `MacBook-Pro.lan`, a
      // pane made before a restart on `MacBook-Pro.local`. Only a title shaped as a host name, so one
      // that is a sentence is never refused for starting with the machine's name.
      return forms.has(name) || (HOST_NAME.test(name) && forms.has(name.split('.')[0]!))
    },
  }
}

/**
 * The machine's name as the operating system has it. End to end, `file` (HARNESSD_TEST_HOSTNAME_FILE)
 * stands in for it while the file holds a name: a test cannot change the computer's name, and must
 * not. A file not written yet, or empty, is the computer's own name.
 */
export function hostnameReader(file: string | undefined): () => string {
  if (!file) return hostname
  return () => {
    try {
      const name = readFileSync(file, 'utf8').trim()
      if (name) return name
    } catch {
      // Not written yet.
    }
    return hostname()
  }
}

/** The daemon's: what its title sweep and its tmux panes read, and what titles are refused as. */
export const machineNames = createMachineNames(hostnameReader(process.env.HARNESSD_TEST_HOSTNAME_FILE))
