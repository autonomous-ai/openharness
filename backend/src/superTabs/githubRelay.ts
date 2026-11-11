/**
 * What GitHub said to a Swarm v4 agent, in its chat with its person (anh Dee, 2026-11-09: "why can't it be built into the
 * product?").
 *
 * A v4 team's tasks are its repository's GitHub issues, and its agents answer each other there: a review's READ-OK, a
 * question, a new task labelled builder:<name>. Its person's own Harness reads GitHub with their own gh login (cli
 * superTabs/githubMentions.ts) and relays here each comment that names one of their agents and each issue newly labelled
 * for one. The row is the person's, since their daemon read it as them, and says it came from GitHub: their agent hears it
 * as it hears any message in its chat. Only the agent reads it (model.ts NOTICE_READERS): the person's chat with their
 * agent is their conversation, not a feed of GitHub's (anh Dee, 2026-11-11).
 */
import { z } from 'zod'
import { agent, author, conversation, fail, type Actor, type MessageDraft, type SuperTabState } from './model.js'
import { isAgentChat } from './projects.js'

/** The repository's people, who alone may speak to an agent through GitHub: anyone may comment on a public repository. */
export const GITHUB_TEAM = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const
/** A comment is relayed whole up to this, then cut: a longer one is read on GitHub through its link. */
export const GITHUB_RELAY_TEXT_MAX = 4_000
export const GITHUB_SOURCE = 'github'

const slug = z.string().max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
export const githubRelaySchema = z.object({
  type: z.literal('github.relay'),
  conversationId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  agentId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  // What happened: a comment that names the agent, on an issue or a pull request's conversation; a pull request review
  // that names it, with its verdict; a review comment on a line of code that names it; or an issue newly labelled
  // builder:<name>, a task for it (the same label on a pull request is the agent's own work, and is never relayed).
  event: z.enum(['comment', 'review', 'review-comment', 'task']),
  on: z.enum(['issue', 'pull']),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']).optional(),
  path: z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  line: z.number().int().min(1).max(10_000_000).optional(),
  repository: slug,
  number: z.number().int().min(1).max(1_000_000_000),
  url: z.string().max(500),
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  association: z.enum(GITHUB_TEAM),
  // The comment's words, or the issue's title for a task.
  text: z.string().trim().min(1).max(GITHUB_RELAY_TEXT_MAX),
}).strict()
export type GitHubRelay = z.infer<typeof githubRelaySchema>

const VERDICTS = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented' } as const

/** The row's words, which its agent reads; a Desktop that meets a server before this one draws a card from its source. */
export function relayText(command: GitHubRelay): string {
  const where = `${command.on === 'pull' ? 'pull request' : 'issue'} ${command.repository}#${command.number}`
  const head = command.event === 'task' ? `New task for you on GitHub: ${where} ${command.text}`
    : command.event === 'review' ? `On GitHub, ${command.login} reviewed ${where}: ${VERDICTS[command.verdict!]}`
    : command.event === 'review-comment' ? `On GitHub, ${command.login} commented on ${command.path}${command.line ? ` line ${command.line}` : ''} in ${where}:`
    : `On GitHub, ${command.login} wrote on ${where}:`
  return command.event === 'task' ? `${head}\n${command.url}` : `${head}\n${command.text}\n${command.url}`
}

/** Each kind with what it needs and nothing it cannot have: a task is an issue's; a review has a verdict; a line's comment a file. */
function wellFormed(command: GitHubRelay): boolean {
  if (command.event === 'task') return command.on === 'issue' && !command.verdict && !command.path && command.line === undefined
  if (command.event === 'review') return command.on === 'pull' && !!command.verdict && !command.path && command.line === undefined
  if (command.event === 'review-comment') return command.on === 'pull' && !command.verdict && !!command.path
  return !command.verdict && !command.path && command.line === undefined
}

/** Writes [command] into its person's chat with their own agent, to that agent: refused for anyone else's chat or agent. */
export function relayGitHub(state: SuperTabState, actor: Actor, command: GitHubRelay, operationId: string, messages: MessageDraft[]): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Only a person\'s own Harness relays GitHub to their agents.', 403)
  const chat = conversation(state, command.conversationId)
  const owner = chat.audience?.people[0]
  // Not this person's chat with one of their own agents: answered as a chat that is not there, so nothing is learnt of it.
  if (!isAgentChat(chat) || chat.archived || owner?.id !== actor.userId || !chat.agentIds.includes(command.agentId)
    || !state.people.some(p => p.id === owner.id && p.generation === owner.generation)) {
    fail('NOT_FOUND', 'This conversation is unavailable.', 404)
  }
  const target = agent(state, command.agentId)
  if (target.contributorId !== actor.userId) fail('NOT_FOUND', 'This conversation is unavailable.', 404)
  if (!wellFormed(command)) fail('VALIDATION_ERROR', 'Relay one GitHub comment, review, line comment or task as it came.', 400)
  // Only a link into the repository it names: the card opens it.
  if (!command.url.startsWith(`https://github.com/${command.repository}/`)) fail('VALIDATION_ERROR', 'Link to the comment or issue on GitHub.', 400)
  messages.push({ id: operationId, conversationId: chat.id, author: author(state, actor), replyTo: null, recipients: [target.id],
    text: relayText(command),
    source: { kind: GITHUB_SOURCE, event: command.event, on: command.on, repository: command.repository, number: command.number, url: command.url,
      login: command.login, association: command.association, ...(command.verdict ? { verdict: command.verdict } : {}),
      ...(command.path ? { path: command.path } : {}), ...(command.line !== undefined ? { line: command.line } : {}) } })
}
