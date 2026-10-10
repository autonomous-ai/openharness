/**
 * Every machine's memories in one pane, and one About You on all of them.
 *
 * Each machine's daemon answers `memory_snapshot` with what its agents remember and how the person
 * works there (its memory service runs this package's `mem snapshot`), over the same encrypted link
 * Harness search uses. This module asks every online machine, merges the answers into the local
 * snapshot with each row labeled by its machine, and keeps About You the same everywhere: the newest
 * profile is written where it is missing or different (`memory_about_put`), and that machine's agents
 * get it as its own do.
 *
 * A machine on a Harness without the memory service answers UNSUPPORTED; it is listed as needing an
 * update, never as having no memories.
 */

/** Rows from another machine: ids made unique across machines, each row labeled with where it lives. */
function labeled(rows, machine) {
  return (rows ?? []).map((row) => ({ ...row, id: `${machine.id}|${row.id}`, origin: row.id, machine }))
}

function addCounts(into, from) {
  for (const [key, value] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + (value ?? 0)
  return into
}

/** One snapshot of every machine: the local one as it is, the others' rows added and their counts summed. */
export function merge(local, remotes, here) {
  const machine = { id: here?.id ?? 'local', name: here?.name ?? 'this computer', current: true }
  const memories = (local.memories ?? []).map((row) => ({ ...row, machine }))
  const answered = remotes.filter((remote) => remote.snapshot)
  for (const remote of answered) memories.push(...labeled(remote.snapshot.memories, { id: remote.id, name: remote.name, current: false }))
  memories.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0) || a.id.localeCompare(b.id))

  const agents = (local.agents ?? []).map((agent) => ({ ...agent, machines: agent.memories || agent.sessions ? [machine.name] : [] }))
  for (const remote of answered) {
    for (const theirs of remote.snapshot.agents ?? []) {
      const ours = agents.find((agent) => agent.id === theirs.id)
      if (!ours) continue
      ours.memories += theirs.memories ?? 0
      ours.sessions += theirs.sessions ?? 0
      ours.instructions += theirs.instructions ?? 0
      ours.present ||= theirs.present
      if (theirs.memories || theirs.sessions) ours.machines.push(remote.name)
    }
  }

  // Projects by name: the same repository is in a different folder on each machine.
  const projects = new Map()
  for (const [snap, owner] of [[local, null], ...answered.map((remote) => [remote.snapshot, remote])]) {
    for (const project of snap.projects ?? []) {
      const entry = projects.get(project.name) ?? { ...project, key: `name:${project.name}`, memories: [], sessions: 0, asks: 0, engines: {}, lastAt: null, machines: [] }
      entry.memories.push(...project.memories.map((id) => (owner ? `${owner.id}|${id}` : id)))
      entry.sessions += project.sessions ?? 0
      entry.asks += project.asks ?? 0
      entry.lastAt = Math.max(entry.lastAt ?? 0, project.lastAt ?? 0) || null
      addCounts(entry.engines, project.engines)
      entry.machines.push(owner ? owner.name : machine.name)
      if (!owner && project.path) entry.path = project.path
      projects.set(project.name, entry)
    }
  }

  let sessions = local.sessions ? { ...local.sessions, engines: local.sessions.engines.map((row) => ({ ...row })), activity: [...local.sessions.activity] } : null
  for (const remote of answered) {
    const theirs = remote.snapshot.sessions
    if (!theirs) continue
    sessions ??= { sessions: 0, asks: 0, firstAt: null, engines: [], activity: [], folders: [] }
    sessions.sessions += theirs.sessions ?? 0
    sessions.asks += theirs.asks ?? 0
    if (theirs.firstAt && (!sessions.firstAt || theirs.firstAt < sessions.firstAt)) sessions.firstAt = theirs.firstAt
    for (const row of theirs.engines ?? []) {
      const ours = sessions.engines.find((engine) => engine.engine === row.engine)
      if (ours) { ours.sessions += row.sessions ?? 0; ours.asks += row.asks ?? 0; ours.lastAt = Math.max(ours.lastAt ?? 0, row.lastAt ?? 0) }
      else sessions.engines.push({ ...row })
    }
    sessions.activity.push(...(theirs.activity ?? []))
  }
  sessions?.engines.sort((a, b) => (b.asks ?? 0) - (a.asks ?? 0))

  const machines = [{ ...machine, online: true, ok: true, deliveryOn: Boolean(local.delivery?.on) }, ...remotes.map((remote) => ({ id: remote.id, name: remote.name, current: false, online: remote.online, ok: Boolean(remote.snapshot), deliveryOn: Boolean(remote.snapshot?.delivery?.on), error: remote.error ?? null }))]
  return { ...local, memories, agents, projects: [...projects.values()].sort((a, b) => b.memories.length - a.memories.length || (b.lastAt ?? 0) - (a.lastAt ?? 0)), sessions, machines }
}

