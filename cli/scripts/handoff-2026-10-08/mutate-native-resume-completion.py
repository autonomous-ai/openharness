"""Resume metadata cleanup needs original durable completion, never fresh dispatch."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
archive = 'src/lib/stoppedAgents.ts'
marker = 'src/lib/nativeResumeMarker.ts'
receipt = 'src/lib/agentCreationReceipt.ts'
archive_spec = 'src/lib/nativeArchiveReturn.spec.ts'
marker_spec = 'src/lib/nativeResumeMarker.spec.ts'
receipt_spec = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
mutations = [
    ('created cleanup ignores original permissions', archive, '        && creationFingerprint(nativeRearmRequest(record.session.nativeControl)) === creationFingerprint(receipt.request)', '', archive_spec, 'created receipt has'),
    ('cleanup accepts unknown dispatch outcomes', receipt, "if (!created && !undispatched) throw new AgentCreationReceiptError('CREATION_CONFLICT')", "if (false) throw new AgentCreationReceiptError('CREATION_CONFLICT')", receipt_spec, 'holds uncertain receipt'),
    ('direct success substitutes for explicit native confirmation', receipt, '      && !!confirmation && !!process', '', receipt_spec, 'holds direct-success receipt'),
    ('cleanup forgets immutable receipt inode', receipt, 'for (const part of retained) part.verify()', 'void retained', receipt_spec, 'pins original .*receipt evidence'),
    ('cleanup omits receipt durability', receipt, 'inspectNativeControlFile(files[index], this.directory).confirm(verify)', 'verify()', receipt_spec, 'confirms the exact receipt files and parent'),
    ('cleanup accepts substitute directory descriptor', marker, "if (identity(fstatSync(fd, { bigint: true })) !== original) throw Error('The original native Resume directory descriptor changed.')", 'void fd', marker_spec, 'does not fsync a substitute directory'),
    ('cleanup loses parent when unlink reports after-effect failure', marker, "      this.uncertain.set(link.agentId, { kind: 'remove', link, directory, verifyPublished: published })", '', marker_spec, 'unlink takes effect and then reports'),
    ('cleanup adopts a substitute for its surviving marker', marker, 'const published = prior?.verifyPublished ?? (() => { before.verify(); retained.verify() })', 'const published = (() => { before.verify(); retained.verify() })', marker_spec, 'equal replacement for the surviving marker'),
    ('cleanup skips post-close absence', marker, '  } finally { closeSync(fd) }\n  verify()', '  } finally { closeSync(fd) }', marker_spec, 'checks post-sync absence'),
    ('retry adopts a substitute uncertain parent', marker, 'const directory = prior?.directory ?? parentProof(this.directory, file)', 'const directory = parentProof(this.directory, file)', marker_spec, 'pins the original directory through uncertain finish'),
    ('missing saved owner clears unreadable reservation', archive, 'if (!saved || saved.nativeControl || token !== undefined) throw error', 'if (saved?.nativeControl || token !== undefined) throw error', archive_spec, 'unreadable marker without its saved owner'),
    ('native marker uses generic cleanup', archive, "if (value && typeof value === 'object' && Object.hasOwn(value, 'nativeArchive')) {", 'if (false) {', archive_spec, 'using legacy cleanup, generic authority'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(specs, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=240)


baseline = run([archive_spec, marker_spec, receipt_spec])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native Resume completion baseline passed', flush=True)
failures = []
for label, path, before, after, target, pattern in mutations:
    source = cli / path
    original = source.read_text()
    try:
        assert original.count(before) == (2 if label in ['cleanup forgets immutable receipt inode', 'retry adopts a substitute uncertain parent'] else 1), (label, original.count(before))
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
print(f'All {len(mutations)} native Resume completion wiring faults caught by assertions', flush=True)
