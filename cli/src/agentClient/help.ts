/**
 * `harness help agents`: all an agent needs on one screen (docs/design/2026-10-15-agent-experience.md, part 4). Each
 * verb's line is its own usage's first line, so this cannot name an option the verb does not take.
 */
import { CLOSE_USAGE, EXIT, PS_USAGE, SHOW_USAGE, SPAWN_LIMITS, TELL_USAGE, WAIT_USAGE, WATCH_USAGE, WHOAMI_USAGE } from './commands.js'
import { NEW_USAGE } from '../lib/newCommand.js'
import { SEND_USAGE } from '../messages/command.js'
import { outsideCaller } from './model.js'
import { PERSON_SAID_YES } from '../lib/agentSettings.js'

const synopsis = (usage: string): string => usage.split('\n')[0].replace(/^Usage: /, '')
const sendLine = (): string => (SEND_USAGE.split('\n').find((l) => l.includes('harness send <name>[,<name>]')) ?? '').trim().split(/\s{2,}/)[0]

export function agentsHelp(): string {
  return [
    'Harness for agents: start other agents, wait for them, read their answers, close them,',
    'on this computer or another of the person\'s machines (--machine <machine>).',
    'Every harness spends the person\'s tokens: start one only for work that runs beside yours,',
    'needs another model\'s view, or takes long. Do quick work yourself.',
    '',
    `First:  ${synopsis(WHOAMI_USAGE)}   who you are here, and whether you may start harnesses`,
    `Then:   ${synopsis(PS_USAGE)}`,
    `        ${synopsis(NEW_USAGE)}`,
    `        ${synopsis(WAIT_USAGE)}`,
    `        ${synopsis(SHOW_USAGE)}`,
    `        ${synopsis(WATCH_USAGE)}   a line each time it changes, for a program that follows it`,
    `        ${synopsis(CLOSE_USAGE)}`,
    `        ${synopsis(TELL_USAGE)}   more work for one you started, while the person allows it`,
    `        ${sendLine()}`,
    '',
    'A whole job:',
    '  harness new <agent> --name <name> <project> -- <task>',
    '  harness wait <name>',
    '  harness show <name>',
    '  harness close <name>',
    'Most commands end with Next: the command to run next. --json gives it as "next".',
    '',
    'States: working, idle, needs the person, installing, starting, stopped, gone, closed, failed.',
    `Exit codes: ${EXIT.ok} done · ${EXIT.failed} failed · ${EXIT.usage} wrong command · ${EXIT.needsInput} needs the person · `
      + `${EXIT.stopped} stopped or gone · ${EXIT.refused} refused (do not retry) · ${EXIT.timeout} still working when the wait ended.`,
    `Limits: ${SPAWN_LIMITS.livePerHarness} of yours open at once, ${SPAWN_LIMITS.perWindow} starts in ${SPAWN_LIMITS.windowMs / 60_000} minutes;`,
    'a harness another agent started may not start harnesses.',
    'Rules: name every harness. Put the whole task in it: more work later goes only by harness tell.',
    'A setting that refuses you is the person\'s to give: ask them with your tool for asking them',
    '(Claude Code: AskUserQuestion; Codex: request_user_input) or in your reply, and only after their yes run',
    `harness settings <name> on ${PERSON_SAID_YES}. Never answer it for them.`,
    'Close what you started once you have its answer. Never close one you did not start.',
    'When a harness needs the person, tell the person: only they answer it.',
    'Never ask a harness to publish, deploy, delete or push.',
    '',
    'More: https://harness.autonomous.ai/agents',
  ].join('\n')
}

/** `harness --help`: a line for agents first; an agent asking (by what its shell sets) gets its own help before the rest. */
export function helpFor(env: NodeJS.ProcessEnv, full: string): string {
  return outsideCaller(env, '') ? `${agentsHelp()}\n\n${full}` : `An agent? Run: harness help agents\n${full}`
}
