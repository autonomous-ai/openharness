/**
 * Proves, before a pass, what Claude Code's skill listing gave the model in a condition: the dial's line, the crowd's
 * lines, the listing's length, and whether project instructions reached it: the staged CLAUDE.md, and none in clean.
 * Only Claude Code's saved transcript holds the listing; the stream names the skills alone.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIAL_SKILL_DESCRIPTION } from '../../../src/devices/dialSkill.js'
import { claudeArgs, isDefaultProfile, spawnGroup, type AgentConfig, type Exit } from './agents.js'
import { parseClaudeStream, type RunResult, type Usage } from './parse.js'
import type { Condition, Scenario } from './scenarios.js'
import { runProfileFolder, stage, unstage, type StagedSkill, type StageOptions, type Staged } from './stage.js'

export type DialListing = 'full' | 'name-only' | 'cut' | 'absent'
export interface Listing { dial: DialListing; skills: number; cut: number; chars: number }

export const PROBE_PROMPT = 'Do not use any tool. Reply with the first line of the CLAUDE.md project instructions you were given, exactly, or NONE if you were given none.'
/** The measured median listing is 21,141 characters; the crowd's whole listing stays under it, half the 40,000 budget. */
export const CROWD_LISTING_MAX = 20_000
/** A probe is one turn with no tool: it never needs a run's share of --timeout-s. */
export const PROBE_TIMEOUT_MS = 120_000

/** Counts, fixed words and the init only: a probe row is committed as written, so it holds no path and no model text. */
export interface Probe {
  condition: Condition
  at: string
  listing: Listing | null
  /** Whether the model was given project instructions: where a CLAUDE.md was staged, whether it quoted its first line;
   *  in clean, where none was, whether it answered anything but NONE. Null when the probe got no answer. */
  instructions: boolean | null
  skills: string[]
  claude_version: string | null
  model: string | null
  usage: Usage
  failure: string | null
}

/** The first initial `skill_listing` attachment of a saved transcript, or null when it holds none. */
export function readListing(transcript: string, staged: StagedSkill[]): Listing | null {
  for (const line of transcript.split('\n')) {
    let event: { type?: unknown; attachment?: Record<string, unknown> }
    try {
      event = JSON.parse(line)
    } catch {
      // An empty line, or the last one torn by a probe killed mid-write.
      continue
    }
    const a = event.attachment
    if (event.type !== 'attachment' || a?.type !== 'skill_listing' || a.isInitial !== true || typeof a.content !== 'string') continue
    const lines = new Set(a.content.split('\n'))
    const dial = lines.has(`- dial: ${DIAL_SKILL_DESCRIPTION}`) ? 'full'
      : lines.has('- dial') ? 'name-only'
      : [...lines].some((l) => l.startsWith('- dial: ')) ? 'cut'
      : 'absent'
    const cut = staged.filter((s) => s.name !== 'dial' && !lines.has(`- ${s.name}: ${s.description}`)).length
    return { dial, skills: typeof a.skillCount === 'number' ? a.skillCount : 0, cut, chars: a.content.length }
  }
  return null
}

/** The probe's session is saved, unlike a run's: the listing is only in the transcript. One turn holds one short answer
 *  in the person's profile for seconds, and unstage removes it. */
export function probeArgs(cfg: Omit<AgentConfig, 'timeoutMs'>, st: Pick<Staged, 'root' | 'origin' | 'condition'>): string[] {
  return claudeArgs({ ...cfg, maxTurns: 1 }, st, PROBE_PROMPT).filter((arg) => arg !== '--no-session-persistence')
}

/** Why the listing does not hold what the condition gives the model, or null when it does. */
export function probeFailure(p: Omit<Probe, 'failure'>, condition: Condition, skill: boolean): string | null {
  if (p.listing === null) return 'no skill listing'
  const expected: DialListing = !skill ? 'absent' : condition === 'name-only' ? 'name-only' : 'full'
  if (p.listing.dial !== expected) return `dial ${p.listing.dial}, expected ${expected}`
  if (p.listing.cut > 0) return `${p.listing.cut} crowd skill${p.listing.cut === 1 ? '' : 's'} cut`
  if (condition !== 'clean' && p.listing.chars > CROWD_LISTING_MAX) return 'listing over 20,000 characters'
  if (condition === 'clean' && p.instructions === true) return 'project instructions given'
  if (condition !== 'clean' && p.instructions === false) return 'CLAUDE.md not given'
  return null
}

