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

function chosen(agent: NamedAgent): string | undefined {
  if (agent.displayName?.trim()) return agent.displayName
  const name = agent.name.trim()
  return name && !defaults.test(name) && !automatic.test(name) ? name : undefined
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
export function agentDisplayName(agents: NamedAgent[], id: string): string | undefined {
  const member = agents.find(agent => agent.id === id)
  if (!member) return undefined
  if (member.displayName) return member.displayName
  const named = agents.map(agent => ({ ...agent }))
  assignAgentDisplayNames(named)
  return named.find(agent => agent.id === id)!.displayName
}
