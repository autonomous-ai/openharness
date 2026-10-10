/**
 * Where a typed task goes, decided without asking the person (docs/design/2026-10-09-auto-router.md).
 *
 * Jev 1.13, through OpenRouter (~0.6 s), is asked once: which session the task is for (or none — new
 * work), and, for new work, which project and which agent. Its pick is taken at JEV_SURE_P or more; below
 * that Jev is unsure and the task is new work. A project or agent Jev is unsure of is left to the caller,
 * which uses the pane the person is in.
 *
 * Jev alone, owner's call 2026-10-10. It started as a ladder with julia-1, a local model, deciding first:
 * every task sent to a wrong session — on the benchmark and on the owner's desk ("how is lamp v2 going"
 * to "Catch up on lamp GTM") — was julia-1's, and Jev's alone sent none.
 *
 * The send is instant — the owner chose no undo window — so the bar is the safety: a session is chosen
 * only on Jev's word, and everything else becomes new work, which costs a little and pollutes nobody's
 * conversation. When Jev cannot be asked at all, nothing is decided: the caller says so and acts on
 * nothing, rather than guessing.
 */
import type { JevChoice, JevChoiceAnswer, JevDecide } from './jev/jevClient.js'

export interface RouteSession {
  id: string
  name: string
  /** The person's last prompts to it, newest first. */
  asks: string[]
  /** Its last few turns, summarised, newest first: often the only place its topic is said. "ok, check
   *  again in 24 hours" names nothing, and neither did the newest summary; the two before it said
   *  "activation and repeat use" — which is what "what's d30 retention" is about. */
  about?: string
}
/** A project a new harness could start in; [id] is the caller's, handed back untouched. */
export interface RouteOption { id: string; name: string }

export interface RouteInput {
  text: string
  sessions: RouteSession[]
  projects: RouteOption[]
  agents: RouteOption[]
  /** The session the person's last routed task went to, and how long ago. */
  last?: { id: string; agoMs: number }
}

export type RouteVerdict = (
  | { kind: 'session'; id: string; p: number }
  | { kind: 'new'; project?: string; agent?: string; via: 'jev' | 'unsure'; why: string }
  /** Jev could not be asked: no key, no network, no credit. Nothing is decided. */
  | { kind: 'unavailable'; why: string }
) & {
  /** What Jev said, for the log: a wrong decision has to be explainable after the fact. */
  trace: string
}

export interface RouteDeps {
  jev?: JevDecide
  log?: (line: string) => void
}

/** The sessions, projects and agents Jev weighs, at most: a client sends its most recently active first. */
const JEV_OPTIONS = 40
const LABEL_CHARS = 600
/** A follow-up names nothing; who the person was just talking to is what Jev gets to go on. */
const CONTINUITY_MS = 10 * 60_000
/** Below this Jev is unsure, and the task is new work. */
export const JEV_SURE_P = 0.6

/** Jev's pick when it is a whole answer over exactly [options] and Jev gives it JEV_SURE_P or more. */
export function jevPick(answer: JevChoiceAnswer | undefined, options: string[]): string | undefined {
  const p = answer?.probabilities
  if (!answer || !p || !options.includes(answer.choice)) return undefined
  if (options.some((id) => typeof p[id] !== 'number' || !Number.isFinite(p[id]))) return undefined
  return p[answer.choice] >= JEV_SURE_P ? answer.choice : undefined
}

/** An error and what caused it: fetch's own message ("fetch failed") says nothing by itself. */
const why = (error: unknown): string => {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause
  return `${(error as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ''}`
}

const label = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= LABEL_CHARS ? clean : `${clean.slice(0, LABEL_CHARS - 1)}…`
}

/** A session as Jev reads it: its name, the person's last prompt and what its last turns were about. */
function describe(session: RouteSession): string {
  return label([
    session.name,
    session.asks[0] ? `asked: ${session.asks[0].slice(0, 120)}` : '',
    session.about ? `lately: ${session.about.slice(0, 420)}` : '',
  ].filter(Boolean).join(' — '))
}

/** [signal] stops the question when whoever asked has gone: Jev's answer would act on nothing. */
export async function decideRoute(input: RouteInput, deps: RouteDeps, signal?: AbortSignal): Promise<RouteVerdict> {
  const { text } = input
  const sessions = input.sessions.slice(0, JEV_OPTIONS)
  const projects = input.projects.slice(0, JEV_OPTIONS)
  const agents = input.agents.slice(0, JEV_OPTIONS)
  const trace: string[] = [`${sessions.length} sessions`]
  if (!deps.jev) return { kind: 'unavailable', why: 'Jev is not set up', trace: [...trace, 'jev: not set up'].join(' · ') }

  const questions: Record<string, JevChoice> = {
    target: {
      type: 'choice',
      // Worded as measured (docs/design/2026-10-09-auto-router.md): this framing — the person continuing
      // their own work — got 95% right against 85% for "which session should this message go to?", with
      // the same one wrong send.
      instructions: 'A person typed this message to continue their work. Which of their ongoing sessions is it for?',
      criteria: {
        ...Object.fromEntries(sessions.map((session, i) => [`s${i}`, describe(session)])),
        new: 'None of them: it starts new, unrelated work',
      },
    },
  }
  if (projects.length > 1) {
    questions.project = {
      type: 'choice',
      instructions: 'If this becomes new work, which project folder does it belong in?',
      criteria: Object.fromEntries(projects.map((project, i) => [`p${i}`, label(project.name)])),
    }
  }
  if (agents.length > 1) {
    questions.agent = {
      type: 'choice',
      instructions: 'Which agent is best suited to do this work?',
      criteria: Object.fromEntries(agents.map((agent, i) => [`a${i}`, label(agent.name)])),
    }
  }
  const last = input.last && input.last.agoMs <= CONTINUITY_MS ? sessions.find((session) => session.id === input.last!.id) : undefined
  const state = last ? { message: text, previous_message_went_to: last.name } : { message: text }

  let answers: Awaited<ReturnType<JevDecide>>
  try {
    answers = await deps.jev(state, questions, signal)
  } catch (error) {
    deps.log?.(`jev could not answer: ${why(error)}`)
    return { kind: 'unavailable', why: (error as Error).message, trace: [...trace, 'jev: failed'].join(' · ') }
  }
  const said = answers.target
  const named = said?.choice === 'new' ? 'new' : sessions[Number(said?.choice?.slice(1))]?.name
  trace.push(`jev: ${said ? `"${named ?? said.choice}" ${(said.probabilities[said.choice] ?? 0).toFixed(2)}` : 'no answer'}`)

  const target = jevPick(said, [...sessions.map((_, i) => `s${i}`), 'new'])
  if (target && target !== 'new') {
    const session = sessions[Number(target.slice(1))]
    return { kind: 'session', id: session.id, p: said!.probabilities[target], trace: trace.join(' · ') }
  }

  const pick = (key: 'project' | 'agent', prefix: string, options: RouteOption[]): string | undefined => {
    const choice = jevPick(answers[key], options.map((_, i) => `${prefix}${i}`))
    return choice === undefined ? undefined : options[Number(choice.slice(prefix.length))].id
  }
  const project = pick('project', 'p', projects)
  const agent = pick('agent', 'a', agents)
  return {
    kind: 'new',
    ...(project ? { project } : {}),
    ...(agent ? { agent } : {}),
    via: target ? 'jev' : 'unsure',
    why: target ? 'Jev: new work' : 'Jev was not sure',
    trace: trace.join(' · '),
  }
}
