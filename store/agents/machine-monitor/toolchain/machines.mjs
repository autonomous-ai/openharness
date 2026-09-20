#!/usr/bin/env node
/**
 * `machines …` — the agent's hands on the fleet.
 *
 * Every subcommand is one thing a person asks for in plain words: show me my machines, call that
 * one the studio Mac, link it, drop it, what is it running. Reads prefer the observation the pane
 * already published (no second poll); anything that changes a machine re-reads the live list first,
 * so a rename or a removal is never aimed at a row that has gone stale.
 *
 * Text by default, because the person is watching this terminal. `--json` for a machine-readable
 * answer. Exit code 1 means the thing did not happen.
 */
import { resolve } from 'node:path';
import { deleteMachine, listMachines, renameMachine } from '../lib/daemon.mjs';
import { now, readJson, readRecord, recordOperation, stateDir, writeRecord, writeVerdict } from '../lib/fleet.mjs';
import { clearRemotePassword, linkMachine, listLinks, remotePasswordStatus, resolveMachine, setRemotePassword, unlinkMachine, watchForNewMachine } from '../lib/ops.mjs';
import { createCollector, machineName } from '../lib/snapshot.mjs';

const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd());
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const named = key => argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const words = argv.filter(a => !a.startsWith('--'));
const asJson = flags.has('--json');

