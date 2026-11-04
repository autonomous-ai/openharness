/** Member identities are separate from native session names and routing roles.
 * Allocate on the full state, before filtering private projects. Once assigned,
 * a name stays with that agent when its role, project or engine changes. */
export interface NamedAgent { id: string; name: string; displayName?: string }

const names = [
  'Atlas', 'Nova', 'Orion', 'Echo', 'Sage', 'Finn', 'Arlo', 'Iris',
  'Rowan', 'Mira', 'Theo', 'Luna', 'Jules', 'Remy', 'Avery', 'Kai',
  'Robin', 'Juno', 'Reed', 'Wren', 'Aster', 'Cleo', 'Ellis', 'Faye',
  'Hugo', 'Indigo', 'Jasper', 'Lark', 'Milo', 'Nico', 'Quinn', 'River',
]
const defaults = /^(?:lead|builder|agent|new agent|product manager|engineer|pm|dev)(?:[\s#-]+\d+)?$/i
/** A role's name, never a member's: an agent named so is given a member name instead (assignAgentDisplayNames). */
export const isRoleName = (name: string): boolean => defaults.test(name.trim())
const automatic = /^(?:claude|codex|pi|agent)-\d{4}-\d{2}-\d{2}(?:[-T].*)?$/i
/** The Reviewer role's name is no member's either (Dee, 2026-10-30: three "Reviewer" rows). Kept out of isRoleName, whose
 *  Buddy check reserves it on its own (buddies.ts BUDDY_RESERVED). */
const reviewer = /^reviewer(?:[\s#-]+\d+)?$/i
/** Whether [name] names a role or an automatic session rather than a member. */
const unnamed = (name: string): boolean => defaults.test(name) || reviewer.test(name) || automatic.test(name)

function chosen(agent: NamedAgent): string | undefined {
  // Every Reviewer kept "Reviewer" as its member name until 2026-10-30: that one stored name is given a real one.
  // Any other stored name stays, even one that reads like a role (a Buddy may be named so).
  const shown = agent.displayName?.trim()
  if (shown && !reviewer.test(shown)) return agent.displayName
  const name = agent.name.trim()
  return name && !unnamed(name) ? name : undefined
}

export function assignAgentDisplayNames(agents: NamedAgent[]): void {
  const used = new Set(agents.map(chosen).filter((name): name is string => !!name).map(name => name.toLowerCase()))
  for (const agent of [...agents].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const existing = chosen(agent)
    if (existing) {
      agent.displayName = existing
      continue
    }
    let hash = 0
    for (const letter of agent.id) hash = (hash * 31 + letter.charCodeAt(0)) & 0x7fffffff
    for (let attempt = 0; ; attempt++) {
      const round = Math.floor(attempt / names.length)
      const candidate = `${names[(hash + attempt) % names.length]}${round ? ` ${round + 1}` : ''}`
      if (used.has(candidate.toLowerCase())) continue
      agent.displayName = candidate
      used.add(candidate.toLowerCase())
      break
    }
  }
}

/** Read-only callers (native observations and legacy snapshots) get the same
 * names as the next authorized transaction, without mutating stored state. */
export function agentDisplayName(agents: readonly NamedAgent[], id: string): string | undefined {
  const member = agents.find(agent => agent.id === id)
  if (!member) return undefined
  if (member.displayName && !reviewer.test(member.displayName.trim())) return member.displayName
  const named = agents.map(agent => ({ ...agent }))
  assignAgentDisplayNames(named)
  return named.find(agent => agent.id === id)!.displayName
}

/** A name a person gives an agent with Rename Harness: NFKC, trimmed, 1 to 60 characters, nothing that hides its shape (controls,
 *  bidi overrides, default-ignorables). Not a role's name or the Reviewer's (isRoleName), which would be given a member name
 *  instead, and not another agent's, compared as names are everywhere (NFKC, lowercase). */
const AGENT_NAME_LENGTH = 60
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const key = (name: string): string => name.normalize('NFKC').toLowerCase().trim()
export function checkAgentName(agents: readonly NamedAgent[], id: string, input: string):
  { name: string } | { code: 'INVALID_AGENT_NAME' | 'AGENT_NAME_ROLE' | 'AGENT_NAME_TAKEN'; message: string } {
  const name = input.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const length = [...name].length
  if (!length || length > AGENT_NAME_LENGTH || HIDDEN.test(name)) {
    return { code: 'INVALID_AGENT_NAME', message: `Use 1 to ${AGENT_NAME_LENGTH} visible characters for an agent's name.` }
  }
  if (isRoleName(name) || reviewer.test(name)) return { code: 'AGENT_NAME_ROLE', message: `${name} is a role's name. Choose another.` }
  if (agents.some(other => other.id !== id && key(agentDisplayName(agents, other.id) ?? other.name) === key(name))) {
    return { code: 'AGENT_NAME_TAKEN', message: `${name} is taken in this Swarm. Choose another.` }
  }
  return { name }
}
