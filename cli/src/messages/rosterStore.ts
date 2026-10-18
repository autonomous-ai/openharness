/**
 * The shared tabs this computer takes part in, as their owners signed them: the owner key pinned when the
 * person accepted (trust on first use), and the newest roster that verified against it. A roster older than the
 * one held is stale, never an error: the backend may serve an older one during a race. One that does not verify
 * is kept out and remembered as an alert (devlog principle: detect, not block), and the last valid one stays.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { verifyRoster, type Roster, type RosterError, type SignedRoster } from './roster.js'
import { list, NO, nullable, num, object, oneOf, optional, record, text, type Check } from './shape.js'

/** What went wrong: a roster that did not verify, a pin refused, or what a member's own check of its account's entries
 *  found (sharedTabs.ts `checkOwn`), one of its machines listed under another account among them (`own_machine_listed`). */
export type RosterAlertCode = RosterError | 'already_pinned' | 'foreign_machine' | 'machine_key_mismatch' | 'own_machine_listed' | 'file_unreadable' | 'share_id_mismatch'
/** `count`: how many times it happened within ALERT_WINDOW_MS of the one before, when more than once; `at` is the last. */
export type RosterAlert = { id: string; sharedTabId: string; at: string; error: RosterAlertCode; count?: number; dismissed?: true }
/** Not strict, as the zod schema was not: a key this store does not know is left out, never a reason to move the file aside. */
const signedSchema: Check<SignedRoster> = object<SignedRoster>({ body: text(), signature: text(),
  keyChange: optional(object({ previousPub: text(), signature: text() }, false)) }, false)
type StoredTab = { pinned: string; signed: SignedRoster | null; floor?: number }
type StoredAlert = { id?: string; sharedTabId: string; at: string; error: string; count?: number; dismissed?: true }
type Loaded = { tabs: Record<string, StoredTab>; alerts: StoredAlert[] }
const schema = object<Loaded>({
  // `floor`: the version of the roster a tab held when the relay said this machine is no longer in it (`release`).
  tabs: record(object<StoredTab>({ pinned: text(), signed: nullable(signedSchema), floor: optional(num) }, false)),
  // `id` is missing in a file 1b wrote; the store gives one on load. `dismissed`: the person has seen it.
  alerts: list(object<StoredAlert>({ id: optional(text()), sharedTabId: text(), at: text(), error: text(), count: optional(num),
    dismissed: optional(oneOf(true as const)) }, false)),
}, false)
type State = Omit<Loaded, 'alerts'> & { alerts: Array<Omit<StoredAlert, 'id'> & { id: string }> }
type Tab = State['tabs'][string]
const MAX_ALERTS = 50
/**
 * The same alert for the same tab within this long of the last is counted on that one, not added: a tab's owner sending
 * a roster that does not verify at the relay's 20 frames a second pushed every other alert out of the 50 kept in about
 * 2.5 s, and wrote the file and woke Share for each (final review of 1b).
 */
export const ALERT_WINDOW_MS = 10 * 60_000

/** The file as it was saved: null when there is none yet, undefined when what it holds is not this store's (not JSON,
 *  or not its shape). Any other error reading it (EACCES, EMFILE, EIO) is thrown: the file may be whole, and moving it
 *  aside would drop every pin for a failure that the next wake does not have (review of A7). */
function load(path: string): Loaded | null | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  let json: unknown
  try { json = JSON.parse(raw) } catch { return undefined }
  const loaded = schema(json)
  return loaded === NO ? undefined : loaded
}

/** What a tab's entry verifies to: the roster its pinned key signed, filed under the tab it names; null otherwise. */
function verifiedRoster(sharedTabId: string, tab: Tab): Roster | null {
  if (!tab.signed) return null
  const result = verifyRoster(tab.signed, tab.pinned)
  return 'error' in result || result.roster.sharedTabId !== sharedTabId ? null : result.roster
}

