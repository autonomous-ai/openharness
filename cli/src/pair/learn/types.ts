/**
 * Learning (L1), the shapes every step shares (daemons/LEARNING.md): notice → propose → teach → revert.
 *
 *   signals.ts  notices a REAL signal in what the daemon already sees (a correction, the same failure on two
 *               harnesses, the same steps three times). Default: nothing.
 *   distill.ts  turns one signal into at most ONE candidate lesson, guarded (guard.ts). Default: nothing.
 *   store.ts    keeps lessons in a git-backed folder outside any repo: pending, approved, reverted.
 *   propose.ts  says one line for a pending lesson and acts on the person's key; the `lessons` verbs.
 *   publish.ts  teaches an approved lesson: skills through the Store runtime path, notes into an existing
 *               AGENTS.md/CLAUDE.md block.
 *
 * L2 (pair.jsonc `learn`, off by default except usage):
 *   borrow.ts   reads what Hermes, Claude Code and Codex learned on their own, read-only, as candidates.
 *   usage.ts    notices a session reading a lesson's SKILL.md: when each was last used.
 *   curate.ts   once a day, when idle: unused for 30 days is stale, for 90 archived (restore brings it back).
 *   export.ts   approved skills also written to ~/.agents/skills and ~/.claude/skills, marked as Harness's.
 */
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'

export type SignalKind = 'correction' | 'repeat-failure' | 'repeat-steps' | 'borrowed' | 'conversation'

/** Where a signal came from. The project is a hash: the store never keeps a folder path. */
export interface Provenance {
  engine: string
  /** The machine's name as the person knows it. */
  machine: string
  agentId: string
  session: string
  /** The turn's number in that session, as this daemon counted it. */
  turn: number
  project: string | null
  at: number
  /** A readable source conversation title, never a transcript path. */
  title?: string
}

export interface Signal {
  kind: SignalKind
  /** What was noticed, stably: the same thing noticed again has the same key. */
  key: string
  project: string | null
  /** The project's folder name, for words ("in api"). Never a path. */
  projectName: string | null
  from: Provenance[]
  /** Trimmed, redacted, stripped of instructions to a model. Still untrusted. */
  evidence: string[]
  at: number
  /** Why an explicit conversation review proposed this lesson. */
  reason?: string
  /** repeat-failure: what failed. */
  failure?: { what: 'test' | 'command'; name: string }
  /** repeat-steps: the steps, in order. */
  steps?: string[]
  /** correction: the person's words, and what the agent did just before. */
  correction?: { said: string; before: string[] }
  /** borrowed: the engine whose own store it came from, and where in it (relative, never a home path). */
  borrowed?: { engine: string; source: string }
}

export type Lesson =
  | { kind: 'skill'; name: string; description: string; body: string }
  | { kind: 'note'; lines: string[] }

/** A project's folder, as the store keeps it: a hash, never the path. */
export function projectHash(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
}

/** The folder's own name, printable and short — `api`, never `/Users/someone/code/api`. */
export function projectName(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const name = basename(resolve(cwd)).replace(/[^\w.@+-]+/g, '-').slice(0, 40)
  return name || null
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}
