/**
 * The leaderboard read's response (`GET /api/super-tabs/:tabId/leaderboard?projectId=&week=`), the `data` of the usual
 * envelope. Desktop/web (`desktop/lib/super_tabs/leaderboard`) mirror it by hand. Times are epoch milliseconds; people are
 * member ids, which clients name from the members they already read. No text from any conversation is ever in it.
 */
export type Medal = 'gold' | 'silver' | 'bronze'

export interface PersonScore {
  personId: string
  points: number
  /** 1 for the most points; people with the same points share a rank. */
  rank: number
  /** For the top three ranks with points; null otherwise. */
  medal: Medal | null
  shipped: { count: number; medianAskToShipMs: number | null }
  /** `agentMs`: the agent time the answers freed; `medianAnswerMs`: how long an item waited for the person's answer. */
  unblocked: { count: number; agentMs: number; medianAnswerMs: number | null }
  /** Machines that ran Swarm agents this week, and the agent time they ran. */
  lent: { machines: number; agentMs: number }
  /** Days in a row, up to today, with a shipped request. */
  streakDays: number
}

export interface WeekGoal { shipped: number; points: number; medianAskToShipMs: number | null }

/** A week's attempts at requests (never reviews) and how many ran on a model served on the Swarm's grid; of those whose
 *  work had a review verdict, how many passed the first one, grid and subscription apart (roadmap, Dec: about 30% of work on
 *  cheaper models without lower quality). */
export interface ModelShare { attempts: number; grid: number; reviewed: { grid: number; subscription: number }; passedFirst: { grid: number; subscription: number } }

export interface Leaderboard {
  projectId: string
  week: number
  /** The team's goal: everyone's points count toward it. */
  goal: { openRequests: number; thisWeek: WeekGoal; lastWeek: WeekGoal }
  /** Every person who reads the project, most points first. */
  people: PersonScore[]
  /** Agents waiting on a person now: how many per person, in name order. Never ranked, never in the points. */
  waiting: { total: number; people: Array<{ personId: string; count: number; conversationIds: string[] }> }
  /** Absent from a backend before it. */
  models: { thisWeek: ModelShare; lastWeek: ModelShare }
}