const out = (text = '') => process.stdout.write(`${text}\n`);
const emit = (value, text) => { if (asJson) out(JSON.stringify(value, null, 2)); else text(); };
function fail(message, extra = {}) {
  if (asJson) out(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  else process.stderr.write(`${message}\n`);
  process.exit(1);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function ago(time) {
  const at = Date.parse(time);
  if (!Number.isFinite(at)) return 'never';
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
/** Presence and link state are independent segments, the same split the Machines menu makes. */
function stateWord(machine) {
  if (machine.local) return 'this computer';
  if (machine.shared) return 'shared with you';
  const presence = machine.status === 'online' ? 'online' : machine.status === 'offline' ? 'offline' : 'status unknown';
  return machine.needsLink ? `${presence} · link required` : presence;
}

/** The pane's latest observation. The pane writes it every poll; nothing here re-polls to read it. */
async function published() {
  return readJson(`${stateDir(workspace)}/snapshot.json`, null);
}

/** A fresh observation, written where the pane and the agent both read it. */
async function observe() {
  const snapshot = await createCollector(workspace)();
  await writeVerdict(workspace, snapshot).catch(() => {});
  return snapshot;
}

/** Machines as the fleet currently reports them — always live, for anything that changes one. */
async function liveMachines() {
  const list = await listMachines();
  if (!list.ok) fail(list.error);
  const record = await readRecord(workspace);
  return list.machines.filter(row => typeof row?.machineId === 'string').map(row => ({
    id: row.machineId,
    name: machineName(row, record.nicknames),
    givenName: typeof row.name === 'string' ? row.name : null,
    nickname: record.nicknames?.[row.machineId] ?? null,
    hostname: typeof row.hostname === 'string' ? row.hostname : null,
    status: row.status === 'running' ? 'online' : row.status === 'offline' || row.status === 'stopped' ? 'offline' : 'unknown',
    local: false,
  }));
}

function pick(machines, query) {
  const found = resolveMachine(machines, query);
  if (found.machine) return found.machine;
  const names = (found.candidates ?? []).slice(0, 12).map(m => `  ${m.name}${m.hostname && m.hostname !== m.name ? ` (${m.hostname})` : ''}  ${m.id.slice(0, 8)}`);
  fail([found.error, ...(names.length ? ['', 'Machines here:', ...names] : [])].join('\n'), { candidates: found.candidates?.map(m => ({ id: m.id, name: m.name })) });
}

function printFleet(snapshot) {
  if (!snapshot?.machines?.length) { out(snapshot?.message || 'No machines on this account yet.'); return; }
  const rows = snapshot.machines.map(machine => [
    machine.name,
    stateWord(machine),
    machine.needsLink ? '—' : plural(machine.harnessCount ?? 0, 'harness', 'harnesses'),
    machine.openCount ? `${machine.openCount} open` : '',
    machine.id.slice(0, 8),
  ]);
  const width = column => Math.max(...rows.map(row => row[column].length));
  for (const row of rows) {
    out(`  ${row[0].padEnd(width(0))}  ${row[1].padEnd(width(1))}  ${row[2].padEnd(width(2))}  ${row[3].padEnd(width(3))}  ${row[4]}`);
  }
  const summary = snapshot.summary ?? {};
  out('');
  out(`  ${plural(summary.machines ?? 0, 'machine')} · ${summary.online ?? 0} online · ${plural(summary.harnesses ?? 0, 'harness', 'harnesses')} · ${plural(summary.projects ?? 0, 'project')}`);
  if (snapshot.observedAt) out(`  observed ${ago(snapshot.observedAt)}`);
  const linkable = snapshot.machines.filter(machine => machine.needsLink && machine.status !== 'offline').length;
  if (linkable) out(`  ${plural(linkable, 'machine')} can be linked from this computer right now.`);
}

function printMachine(machine) {
  out(`  ${machine.name}${machine.nickname ? `  (called "${machine.nickname}" here)` : ''}`);
  out(`  ${stateWord(machine)}${machine.hostname ? ` · ${machine.hostname}` : ''}`);
  out(`  id ${machine.id}`);
  if (machine.linkedAt) out(`  linked from this computer ${ago(machine.linkedAt)}`);
  if (machine.note) out(`  note: ${machine.note}`);
  if (machine.error) out(`  could not be read: ${machine.error}`);
  const projects = new Map();
  for (const harness of machine.harnesses ?? []) {
    const key = harness.project?.key ?? 'none';
    const found = projects.get(key) ?? { name: harness.project?.name ?? 'no project', branch: harness.project?.branch ?? null, harnesses: [] };
    found.harnesses.push(harness);
    projects.set(key, found);
  }
  if (!projects.size) { out(machine.needsLink ? '  Link it to see what it is running.' : '  Nothing running here.'); return; }
  out('');
  for (const project of projects.values()) {
    out(`  ${project.name}${project.branch ? ` · ${project.branch}` : ''}`);
    for (const harness of project.harnesses.slice(0, 12)) {
      out(`    ${harness.open ? '●' : '○'} ${harness.name}  ${harness.agent}${harness.createdAt ? ` · started ${ago(harness.createdAt)}` : ''}`);
    }
    if (project.harnesses.length > 12) out(`    …and ${project.harnesses.length - 12} more`);
  }
}

const usage = `machines — your computers, managed by asking

  machines status                  what the pane is showing right now (no network)
  machines list [--json]           a fresh read of every machine on the account
  machines show <machine>          one machine: state, projects, harnesses
  machines rename <machine> <name> rename it everywhere (this is the real name)
  machines nickname <machine> <text|--clear>   a name only this workspace uses
  machines note <machine> <text|--clear>       something to remember about it
  machines group <name> add|remove <machine>   keep a set of machines together
  machines link <machine> [--name=<label>]     link it from here (password on stdin)
  machines unlink <machine>        drop this computer's link to it
  machines links                   what this computer has linked
  machines password [set|clear]    this computer's remote password (stdin)
  machines invite                  how to bring a new computer in
  machines watch [--seconds=N]     wait for a new machine to sign in
  machines remove <machine> --yes  remove it from the account (not undoable)
  machines refresh                 observe now and rewrite the pane's snapshot
  machines doctor                  can this computer manage the fleet?`;

async function main() {
  const command = words[0] ?? 'status';
  switch (command) {
    case 'status': {
      const snapshot = await published();
      if (!snapshot) { out('The pane has not published an observation yet. Run `machines refresh`.'); return; }
      emit(snapshot, () => printFleet(snapshot));
      return;
    }
    case 'refresh': {
      const snapshot = await observe();
      emit(snapshot, () => printFleet(snapshot));
      return;
    }
    case 'list': {
      const snapshot = await observe();
      emit({ ok: true, machines: snapshot.machines, summary: snapshot.summary }, () => printFleet(snapshot));
      return;
    }
    case 'show': {
      const snapshot = (await published()) ?? (await observe());
      const machine = pick(snapshot.machines ?? [], words.slice(1).join(' '));
      emit({ ok: true, machine }, () => printMachine(machine));
      return;
    }
    case 'rename': {
      const machines = await liveMachines();
      const machine = pick(machines, words[1]);
      const name = words.slice(2).join(' ').trim();
      if (!name) fail('Say what to call it: machines rename <machine> <name>');
      if (name.length > 40) fail('A machine name is at most 40 characters.');
      const result = await renameMachine(machine.id, name);
      if (!result.ok) fail(result.error);
      await recordOperation(workspace, { kind: 'rename', machineId: machine.id, machine: name, detail: `Renamed ${machine.name} to ${name}` });
      emit({ ok: true, machineId: machine.id, name }, () => out(`  ${machine.name} is now ${name}.`));
      return;
    }
    case 'nickname':
    case 'note': {
      const record = await readRecord(workspace);
      const snapshot = (await published()) ?? { machines: await liveMachines() };
      const machine = pick(snapshot.machines ?? [], words[1]);
      const field = command === 'nickname' ? 'nicknames' : 'notes';
      const value = words.slice(2).join(' ').trim();
      if (flags.has('--clear') || !value) delete record[field][machine.id];
      else record[field][machine.id] = value;
      await writeRecord(workspace, record);
      emit({ ok: true, machineId: machine.id, [command]: record[field][machine.id] ?? null }, () => out(
        record[field][machine.id] ? `  ${machine.name} · ${command} "${record[field][machine.id]}"` : `  Cleared the ${command} for ${machine.name}.`));
      return;
    }
    case 'group': {
      const [, name, action, ...rest] = words;
      if (!name || !['add', 'remove'].includes(action)) fail('Usage: machines group <name> add|remove <machine>');
      const record = await readRecord(workspace);
      const snapshot = (await published()) ?? { machines: await liveMachines() };
      const machine = pick(snapshot.machines ?? [], rest.join(' '));
      const members = new Set(record.groups[name] ?? []);
      if (action === 'add') members.add(machine.id); else members.delete(machine.id);
      record.groups[name] = [...members];
      if (!record.groups[name].length) delete record.groups[name];
      await writeRecord(workspace, record);
      emit({ ok: true, group: name, members: record.groups[name] ?? [] }, () => out(`  ${name}: ${plural((record.groups[name] ?? []).length, 'machine')}`));
      return;
    }
    case 'link': {
      const machines = await liveMachines();
      const machine = pick(machines, words.slice(1).join(' '));
      // Always --stdin, never a positional: a password in an argument is in the shell history and
      // in every `ps` on the machine. Without the flag this command only explains where it belongs.
      if (!flags.has('--stdin')) {
        // The password is the person's, and the pane is where it belongs: typed once, into the row
        // that is asking for it, never through the conversation or a shell line.
        fail([`${machine.name} needs its remote password to link.`,
          'Ask the person to click Link on that machine in the pane and type it there.',
          'If they would rather pipe it: machines link <machine> --stdin, with the password on stdin.'].join('\n'),
          { machineId: machine.id, needsPassword: true });
      }
      const password = await new Promise(done => { let buffer = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { buffer += chunk; }); process.stdin.on('end', () => done(buffer.trim())); });
      const result = await linkMachine(machine.id, password, { displayName: named('name') || machine.name });
      await recordOperation(workspace, { kind: 'link', machineId: machine.id, machine: machine.name, detail: result.ok ? `Linked ${machine.name}` : `Link refused: ${result.error}`, ok: result.ok });
      if (!result.ok) fail(result.error, { machineId: machine.id });
      emit({ ok: true, machineId: machine.id }, () => out(`  Linked ${machine.name}. Its harnesses will appear in the pane on the next observation.`));
      return;
    }
    case 'unlink': {
      const machines = await liveMachines();
      const machine = pick(machines, words.slice(1).join(' '));
      const result = await unlinkMachine(machine.id);
      await recordOperation(workspace, { kind: 'unlink', machineId: machine.id, machine: machine.name, detail: result.ok ? `Unlinked ${machine.name}` : `Unlink failed: ${result.error}`, ok: result.ok });
      if (!result.ok) fail(result.error);
      emit({ ok: true, machineId: machine.id }, () => out(`  Unlinked ${machine.name}. It stays on the account; this computer just cannot reach into it.`));
      return;
    }
    case 'links': {
      const result = await listLinks();
      emit({ ok: result.ok, text: result.text }, () => out(result.text));
      return;
    }
    case 'password': {
      const action = words[1] ?? 'status';
      if (action === 'status') {
        const status = await remotePasswordStatus();
        emit({ ok: true, set: status.set }, () => out(status.set
          ? '  This computer has a remote password, so your other machines can link to it.'
          : '  No remote password here. Set one to let another machine link to this computer.'));
        return;
      }
      if (action === 'clear') {
        const result = await clearRemotePassword();
        if (!result.ok) fail(result.error);
        await recordOperation(workspace, { kind: 'password', detail: 'Cleared this computer\'s remote password' });
        emit({ ok: true }, () => out('  Cleared. Machines that linked with it stay linked; new links cannot use it.'));
        return;
      }
      if (action === 'set') {
        if (process.stdin.isTTY) fail('Pipe the new password in: machines password set < ‹the password›. It never goes in an argument.');
        const password = await new Promise(done => { let buffer = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { buffer += chunk; }); process.stdin.on('end', () => done(buffer.trim())); });
        const result = await setRemotePassword(password);
        if (!result.ok) fail(result.error);
        await recordOperation(workspace, { kind: 'password', detail: 'Set this computer\'s remote password' });
        emit({ ok: true }, () => out('  Set. Another machine can now link to this one with it.'));
        return;
      }
      fail('Usage: machines password [status|set|clear]');
      return;
    }
    case 'invite': {
      const status = await remotePasswordStatus();
      const steps = [
        'On the computer you are bringing in:',
        '  1. Install Harness — the app from autonomous.ai/harness, or:',
        '     curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | bash',
        '  2. Sign in to THIS account:  harness login',
        '  3. Let this computer reach it:  harness start && harness remote-password set',
        '',
        'Then it appears on the account by itself, and its remote password links it from here.',
        status.set ? 'This computer already has a remote password, so it can be linked to as well.'
          : 'This computer has no remote password yet, so nothing can link to it. Say the word and I will set one.',
      ];
      emit({ ok: true, steps, remotePasswordSet: status.set }, () => out(steps.join('\n')));
      return;
    }
    case 'watch': {
      const seconds = Number(named('seconds') ?? 300);
      const result = await watchForNewMachine({ seconds });
      if (!result.ok) fail(result.error, { timedOut: result.timedOut === true });
      const arrivals = result.machines.map(row => ({ id: row.machineId, name: row.name || row.hostname || row.machineId.slice(0, 8) }));
      for (const arrival of arrivals) await recordOperation(workspace, { kind: 'joined', machineId: arrival.id, machine: arrival.name, detail: `${arrival.name} signed in` });
      emit({ ok: true, machines: arrivals }, () => out(`  ${arrivals.map(a => a.name).join(', ')} signed in just now.`));
      return;
    }
    case 'remove': {
      const machines = await liveMachines();
      const machine = pick(machines, words.slice(1).join(' '));
      const snapshot = await published();
      const local = snapshot?.localMachineId ?? null;
      if (machine.id === local) fail('That is this computer. Removing it from here would cut the connection you are using; `harness logout` is the way to release it.');
      if (!flags.has('--yes')) fail(`Removing ${machine.name} from the account cannot be undone. Confirm with the person, then run it again with --yes.`);
      const result = await deleteMachine(machine.id);
      if (!result.ok) fail(result.error);
      await recordOperation(workspace, { kind: 'remove', machineId: machine.id, machine: machine.name, detail: `Removed ${machine.name} from the account` });
      emit({ ok: true, machineId: machine.id }, () => out(`  Removed ${machine.name}. It can sign in again at any time and come back as a new machine.`));
      return;
    }
    case 'doctor': {
      const snapshot = await createCollector(workspace)();
      const lines = [];
      lines.push(snapshot.status === 'unavailable' || snapshot.status === 'signed-out'
        ? `miss ${snapshot.message}`
        : `ok   Harness answers on this computer${snapshot.thisComputer?.version ? ` (v${snapshot.thisComputer.version})` : ''}`);
      if (snapshot.account?.email) lines.push(`ok   signed in as ${snapshot.account.email}`);
      if (snapshot.machines.length) lines.push(`ok   ${plural(snapshot.machines.length, 'machine')} on this account, ${snapshot.summary.online} online`);
      // Only a machine that is up and unlinked is something to do now; an offline one is a fact.
      for (const machine of snapshot.machines.filter(m => m.needsLink && m.status !== 'offline')) {
        lines.push(`warn ${machine.name} is online but not linked from this computer`);
      }
      const asleep = snapshot.machines.filter(m => m.status === 'offline').length;
      if (asleep) lines.push(`ok   ${plural(asleep, 'machine')} offline`);
      out(lines.join('\n'));
      process.exit(lines.some(line => line.startsWith('miss')) ? 1 : 0);
      return;
    }
    case 'init': {
      // First run in a fresh workspace: lay down the record and a verdict, so the header has a state
      // before the first prompt. No network is required for this to succeed.
      const record = await readRecord(workspace);
      await writeRecord(workspace, record);
      await writeVerdict(workspace, { status: 'connecting', observedAt: now(), machines: [], summary: {} });
      out('Machines workspace ready.');
      return;
    }
    case 'help': case '--help': case '-h':
      out(usage);
      return;
    default:
      fail(`Unknown command: ${command}\n\n${usage}`);
  }
}

main().catch(error => fail(String(error?.message || error)));