export class RosterStore {
  private state: State
  /** What each tab's entry verified to. A signature check costs about 12 ms (noble ed25519, 2026-10-15), and shared
   *  tabs read `current` on every frame; an entry is replaced whenever its pin or roster changes, so it never goes stale. */
  private readonly verified = new WeakMap<object, Roster | null>()
  /**
   * A file that reads but holds no store (cut short, or not this store's shape) is moved aside and the store starts empty, with an
   * alert for the person: refusing to start left Agent Messages without shared tabs until someone removed the file by
   * hand. Starting empty trusts nothing it did not verify: each tab is pinned again by accepting, or trusting the owner
   * again (`untrusted`), and the old file is kept beside it. A file that cannot be read at all throws, as before: the
   * service answers SHARES_UNAVAILABLE and reads it again as it next wakes.
   */
  /** `onChange` is told after every save (which kind: tabs, or only alerts), once the file holds it: the messages process, the file's only writer, nudges
   *  Share then to derive its tabs' observers again (core/messagesLink.ts `observers`), so a member removed from a roster
   *  stops watching within a second instead of at Share's next 30 s look. */
  constructor(private readonly path: string, private readonly now = () => Date.now(), private readonly onChange?: (kind: 'tabs' | 'alerts') => void) {
    const loaded = load(path)
    const unnamed = loaded?.alerts.some((a) => !a.id) ?? false
    this.state = loaded ? { ...loaded, alerts: loaded.alerts.map((a) => ({ ...a, id: a.id ?? randomUUID() })) } : { tabs: {}, alerts: [] }
    if (loaded === undefined) {
      renameSync(path, `${path}.unreadable-${this.now()}`)
      this.alert('', 'file_unreadable')
    } else if (unnamed) this.save(null)
  }

