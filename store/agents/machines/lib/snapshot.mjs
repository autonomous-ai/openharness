/**
 * One observation of the fleet: the machines on the account, the harnesses each one is carrying,
 * and the projects those harnesses are in.
 *
 * Every number here was reported by Harness. A machine that cannot be read keeps its last known
 * roster, marked stale, and says why — a roster this package could not fetch is never zero
 * harnesses, and a machine that is merely unlinked is never offline.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { authMe, daemonStatus, linkedPeers, listHarnesses, listMachines, remotePasswordSet, sharedMachines } from './daemon.mjs';
import { now, readRecord } from './fleet.mjs';

/** How many machines are asked for their roster at once. A fleet is small; a relayed dial is not free. */
const ROSTER_CONCURRENCY = 4;
/** Harness rows kept per machine. Beyond this the counts stay true and the map stops drawing ticks. */
export const ROSTER_LIMIT = 240;

const text = (value, limit = 200) => (typeof value === 'string' ? value.slice(0, limit) : null);
const iso = value => { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toISOString() : null; };

/** Machine presence, as the app reads it: `running` is the only word that means online. */
function presenceOf(row) {
  if (row.status === 'running') return 'online';
  if (row.status === 'stopped' || row.status === 'offline') return 'offline';
  return 'unknown';
}

/** A machine's name is its own, else the hostname of the computer that last connected it. */
export function machineName(row, nicknames = {}) {
  return text(nicknames[row.machineId], 40) || text(row.name, 80) || text(row.hostname, 80) || `machine ${String(row.machineId).slice(0, 8)}`;
}

/** Two harnesses are in the same project when they are in the same repository, else the same folder. */
export function projectKey(machineId, project) {
  if (!project) return null;
  if (project.remote) return `repo:${project.remote}`;
  return `dir:${machineId}:${project.root || project.cwd}`;
}

function harnessRow(raw, machineId) {
  const project = raw?.project && typeof raw.project === 'object' ? raw.project : null;
  return {
    id: text(raw?.id, 64),
    machineId,
    name: text(raw?.name, 120) || 'Harness',
    title: text(raw?.title, 160),
    // The agent is the who: a harness package's name when it has one, else the bare engine.
    agent: text(raw?.dshName, 60) || text(raw?.engine, 40) || 'agent',
    engine: text(raw?.engine, 40) || 'unknown',
    dsh: text(raw?.dsh, 80),
    // The registry calls a session active when it is still open — a pane that exists, a process
    // that is alive. It is not a claim that the agent is mid-turn, and nothing here says it is.
    open: raw?.status === 'active',
    project: project ? {
      key: projectKey(machineId, project),
      name: text(project.name, 80) || 'project',
      cwd: text(project.cwd, 240),
      branch: text(project.branch, 80),
      repo: text(project.remote, 160),
    } : null,
    verdict: raw?.verdict && typeof raw.verdict === 'object' ? {
      ready: raw.verdict.ready === true,
      summary: text(raw.verdict.summary, 120),
      errors: Number.isFinite(raw.verdict.errors) ? raw.verdict.errors : 0,
      warnings: Number.isFinite(raw.verdict.warnings) ? raw.verdict.warnings : 0,
    } : null,
    createdAt: iso(raw?.createdAt),
    // The registry stamps this when it reconciles, so a whole machine's harnesses share the moment
    // it was last polled. It is kept for completeness and is never read as "last worked on": the
    // honest time signal a roster carries is when each harness was CREATED.
    updatedAt: iso(raw?.updatedAt),
  };
}

/** Run `work` over `items`, a few at a time, in order of completion. */
async function pooled(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index], index);
  });
  await Promise.all(runners);
  return results;
}

/** This computer's own lifetime counters, written by the app. Absent is absent, never zero. */
export async function localTotals(env = process.env) {
  const dir = env.HARNESS_APP_DIR || join(homedir(), '.harness', 'desktop-app-v2');
  try {
    const raw = JSON.parse(await readFile(join(dir, 'harness-stats.json'), 'utf8'));
    const number = value => (Number.isFinite(value) && value >= 0 ? value : null);
    return {
      harnessesStarted: number(raw?.agentsSpawned),
      turns: number(raw?.turns),
      workedMs: number(raw?.workedMs),
      since: iso(raw?.firstEventAt),
    };
  } catch { return null; }
}

