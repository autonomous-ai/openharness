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
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>

static unsigned births, paths, commands, lists;
static int scenario(const char *name) {
    const char *value = getenv("PROBE_FIXTURE_CASE");
    return value && strcmp(value, name) == 0;
}
int fixture_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
    if (scenario("denied")) { errno = EPERM; return 0; }
    if (scenario("short-info")) return size - 1;
    if (flavor == PROC_PIDLISTFDS) {
        lists++;
        if (scenario("short-fds")) return 1;
        if (scenario("full-fds")) return size;
        struct proc_fdinfo *fds = buffer;
        fds[0].proc_fd = 3; fds[0].proc_fdtype = PROX_FDTYPE_VNODE;
        if (scenario("fd-changed") && lists > 1) fds[0].proc_fd = 4;
        return sizeof(*fds);
    }
    struct proc_bsdinfo *info = buffer;
    memset(info, 0, sizeof(*info));
    info->pbi_pid = (uint32_t)(pid + (scenario("pid-mismatch") ? 1 : 0));
    info->pbi_start_tvsec = scenario("bad-start") ? 0 : 1770000000;
    info->pbi_start_tvusec = scenario("pid-reused") ? ++births : 123456;
    info->pbi_ppid = pid == 7 ? 1 : 7;
    info->pbi_status = pid == 8 && scenario("zombie-child") ? SZOMB : SRUN;
    if (info->pbi_status == SZOMB && !arg) { errno = ESRCH; return 0; }
    info->pbi_nfiles = scenario("fd-capacity-grew") && lists ? 64 : 32;
    memcpy(info->pbi_comm, "fixture", 8);
    return sizeof(*info);
}
int fixture_proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int size) {
    (void)pid; (void)fd; (void)flavor;
    if (scenario("fd-denied")) { errno = EPERM; return 0; }
    struct vnode_fdinfo *info = buffer;
    memset(info, 0, sizeof(*info));
    info->pvi.vi_stat.vst_mode = S_IFREG;
    info->pvi.vi_stat.vst_dev = 17;
    info->pvi.vi_stat.vst_ino = 9007199254740993ULL;
    return size;
}
int fixture_proc_listchildpids(pid_t parent, void *buffer, int size) {
    (void)parent; (void)size;
    if (scenario("children-full")) return 33;
    if (scenario("children-denied")) { errno = EPERM; return -1; }
    if (scenario("zombie-child")) { ((pid_t *)buffer)[0] = 8; return 1; }
    return 0;
}
int fixture_sysctl(int *name, unsigned int count, void *buffer, size_t *size, void *value, size_t value_size) {
    (void)name; (void)count; (void)value; (void)value_size;
    if (scenario("command-denied")) { errno = EPERM; return -1; }
    if (scenario("command-full")) { memset(buffer, 0, *size); return 0; }
    unsigned char *out = buffer;
    int argc = 1;
    memcpy(out, &argc, sizeof(argc));
    const char data[] = "/fixture/probe\0\0fixture\0FIXTURE_SECRET=never-output\0";
    memcpy(out + sizeof(argc), data, sizeof(data));
    *size = sizeof(argc) + sizeof(data);
    if (scenario("command-changed") && ++commands > 1) out[sizeof(argc) + 16] = 'x';
    return 0;
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
                 '-Dproc_pidfdinfo=fixture_proc_pidfdinfo', '-Dproc_listchildpids=fixture_proc_listchildpids',
                 '-Dsysctl=fixture_sysctl',
                 str(SOURCE), str(stub), '-o', str(cls.stub)])
        sleeper = cls.root / 'sleeper.c'
        sleeper.write_text('#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n'
                           'int main(int argc, char **argv) { (void)argc; '
                           'puts("ready"); fflush(stdout); char c; while (read(0, &c, 1) > 0) { '
                           'if (c == \'t\') { size_t n = strlen(argv[0]); if (n >= 5) { '
                           'memset(argv[0], 0, n); memcpy(argv[0], "codex", 5); } '
                           'puts("ready"); fflush(stdout); } } return 0; }\n')
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

    def launch(self, argv, **kwargs):
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, **kwargs)
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

    def control(self, pids, parent=0, *, stub=False, case='stable', okay=True):
        result = subprocess.run([str(self.stub if stub else self.probe), '--control', '2000', str(parent), *map(str, pids)],
                                capture_output=True, timeout=5, env={**os.environ, 'PROBE_FIXTURE_CASE': case})
        if not okay:
            self.assertEqual(result.returncode, 75)
            self.assertEqual(result.stdout, b'')
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(records.pop(0), {'schema': 2, 'mode': 'control', 'parent': parent, 'children': []})
        self.assertEqual([row['pid'] for row in records], pids)
        return records

    def test_control_protocol_preserves_lossless_keys_and_never_emits_argument_or_environment_strings(self):
        [row] = self.control([7], stub=True)
        self.assertEqual(row['fds'], [{'fd': 3, 'type': 1, 'mode': 32768, 'device': '17', 'inode': '9007199254740993'}])
        self.assertRegex(row['commandDigest'], '^[a-f0-9]{64}$')
        self.assertNotIn('argvHex', row)
        self.assertNotIn('argc', row)
        self.assertNotIn('SECRET', json.dumps(row))

    def test_control_holds_partial_changed_denied_and_capacity_truncated_evidence(self):
        for case in ['denied', 'short-info', 'pid-mismatch', 'pid-reused', 'exec-changed',
                     'missing-second-path', 'truncated-path', 'relative-path', 'bad-start',
                     'short-fds', 'full-fds', 'fd-changed', 'fd-denied', 'fd-capacity-grew',
                     'children-full', 'children-denied', 'command-denied', 'command-full', 'command-changed']:
            with self.subTest(case=case):
                self.control([7], parent=7, stub=True, case=case, okay=False)

    def test_control_excludes_a_proven_unreaped_zombie(self):
        self.control([7], parent=7, stub=True, case='zombie-child')

    def test_control_reads_a_private_process_with_empty_argv_without_exposing_environment(self):
        child = self.launch([''], executable=str(self.sleeper), env={**os.environ, 'PRIVATE_FIXTURE_SECRET': 'never-output'})
        self.wait_ready(child)
        [row] = self.control([child.pid])
        self.assertRegex(row['commandDigest'], '^[a-f0-9]{64}$')
        self.assertNotIn('PRIVATE_FIXTURE_SECRET', json.dumps(row))
        self.assertNotIn('argvHex', row)

    def test_control_retains_same_process_generation_and_fd_file_identity(self):
        child = self.launch([str(self.sleeper)])
        self.wait_ready(child)
        [first] = self.control([child.pid])
        [second] = self.control([child.pid])
        self.assertEqual(first, second)
        self.assertTrue(any(fd['type'] == 6 for fd in first['fds']))

    def test_control_fences_a_rewritten_title_without_inventing_argv_boundaries(self):
        child = self.launch([str(self.sleeper), 'original-argument'], env={**os.environ, 'PRIVATE_FIXTURE_SECRET': 'never-output'})
        self.wait_ready(child)
        [before] = self.control([child.pid])
        child.stdin.write(b't'); child.stdin.flush(); self.wait_ready(child)
        [after] = self.control([child.pid])
        self.assertNotEqual(before['commandDigest'], after['commandDigest'])
        for key in ['pid', 'parentPid', 'startSeconds', 'startMicros', 'imageHex', 'fds']:
            self.assertEqual(before[key], after[key])
        self.assertNotIn('argvHex', after)
        self.assertNotIn('PRIVATE_FIXTURE_SECRET', json.dumps(after))

    def test_control_rejects_invalid_requests_before_output(self):
        for args in [[], ['0', '0', '7'], ['3001', '0', '7'], ['1', '0', '7', '7'], ['100', '0', 'bad'],
                     ['100', '0', *map(str, range(1, 35))]]:
            with self.subTest(args=args[:4]):
                result = subprocess.run([str(self.stub), '--control', *args], capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 64)
                self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main(verbosity=2)