  /**
   * The rosters held in the file at `path`, each verified against its pin, for a process that only reads them (the
   * Share process, which never pins or alerts): never renames, writes or alerts. Null when the file cannot be read, or
   * holds no store: the messages process, which owns it, moves a broken one aside and records why.
   */
  static readRosters(path: string): Roster[] | null {
    let state: Loaded | null | undefined
    try { state = load(path) } catch { return null }
    if (state === undefined) return null
    return Object.entries(state?.tabs ?? {}).flatMap(([id, tab]) => { const roster = verifiedRoster(id, tab); return roster ? [roster] : [] })
  }
  /** What changed, for `onChange`: `tabs`, a tab's pin or roster; `alerts`, an alert added or dismissed, which changes
   *  nothing Share derives or the consent follows (final review of 1b), but the windows show it; null, nothing anyone is
   *  told of. A repeat counted on an alert is null: a tab's owner sending a roster that does not verify 20 times a second
   *  otherwise had every member's windows read `shares`, two backend requests each, 4 times a second (final review of 1c, I4). */
  private save(change: 'tabs' | 'alerts' | null = 'tabs'): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.state), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.path)
    if (change) this.onChange?.(change)
  }
  /** Kept with the roster's own alerts: a member's check of the entries under its account records here too, so the
   *  person reads every warning about a shared tab in one place (`shares`). Once per tab and error within
   *  ALERT_WINDOW_MS: a repeat is counted on the last one and moved to the end, as the newest. */
  alert(sharedTabId: string, error: RosterAlertCode): void {
    const now = this.now()
    const last = this.state.alerts.find((a) => !a.dismissed && a.sharedTabId === sharedTabId && a.error === error && now - Date.parse(a.at) < ALERT_WINDOW_MS)
    const count = last ? (last.count ?? 1) + 1 : undefined
    this.state.alerts = [...this.state.alerts.filter((a) => a !== last), { id: last?.id ?? randomUUID(), sharedTabId, at: new Date(now).toISOString(), error, ...(count ? { count } : {}) }].slice(-MAX_ALERTS)
    this.save(last ? null : 'alerts')
  }
  /** Pins the owner key on first use. Pinning the same key again is a no-op; a different key for a tab that already
   *  has a pin is refused and recorded, because swapping it would drop the signed key-change check and the version
   *  floor. To trust a new key the person must forget the tab and accept again. */
  pin(sharedTabId: string, ownerPub: string): 'pinned' | 'already_pinned' {
    const held = this.state.tabs[sharedTabId]
    if (held) {
      if (held.pinned === ownerPub) return 'pinned'
      this.alert(sharedTabId, 'already_pinned')
      return 'already_pinned'
    }
    this.state.tabs[sharedTabId] = { pinned: ownerPub, signed: null }
    this.save()
    return 'pinned'
  }
  /** The owner key a tab is pinned to, with or without a roster yet; null for a tab never pinned or since forgotten.
   *  Another computer of this account takes it from here (sharedTabs.ts `pinOf`). */
  pinned(sharedTabId: string): string | null { return this.state.tabs[sharedTabId]?.pinned ?? null }
  offer(signed: SignedRoster): { roster: Roster } | { stale: true } | { error: RosterError | 'not_pinned' } {
    const sharedTabId = /"sharedTabId":"([a-f0-9]{24})"/.exec(signed.body)?.[1] ?? ''
    const tab = this.state.tabs[sharedTabId]
    if (!tab) return { error: 'not_pinned' }
    const result = verifyRoster(signed, tab.pinned)
    if ('error' in result) {
      this.alert(sharedTabId, result.error)
      return { error: result.error }
    }
    // The id above came from a pattern on the body; JSON.parse keeps the last duplicate key. Only a roster that
    // names the tab it was filed under may be kept there.
    if (result.roster.sharedTabId !== sharedTabId) { this.alert(sharedTabId, 'malformed'); return { error: 'malformed' } }
    const held = this.current(sharedTabId)
    // Released (`release`), the roster it held is still the floor: the same one is taken back, never an older one.
    if (held ? held.roster.version >= result.roster.version : (tab.floor ?? 0) > result.roster.version) return { stale: true }
    this.state.tabs[sharedTabId] = { pinned: result.ownerPub, signed }
    this.save()
    return { roster: result.roster }
  }
  current(sharedTabId: string): { roster: Roster; signed: SignedRoster } | null {
    const tab = this.state.tabs[sharedTabId]
    if (!tab?.signed) return null
    let roster = this.verified.get(tab)
    if (roster === undefined) {
      roster = verifiedRoster(sharedTabId, tab)
      this.verified.set(tab, roster)
    }
    return roster && { roster, signed: tab.signed }
  }
  all(): Roster[] {
    return Object.keys(this.state.tabs).flatMap(id => { const c = this.current(id); return c ? [c.roster] : [] })
  }
  forget(sharedTabId: string): void {
    delete this.state.tabs[sharedTabId]
    this.save()
  }
  /**
   * The relay no longer admits this machine to a tab another account owns (4403): its roster goes, so nothing of the tab
   * runs here, but the pin stays, with the version held as a floor. A 4403 is only the relay's word: forgetting the pin
   * on it let the backend have the person trust the owner on first use again, a key of its choosing (final review of
   * 1b). Listed again, the tab's roster is taken back under the same pin (sharedTabs.ts `retake`); accepting again, or
   * trusting the owner again, pins anew as before.
   */
  release(sharedTabId: string): void {
    const tab = this.state.tabs[sharedTabId]
    if (!tab) return
    const floor = this.current(sharedTabId)?.roster.version ?? tab.floor
    this.state.tabs[sharedTabId] = { pinned: tab.pinned, signed: null, ...(floor === undefined ? {} : { floor }) }
    this.save()
  }
  /** The alerts the person has not dismissed. */
  alerts(): RosterAlert[] { return this.state.alerts.filter(a => !a.dismissed).map(({ dismissed: _dismissed, ...a }) => ({ ...a, error: a.error as RosterAlertCode })) }
  /** The person dismissed one: it is kept, hidden, so the next like it within ALERT_WINDOW_MS starts a new alert. False
   *  when there is none by that id, or it is already dismissed. */
  dismiss(id: string): boolean {
    const a = this.state.alerts.find(x => x.id === id && !x.dismissed)
    if (!a) return false
    a.dismissed = true
    this.save('alerts')
    return true
  }
}
