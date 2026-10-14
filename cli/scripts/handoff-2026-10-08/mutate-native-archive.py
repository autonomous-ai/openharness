"""Saved Resume must preserve a single durable owner across both stores."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
archive = 'src/lib/stoppedAgents.ts'
spec = 'src/lib/nativeArchiveHandoff.spec.ts'
guards = 'src/lib/stoppedAgents.nativeControl.spec.ts'
mutations = [
    ('admission skips archive transfer', registry,
     'archive.transferToLive(transfer, { verifyBefore: verify,',
     '((..._args: unknown[]) => undefined)(transfer, { verifyBefore: verify,', spec,
     'moves saved ownership before admitting'),
    ('archive confirmation forgets its actual publisher', archive,
     'this.uncertainTransfers.set(original.agentId, { bytes, verifyPublished: publication!, verifyDirectory: before.verifyDirectory })\n            retained = this.inspectResumeSource(original)',
     'void publication\n            retained = this.inspectResumeSource(original)', spec, 'first subsequent inspection'),
    ('pending destination forgets its confirmed publisher', registry,
     'pendingPublication = () => { verifyPublished(); verifyDirectory(); written.verify() }',
     'pendingPublication = () => {}', spec, 'entry notifications into phase two'),
    ('pending retry adopts equal bytes from another inode', registry,
     'prior.verifyPublished()', 'void prior', spec, 'pending substitute during its sticky uncertain retry'),
    ('uncertain transfer permits old saved authority', archive,
     'if (this.uncertainTransfers.has(agentId))', 'if (false)', spec, 'uncertain transfer blocks'),
    ('final guard overwrites its changed local owner', registry,
     'const unchanged = () => { sameOwner(); current(); sameOwner() }',
     'const unchanged = () => { sameOwner(); current() }', spec, 'final admission guard'),
    ('final absent-owner guard admits over a new local row', registry,
     'absent(); verifyDirectory(); verifySource(); absent()',
     'absent(); verifyDirectory(); verifySource()', spec, 'absent ownership after the final'),
    ('missing transferred destination is recreated', registry,
     "if (archive.transfer) throw new IdentityReadUnavailable('the original native archive destination is missing')",
     'void archive.transfer', spec, 'never recreates a transferred destination'),
    ('stale peers cannot import unrelated transferred rows', registry,
     'const before = latest.get(id)?.nativeArchive, after = mergedRows.get(id)?.nativeArchive',
     'const before = latest.get(id)?.nativeArchive, after = currentRows.get(id)?.nativeArchive', spec,
     'unrelated stale Registry update'),
    ('legacy envelopes erase their live lineage', archive,
     'if (!session || session.agentId !== agentId || session.nativeArchive || session.nativeRetirement)',
     'if (!session || session.agentId !== agentId)', guards, 'legacy envelope cannot grant'),
    ('native control bypasses the shared envelope decoder', archive,
     '\n    const record = this.decodeRecord(JSON.parse(retained.content!), original.agentId), saved = record.session',
     '\n    const record = JSON.parse(retained.content!), saved = strictPersistedRow(record.session)', guards,
     'holds a transferred archive with legacy-version'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(specs, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=120)


baseline = run([spec, guards])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native archive handoff baseline passed', flush=True)
failures = []
for label, path, before, after, target, pattern in mutations:
    source = cli / path
    original = source.read_text()
    try:
        assert original.count(before) == 1, (label, original.count(before))
        source.write_text(original.replace(before, after))
        result = run([target], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Unproven mutations: ' + ', '.join(failures))
print(f'All {len(mutations)} native archive wiring faults caught by assertions', flush=True)
