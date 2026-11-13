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

/** Harness's own name on the lines it writes on GitHub with its PM's person's login. */
const HARNESS = 'Harness'
const sameName = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * The agent that signed [text], and the text after its signature, or null. Every agent of a person posts on GitHub with that
 * person's login and opens its comment with its name, so "deehw wrote: Devon: Lennox, …" named only the login Devon posts with
 * (anh Dee, 2026-11-12: each comment credited to the agent who wrote it). The forms agents and Harness write: "Devon: …",
 * "**Faye** (PM): …", and the older "Lennox, 16:52: …" and "Harness, 17:15, to **Kiri**: …", which stay on GitHub. A name
 * counts only when it is one of the Swarm's agents' ([names]) or Harness's: "Note: …" is no signature, nor is "Devon, can you
 * look?", how a person addresses an agent. The comment is a team login's already (githubRelaySchema's association).
 */
export function signedBy(text: string, names: readonly string[]): { name: string; text: string } | null {
  const found = /^\s*\**([^:,(*\n]{1,60}?)\**\s*(?:\([^)\n]{1,40}\)\s*)?(?:,\s*\d{1,2}:\d{2}\s*(?:,\s*to\s+\**[^:*\n]{1,60}\**\s*)?)?:\s*/.exec(text)
  if (!found) return null
  const key = sameName(found[1]!), name = [...names, HARNESS].find(known => sameName(known) === key), rest = text.slice(found[0].length).trim()
  return name && key && rest ? { name, text: rest } : null
}

/** The row's words, which its agent reads; a Desktop that meets a server before this one draws a card from its source. Who
 *  wrote is the agent of [names], the Swarm's, that signed the comment, with its signature left out; else its GitHub login. */
export function relayText(command: GitHubRelay, names: readonly string[] = []): string {
  const where = `${command.on === 'pull' ? 'pull request' : 'issue'} ${command.repository}#${command.number}`
  const signed = command.event === 'task' ? null : signedBy(command.text, names)
  const who = signed?.name ?? command.login
  const head = command.event === 'task' ? `New task for you on GitHub: ${where} ${command.text}`
    : command.event === 'review' ? `On GitHub, ${who} reviewed ${where}: ${VERDICTS[command.verdict!]}`
    : command.event === 'review-comment' ? `On GitHub, ${who} commented on ${command.path}${command.line ? ` line ${command.line}` : ''} in ${where}:`
    : `On GitHub, ${who} wrote on ${where}:`
  return command.event === 'task' ? `${head}\n${command.url}` : `${head}\n${signed?.text ?? command.text}\n${command.url}`
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
    // Never the agent it is for: its own posts are not relayed to it (cli githubMentions.ts), so its name first is someone
    // addressing it ("Pip: add a test for day 0.").
    text: relayText(command, state.agents.filter(one => one.id !== target.id).map(one => one.displayName ?? one.name)),
    source: { kind: GITHUB_SOURCE, event: command.event, on: command.on, repository: command.repository, number: command.number, url: command.url,
      login: command.login, association: command.association, ...(command.verdict ? { verdict: command.verdict } : {}),
      ...(command.path ? { path: command.path } : {}), ...(command.line !== undefined ? { line: command.line } : {}) } })
}
