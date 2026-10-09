"""Each broken native-control connection must fail an assertion in a disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
location = 'src/engines/kit/sessionLocation.ts'
spec = 'src/engines/kit/sessionLocation.spec.ts'
polling = 'src/engines/kit/transcriptDiscovery.ts'
poll_spec = 'src/engines/kit/transcriptDiscovery.spec.ts'
golden = 'src/engines/nativeLocation.golden.spec.ts'
mutations = [
    ('unreadable metadata is absent', location, "if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null", 'return null', spec),
    ('first transcript wins', location, '    selected ??= { path, info, workspace }', '    return path', spec),
    ('selected Grok workspace not rechecked', location, 'if (selected.workspace) await verifyWorkspace(selected.workspace)', 'if (false) await verifyWorkspace(selected.workspace!)', spec),
    ('selected Cursor path not revalidated', location, 'if (options.valid && !options.valid(selected.path))', 'if (false)', spec),
    ('unreadable Cursor validation is rejection', 'src/lib/registry.ts', "if (strict) throw new IdentityReadUnavailable('the transcript path could not be validated')", 'if (false) throw new Error()', 'src/lib/nativeLocations.control.spec.ts'),
    ('Copilot bind claim not revalidated', 'src/core/agents/bind.ts', "if (await processSessionOf('copilot', homes.copilot, observed.processIdentity.pid) !== next)", 'if (false)', 'src/lib/nativeLocations.control.spec.ts'),
    ('Copilot repair claim not revalidated', 'src/lib/sessionRepair.ts', "if (await nativeProcessSession('copilot', env.COPILOT_HOME, opts!.pid!) !== locked)", 'if (false)', 'src/lib/nativeLocations.control.spec.ts'),
    ('agy repair claim not revalidated', 'src/lib/sessionRepair.ts', "if (await nativeProcessSession('agy', env.AGY_HOME, pid) !== conversationId)", 'if (false)', 'src/lib/nativeLocations.control.spec.ts'),
    ('shared listing loses its authority', location, "if (signature(await inspect(root)) !== proof.signature)", 'if (false)', spec),
    ('new transcript ignored', location, "if (file.path !== selected?.path && fileIdentity(await fileInfo(file.path)) !== fileIdentity(file.info))", 'if (false)', spec),
    ('tied process locks accepted', location, 'if (tied) throw', 'if (false) throw', spec),
    ('selected process claim not rechecked', location, 'if (best && signature(await fileInfo(best.path)) !== signature(best.info))', 'if (false)', spec),
    ('new process directories ignored', location, "if (signature(await inspect(root)) !== before) throw new IdentityReadUnavailable('the native session directories", "if (false) throw new IdentityReadUnavailable('the native session directories", spec),
    ('first held lock wins', location, 'if (ids.size > 1)', 'if (false)', spec),
    ('partial process output accepted', location, "if (Buffer.byteLength(out) > DESCRIPTOR_BYTES || (out && !out.endsWith('\\n')))", 'if (false)', spec),
    ('new descriptors ignored', location, "if (names.sort().join('\\0') !== descriptors.map(entry => entry.name).sort().join('\\0'))", 'if (false)', spec),
    ('initial lookup stays busy forever', polling, '      candidate.looking = false\n      this.schedule()', '      candidate.looking = true\n      this.schedule()', poll_spec),
    ('failed candidate aborts its siblings', polling, '        } catch (error) { this.hold(id, candidate, error) }', '        } catch (error) { throw error }', poll_spec),
    ('native read failure escapes binding', 'src/core/agents/bind.ts', '        return null\n      }\n    }\n    const mayClaim', '        throw error\n      }\n    }\n    const mayClaim', 'src/core/agents/bind.spec.ts'),
    ('Cursor declaration disconnected', 'src/engines/cursor/contract.ts', "folder: 'agent-transcripts'", "folder: 'missing-transcripts'", golden),
    ('Copilot process declaration disconnected', 'src/engines/copilot/contract.ts', "prefix: 'inuse.'", "prefix: 'missing.'", golden),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for name in ['TMUX', 'TMUX_PANE', 'RECORD_NATIVE_LOCATION_GOLDEN', 'RECORD_OTHER_ENGINES_GOLDEN']:
    env.pop(name, None)


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=2'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run(list(dict.fromkeys(item[4] for item in mutations)))
if baseline.returncode:
    print(baseline.stdout + baseline.stderr)
    raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, target in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([target])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            print(output)
            raise SystemExit(f'{label}: not caught by an assertion')
        print(f'{label}: caught by assertion', flush=True)
    finally:
        path.write_text(original)
