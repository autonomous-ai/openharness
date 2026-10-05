#!/usr/bin/env python3
"""Native protocol, packaging, race rejection and disposable-process checks."""
import base64
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'native/darwin-process-images.c'
BUILDER = ROOT / 'scripts/build-process-images.py'
STUB = r'''
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libproc.h>
#include <sys/proc_info.h>

static unsigned births, paths;
static int scenario(const char *name) {
    const char *value = getenv("PROBE_FIXTURE_CASE");
    return value && strcmp(value, name) == 0;
}
int fixture_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
    (void)flavor; (void)arg;
    if (scenario("denied")) { errno = EPERM; return 0; }
    if (scenario("short-info")) return size - 1;
    struct proc_bsdinfo *info = buffer;
    memset(info, 0, sizeof(*info));
    info->pbi_pid = (uint32_t)(pid + (scenario("pid-mismatch") ? 1 : 0));
    info->pbi_start_tvsec = scenario("bad-start") ? 0 : 1770000000;
    info->pbi_start_tvusec = scenario("pid-reused") ? ++births : 123456;
    return sizeof(*info);
}
int fixture_proc_pidpath(int pid, void *buffer, uint32_t size) {
    (void)pid; ++paths;
    if (scenario("missing-second-path") && paths == 2) return 0;
    if (scenario("truncated-path")) { memset(buffer, 'a', size); return (int)size; }
    const char *value = scenario("relative-path") ? "relative"
        : scenario("exec-changed") && paths == 2 ? "/changed"
        : scenario("raw-path") ? "/raw/quote\" line\n slash\\ byte\xff"
        : "/fixture/probe";
    size_t length = strlen(value);
    if (length >= size) return 0;
    memcpy(buffer, value, length + 1);
    return (int)length;
}
'''


def command(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, timeout=30, **kwargs)