/** Runs one probe staged exactly as the condition's runs, and reads its listing before unstage removes the session. */
export async function probeListing(s: Scenario, condition: Condition, opts: StageOptions, cfg: AgentConfig): Promise<Probe> {
  const profile = process.env.CLAUDE_CONFIG_DIR
  // The saved session would land in the person's default profile.
  if (!profile || isDefaultProfile(profile)) throw new Error('CLAUDE_CONFIG_DIR must name the session profile, not the default ~/.claude')
  if (!cfg.claudeBin) throw new Error('claude was not found on PATH when the eval started')
  const st = stage(s, 'claude', { ...opts, condition })
  try {
    const claudeMd = join(st.repo, 'CLAUDE.md')
    const rules = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8').split('\n')[0] : null
    const timeoutMs = cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, PROBE_TIMEOUT_MS) : PROBE_TIMEOUT_MS
    const base: Omit<Probe, 'failure'> = {
      condition, at: new Date().toISOString(), listing: null, instructions: null, skills: [], claude_version: null, model: null, usage: { input_tokens: 0, output_tokens: 0 },
    }
    let exit: Exit
    let run: RunResult
    try {
      exit = await spawnGroup(cfg.claudeBin, probeArgs(cfg, st), st, timeoutMs)
      run = parseClaudeStream(exit.stdout)
    } catch {
      // Its class only: the message may name the run root or quote the model.
      return { ...base, failure: 'error' }
    }
    // A transcript that cannot be read fails the probe below, which keeps what the stream says it was billed.
    let transcript: string | null
    try {
      transcript = transcriptOf(st, run.init?.session_id ?? null)
    } catch {
      transcript = null
    }
    const p: Omit<Probe, 'failure'> = {
      ...base,
      listing: transcript === null ? null : readListing(transcript, st.skills),
      instructions: rules === null ? run.answer.trim() !== 'NONE' : run.answer.includes(rules),
      skills: run.init?.skills ?? [],
      claude_version: run.init?.claude_version ?? null,
      model: run.model,
      usage: run.usage,
    }
    if (exit.timedOut) return { ...p, failure: 'timeout' }
    // As a run's: the account limit stops the pass, and the probe was billed for what it did.
    if (run.limited) {
      throw Object.assign(new Error('the Claude account limit is reached'), { failure_class: 'account_limited', model: run.model, usage: run.usage })
    }
    // Its class only, for the transcript too: the read error's message names the profile.
    if ((exit.code !== 0 && run.status !== 'truncated') || transcript === null) return { ...p, failure: 'error' }
    return { ...p, failure: probeFailure(p, condition, opts.skill) }
  } finally {
    unstage(st)
  }
}

function transcriptOf(st: Staged, sessionId: string | null): string {
  const folder = runProfileFolder(st)
  if (folder === null || sessionId === null) return ''
  try {
    return readFileSync(join(folder, `${sessionId}.jsonl`), 'utf8')
  } catch (error) {
    // A probe stopped before Claude Code saved its session has no listing to read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Whether a run started with its probe's listing. The listing follows the staged skills, the Claude Code version and
 *  the model, and with half the budget spare no usage ranking cuts it; a run is not saved to read its own (its
 *  transcript would sit where the live Harness daemon reads Claude sessions), so its init's skills and version stand
 *  in. */
export function matchesProbe(init: RunResult['init'], probe: Pick<Probe, 'skills' | 'claude_version'>): boolean {
  if (init === undefined || init.claude_version !== probe.claude_version) return false
  const skills = new Set(init.skills)
  return skills.size === new Set(probe.skills).size && probe.skills.every((name) => skills.has(name))
}
