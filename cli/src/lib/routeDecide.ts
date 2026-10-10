/**
 * Where a typed task goes, decided without asking the person (docs/design/2026-10-09-auto-router.md).
 *
 * Jev 1.13, through OpenRouter (~0.6 s), is asked once: which session the task is for (or none — new
 * work), and, for new work, which project and which agent. Its pick is taken at JEV_SURE_P or more, or when
 * it still leads clearly (`jevPick`); otherwise Jev is unsure and the task is new work. A project or agent
 * Jev is unsure of is left to the caller, which uses the pane the person is in.
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
  /** How long ago a stopped session was last active; absent for a live one. Sending to it resumes it. */
  stoppedAgoMs?: number
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
/** At this or more Jev is sure. */
export const JEV_SURE_P = 0.6
/**
 * Below JEV_SURE_P, a session is still picked when it leads clearly: JEV_LEAD_P or more, and JEV_LEAD_RATIO
 * times the next option, "new" included — over JEV_LEAD_OPTIONS options or more. Jev's numbers are spread
 * over every session it is shown, so a right answer among forty can read 0.45. On the owner's desk
 * (2026-10-10) every task that missed its session did so this way, Jev's top pick right at 0.45 and 0.57;
 * on the 43-prompt benchmark a lower bar added only right sends. The lead keeps what the bar was for: a pick
 * torn with new work, or with a second session much like it, is still new work, which costs a harness,
 * never a wrong conversation. Over a few options there is no spread to excuse — 0.4 of four is 0.6
 * somewhere else — so the bar stands there, and for the project and the agent, where the pane the person
 * is in is the fallback.
 */
export const JEV_LEAD_P = 0.4
export const JEV_LEAD_RATIO = 2
export const JEV_LEAD_OPTIONS = 6

/** The likeliest of [options] other than [choice], for the log: how far ahead the pick was. */
function runnerUp(p: Record<string, number>, choice: string, options: string[]): string | undefined {
  return options.filter((id) => id !== choice && typeof p[id] === 'number').sort((a, b) => p[b] - p[a])[0]
}

/** Jev's pick when it is a whole answer over exactly [options] and Jev is sure of it, or, with [lead], when
 *  it leads clearly over enough options. */
export function jevPick(answer: JevChoiceAnswer | undefined, options: string[], lead = false): string | undefined {
  const p = answer?.probabilities
  if (!answer || !p || !options.includes(answer.choice)) return undefined
  if (options.some((id) => typeof p[id] !== 'number' || !Number.isFinite(p[id]))) return undefined
  const top = p[answer.choice]
  if (top >= JEV_SURE_P) return answer.choice
  if (!lead || options.length < JEV_LEAD_OPTIONS) return undefined
  const next = runnerUp(p, answer.choice, options)
  return top >= JEV_LEAD_P && top >= JEV_LEAD_RATIO * (next === undefined ? 0 : p[next]) ? answer.choice : undefined
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

/** "3 days", "5 hours", "20 minutes": how long ago, as a person says it. */
function ago(ms: number): string {
  const [n, unit] = ms >= 2 * 86_400_000 ? [Math.round(ms / 86_400_000), 'day'] : ms >= 2 * 3_600_000 ? [Math.round(ms / 3_600_000), 'hour'] : [Math.max(1, Math.round(ms / 60_000)), 'minute']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** A session as Jev reads it: its name, whether it is stopped, the person's last prompt and what its last
 *  turns were about. */
function describe(session: RouteSession): string {
  return label([
    session.name,
    session.stoppedAgoMs === undefined ? '' : `stopped, last active ${ago(session.stoppedAgoMs)} ago`,
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
  const targets = [...sessions.map((_, i) => `s${i}`), 'new']
  const name = (id: string | undefined): string | undefined => id === 'new' ? 'new' : sessions[Number(id?.slice(1))]?.name
  const odds = (id: string): string => (said!.probabilities[id] ?? 0).toFixed(2)
  const next = said ? runnerUp(said.probabilities, said.choice, targets) : undefined
  // The runner-up too: whether a pick led clearly is what the next change to the bar is measured from.
  trace.push(`jev: ${said ? `"${name(said.choice) ?? said.choice}" ${odds(said.choice)}${next ? `, then "${name(next)}" ${odds(next)}` : ''}` : 'no answer'}`)

  const target = jevPick(said, targets, true)
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