@unittest.skipUnless(sys.platform == 'darwin', 'macOS process APIs are required')
class ProcessImagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='harness-process-images-test-')
        cls.root = Path(cls.temporary.name).resolve()
        cls.addClassCleanup(cls.temporary.cleanup)
        artifact = cls.root / 'artifact.json'
        command([sys.executable, str(BUILDER), '--output', str(artifact)])
        cls.artifact = json.loads(artifact.read_text())
        cls.probe = cls.root / 'probe'
        data = base64.b64decode(cls.artifact['base64'], validate=True)
        if hashlib.sha256(data).hexdigest() != cls.artifact['sha256']:
            raise AssertionError('Artifact checksum mismatch')
        cls.probe.write_bytes(data)
        cls.probe.chmod(0o700)
        stub = cls.root / 'stub.c'
        stub.write_text(STUB)
        cls.stub = cls.root / 'stub-probe'
        command(['/usr/bin/xcrun', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
                 '-Dproc_pidinfo=fixture_proc_pidinfo', '-Dproc_pidpath=fixture_proc_pidpath',
                 str(SOURCE), str(stub), '-o', str(cls.stub)])
        sleeper = cls.root / 'sleeper.c'
        sleeper.write_text('#include <stdio.h>\n#include <unistd.h>\n'
                           'int main(void) { puts("ready"); fflush(stdout); '
                           'char c; while (read(0, &c, 1) > 0) {} return 0; }\n')
        cls.sleeper = cls.root / 'renamed 引擎 2.9.0'
        command(['/usr/bin/xcrun', 'clang', '-Wall', '-Wextra', '-Werror',
                 str(sleeper), '-o', str(cls.sleeper)])

    def setUp(self):
        self.children = []
        self.addCleanup(self.stop_children)

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
        for child in self.children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            for stream in [child.stdin, child.stdout, child.stderr]:
                if stream:
                    stream.close()

    def launch(self, argv):
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
        self.children.append(child)
        return child

    def wait_ready(self, child):
        self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'Fixture failed to become ready')
        self.assertEqual(child.stdout.readline(), b'ready\n')

    def probe_pids(self, pids, *, stub=False, case='stable'):
        result = command([str(self.stub if stub else self.probe), '--paths', *map(str, pids)],
                         env={**os.environ, 'PROBE_FIXTURE_CASE': case, 'LC_ALL': 'fr_FR.UTF-8'})
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(records.pop(0), {'schema': 1, 'mode': 'paths'})
        self.assertEqual([row['pid'] for row in records], list(pids))
        return records

    def test_universal_artifact_and_signature_survive_embedding(self):
        self.assertEqual(self.artifact['architectures'], ['arm64', 'x86_64'])
        self.assertEqual(self.artifact['size'], self.probe.stat().st_size)
        self.assertEqual(self.artifact['sourceSha256'], hashlib.sha256(SOURCE.read_bytes()).hexdigest())
        self.assertEqual(self.artifact['builderSha256'], hashlib.sha256(BUILDER.read_bytes()).hexdigest())
        self.assertEqual(sorted(command(['/usr/bin/lipo', str(self.probe), '-archs']).stdout.split()),
                         [b'arm64', b'x86_64'])
        command(['/usr/bin/codesign', '--verify', '--strict', '--all-architectures', str(self.probe)])

    def test_invalid_arguments_are_rejected_before_output(self):
        for argv in [[], ['--paths'], ['--table', '7'], ['--paths', '7', 'bad'],
                     ['--paths', '+7'], ['--paths', '-1'], ['--paths', '0'],
                     ['--paths', ' 7'], ['--paths', '7\n'], ['--paths', '2147483648'],
                     ['--paths', '9' * 100], ['--paths', *['7'] * 4097]]:
            with self.subTest(argv=argv[:3]):
                result = subprocess.run([str(self.stub), *argv], capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 64)
                self.assertEqual(result.stdout, b'')

    def test_unavailable_racing_or_incomplete_identities_are_not_reported_as_paths(self):
        for case in ['denied', 'short-info', 'pid-mismatch', 'pid-reused', 'exec-changed',
                     'missing-second-path', 'truncated-path', 'relative-path', 'bad-start']:
            with self.subTest(case=case):
                self.assertEqual(self.probe_pids([7], stub=True, case=case),
                                 [{'pid': 7, 'unavailable': True}])

    def test_paths_preserve_raw_bytes_without_breaking_json(self):
        [row] = self.probe_pids([7], stub=True, case='raw-path')
        self.assertEqual(bytes.fromhex(row['imageHex']), b'/raw/quote" line\n slash\\ byte\xff')
        self.assertEqual(row['startSeconds'], 1770000000)
        self.assertEqual(row['startMicros'], 123456)
        self.assertRegex(row['startMarker'], r'^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$')

    def test_real_renamed_unicode_symlink_hardlink_and_newline_paths(self):
        alias = self.root / 'agent alias'
        alias.symlink_to(self.sleeper)
        hard = self.root / 'hard link'
        os.link(self.sleeper, hard)
        strange = self.root / 'quote" newline\nimage'
        os.link(self.sleeper, strange)
        children = [self.launch([str(path)]) for path in [self.sleeper, alias, hard, strange]]
        for child in children:
            self.wait_ready(child)
        expected = self.sleeper.stat()
        for row in self.probe_pids([child.pid for child in children]):
            actual = os.stat(bytes.fromhex(row['imageHex']))
            self.assertEqual((actual.st_dev, actual.st_ino), (expected.st_dev, expected.st_ino))

    def test_same_pid_exec_gets_fresh_image_and_exit_has_no_identity(self):
        child = self.launch(['/bin/sh', '-c', 'printf "ready\\n"; read -r line; exec "$1"',
                             'harness-process-images-fixture', str(self.sleeper)])
        self.wait_ready(child)
        [before] = self.probe_pids([child.pid])
        old = os.stat(bytes.fromhex(before['imageHex']))
        # macOS can launch /bin/bash from /bin/sh. Compare the actual legacy
        # reader, rather than assuming the launch pathname is the current image.
        text_files = command(['/usr/sbin/lsof', '-b', '-a', '-p', str(child.pid),
                              '-d', 'txt', '-Fn']).stdout.splitlines()
        first_text_path = next(line[1:] for line in text_files if line.startswith(b'n/'))
        shell = os.stat(first_text_path)
        self.assertEqual((old.st_dev, old.st_ino), (shell.st_dev, shell.st_ino))
        child.stdin.write(b'go\n')
        child.stdin.flush()
        self.wait_ready(child)
        [after] = self.probe_pids([child.pid])
        native = os.stat(bytes.fromhex(after['imageHex']))
        self.assertEqual(native.st_ino, self.sleeper.stat().st_ino)
        self.assertNotEqual(before['imageHex'], after['imageHex'])
        for key in ['startMarker', 'startSeconds', 'startMicros']:
            self.assertEqual(before[key], after[key])
        child.stdin.close()
        child.wait(timeout=5)
        self.assertEqual(self.probe_pids([child.pid]), [{'pid': child.pid, 'unavailable': True}])

    def test_start_marker_matches_ps_despite_inherited_nonenglish_locale(self):
        [row] = self.probe_pids([os.getpid()])
        expected = command(['/bin/ps', '-p', str(os.getpid()), '-o', 'lstart='],
                           env={**os.environ, 'LC_ALL': '', 'LC_TIME': 'C'}).stdout.decode().strip()
        self.assertEqual(row['startMarker'], expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
