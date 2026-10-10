/**
 * Where a typed task goes, decided without asking the person (docs/design/2026-10-09-auto-router.md).
 *
 * Jev 1.13, through OpenRouter (~0.6 s), is asked once: which session the task is for (or none — new
 * work), whether the message names anything of its own, and, for new work, which project and which agent.
 * Its pick is taken at JEV_SURE_P or more, or when it still leads clearly (`jevPick`, `leadsLive`);
 * otherwise Jev is unsure and the task is new work. A message that names nothing ("merge it") goes where
 * the last one went, or nowhere; one that asks for a new session is new work. A project or agent Jev is
 * unsure of is left to the caller, which uses the pane the person is in.
 *
 * Hill-climbed on the owner's real desk (2026-10-10, 80 sessions on three machines, 390 labelled
 * messages, a red team's 116 written to break it, and 50 held out): from 63% right with 25 wrong sends in
 * 123 to 90% right with none in 202, 51% to 72% right with 66 to 6 in a red team's 232, and 83% with 4 in
 * 100 held out. What moved it, in order:
 * the sessions Jev is shown (live ones first, no stopped twins or empty leftovers, no pasted-text noise),
 * a question that asks for the same work on the same subject rather than shared words, and the check for
 * a message that names nothing. docs/design/2026-10-09-auto-router.md has the runs.
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
  /** The machine it runs on, as the person names it: "the lamp session on tropic". */
  machine?: string
  /** Its conversation: one conversation listed twice (a resume, a rename) is one session to Jev. */
  conversation?: string
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

/** The sessions, projects and agents Jev weighs, at most: a client sends its live sessions first, then its
 *  stopped ones, each most recently active first. More stopped sessions than this let in let old leftovers
 *  ("daemon refactoring", 53 hours stopped) take tasks that were new work: 7 wrong sends at 50, none at 40. */
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
/** A running session's lead over every other running session and new work. A stopped copy of the same work
 *  ("X Posts" 0.44 against the stopped "write an x post about the" 0.32) holds it back only within
 *  JEV_OVER_STOPPED: the person prefers what is running, but not on a coin flip. */
export const JEV_LIVE_RATIO = 1.75
export const JEV_OVER_STOPPED = 1.25

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
  // Six options or more: there is always one next.
  return top >= JEV_LEAD_P && top >= JEV_LEAD_RATIO * p[runnerUp(p, answer.choice, options)!] ? answer.choice : undefined
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

