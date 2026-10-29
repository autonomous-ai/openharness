/**
 * `harness reply` to a harness in a pane (#1628; shape A of its design, #1873): more work for
 * an idle harness of the person's, from a program acting for them. The lamp hands a spoken request to Claude Code on
 * the person's computer, checks its answer, and when the check fails says so to the same conversation, as a person
 * would type it, instead of closing it and starting again with everything.
 *
 * A program is not an agent: `outsideCaller` (agentClient/model.ts) does not recognise it, and Harness reads it as the
 * person, as `harness reply` to a cloud harness already does. So this is the person's own reach, with three bounds of
 * its own: the person's switch (`programs-reply`, off by default; `agents-tell-agents` is about agents), only an idle
 * harness (one that waits on a question or a permission is the person's alone to answer), and the mailbox (mailbox.ts),
 * which types the words once the composer is free and never over a person's draft. The bounds are `tell`'s: its
 * length, its rate and its queue.
 *
 * Its messages are kept under the pseudo-tab `replied`, as `tell`'s are under `told`: no tab carries them.
 */
import { askThePersonFirst } from '../lib/agentSettings.js'

/** The tab id a replied message is kept under. No desk tab has it: ids there are the backend's. */
export const REPLIED_TAB = 'replied'

/** Who a replied message is from, in the ledger's `Told` lines and the message's sender: the person, not a harness. */
export const PERSON_AGENT_ID = 'person'

/** Said when the person has not allowed it: the program asks them, and starts a new harness if they say no. */
export const REPLY_OFF_TEXT = `Programs may not give more work to your harnesses yet. ${askThePersonFirst('programs-reply', 'start a new harness with the whole task.')}`

export interface ReplyRefusal { code: 'REPLY_OFF' | 'NOT_RUNNING' | 'NOT_IDLE'; message: string }

export interface ReplyCheck {
  /** The switch, as this machine keeps the account's experiments. */
  on: boolean
  /** Whether [agentId] is a live harness here. */
  live: boolean
  /** What it is doing, as this machine reads it (`core.agents.activity`). */
  activity: 'working' | 'idle' | 'unknown'
}

/** Why a program may not reply to a harness on this machine, or null. */
export function replyRefusal(check: ReplyCheck): ReplyRefusal | null {
  if (!check.on) return { code: 'REPLY_OFF', message: REPLY_OFF_TEXT }
  if (!check.live) return { code: 'NOT_RUNNING', message: 'That harness is no longer running: it was closed or stopped. Start a new harness with the whole task.' }
  // Working, it would get the words at its next tool call, inside work the person did not ask to change; unknown, it may
  // be waiting on a question or a permission, which only the person answers.
  if (check.activity !== 'idle') {
    return { code: 'NOT_IDLE', message: check.activity === 'working'
      ? 'That harness is working. Wait for it to finish (harness wait), then reply.'
      : 'That harness is not idle: it may be waiting for the person (a question or a permission). Only they answer that.' }
  }
  return null
}
