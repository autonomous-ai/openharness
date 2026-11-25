// The dial eval's contract: the catalog, the drivers, the runner, the grader and the report all speak these types
// (docs/plans/2026-11-21-dial-app-eval-design.md, docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md,
// docs/plans/2026-11-22-dial-eval-orca-design.md, docs/plans/2026-11-22-dial-eval-iterm2-design.md).
import { observedAgentId } from '../../cable/hosts/observed.js'
import type { Nest } from '../../cable/hosts/types.js'

export type App = 'claude' | 'chatgpt' | 'vscode' | 'cursor' | 'orca' | 'iterm'
/** A page of the dial's Apps screen: an app's, or tmux's or herdr's, which count their agents across every terminal app
 *  (docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md, decision 1). */
export type Page = App | Nest
export type Editor = Extract<App, 'vscode' | 'cursor'>
/** The apps whose rows open by a link of their scheme: all but Orca and iTerm2. */
export type LinkedApp = Exclude<App, 'orca' | 'iterm'>
export type Dimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8'
export type Platform = 'darwin' | 'win32' | 'linux'
/** `a`: replay in process; `b`: scripted end to end on the real daemon, fake apps. */
export type Tier = 'a' | 'b'
export type SessionKey = string
export type Label = string

export const DIMENSIONS: readonly Dimension[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']
/** The apps scored, in the order the grader and the report list them. */
export const APPS: readonly App[] = ['claude', 'chatgpt', 'vscode', 'cursor', 'orca', 'iterm']
export const EDITORS: readonly Editor[] = ['vscode', 'cursor']
/** The wire's name for an app's page, which is its app id on the host too (hostDetect.ts): the ChatGPT app's threads are Codex's. */
export const PAGE: Readonly<Record<App, string>> = { claude: 'claude', chatgpt: 'codex', vscode: 'vscode', cursor: 'cursor', orca: 'orca',
  iterm: 'iterm' }
/** The wire's name for a page: tmux's and herdr's are their own, an app's is PAGE's. */
export const pageId = (page: Page): string => page === 'tmux' || page === 'herdr' ? page : PAGE[page]
/** The maker of a held Orca pane's terminal, in both tiers: a program that is not Orca's terminal host. */
export const HELD_MAKER = 'eval-terminal'
/** How long after a switch Orca tells the focus it moved, in both tiers: inside the devices' 2 s echo window
 *  (services/devices.ts TAB_ECHO_MS), and after a turn of the dial a second past the switch, which its echo could
 *  bounce (O4). */
export const ORCA_ECHO_MS = 1_500
/**
 * The app in front as each OS names it, as Harness Device tells it: a bundle id on macOS, the window's process on Linux,
 * its program on Windows; `other` is an app the dial follows none of. Orca's are its own names on each (its bundle id,
 * src/testing/recordedOrca.ts's executable, orca.exe), whether or not the product tells Orca by them, so a platform it
 * cannot is graded as the person sees it. iTerm2 runs on macOS alone, so it has no name on the others.
 */
export const FRONT_NAMES: Readonly<Record<Platform, Readonly<Partial<Record<App | 'other', string>>>>> = {
  darwin: { claude: 'com.anthropic.claudefordesktop', chatgpt: 'com.openai.codex', vscode: 'com.microsoft.VSCode',
    cursor: 'com.todesktop.230313mzl4w4u92', orca: 'com.stablyai.orca', iterm: 'com.googlecode.iterm2', other: 'com.apple.Safari' },
  linux: { claude: 'claude-desktop', chatgpt: 'ChatGPT', vscode: 'code', cursor: 'cursor', orca: 'orca-ide', other: 'firefox' },
  win32: { claude: 'Claude.exe', chatgpt: 'ChatGPT.exe', vscode: 'Code.exe', cursor: 'Cursor.exe', orca: 'orca.exe', other: 'firefox.exe' },
}

/** The app's front name on the platform; an app with none there throws, as no scenario of it runs there. */
export function frontName(platform: Platform, app: App | 'other'): string {
  const name = FRONT_NAMES[platform][app]
  if (name === undefined) throw new Error(`${app} has no front name on ${platform}`)
  return name
}
/** The agent a session runs, which names its observed source. */
export type Engine = 'claude' | 'codex' | 'cursor'
/** Where an editor session runs: a terminal of its window, the Claude Code panel, or Cursor's own agent. */
export type Place = 'terminal' | 'panel' | 'agent'
/** Where an iTerm2 session runs: a tab or split of its own, or a pane of tmux or herdr whose client runs in a tab. */
export type ItermPlace = 'tab' | 'tmux' | 'herdr'
const ITERM_PLACES: readonly ItermPlace[] = ['tab', 'tmux', 'herdr']
const isItermPlace = (place: Place | ItermPlace | undefined): place is ItermPlace => (ITERM_PLACES as readonly unknown[]).includes(place)
/** What the devices log when a stroke scrolls nothing, followed by why. */
export const SKIPPED_SCROLL = '[device] scroll · skipped · '

/** Each dimension's weight in an app's score: voice send counts most, since a wrong-session send is the worst failure. */
export const WEIGHTS: Readonly<Record<Dimension, number>> = {
  D1: 15, D2: 15, D3: 15, D4: 10, D5: 25, D6: 5, D7: 10, D8: 5,
}

/** [full, half], inclusive: at or under the first scores 1, at or under the second 0.5, else 0. */
export const THRESHOLDS: {
  follow: [1000, 3000]; open: [1000, 3000]; working: [1000, 3000]; needsYou: [1000, 3000]
  done: [2500, 5000]; ringChange: [2000, 5000]; loopP99Ms: [50, 200]; cpuPercent: [10, 25]
} = {
  follow: [1000, 3000],
  open: [1000, 3000],
  working: [1000, 3000],
  needsYou: [1000, 3000],
  // The 1.5 s answer grace is by design, so done gets more room.
  done: [2500, 5000],
  ringChange: [2000, 5000],
  loopP99Ms: [50, 200],
  cpuPercent: [10, 25],
}

export interface SessionDef {
  key: SessionKey; app: App
  /** Claude Code's cliSessionId, or the Codex thread id: a fixed made-up UUID. */
  id: string
  /** Claude only: `local_<uuid>`, its store file and its link's session. */
  localId?: string
  /** The app's title (Claude) / Codex's thread name (ChatGPT): starts with "Eval ". */
  title: string
  /** Under /work/eval-. */
  cwd: string
  /** Last active this long before the step that writes it. */
  ageMs: number
  /** ChatGPT: its sidebar project. */
  project?: string
  /** The fake app starts it when its link runs. */
  resumable?: true
  /** A Codex CLI session in a terminal, not the ChatGPT app's (X10). */
  cli?: true
  /** Never written or started: only probes name it. */
  ghost?: true
  /** The editors: `terminal` when unset. iTerm2: `tab` when unset. */
  place?: Place | ItermPlace
  /** `claude` when unset, but the ChatGPT app's threads are Codex's and Cursor's `agent` is Cursor's own. */
  engine?: Engine
  /** The editor window that holds its terminal; iTerm2's window that holds its tab. */
  window?: string
  /** A Codex whose `CODEX_HOME` is a folder of its own. */
  codexHome?: 'own'
  /** Cursor's agent's workspace folders, under /work/eval-. */
  folders?: string[]
  /** Claude Code run in the person's tmux, whose client runs in its terminal (V12, O11). Not iTerm2's: there tmux is a
   *  place. */
  tmux?: true
  /** Orca only: the key of its Orca worktree. */
  worktree?: string
  /**
   * Orca: where its pane sits in the layout, its worktree's tab and that tab's split. iTerm2: its tab and split; for a
   * tmux or herdr session, the tab its multiplexer's first client runs in and its pane's order in that multiplexer's window.
   */
  tab?: number
  split?: number
  /** iTerm2's herdr only: herdr's row gives no session id (IH4). */
  herdrSession?: false
  /** Orca only: its terminal's fixed made-up `term_<uuid>`; `none`: its hooks name none. */
  handle?: string
  /** Orca only: its terminal's maker is another program than Orca's terminal host (HELD_MAKER). */
  held?: true
  /**
   * Orca only: a chat of Orca's in its worktree, which `orca agent list` lists and no terminal holds
   * (docs/plans/2026-11-23-dial-orca-chats-design.md): no layout has a pane of it, and its hooks name its Orca session and
   * no handle. `resting`: no process runs it, so no hook ever names it and its row is Orca's alone, by its Orca session id.
   */
  chat?: 'live' | 'resting'
}

export const STEP_KINDS = ['claude.write', 'codex.write', 'hook', 'front', 'thread', 'attach', 'tap', 'swipe',
  'voice', 'quit', 'relaunch', 'unplug', 'replug', 'pick', 'wait',
  'editor.window', 'editor.focus', 'editor.closeTerminal', 'editor.reload', 'editor.close', 'stroke',
  'orca.layout', 'orca.focus', 'orca.front', 'orca.plugin', 'orca.close',
  'iterm.tab', 'iterm.split', 'iterm.closeTab', 'iterm.select', 'iterm.relaunch', 'tmux.detach', 'tmux.attach', 'tmux.selectPane',
  'herdr.focus', 'herdr.restart', 'devices.restart'] as const
export type StepKind = (typeof STEP_KINDS)[number]
// One member per kind, so StepOf<K> narrows.
export type Step = { label?: Label } & (
  | { kind: 'claude.write'; sessions: SessionKey[]; archived?: true }
  | { kind: 'codex.write'; sessions: SessionKey[]; projects?: string[]; names?: Record<SessionKey, string>;
      archived?: SessionKey[]; ages?: Record<SessionKey, number>; walBusy?: true }
  | { kind: 'hook'; session: SessionKey; event: 'start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'end';
      asks?: 'permission' | 'question'; lastAnswer?: string }
  | { kind: 'front'; app: App | 'other' }
  | { kind: 'thread'; title: string }
  | { kind: 'attach'; session: SessionKey }
  | { kind: 'tap'; session: SessionKey }
  | { kind: 'swipe'; session: SessionKey }
  | { kind: 'voice'; transcript: string; target: SessionKey }
  | { kind: 'quit'; app: App }
  | { kind: 'relaunch'; app: App }
  | { kind: 'unplug' }
  | { kind: 'replug' }
  /** The person picks a page on the dial's Apps screen (ui_habitat.c app_pick). */
  | { kind: 'pick'; page: Page }
  /** A window opens its stream and reports its shells: by default the live terminal sessions whose `window` is it. */
  | { kind: 'editor.window'; window: string; active: SessionKey | null; focused: boolean; terminals?: SessionKey[] }
  /** A terminal becomes its window's active one, and the window is focused. */
  | { kind: 'editor.focus'; session: SessionKey }
  | { kind: 'editor.closeTerminal'; session: SessionKey }
  | { kind: 'editor.reload'; window: string }
  | { kind: 'editor.close'; window: string }
  /** The person strokes the dial on the face's row. */
  | { kind: 'stroke' }
  /** Orca's worktrees, in this order, as `terminal list` answers from now on; `renamed`: a tab the person renamed, by
   *  one of its panes' sessions. */
  | { kind: 'orca.layout'; worktrees: string[]; renamed?: Record<SessionKey, string> }
  /** A watch-focus line for the session's pane. */
  | { kind: 'orca.focus'; session: SessionKey }
  /** The plugin's `orcaFront` for the worktree: its terminals. */
  | { kind: 'orca.front'; worktree: string }
  /** The plugin's `dial` stream opens or closes. */
  | { kind: 'orca.plugin'; open: boolean }
  /** The session's pane closes: its agent and shell end with no hook. */
  | { kind: 'orca.close'; session: SessionKey }
  /** iTerm2 opens a tab, or a split of one, with an empty shell; a session's start opens its own when none is. */
  | { kind: 'iterm.tab'; window: string; tab: number }
  | { kind: 'iterm.split'; window: string; tab: number; split: number }
  /** The tab closes: its shells and all under them end with no hook, while an agent in a multiplexer runs on under its
   *  server. */
  | { kind: 'iterm.closeTab'; window: string; tab: number }
  /** The watch reports the tab, or one of its splits, as selected. */
  | { kind: 'iterm.select'; window: string; tab: number; split?: number }
  /** iTerm2's process ends and none starts: its server goes to launchd, and every session runs on. */
  | { kind: 'iterm.relaunch' }
  /** Every client of the session's tmux session ends. */
  | { kind: 'tmux.detach'; session: SessionKey }
  /** A client of the session's tmux session starts in the tab, used now. */
  | { kind: 'tmux.attach'; session: SessionKey; window: string; tab: number }
  /** The person's own pane moves, which the devices run no command for. */
  | { kind: 'tmux.selectPane'; session: SessionKey }
  | { kind: 'herdr.focus'; session: SessionKey }
  /** herdr's server, its clients and agents end with no hook; then a new client in the same tab, a new server, and each
   *  herdr session started again on a new pane, with its start hook and herdr's report. */
  | { kind: 'herdr.restart' }
  /** The devices stop and start again on the same root, sessions and dial. */
  | { kind: 'devices.restart' }
  /**
   * With `until`, the wait ends once it holds and `ms` is only its limit: one that reaches it is a failing result.
   * Without, `ms` is the person's own timing.
   */
  | { kind: 'wait'; ms: number; until?: Until }
)
/** What a wait ends on. `ring`: what the dial has received from the scenario's start, as a ring check reads it, its
 *  `apart` too, so a wait ends only once the other pages count theirs. `apps`: the Apps screen alone, as a person reads
 *  it before a pick: an apps frame since the last step shows that page and counts exactly these pages' agents, so a
 *  screen left from before a restart is not the devices' count. */
export type Until =
  | { kind: 'ring'; page: Page; expect: SessionKey[]; apart?: SessionKey[] }
  | { kind: 'apps'; shown: Page; counts: Partial<Record<Page, number>> }
export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>

export const CHECK_KINDS = ['ring', 'focus', 'still', 'open', 'state', 'voice', 'refused', 'recap', 'cost', 'scroll', 'logged', 'face'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]
export type Check = { id: string; dim: Dimension; after?: Label; at?: Label } & (
  /**
   * apart: sessions on other pages (a terminal's), each counted there as a row of its own. The dial is sent no list of a
   * page it has not picked, so they are read from the `apps` frame's counts: one merged into this page's rows is missing there.
   */
  | { kind: 'ring'; page: Page; expect: SessionKey[]; timed?: true; apart?: SessionKey[] }
  | { kind: 'focus'; session: SessionKey; noBounce?: true }
  | { kind: 'still'; ms: number }
  /** tab: iTerm2 only, the label a select must name when the session's client moved to another tab (I13, IH2). */
  | { kind: 'open'; session: SessionKey; link: boolean; tab?: string }
  | { kind: 'state'; session: SessionKey; state: 'working' | 'needs-you' | 'done' | 'idle' }
  /** path: the words must reach the session by it; one by another path does not reach it, and counts against once. */
  | { kind: 'voice'; session: SessionKey; text: string; path?: Delivery['path'] }
  /** Words to the session on the dial's face that the product takes no route for: the dial says `text`, the product's
   *  own sentence, and the words reach no session. */
  | { kind: 'refused'; session: SessionKey; text: string }
  | { kind: 'recap'; session: SessionKey; text: string }
  | { kind: 'cost' }
  /** The window that holds the session's shell ran scroll lines for that shell while it was active. */
  | { kind: 'scroll'; session: SessionKey }
  /** The devices logged SKIPPED_SCROLL and a reason: pass/fail. */
  | { kind: 'logged' }
  /** From its `after` on, the carousel refused no tile and never held tiles with none on the face: pass/fail. */
  | { kind: 'face' }
)

export interface Scenario {
  id: string; app: App; title: string; dims: Dimension[]; platforms: Platform[]; tiers: Tier[]; heldOut: boolean
  sessions: SessionDef[]
  /** front defaults to `app`. accessibility false: Harness Device is not granted it, so no window title is read. */
  world?: { front?: App | 'other'; chatgptInstalled?: false; linkFails?: LinkedApp[]; accessibility?: false
    /** The editor was started from Terminal (`code .`, `cursor .`). */
    launchedFrom?: 'terminal-app'
    /** The Harness extension is not installed, so no window opens a stream (V13). */
    extension?: false
    /** watchFocus false: Orca's CLI has no `terminal watch-focus`. plugin false: the Harness plugin is not installed in
     *  Orca, so no `dial` stream opens (O13). noIdentity: the worktrees Orca gives no identity, which its plugin names by
     *  their id (2 of the 14 on Tony's Mac, docs/plans/2026-11-23-dial-orca-chats-design.md, Task 0). */
    orca?: { watchFocus?: false; plugin?: false; noIdentity?: string[] }
    /** Harness's `CODEX_HOME` is the ChatGPT app's Codex home, as on a computer that never set it. Tier A only. */
    codexHome?: 'app' }
  steps: Step[]; checks: Check[]
  /** Checks that name a ghost session, so they must fail: they prove a check can fail with its evidence. Never scored. */
  probes: Check[]
  /** Tier B: on a daemon of its own. */
  fresh?: true
}

/** Every delivery path, with its target: the Claude mod's inbox, the core's turns.send, the Codex queue, typed words. */
export interface Delivery { at: number; path: 'mod' | 'turns' | 'codex' | 'typed'; target: SessionKey | null; text: string }
/** What a driver observed. `at`: ms since the scenario's start (virtual in tier A, wall in tier B). */
export interface Seen {
  frames: Array<{ at: number; message: Record<string, unknown> }>
  /** refused: the carousel model's refused tiles so far (dialCarousel.ts). */
  faces: Array<{ at: number; page: string; tiles: string[]; active: string | null; refused: number }>
  /** ok: the command succeeded. */
  commands: Array<{ at: number; argv: string[]; ok: boolean }>
  deliveries: Delivery[]
  steps: Array<{ at: number; index: number; kind: StepKind; label?: Label }>
  cost?: { cpuPercent: number; loopP99Ms: number; leftovers: number }
  /** Each message on an editor window's stream, both ways, and on the watch's tabs stream (window `tabs`). */
  streams?: Array<{ at: number; window: string; line: Record<string, unknown> }>
  /** Each devices log line; absent: the driver saw none. */
  logs?: Array<{ at: number; line: string }>
}
export interface CheckResult {
  tier: Tier; platform: Platform; scenario: string
  /** `<id>.<part>`, or `<id>` for a D7 check. */
  check: string
  app: App; dim: Dimension; heldOut: boolean
  /** 0..1. */
  score: number
  /** Latency or cost threshold: reported, never asserted in tier B, since it depends on the runner. */
  timed: boolean
  ms?: number | null
  /** What was observed, one line each; empty when nothing was. */
  evidence: string[]
}
/** A voice prompt delivered to a session other than the step's target: it fails the whole run. */
export interface WrongSend { tier: Tier; platform: Platform; scenario: string; target: SessionKey; got: SessionKey | null;
  path: Delivery['path']; at: number }
/** A scenario × platform the injected platform cannot drive, or the catalog leaves out: out of the scores, neither pass nor fail. */
export interface CoverageGap { tier: Tier; platform: Platform; scenario: string; app: App; heldOut: boolean; reason: string }
export interface RunResults { schema: 1; results: CheckResult[]; wrongSends: WrongSend[]; gaps: CoverageGap[] }
/**
 * checks: keyed by resultKey. apps: each subset's app scores, keyed `a` (tier A, every platform at once, as it runs them
 * all by injection) or `b/<platform>`, so a run is compared only with the subsets it drove.
 */
export interface Baseline { schema: 1; checks: Record<string, number>
  /** One written before an app joined the eval has no entry of it. */
  apps: Record<string, Partial<Record<App, number | null>>> }
export interface AppScores {
  score: number | null; dims: Record<Dimension, number | null>
  /** That app's tier × platform × scenario runs left out for a gap. */
  leftOut: number
}
export interface Group { app: App; dim: Dimension; scenario: string; pointsLost: number; checks: string[] }
export interface Report {
  schema: 1
  apps: Record<App, AppScores>; heldOut: Record<App, AppScores>
  /** byPlatform's key: `<tier>/<platform>`. */
  byTier: Record<Tier, Record<App, AppScores>>; byPlatform: Record<string, Record<App, AppScores>>
  gate: { passed: boolean; wrongSends: WrongSend[] }
  /** groups ranked, most points lost first. */
  failing: Array<CheckResult & { pointsLost: number }>; groups: Group[]
  /** The main set's: a held-out gap counts in its table's left out, and only its reason is given, in heldOutGaps. */
  gaps: CoverageGap[]
  /** Each held-out gap's reason, with the tiers and platforms it left out and how many runs, by reason: no scenario is
   *  named, so whoever fixes the main set learns none of them. */
  heldOutGaps: Array<{ reason: string; tiers: Tier[]; platforms: Platform[]; runs: number }>
  /** Each tier the eval command did not run, and why. */
  skipped?: Array<{ tier: Tier; reason: string }>
  /**
   * apps: keyed by subset, as the baseline's, for each subset this run drove. checks: the main set's; the held-out ones
   * that changed are only counted, so the report shows nothing of them to fix by.
   */
  delta: { apps: Record<string, Record<App, { before: number | null; after: number | null }>>;
           checks: Array<{ key: string; before: number | null; after: number | null }>; heldOutChanged: number }
}
export interface Verdict { ok: boolean; message: string }
export interface EvalDriver {
  readonly tier: Tier
  /** Time 0: devices up, dial welcomed, page and front set. */
  start(scenario: Scenario, platform: Platform): Promise<void>
  step(step: Exclude<Step, { kind: 'wait' }>): Promise<void>
  /** Let the world run up to ms, or until `until` holds. */
  settle(ms: number, until?: () => boolean): Promise<void>
  /** Still read after stop(). */
  seen(): Seen
  gaps(): string[]
  stop(): Promise<void>
}

/**
 * The session as defined, refused when it runs in a place its app has not: only Cursor has an agent of its own, iTerm2's
 * places are its alone and it has none of the editors', and an iTerm2 session's tmux is its place, not `tmux: true`.
 */
function owned<S extends Pick<SessionDef, 'app' | 'place'> & Pick<Partial<SessionDef>, 'tmux'>>(s: S): S {
  if (s.place === 'agent' && s.app !== 'cursor') throw new Error(`${s.app} has no agent of its own: only Cursor's sessions run in place 'agent'`)
  if (s.app !== 'iterm' && isItermPlace(s.place)) {
    throw new Error(`${s.app} has no ${s.place} place: only iTerm2's sessions run in a tab, tmux or herdr`)
  }
  if (s.app === 'iterm' && s.place !== undefined && !isItermPlace(s.place)) {
    throw new Error(`iTerm2 has no ${s.place} place: its sessions run in a tab, tmux or herdr`)
  }
  if (s.app === 'iterm' && s.tmux) throw new Error("an iTerm2 session's tmux is its place: tmux: true is refused")
  return s
}

export function engineOf(s: Pick<SessionDef, 'app' | 'engine' | 'place'>): Engine {
  return owned(s).engine ?? (s.app === 'chatgpt' ? 'codex' : s.app === 'cursor' && s.place === 'agent' ? 'cursor' : 'claude')
}

/** An editor session's place; undefined for every other app. */
export function placeOf(s: Pick<SessionDef, 'app' | 'place'>): Place | undefined {
  // owned refuses an iTerm2 place on an editor's session.
  return (EDITORS as readonly App[]).includes(owned(s).app) ? s.place as Place | undefined ?? 'terminal' : undefined
}

/** An iTerm2 session's place, `tab` when unset; undefined for every other app. */
export function itermPlaceOf(s: Pick<SessionDef, 'app' | 'place'> & Pick<Partial<SessionDef>, 'tmux'>): ItermPlace | undefined {
  // owned refuses an editor's place on an iTerm2 session.
  return owned(s).app === 'iterm' ? s.place as ItermPlace | undefined ?? 'tab' : undefined
}

/**
 * The wire's name for the page the session's row is on: an iTerm2 session in tmux or herdr is on that multiplexer's
 * page, as one tmux page and one herdr page count their agents across every terminal app, and so is a Claude Code in the
 * person's tmux in an editor's terminal, while Orca's stays on Orca's (docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md,
 * decisions 1 and 3); every other session is on its app's.
 */
export function sessionPage(s: SessionDef): string {
  const place = itermPlaceOf(s)
  if (place === 'tmux' || place === 'herdr') return place
  return s.tmux && s.app !== 'orca' ? 'tmux' : PAGE[s.app]
}

/** The agent id the daemon's observed sources give this session: its engine's. No hook names a resting Orca chat, so its
 *  row is Orca's own, by its Orca session (cable/hosts/orcaChatSource.ts rowOf). */
export function agentIdOf(s: Pick<SessionDef, 'app' | 'id' | 'engine' | 'place' | 'chat'> & { key?: SessionKey }): string {
  if (s.chat !== 'resting') return observedAgentId(engineOf(s), s.id)
  if (s.key === undefined) throw new Error('a resting Orca chat is named by its key')
  return observedAgentId('orca', orcaAgentSessionId(s.key))
}

/** The handle of the terminal Orca first lays the session out in: a fixed made-up one from the key's bytes. */
export function orcaTerminalHandle(key: SessionKey): string {
  const bytes = Buffer.from(key).toString('hex')
  if (bytes.length > 12) throw new Error(`session key ${key} is longer than 6 bytes`)
  return `term_00000000-0000-4000-8d00-${bytes.padStart(12, '0')}`
}

/** The handle of the terminal Orca lays the session out in at Orca's nth launch (0: its first), one count per world in
 *  both tiers and the checks. A relaunched Orca gives each pane a new terminal, a session first started after it too,
 *  so a check that reads an old handle grades a pane that is gone. */
export function orcaPaneHandle(s: Pick<SessionDef, 'key' | 'handle'>, launch: number): string {
  const first = s.handle === undefined || s.handle === 'none' ? orcaTerminalHandle(s.key) : s.handle
  if (launch === 0) return first
  if (!Number.isInteger(launch) || launch < 0 || launch > 9 || !first.includes('-8d00-')) {
    throw new Error(`${s.key} has no handle at launch ${launch}`)
  }
  return first.replace('-8d00-', `-8d0${launch}-`)
}

/** The handle its hooks name at that launch: none for `handle: 'none'`, nor for a chat, which no terminal holds. */
export function hookHandle(s: Pick<SessionDef, 'key' | 'handle' | 'chat'>, launch: number): string | undefined {
  return s.handle === 'none' || s.chat !== undefined ? undefined : orcaPaneHandle(s, launch)
}

/** Orca's id of the worktree, as `terminal list` prints it, in both tiers. */
export function orcaWorktreeId(worktree: string): string {
  return `eval-repo::/work/eval-${worktree}`
}

/** The Orca session of the session's agent, as its hooks name it (ORCA_AGENT_SESSION_ID) in both tiers: a chat's
 *  `orcaSessionId` in `orca agent list`. */
export function orcaAgentSessionId(key: SessionKey): string {
  return `eval-orca-${key}`
}

/** A result's key in the baseline: tier/platform/scenario/check. */
export function resultKey(r: Pick<CheckResult, 'tier' | 'platform' | 'scenario' | 'check'>): string {
  return `${r.tier}/${r.platform}/${r.scenario}/${r.check}`
}