/** The newest About You among every machine that answered: `{ text, modified, from }` or null. */
export function newestAbout(local, remotes, here) {
  let best = local.about ? { text: local.about.text, modified: local.about.modified, from: here?.id ?? 'local' } : null
  for (const remote of remotes) {
    const about = remote.snapshot?.about
    if (about?.text && (!best || about.modified > best.modified)) best = { text: about.text, modified: about.modified, from: remote.id }
  }
  return best
}

/**
 * Make every machine's About You the newest one. Compared by text, so a copy written here a moment
 * after another machine built it (a later file time, the same words) is not sent back. Returns what it
 * did: `{ wroteHere, sentTo: [names], failed: [{ name, error }] }`.
 */
export async function syncAbout({ local, remotes, here, request, writeHere }) {
  const best = newestAbout(local, remotes, here)
  const result = { wroteHere: false, sentTo: [], failed: [] }
  if (!best) return result
  if (best.from !== (here?.id ?? 'local') && local.about?.text !== best.text) {
    await writeHere(best.text)
    result.wroteHere = true
  }
  for (const remote of remotes) {
    if (!remote.snapshot || remote.snapshot.about?.text === best.text) continue
    try {
      await request(remote.id, 'memory_about_put', { text: best.text })
      result.sentTo.push(remote.name)
    } catch (error) {
      result.failed.push({ name: remote.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/**
 * The person's on/off choice, the same on every machine: the newest choice (by the time it was made)
 * is applied where it differs. A machine that has never been given a choice takes the newest one too.
 * Returns `{ appliedHere, sentTo, failed }`.
 */
export async function syncChoice({ local, remotes, here, request, applyHere }) {
  const result = { appliedHere: false, sentTo: [], failed: [] }
  const choiceOf = (delivery) => (delivery?.choiceAt ? { on: !delivery.choseOff, at: delivery.choiceAt } : null)
  let best = choiceOf(local.delivery) && { ...choiceOf(local.delivery), from: here?.id ?? 'local' }
  for (const remote of remotes) {
    const theirs = choiceOf(remote.snapshot?.delivery)
    if (theirs && (!best || theirs.at > best.at)) best = { ...theirs, from: remote.id }
  }
  if (!best) return result
  const differs = (delivery) => !delivery || delivery.choiceAt !== best.at || Boolean(delivery.choseOff) === best.on
  if (best.from !== (here?.id ?? 'local') && differs(local.delivery)) {
    await applyHere(best.on, best.at)
    result.appliedHere = true
  }
  for (const remote of remotes) {
    if (!remote.snapshot || !differs(remote.snapshot.delivery)) continue
    // Turning on needs the profile there first; syncAbout runs before this and sends it.
    try {
      await request(remote.id, 'memory_deliver', { on: best.on, choiceAt: best.at })
      result.sentTo.push(remote.name)
    } catch (error) {
      result.failed.push({ name: remote.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** Ask every online machine but this one for its snapshot. Never throws: a machine that fails says why. */
export async function askMachines({ machinesReport, request, timeoutMs = 20_000 }) {
  const report = await machinesReport()
  const here = report.machines.find((machine) => machine.current) ?? null
  const others = report.machines.filter((machine) => !machine.current)
  const remotes = await Promise.all(others.map(async (machine) => {
    const base = { id: machine.machineId, name: machine.name, online: machine.online, snapshot: null, error: null }
    if (!machine.online) return { ...base, error: 'offline' }
    try {
      const snapshot = await request(machine.machineId, 'memory_snapshot', {}, { timeoutMs })
      return { ...base, snapshot: snapshot?.snapshot ?? snapshot }
    } catch (error) {
      // A Harness from before the memory service: it does not know the request (UNSUPPORTED), or its relay
      // cannot seal a type it has never heard of (E2EE_REQUIRED). Both mean "update Harness there".
      const unsupported = ['UNSUPPORTED', 'E2EE_REQUIRED'].includes(error?.code) || /UNSUPPORTED|E2EE_REQUIRED/.test(String(error?.message))
      return { ...base, error: unsupported ? 'needs the newest Harness' : (error instanceof Error ? error.message : String(error)) }
    }
  }))
  return { here: here && { id: here.machineId, name: here.name }, remotes, error: report.error ?? null }
}
