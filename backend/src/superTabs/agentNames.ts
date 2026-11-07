/** Member identities are separate from native session names and routing roles.
 * Allocate on the full state, before filtering private projects. Once assigned,
 * a name stays with that agent when its role, project or engine changes. */
export interface NamedAgent { id: string; name: string; displayName?: string }

/** Member names (task #4568: 200, so a Swarm's agents rarely share one even before the two-name fallback). Letters only, never
 *  a role's, an engine's or a model's name. New names go at the end: a name already given stays with its agent. */
export const AGENT_NAMES: readonly string[] = [
  'Atlas', 'Nova', 'Orion', 'Echo', 'Sage', 'Finn', 'Arlo', 'Iris', 'Rowan', 'Mira', 'Theo', 'Luna', 'Jules', 'Remy',
  'Avery', 'Kai', 'Robin', 'Juno', 'Reed', 'Wren', 'Aster', 'Cleo', 'Ellis', 'Faye', 'Hugo', 'Indigo', 'Jasper',
  'Lark', 'Milo', 'Nico', 'Quinn', 'River', 'Adair', 'Alder', 'Alexis', 'Amari', 'Andie', 'Ansel', 'Arden', 'Ari',
  'Ash', 'Aspen', 'Auden', 'August', 'Bailey', 'Basil', 'Bay', 'Bellamy', 'Bexley', 'Blair', 'Blake', 'Bo', 'Brook',
  'Cade', 'Callan', 'Cameron', 'Carey', 'Casey', 'Cedar', 'Channing', 'Charlie', 'Corin', 'Cove', 'Dakota', 'Dale',
  'Dallas', 'Darby', 'Darcy', 'Dell', 'Devon', 'Drew', 'Eden', 'Elliot', 'Ember', 'Emery', 'Emerson', 'Ezra',
  'Fallon', 'Fern', 'Fletcher', 'Flynn', 'Frankie', 'Gale', 'Gray', 'Greer', 'Hadley', 'Harper', 'Hayden', 'Haven',
  'Hollis', 'Honor', 'Ira', 'Jamie', 'Jay', 'Jordan', 'Jude', 'Kade', 'Keegan', 'Kendall', 'Kerry', 'Kit', 'Lane',
  'Laurel', 'Lee', 'Leighton', 'Lennox', 'Linden', 'Logan', 'Lou', 'Lowen', 'Lyric', 'Marlo', 'Marlowe', 'Mason',
  'Maxwell', 'Merritt', 'Micah', 'Morgan', 'Nash', 'Noel', 'Oakley', 'Ocean', 'Onyx', 'Oren', 'Parker', 'Payton',
  'Perry', 'Phoenix', 'Piper', 'Presley', 'Raleigh', 'Rain', 'Raven', 'Ray', 'Reese', 'Rhys', 'Riley', 'Rio',
  'Ripley', 'Rory', 'Rumi', 'Ryan', 'Sailor', 'Salem', 'Sam', 'Sawyer', 'Scout', 'Shay', 'Shiloh', 'Sky', 'Sloane',
  'Sol', 'Spencer', 'Stellan', 'Sterling', 'Sutton', 'Sydney', 'Tate', 'Taylor', 'Teagan', 'Tobin', 'Toby',
  'Tristan', 'Tully', 'Vale', 'Vesper', 'West', 'Whit', 'Winter', 'Wynn', 'Yael', 'Zion', 'Zane', 'Zuri', 'Alba',
  'Bran', 'Dune', 'Elio', 'Ines', 'Joss', 'Kiri', 'Leif', 'Lumi', 'Maren', 'Neve', 'Odin', 'Pax', 'Selah', 'Tamsin',
  'Uma', 'Veda', 'Wilder', 'Yuki', 'Zephyr', 'Briar', 'Cyrus', 'Dorian', 'Esme', 'Hazel', 'Ivo',
]
const defaults = /^(?:lead|builder|agent|new agent|product manager|engineer|pm|dev)(?:[\s#-]+\d+)?$/i
/** A role's name, never a member's: an agent named so is given a member name instead (assignAgentDisplayNames). */
export const isRoleName = (name: string): boolean => defaults.test(name.trim())
const automatic = /^(?:claude|codex|pi|agent)-\d{4}-\d{2}-\d{2}(?:[-T].*)?$/i
/** Only its engine's name, which Desktop's local Cmd-N start gave every Member (launch.dart, task #4568): no member's. */
const engine = /^(?:claude(?: code)?|codex|opencode|pi)$/i
/** The Reviewer role's name is no member's either (Dee, 2026-10-30: three "Reviewer" rows). Kept out of isRoleName, whose
 *  Buddy check reserves it on its own (buddies.ts BUDDY_RESERVED). */
const reviewer = /^reviewer(?:[\s#-]+\d+)?$/i
/** Whether [name] names a role or an automatic session rather than a member. */
const unnamed = (name: string): boolean => defaults.test(name) || reviewer.test(name) || automatic.test(name) || engine.test(name)

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
    const name = freeAgentName(candidate => used.has(candidate.toLowerCase()), agent.id)
    agent.displayName = name
    used.add(name.toLowerCase())
  }
}

/** A name [taken] says nobody has, from a start fixed by [seed] (an id), so the same agent is offered the same name: a list name,
 *  else two of them ("Atlas Reed", 39,800 more), else a numbered one. It never runs out (task #4568). */
export function freeAgentName(taken: (name: string) => boolean, seed: string): string {
  let hash = 0
  for (const letter of seed) hash = (hash * 31 + letter.charCodeAt(0)) & 0x7fffffff
  const count = AGENT_NAMES.length, at = (i: number) => AGENT_NAMES[(hash + i) % count]!
  for (let i = 0; i < count; i++) if (!taken(at(i))) return at(i)
  for (let gap = 1; gap < count; gap++) {
    for (let i = 0; i < count; i++) {
      const pair = `${at(i)} ${at(i + gap)}`
      if (!taken(pair)) return pair
    }
  }
  for (let number = 2; ; number++) if (!taken(`${at(0)} ${number}`)) return `${at(0)} ${number}`
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
