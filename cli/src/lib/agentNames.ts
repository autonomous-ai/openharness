/**
 * What a harness is called before anything better is known, and what its new project folder is called.
 *
 * A harness is named by who it is and when it started — "Codex harness 9-17 15:26", "Blender harness
 * 9-17 15:30" — and its folder the same way, `~/harnesses/codex-2026-09-17-15-26`. That replaced
 * `harness-N`, which said nothing and had to be counted: a name and a folder numbered by two counters
 * drifted apart (a tab named harness-43 over a terminal in harness-42) and stayed apart.
 *
 * It is a stand-in. Once the engine titles the session, the title is the name (registry.ts,
 * projectDisplayName), and a rename fixes a name for good.
 */
import type { AgentEngine } from '../engines/types.js'

/** The app's own words for each engine (desktop/lib/widgets/engine_identity.dart). */
const ENGINE_LABELS: Record<AgentEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  hermes: 'Hermes',
  commandcode: 'Command Code',
  devin: 'Devin',
  muse: 'Muse',
  amp: 'Amp',
  kilo: 'Kilo',
  grok: 'Grok',
  agy: 'Antigravity',
  copilot: 'Copilot',
  terminal: 'Terminal',
}

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine as AgentEngine] ?? engine
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * "Codex harness 9-17 15:26" — local time on a 24-hour clock. No zero where it says nothing (month,
 * day and hour: "9-3 9:05"); minutes and seconds always two digits, as a clock reads.
 */
export function automaticAgentName(label: string, at: Date, withSeconds = false): string {
  const clock = `${at.getHours()}:${pad(at.getMinutes())}${withSeconds ? `:${pad(at.getSeconds())}` : ''}`
  return `${label.trim() || 'Agent'} harness ${at.getMonth() + 1}-${at.getDate()} ${clock}`
}

/**
 * A name Harness gave, as opposed to one somebody chose: `<agent> harness M-D HH:MM[:SS]`, or the
 * `harness-N` / `agent-N` of earlier daemons. Only these give way to the engine's session title.
 */
const AUTOMATIC_NAME_RE = /^(?:(?:harness|agent)-[1-9]\d*|.+ harness \d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?)$/

export function isAutomaticName(name: string | null | undefined): boolean {
  return !!name && AUTOMATIC_NAME_RE.test(name)
}

/** "codex-2026-09-03-09-05": the label in lowercase words, then the local date and time, every part
 *  two digits so a folder listing sorts in the order the harnesses were made. */
export function projectFolderName(label: string, at: Date, withSeconds = false): string {
  const slug = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'harness'
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}${withSeconds ? `-${pad(at.getSeconds())}` : ''}`
  return `${slug}-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${time}`
}

/** Two plain words for a branch nothing has named yet — plumbing, like the worktree's folder: the
 *  agent or the person names the real branch when there is something to push. Mirrors
 *  desktop/lib/core/git_worktree.dart. */
export const PLACEHOLDER_ADJECTIVES = [
  'amber', 'bold', 'brave', 'brisk', 'calm', 'clever', 'cosmic', 'crisp', 'dapper', 'eager', 'fancy', 'gentle',
  'glad', 'golden', 'happy', 'hidden', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'merry', 'misty', 'noble',
  'polite', 'proud', 'quick', 'quiet', 'rapid', 'rosy', 'royal', 'rustic', 'shiny', 'silent', 'silver', 'sleek',
  'smart', 'snowy', 'solar', 'spry', 'steady', 'sunny', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty',
] as const
export const PLACEHOLDER_NOUNS = [
  'badger', 'beacon', 'birch', 'bison', 'canyon', 'cedar', 'comet', 'coral', 'crane', 'delta', 'falcon', 'fern',
  'finch', 'fjord', 'fox', 'gecko', 'glacier', 'harbor', 'hawk', 'heron', 'ibis', 'island', 'koala', 'lagoon',
  'lark', 'lynx', 'maple', 'meadow', 'meteor', 'moose', 'nebula', 'otter', 'owl', 'panda', 'pebble', 'pine',
  'puffin', 'quartz', 'raven', 'reef', 'river', 'robin', 'sparrow', 'spruce', 'tiger', 'walrus', 'willow', 'zebra',
] as const

/** `harness/brave-otter`: a branch name none of `taken` (branch names, with or without
 *  `refs/heads/`) already uses. */
export function placeholderBranch(taken: Iterable<string>, pick = (n: number) => Math.floor(Math.random() * n)): string {
  const names = new Set([...taken].map(name => name.replace(/^refs\/heads\//, '')))
  const draw = () => `harness/${PLACEHOLDER_ADJECTIVES[pick(PLACEHOLDER_ADJECTIVES.length)]}-${PLACEHOLDER_NOUNS[pick(PLACEHOLDER_NOUNS.length)]}`
  let name = draw()
  for (let tries = 0; tries < 16 && names.has(name); tries++) name = draw()
  const base = name
  for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`
  return name
}

/** The folder a worktree on `branch` is checked out in, under its repository: the branch without
 *  Harness's prefix, `/` as `-`. Nobody needs to see it. */
export function worktreeFolderName(branch: string): string {
  const name = branch.replace(/^harness\//, '').replaceAll('/', '-').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[.-]+/, '')
  return name ? name.slice(0, 64) : 'worktree'
}

/** A name Git might accept for a new branch, checked before Git is asked. */
export function plausibleBranchName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !name.startsWith('-')
    && !/[\x00-\x20\x7f~^:?*[\\]/.test(name)
}

/** The folder for a project somebody named: their words with spaces as dashes and nothing a path or
 *  a shell reads specially. Null when nothing usable is left. Mirrors `projectFolderSlug` in
 *  desktop/lib/core/project_folder.dart. */
export function projectFolderSlug(name: string): string | null {
  const slug = name.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[.-]+|[.-]+$/g, '')
  return slug ? slug.slice(0, 64) : null
}