/** Projects, gathered across every machine that could be read. */
export function projectsOf(machines) {
  const projects = new Map();
  for (const machine of machines) {
    for (const harness of machine.harnesses) {
      if (!harness.project?.key) continue;
      const found = projects.get(harness.project.key) ?? {
        key: harness.project.key, name: harness.project.name, repo: harness.project.repo,
        branches: [], machines: [], harnesses: 0, open: 0, newestAt: null,
      };
      found.harnesses += 1;
      if (harness.open) found.open += 1;
      if (harness.project.branch && !found.branches.includes(harness.project.branch)) found.branches.push(harness.project.branch);
      if (!found.machines.includes(machine.id)) found.machines.push(machine.id);
      if (harness.createdAt && (!found.newestAt || harness.createdAt > found.newestAt)) found.newestAt = harness.createdAt;
      projects.set(found.key, found);
    }
  }
  return [...projects.values()].sort((a, b) => b.open - a.open || b.harnesses - a.harnesses || a.name.localeCompare(b.name));
}

/**
 * A collector holds one thing between polls: the last roster each machine gave, so an unreachable
 * machine keeps its harnesses on the map with an honest "last seen" instead of emptying out.
 */
export function createCollector(workspace, { env = process.env, intervalMs = 15_000, read = {} } = {}) {
  // Every read this collector makes, in one place, so a test can hand it a fleet and a real run
  // reaches Harness the only way this package ever does.
  const source = {
    machines: listMachines, account: authMe, daemon: daemonStatus, peers: linkedPeers,
    shares: sharedMachines, password: remotePasswordSet, totals: localTotals, roster: listHarnesses,
    record: readRecord, ...read,
  };
  const lastRosters = new Map();

  return async function collect() {
    const observedAt = now();
    const [record, account, daemon, machineList, peers, shares, passwordSet, totals] = await Promise.all([
      source.record(workspace).catch(() => ({ nicknames: {}, notes: {}, groups: {} })),
      source.account(env), source.daemon(env), source.machines(env), source.peers(env),
      source.shares(env), source.password(env), source.totals(env),
    ]);

    const sources = {
      machines: { ok: machineList.ok, error: machineList.ok ? null : machineList.error },
      account: { ok: account.ok, error: account.ok ? null : account.error },
      daemon: { ok: daemon.ok, error: daemon.ok ? null : daemon.error },
    };
    if (!machineList.ok) {
      return {
        spec: 1,
        status: machineList.signedOut ? 'signed-out' : 'unavailable',
        message: machineList.error,
        observedAt, pollIntervalMs: intervalMs,
        account: null, localMachineId: daemon.status?.machineId ?? null,
        machines: [], projects: [], summary: { machines: 0, online: 0, needsLink: 0, harnesses: 0, open: 0, projects: 0, engines: {} },
        thisComputer: null, totals, sources,
      };
    }

    const localMachineId = daemon.status?.machineId ?? null;
    const linked = new Map(peers.map(peer => [peer.machineId, peer]));
    const shared = new Map(shares.machines.filter(m => typeof m?.machineId === 'string').map(m => [m.machineId, m]));
    const rows = machineList.machines.filter(row => typeof row?.machineId === 'string');

    const machines = await pooled(rows, ROSTER_CONCURRENCY, async row => {
      const id = row.machineId;
      const local = id === localMachineId;
      const isShared = shared.has(id);
      const presence = presenceOf(row);
      const linkState = local ? 'local' : isShared ? 'shared' : linked.has(id) ? 'linked' : 'unlinked';
      const base = {
        id,
        name: machineName(row, record.nicknames),
        givenName: text(row.name, 80),
        nickname: text(record.nicknames?.[id], 40),
        note: text(record.notes?.[id], 400),
        hostname: text(row.hostname, 80),
        local, shared: isShared,
        ownerName: isShared ? text(shared.get(id)?.ownerName, 80) : null,
        status: presence,
        linkState,
        linkedAt: linked.get(id)?.linkedAt ?? null,
        needsLink: false,
        plan: text(row.planName, 60),
        authMode: text(row.authMode, 40),
        billingStatus: text(row.billingStatus, 40),
        engine: text(row.engine, 40),
        reportedHarnessCount: Number.isFinite(row.agentCount) ? row.agentCount : null,
        createdAt: iso(row.createdAt),
        groups: Object.entries(record.groups ?? {}).filter(([, ids]) => ids.includes(id)).map(([name]) => name),
      };

      // A machine that is offline, unlinked or shared read-only is not asked; that is not a failure,
      // it is a state with a name, and the map says which one.
      if (presence === 'offline' || linkState === 'unlinked' || linkState === 'shared') {
        const remembered = lastRosters.get(id);
        return {
          ...base,
          needsLink: linkState === 'unlinked',
          harnesses: remembered?.harnesses ?? [],
          harnessesTruncated: remembered?.truncated ?? false,
          rosterObservedAt: remembered?.observedAt ?? null,
          stale: Boolean(remembered),
          error: null,
        };
      }

      const roster = await source.roster(id, { env });
      if (!roster.ok) {
        const remembered = lastRosters.get(id);
        return {
          ...base,
          needsLink: roster.needsLink === true,
          harnesses: remembered?.harnesses ?? [],
          harnessesTruncated: remembered?.truncated ?? false,
          rosterObservedAt: remembered?.observedAt ?? null,
          stale: Boolean(remembered),
          error: roster.needsLink ? null : roster.error,
        };
      }
      const all = roster.harnesses.map(raw => harnessRow(raw, id)).filter(h => h.id);
      const harnesses = all.slice(0, ROSTER_LIMIT);
      lastRosters.set(id, { harnesses, truncated: all.length > harnesses.length, observedAt });
      return { ...base, harnesses, harnessesTruncated: all.length > harnesses.length, rosterObservedAt: observedAt, stale: false, error: null };
    });

    for (const machine of machines) {
      machine.harnessCount = machine.harnesses.length;
      machine.openCount = machine.harnesses.filter(h => h.open).length;
      machine.projectCount = new Set(machine.harnesses.map(h => h.project?.key).filter(Boolean)).size;
      machine.newestAt = machine.harnesses.reduce((latest, h) => (h.createdAt && h.createdAt > latest ? h.createdAt : latest), '') || null;
    }
    // This computer first, then the machines that are up, then by name — the order the map lays out.
    machines.sort((a, b) => Number(b.local) - Number(a.local)
      || Number(b.status === 'online') - Number(a.status === 'online')
      || a.name.localeCompare(b.name));

    const engines = {};
    for (const machine of machines) for (const harness of machine.harnesses) engines[harness.engine] = (engines[harness.engine] ?? 0) + 1;
    const projects = projectsOf(machines);
    // A machine that has never been linked is a state with a name, shown as such, and not a partial
    // observation. Only a machine that SHOULD have answered and did not makes this reading partial.
    const unreadable = machines.filter(m => m.error).length;

    return {
      spec: 1,
      status: machineList.stale ? 'partial' : unreadable ? 'partial' : 'live',
      message: machineList.stale ? 'These machines are the last list Harness could fetch.' : null,
      observedAt, pollIntervalMs: intervalMs,
      account: account.ok ? { email: text(account.user?.email, 160), name: text(account.user?.name, 80) } : null,
      localMachineId,
      thisComputer: daemon.ok ? {
        machineId: daemon.status?.machineId ?? null,
        version: text(daemon.status?.version, 40),
        connected: daemon.status?.connected === true,
        uptimeSec: Number.isFinite(daemon.status?.uptimeSec) ? daemon.status.uptimeSec : null,
        remotePasswordSet: passwordSet,
      } : null,
      machines, projects,
      summary: {
        machines: machines.length,
        online: machines.filter(m => m.status === 'online').length,
        needsLink: machines.filter(m => m.needsLink).length,
        harnesses: machines.reduce((total, m) => total + m.harnessCount, 0),
        open: machines.reduce((total, m) => total + m.openCount, 0),
        projects: projects.length,
        engines,
      },
      totals,
      sources,
    };
  };
}