/** A prompt that is not the person's words: another agent's message, a question's reply, a bare image. */
const NOT_SAID = /^(another claude session sent a message|<agent-message|<send_user_message|<task-notification|\[image #\d+\]\s*$)/i
const tidy = (text: string): string => text.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
/** Words that name nothing: a prompt made only of these ("ok merge it", "cont", "allow") was bait — a
 *  message that echoed it ("merge it") went to that session, whatever it was about. */
const FILLER = new Set(("ok okay yes yeah yep no nope sure please pls thanks thank you ty cool great nice good looks look lgtm lfg " +
  "let lets let's go do it that this the a an and or but so to of on in for with is are was be can could would should will we " +
  "i you me my our continue cont keep going again now then just also all them merge merged ship push approve allow run retry " +
  "try fix go ahead done next proceed").split(' '))
const namesSomething = (text: string): boolean =>
  text.toLowerCase().replace(/[^\p{L}\p{N}#' ]+/gu, ' ').split(/\s+/).filter((word) => word.length > 1 && !FILLER.has(word)).length >= 2
/** The person's last prompt worth showing Jev: their own words, naming something. */
const lastAsk = (session: RouteSession): string | undefined =>
  session.asks.map(tidy).find((ask) => ask && !NOT_SAID.test(ask) && namesSomething(ask))

/** A session as Jev reads it: its name, its machine, whether it is stopped, the person's last prompt that
 *  names something and what its last turns were about. */
function describe(session: RouteSession): string {
  const ask = lastAsk(session)
  const about = tidy(session.about ?? '')
  return label([
    session.name,
    session.machine ? `on ${session.machine}` : '',
    session.stoppedAgoMs === undefined ? '' : `stopped, last active ${ago(session.stoppedAgoMs)} ago`,
    ask ? `asked: ${ask.slice(0, 120)}` : '',
    about ? `lately: ${about.slice(0, 420)}` : '',
  ].filter(Boolean).join(' — '))
}

/** The sessions Jev is shown, at most JEV_OPTIONS: live ones first, then stopped ones, each in the client's
 *  order. A conversation listed twice is shown once, live before stopped. A stopped session goes when a
 *  live one has its name (its older self) or a stopped one already does, or when it has nothing to read.
 *  On the owner's desk the live "X Posts" shared Jev's vote with three stopped copies of itself, and
 *  empty stopped leftovers took the places of live sessions: "Harness TUI" was not among the forty. */
export function offered(all: RouteSession[]): RouteSession[] {
  const live = all.filter((session) => session.stoppedAgoMs === undefined)
  const stopped = all.filter((session) => session.stoppedAgoMs !== undefined)
  const liveNames = new Set(live.map((session) => session.name.toLowerCase()))
  const conversations = new Set<string>()
  const stoppedNames = new Set<string>()
  const out: RouteSession[] = []
  for (const session of [...live, ...stopped]) {
    if (session.conversation) {
      if (conversations.has(session.conversation)) continue
      conversations.add(session.conversation)
    }
    if (session.stoppedAgoMs !== undefined) {
      const name = session.name.toLowerCase()
      if (liveNames.has(name) || stoppedNames.has(name)) continue
      if (!lastAsk(session) && !tidy(session.about ?? '')) continue
      stoppedNames.add(name)
    }
    out.push(session)
  }
  return out.slice(0, JEV_OPTIONS)
}

/** "start a new session and…", "open a fresh harness for…", "in a fresh session, …": what the person asked
 *  for, decided. A verb or "in" before it: "the new pane is broken" and "new session restore drops the cwd"
 *  are about a new pane and a new session, not asking for one. */
const ASKS_FOR_NEW = /\b(?:(?:start|open|spin up|make|create|launch|begin|use)\s+(?:an?\s+)?(?:new|fresh|separate|another|different)\s+(?:session|harness|chat|pane|conversation)|in\s+an?\s+(?:new|fresh|separate)\s+(?:session|harness|chat|conversation))\b/i

/** A running pick that leads every other running session, and new work, by JEV_LIVE_RATIO, and a stopped one
 *  by JEV_OVER_STOPPED. A running twin of its own name is a rival like any other: two "Untitled Pane"s at
 *  0.42 and 0.40 are a coin flip, not a lead. */
function leadsLive(answer: JevChoiceAnswer | undefined, sessions: RouteSession[], targets: string[]): string | undefined {
  const p = answer?.probabilities
  if (!answer || !p || answer.choice === 'new' || !targets.includes(answer.choice) || targets.length < JEV_LEAD_OPTIONS) return undefined
  // A missing or broken number compares false below: no lead.
  const top = sessions[Number(answer.choice.slice(1))]
  const pTop = p[answer.choice]
  if (top.stoppedAgoMs !== undefined || pTop < JEV_LEAD_P || targets.some((id) => p[id] > pTop)) return undefined
  const others = targets.filter((id) => id !== answer.choice)
  const stopped = (id: string) => id !== 'new' && sessions[Number(id.slice(1))].stoppedAgoMs !== undefined
  const most = (ids: string[]) => Math.max(0, ...ids.map((id) => p[id]))
  return pTop >= JEV_LIVE_RATIO * most(others.filter((id) => !stopped(id))) && pTop >= JEV_OVER_STOPPED * most(others.filter(stopped))
    ? answer.choice
    : undefined
}

/** [signal] stops the question when whoever asked has gone: Jev's answer would act on nothing. */
export async function decideRoute(input: RouteInput, deps: RouteDeps, signal?: AbortSignal): Promise<RouteVerdict> {
  const { text } = input
  const sessions = offered(input.sessions)
  const projects = input.projects.slice(0, JEV_OPTIONS)
  const agents = input.agents.slice(0, JEV_OPTIONS)
  const trace: string[] = [`${sessions.length} sessions`]
  if (!deps.jev) return { kind: 'unavailable', why: 'Jev is not set up', trace: [...trace, 'jev: not set up'].join(' · ') }

  // Where the last task went, minutes ago: found by its conversation when the session shown for it is its
  // live self or the one listed first (`offered` shows a conversation once).
  const sent = input.last && input.last.agoMs <= CONTINUITY_MS ? input.sessions.find((session) => session.id === input.last!.id) : undefined
  const last = sent && (sessions.includes(sent) ? sent : sent.conversation ? sessions.find((session) => session.conversation === sent.conversation) : undefined)
  const questions: Record<string, JevChoice> = {
    target: {
      type: 'choice',
      // Worded as measured. "Continue their work" let a message go wherever its words were last typed
      // ("merge it" to the session whose last prompt was "ok merge it"); "whose job is this kind of work"
      // sent the lamp's retention to Harness's usage session. Asking for the same work on the same subject,
      // and not for shared words, took a red team's 116 messages from 66 wrong sends in 232 to 16.
      instructions: 'A person typed this message into a box that either sends it to one of their ongoing sessions or starts a new one. ' +
        "Choose a session only when the message is clearly about that session's own work: it continues that work, or it is the same " +
        'kind of work on the same subject. Sharing a few words with a session is not enough. If the message names nothing to go on ' +
        '(like "merge it" or "continue"), asks for a new session, or is about another subject, choose none. Prefer a session that is ' +
        'still running over a stopped one, unless the message clearly continues the stopped one.' +
        (last ? ' Their previous message went to the session given as previous_message_went_to: a follow-up that names nothing new goes there too; a message about something else does not.' : ''),
      criteria: {
        ...Object.fromEntries(sessions.map((session, i) => [`s${i}`, describe(session)])),
        new: 'None of them: no session does this kind of work',
      },
    },
    // A message that names nothing of its own is decided here and not by the sessions' words: it goes where
    // the last one went, or it is new work. "A single word is enough" is what keeps "also check retention"
    // and "and the daemon?" from being taken for one ("say what it is about on its own" took them).
    topic: {
      type: 'choice',
      instructions: 'Does this message name anything of its own to work on or ask about? A single word is enough: "retention", "the daemon", "the round unit", "the tui".',
      criteria: {
        yes: 'Yes: it names a subject or task, even briefly and even when it starts with "also" or "and"',
        no: 'No: it is only words like "merge it", "do it", "ok merge", "what does that do", "post it as is", "continue", "take care of them all"',
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

  // Names nothing, on Jev's sure word: a yes or no at 0.5 is a coin flip, and a coin flip must not override
  // where the words point.
  const topic = answers.topic
  const noOdds = topic?.probabilities.no
  const topicless = topic?.choice === 'no' && typeof noOdds === 'number' && Number.isFinite(noOdds) && noOdds >= JEV_SURE_P
  const askedForNew = ASKS_FOR_NEW.test(text)
  const picked = jevPick(said, targets, true) ?? leadsLive(said, sessions, targets)
  const lastId = last ? `s${sessions.indexOf(last)}` : undefined
  // Names nothing, yet Jev is sure of another session than the last: the two disagree, and new work is safe.
  const torn = topicless && lastId !== undefined && picked !== undefined && picked !== 'new' && picked !== lastId
  if (topicless) trace.push(`names nothing: ${torn ? 'but Jev is sure of another session than the last' : last ? `to "${last.name}", where the last went` : 'nowhere to go'}`)
  if (askedForNew) trace.push('asked for a new session')
  const target = askedForNew ? 'new' : topicless ? (torn || !lastId ? 'new' : lastId) : picked
  if (target && target !== 'new') {
    const session = sessions[Number(target.slice(1))]
    return { kind: 'session', id: session.id, p: topicless ? noOdds! : said!.probabilities[target], trace: trace.join(' · ') }
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
    why: askedForNew ? 'asked for a new session' : torn ? 'names nothing, and Jev pointed elsewhere' : topicless ? 'names nothing, and no task went anywhere just now' : target ? 'Jev: new work' : 'Jev was not sure',
    trace: trace.join(' · '),
  }
}
