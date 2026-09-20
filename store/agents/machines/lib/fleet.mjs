/**
 * The workspace's own memory: what the person calls each machine, how they group them, what has
 * been done here, and the verdict the pane header reads.
 *
 * Harness owns the machines themselves. This file owns only what Harness has nowhere to keep — a
 * nickname, a note, a group — plus a small log of the operations run from this workspace, so the
 * pane can say what just happened and the agent can say what it did without asking the network.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const now = () => new Date().toISOString();

export const DEFAULT_RECORD = {
  spec: 1,
  nicknames: {},
  groups: {},
  notes: {},
  preferences: { confirmBeforeRemoving: true, watchForNewMachinesSeconds: 300 },
};

export function stateDir(workspace) { return join(workspace, '.harness'); }

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/** Write through a temporary file: a reader never sees half a record, and a crash never truncates one. */
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
  return value;
}

const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const shortText = (value, limit = 120) => String(value ?? '').slice(0, limit);

/** Keep a record readable whatever is in the file: unknown keys stay, known ones get their shape. */
export function validateRecord(raw) {
  const record = object(raw);
  const preferences = object(record.preferences);
  const seconds = Number(preferences.watchForNewMachinesSeconds);
  return {
    ...record,
    spec: 1,
    nicknames: Object.fromEntries(Object.entries(object(record.nicknames)).slice(0, 256).map(([id, name]) => [id, shortText(name, 40)])),
    groups: Object.fromEntries(Object.entries(object(record.groups)).slice(0, 64).map(([name, ids]) => [
      shortText(name, 40),
      (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string').slice(0, 128),
    ])),
    notes: Object.fromEntries(Object.entries(object(record.notes)).slice(0, 256).map(([id, note]) => [id, shortText(note, 400)])),
    preferences: {
      ...preferences,
      confirmBeforeRemoving: preferences.confirmBeforeRemoving !== false,
      watchForNewMachinesSeconds: Number.isFinite(seconds) ? Math.min(3600, Math.max(30, Math.round(seconds))) : 300,
    },
  };
}

export async function readRecord(workspace) {
  return validateRecord(await readJson(join(workspace, 'machines.json'), DEFAULT_RECORD));
}

export async function writeRecord(workspace, record) {
  return atomicJson(join(workspace, 'machines.json'), validateRecord(record));
}

const OPERATIONS_KEPT = 40;

/** What has been done from this workspace, newest first. Never a password, never a key — a sentence. */
export async function recordOperation(workspace, entry) {
  const path = join(stateDir(workspace), 'operations.json');
  const previous = await readJson(path, []);
  const list = Array.isArray(previous) ? previous : [];
  const operation = {
    at: now(),
    kind: shortText(entry?.kind, 40),
    machineId: entry?.machineId ? shortText(entry.machineId, 64) : null,
    machine: entry?.machine ? shortText(entry.machine, 80) : null,
    detail: shortText(entry?.detail, 200),
    ok: entry?.ok !== false,
  };
  await atomicJson(path, [operation, ...list].slice(0, OPERATIONS_KEPT));
  return operation;
}

export async function operations(workspace) {
  const list = await readJson(join(stateDir(workspace), 'operations.json'), []);
  return Array.isArray(list) ? list.slice(0, OPERATIONS_KEPT) : [];
}

/**
 * The pane header's line, written from the same snapshot the map draws.
 *
 * `ready` is one machine fact and not a mood: every machine on the account is online and reachable
 * from here. A machine that needs linking, or one that is offline, is a finding with the machine's
 * name in it, because that is the thing a person can act on.
 */
export function verdictFor(snapshot) {
  const machines = snapshot?.machines ?? [];
  const summary = snapshot?.summary ?? {};
  const findings = [];
  if (snapshot?.status === 'signed-out') {
    findings.push({ severity: 'error', kind: 'signed_out', message: 'Not signed in to Harness on this computer. Run `harness login`.' });
  } else if (snapshot?.status === 'unavailable') {
    findings.push({ severity: 'error', kind: 'daemon', message: snapshot.message || 'Harness is not answering on this computer.' });
  }
  for (const machine of machines) {
    // Offline first: a machine that is not on cannot be linked either, and saying "link required"
    // about a computer that is switched off points the person at the wrong problem.
    if (machine.status === 'offline') findings.push({ severity: 'info', kind: 'offline', message: `${machine.name} is offline.`, ref: machine.id });
    else if (machine.needsLink) findings.push({ severity: 'warning', kind: 'needs_link', message: `${machine.name} is not linked from this computer, so its harnesses cannot be read.`, ref: machine.id });
    else if (machine.error) findings.push({ severity: 'warning', kind: 'unreadable', message: `${machine.name}: ${machine.error}`, ref: machine.id });
  }
  const counted = [
    `${summary.machines ?? machines.length} ${(summary.machines ?? machines.length) === 1 ? 'machine' : 'machines'}`,
    `${summary.online ?? 0} online`,
    `${summary.harnesses ?? 0} ${(summary.harnesses ?? 0) === 1 ? 'harness' : 'harnesses'}`,
  ].join(' · ');
  // A workspace that has not observed anything yet has not learned that there are no machines.
  const nothingRead = !machines.length && (snapshot?.status === 'connecting' || !snapshot?.observedAt);
  return {
    spec: 1,
    ready: findings.every(f => f.severity === 'info') && machines.length > 0,
    summary: machines.length ? counted : nothingRead ? 'Reading your machines…' : 'No machines on this account yet',
    findings: findings.slice(0, 20),
    updatedAt: snapshot?.observedAt || now(),
  };
}

export async function writeVerdict(workspace, snapshot) {
  return atomicJson(join(stateDir(workspace), 'verdict.json'), verdictFor(snapshot));
}
