#!/usr/bin/env python3
"""Helpers for the Windows desktop end to end (docs/testing/windows-desktop-e2e.md), run on the Mac as
`python3 -I e2e_tools.py <command>`. Standard library only. desktop-e2e.sh calls them; test_e2e_tools.py pins them.

  redact                                     stdin to stdout: ids to their short form; no email, token or Mac path
  args-b64 <Name>=<value> ...                a script's parameters as base64 JSON, for invoke.ps1 and session-run.ps1
  zip-info <zip>                             version, arch, and whether the app folder has harness-desktop.exe
  zip-variant <no-exe|no-start> <zip> <version> --out-dir <dir>   a broken build made from a good zip
  truncate <zip> --out-dir <dir>             the first half of the zip: a download cut short
  layout <version> <arch>                    where staging keeps a desktop zip and the manifest, as name=value lines
  verify <manifest.json> <arch> <zip>        the zip against the manifest's entry for it
  cdn-stage <root> <arch>=<zip>[@<claimed zip>] ...   the fake CDN's desktop objects and manifest
  compare-runs <base> <head>                 the desktop suite, test by test (test-desktop.py receipts or JSON logs)
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
import uuid
from pathlib import Path

CDN_HOST = 'cdn.autonomous.ai'
STORAGE_BASE = 'https://storage.googleapis.com/s3-autonomous-upgrade-3'
STAGING_PREFIX = 'harness/staging/desktop'
EXE = 'harness-desktop.exe'
ARCHES = ('x64', 'arm64')
ZIP_NAME = re.compile(r'^harness-desktop-(?P<version>.+)-windows-(?P<arch>x64|arm64)\.zip$')
VERSION = re.compile(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$')
# What each broken build lacks: no executable (the launcher's first rollback case), or the AOT snapshot, so the
# runner exits at once and never draws a frame (the "two starts within 10 s without .started" case).
DROPS = {'no-exe': EXE, 'no-start': 'data/app.so'}

# --- redaction --------------------------------------------------------------------------------------------------

# Order matters: whole credentials first, then emails, then ids. A short id keeps its first 8 characters, as the
# CLI's own output and windows-cli-e2e.md write them.
_RULES = [
    (re.compile(r'(?i)(x-harness-(?:auth|proof):)\s*\S+'), r'\1 <redacted>'),
    (re.compile(r'(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+'), 'Bearer <token>'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'), '<token>'),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b'), '<email>'),
    (re.compile(r'(?i)\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b'), r'\1…'),
    (re.compile(r'\bS-1-5-21-\d+-\d+-\d+-(\d+)\b'), r'S-1-5-21-…-\1'),
    (re.compile(r'(?i)\b([0-9a-f]{8})[0-9a-f]{24,}\b'), r'\1…'),
]


def redact(text, home=None):
    """[text] fit for the public evidence: no credential, no email, ids short, the Mac's home written `~`."""
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    home = str(Path.home()) if home is None else home
    if home and home != '/':
        text = text.replace(home, '~')
    return text


# --- parameters for the VM-side scripts ---------------------------------------------------------------------------

_ARG_NAME = re.compile(r'^[A-Za-z][A-Za-z0-9]*$')


def args_b64(pairs):
    """`Name=value` pairs as base64 of a JSON object. A value starting with [ or { is JSON (an array parameter)."""
    params = {}
    for pair in pairs:
        name, sep, value = pair.partition('=')
        if not sep or not _ARG_NAME.match(name):
            raise ValueError(f'expected <Name>=<value>: {pair}')
        if name in params:
            raise ValueError(f'{name} is given twice')
        params[name] = json.loads(value) if value[:1] in ('[', '{') else value
    return base64.b64encode(json.dumps(params, ensure_ascii=False).encode('utf-8')).decode('ascii')


def ps_b64(source):
    """PowerShell source for OpenSSH's EncodedCommand; no source crosses cmd's parser."""
    return base64.b64encode(source.encode('utf-16le')).decode('ascii')


def record_port(record):
    """Read a user's actual loopback port; a missing record never means the shared default."""
    port = record.get('port') if isinstance(record, dict) else None
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('this test user has no valid daemon port record; start its own daemon first')
    return port


def owned_user(record, user, run_id):
    """Require the creation receipt, not merely an account name that looks disposable."""
    if (not isinstance(record, dict) or record.get('run_id') != run_id
            or record.get('user') != user or record.get('created') is not True
            or not re.fullmatch(r'hx[a-z0-9]+', user)
            or not re.fullmatch(r'[0-9a-f]{32}', run_id)
            or not re.fullmatch(r'S-1-5-21-(?:\d+-){3}\d+', record.get('sid', ''))
            or not record.get('profile')):
        raise ValueError('no matching new-user ownership receipt; preexisting accounts are never adopted')
    return record


def compare_baseline(before, after):
    """List disappeared/replaced preexisting identities; new test objects are permitted."""
    changes = []
    for name, fields in (('processes', ('ProcessId', 'CreationDate', 'Name')),
                         ('tasks', ('TaskPath', 'TaskName'))):
        current = {tuple(item.get(f) for f in fields) for item in after.get(name, [])}
        for item in before.get(name, []):
            key = tuple(item.get(f) for f in fields)
            if key not in current:
                changes.append(f'preexisting {name} identity no longer present: {key}')
    listeners = {' '.join(line.split()) for line in after.get('listeners', [])}
    for line in before.get('listeners', []):
        if ' '.join(line.split()) not in listeners:
            changes.append(f'preexisting listener no longer present: {line}')
    return changes


# --- zips ------------------------------------------------------------------------------------------------------

def _norm(name):
    return name.replace('\\', '/')


def zip_info(path):
    """What a desktop zip holds (the install layout: Harness.exe, Harness.ico, current, app\\<ver>\\)."""
    path = Path(path)
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        entries = {_norm(i.filename): i for i in infos}
        if 'current' not in entries:
            raise ValueError(f'{path.name} has no current pointer at its root')
        raw = zf.read(entries['current'])
        backslashes = any('\\' in i.filename for i in infos)
    version = raw.decode('utf-8-sig').strip()
    if not VERSION.match(version):
        raise ValueError(f'{path.name}: current names {version!r}, not a version')
    for required in ('Harness.exe', 'Harness.ico', f'app/{version}/harness_pipe_io.dll'):
        if required not in entries or entries[required].is_dir():
            raise ValueError(f'{path.name}: missing {required}')
    folders = sorted({n.split('/')[1] for n in entries if n.startswith('app/') and len(n.split('/')) > 2 and n.split('/')[1]})
    match = ZIP_NAME.match(path.name)
    return {
        'file': path.name,
        'version': version,
        'name_version': match['version'] if match else None,
        'arch': match['arch'] if match else None,
        'app_folders': folders,
        'has_launcher': 'Harness.exe' in entries,
        'has_exe': f'app/{version}/{EXE}' in entries,
        'has_icon': 'Harness.ico' in entries,
        'has_pipe_io': f'app/{version}/harness_pipe_io.dll' in entries,
        'current_bom': raw.startswith(b'\xef\xbb\xbf'),
        'backslashes': backslashes,
        'entries': len(infos),
    }


def zip_variant(kind, src, version, out_dir):
    """A broken build at [version] made from a good zip: its app folder renamed and `current` rewritten (a version
    cannot be restamped without a build, and the updater takes only a strictly newer one), minus DROPS[kind]."""
    if kind not in DROPS:
        raise ValueError(f'the kind is one of {", ".join(sorted(DROPS))}: {kind}')
    if not VERSION.match(version):
        raise ValueError(f'not a version: {version}')
    info = zip_info(src)
    if not info['arch']:
        raise ValueError(f'{Path(src).name} is not named harness-desktop-<version>-windows-<arch>.zip')
    old = info['version']
    if version == old:
        raise ValueError('a broken build needs another version than the good one it is made from')
    dst = Path(out_dir) / f'harness-desktop-{version}-windows-{info["arch"]}.zip'
    dst.parent.mkdir(parents=True, exist_ok=True)
    was, now = f'app/{old}/', f'app/{version}/'
    drop = now + DROPS[kind]
    dropped = False
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w') as zout:
        for entry in zin.infolist():
            name = _norm(entry.filename)
            data = zin.read(entry)
            if name == 'current':
                text = data.decode('utf-8-sig')
                data = (version + ('\r\n' if text.endswith('\r\n') else '\n')).encode('utf-8')
            elif name.startswith(was):
                name = now + name[len(was):]
            if name == drop:
                dropped = True
                continue
            # The source's separator style is kept, so only the version and the dropped file differ.
            out = zipfile.ZipInfo(name.replace('/', '\\') if '\\' in entry.filename else name, date_time=entry.date_time)
            out.compress_type, out.external_attr, out.create_system = entry.compress_type, entry.external_attr, entry.create_system
            zout.writestr(out, data)
    if not dropped:
        dst.unlink()
        raise ValueError(f'{Path(src).name} has no {DROPS[kind]} in {was}: nothing to break')
    return dst


def truncate(src, out_dir):
    """The first half of [src]'s bytes, under the same name in [out_dir]: what a download cut short leaves."""
    src = Path(src)
    dst = Path(out_dir) / src.name
    if dst.resolve() == src.resolve():
        raise ValueError('the cut copy must go to another folder than its source')
    dst.parent.mkdir(parents=True, exist_ok=True)
    data = src.read_bytes()
    dst.write_bytes(data[:len(data) // 2])
    return dst


# --- staging and the fake CDN --------------------------------------------------------------------------------------

def _prefix():
    prefix = os.environ.get('STAGING_DESKTOP_PREFIX', STAGING_PREFIX).strip('/')
    if not re.fullmatch(r'harness/staging(?:/[A-Za-z0-9_-]+)+', prefix):
        raise ValueError('the desktop prefix must stay under harness/staging with plain path segments')
    return prefix


def layout(version, arch):
    """Where the staging release keeps a zip, and the manifest an app built for staging reads."""
    if arch not in ARCHES:
        raise ValueError(f'the arch is x64 or arm64: {arch}')
    if not VERSION.match(version):
        raise ValueError(f'not a version: {version}')
    base = _prefix()
    name = f'harness-desktop-{version}-windows-{arch}.zip'
    obj = f'{base}/{version}/{name}'
    manifest = f'{base}/metadata.json'
    return {
        'zip_name': name, 'zip_object': obj, 'zip_url': f'https://{CDN_HOST}/{obj}',
        'manifest_object': manifest, 'manifest_url': f'{STORAGE_BASE}/{manifest}', 'manifest_key': f'desktop-windows-{arch}',
    }


def verify(manifest, arch, zip_path):
    """(ok, sentence): a zip of the version the manifest offers must have its sha256 and size."""
    key = f'desktop-windows-{arch}'
    entry = (manifest or {}).get(key)
    info = zip_info(zip_path)
    if not isinstance(entry, dict):
        return True, f'the manifest offers no {key}: {info["file"]} is not checked against it'
    if entry.get('version') != info['version']:
        return True, f'the manifest offers {key} {entry.get("version")}, not {info["version"]}: not checked against it'
    body = Path(zip_path).read_bytes()
    sha = hashlib.sha256(body).hexdigest()
    problems = [what for what, same in (('sha256', sha == entry.get('sha256')), ('size', len(body) == entry.get('size'))) if not same]
    if problems:
        return False, f'{info["file"]} does not match {key} {info["version"]}: {", ".join(problems)} differ'
    return True, f'{info["file"]} matches {key} {info["version"]} (sha256 {sha[:8]}…, {len(body)} bytes)'


def cdn_stage(root, specs):
    """Lay out the fake CDN's desktop folder under [root] and its manifest. Each spec is `<arch>=<served>` or
    `<arch>=<served>@<claimed>`: the manifest names the claimed zip's version, sha256 and size, and the served bytes
    are what a download gets (a cut copy of the claimed zip, for the download check). The folder is emptied first."""
    root = Path(root)
    base = _prefix()
    manifest = {}
    objects = []
    for spec in specs:
        arch, sep, rest = spec.partition('=')
        if not sep or arch not in ARCHES or not rest:
            raise ValueError(f'expected <arch>=<zip>[@<claimed zip>]: {spec}')
        served, _, claimed = rest.partition('@')
        claimed = claimed or served
        key = f'desktop-windows-{arch}'
        if key in manifest:
            raise ValueError(f'{key} is given twice')
        info = zip_info(claimed)
        if info['arch'] != arch:
            raise ValueError(f'{Path(claimed).name} is not a {arch} zip')
        where = layout(info['version'], arch)
        target = root / where['zip_object']
        objects.append((target, Path(served).read_bytes()))
        body = Path(claimed).read_bytes()
        manifest[key] = {'version': info['version'], 'url': where['zip_url'], 'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body)}
    # Validate/read every input before replacing an existing owned layout.
    if (root / base).exists():
        shutil.rmtree(root / base)
    for target, body in objects:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    out = root / f'{base}/metadata.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    return manifest


# --- the desktop suite, test by test -------------------------------------------------------------------------------

def _logs(path):
    path = Path(path)
    if path.suffix != '.json':
        return None, [path], None
    try:
        receipt = json.loads(path.read_text(encoding='utf-8-sig'))
    except ValueError:
        return None, [path], None  # A newline-delimited reporter can also be named .json.
    if not isinstance(receipt, dict) or 'checks' not in receipt:
        return None, [path], None
    if not isinstance(receipt['checks'], list) or not receipt['checks']:
        raise ValueError(f'{path}: receipt has no test attempts')
    logs = []
    for check in receipt['checks']:
        log = Path(check.get('log', ''))
        if not log.is_file():
            log = path.parent / log.name
        if not log.is_file():
            raise ValueError(f'{path}: the log of {check.get("name")} is missing')
        logs.append(log)
    return receipt.get('desktop_root'), logs, receipt.get('selected_files')


def _relative(path, root):
    path = str(path).replace('\\', '/')
    root = str(root).replace('\\', '/') if root else None
    if root and path.startswith(root.rstrip('/') + '/'):
        return path[len(root.rstrip('/')) + 1:]
    at = path.rfind('/desktop/')
    return path[at + len('/desktop/'):] if at >= 0 else path


def test_results(path):
    """Test results from complete attempts only. A completed loader retry replaces its earlier result.

    Unknown reporter errors, missing completions/inventory and empty input are unavailable evidence,
    not a successful comparison. A complete failing run remains usable, regardless of verified_files.
    """
    root, logs, selected = _logs(path)
    results, reported_files = {}, set()
    for log in logs:
        suites, tests, seen, ended, errors, done = {}, {}, {}, set(), set(), []
        counts, test_suites, completions, loaders, loader_errors = {}, {}, {}, set(), set()
        for line in log.read_text(errors='replace').splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue  # Flutter writes ordinary build/progress lines too.
            if not isinstance(event, dict):
                continue
            kind = event.get('type')
            try:
                if kind == 'suite':
                    suite = event['suite']
                    if suite['id'] in suites:
                        raise ValueError('duplicate suite')
                    suites[suite['id']] = _relative(suite['path'], root)
                    reported_files.add(suites[suite['id']])
                elif kind == 'group':
                    group = event['group']
                    if group['parentID'] is None:
                        sid = group['suiteID']
                        if sid in counts or type(group['testCount']) is not int or group['testCount'] < 0:
                            raise ValueError('invalid or duplicate root group inventory')
                        counts[sid] = group['testCount']
                elif kind == 'testStart':
                    test = event['test']
                    if test['id'] in tests or test.get('suiteID') not in suites:
                        raise ValueError('duplicate test or unknown suite')
                    name = test.get('name', '')
                    if name.startswith('loading ') and _relative(name[len('loading '):], root) == suites[test['suiteID']]:
                        loaders.add(test['id'])
                    name = '<loading>' if name.startswith('loading ') else name
                    key = (suites[test['suiteID']], name)
                    seen[key] = seen.get(key, 0) + 1
                    if seen[key] > 1:
                        key = (key[0], f'{name} #{seen[key]}')
                    tests[test['id']] = key
                    test_suites[test['id']] = test['suiteID']
                    results[key] = 'incomplete'
                elif kind == 'testDone':
                    tid = event['testID']
                    if (tid not in tests or tid in ended or event.get('result') not in ('success', 'failure', 'error')
                            or type(event.get('hidden')) is not bool or type(event.get('skipped')) is not bool):
                        raise ValueError('unknown/duplicate test completion or invalid result')
                    ended.add(tid)
                    completions[tid] = event
                    key = tests[tid]
                    if event['hidden'] and event['result'] == 'success':
                        results.pop(key, None)
                    else:
                        results[key] = 'skip' if event['skipped'] else ('pass' if event['result'] == 'success' else 'fail')
                elif kind == 'error':
                    errors.add(event['testID'])
                    if event.get('isFailure') is False and str(event.get('error', '')).startswith('Failed to load "'):
                        loader_errors.add(event['testID'])
                elif kind == 'done':
                    done.append(event['success'])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f'{log}: invalid {kind} reporter event: {error}') from error
        if not suites or not tests or len(done) != 1 or type(done[0]) is not bool or ended != set(tests):
            raise ValueError(f'{log}: empty or incomplete reporter; every attempt must finish exactly once')
        if errors - set(tests):
            raise ValueError(f'{log}: reporter error without a registered test')
        if set(counts) - set(suites):
            raise ValueError(f'{log}: root group inventory without a registered suite')
        for sid, file in suites.items():
            tids = {tid for tid, suite in test_suites.items() if suite == sid}
            if not tids:
                raise ValueError(f'{log}: suite has no attributable completion/inventory: {file}')
            if sid not in counts:
                # A failed loader has no registered cases yet. Its completed, explicit error is evidence,
                # and a later complete retry may replace it; an unregistered passing file is not evidence.
                loader = next(iter(tids)) if len(tids) == 1 else None
                if (loader in loaders and loader in loader_errors
                        and completions[loader]['result'] == 'error' and not completions[loader]['skipped']):
                    continue
                raise ValueError(f'{log}: suite has no declared root group inventory: {file}')
            visible = sum(not completions[tid]['hidden'] for tid in tids)
            if visible != counts[sid]:
                raise ValueError(f'{log}: root group inventory mismatch for {file}: {counts[sid]} registered, {visible} completed')
        for tid in errors:
            results[tests[tid]] = 'fail'
        if not done[0] and not any(results.get(key) == 'fail' for key in tests.values()):
            raise ValueError(f'{log}: reporter failed without an attributable failing test')
    if selected is not None:
        if (not isinstance(selected, list) or not selected
                or {_relative(file, root) for file in selected} != reported_files):
            raise ValueError(f'{path}: reporter files do not match the declared receipt inventory')
    return results


def _summary(results):
    files = len({file for file, _ in results})
    count = lambda what: sum(1 for r in results.values() if r == what)  # noqa: E731
    return (f'{len(results)} tests in {files} files: {count("pass")} passed, {count("fail")} failed, '
            f'{count("skip")} skipped, {count("incomplete")} incomplete')


def compare_runs(base_path, head_path):
    """(exit code, report). A regression is a test that fails in head and did not in base, including a new test
    that fails. A removed test is listed for the reviewer (a rename shows as one removed and one new), not failed."""
    base, head = test_results(base_path), test_results(head_path)
    bad = lambda result: result in ('fail', 'incomplete')  # noqa: E731
    newly = sorted(k for k, r in head.items() if bad(r) and not bad(base.get(k, 'pass')))
    still = sorted(k for k, r in head.items() if k in base and bad(base[k]) and bad(r))
    fixed = sorted(k for k, r in head.items() if k in base and bad(base[k]) and not bad(r))
    added = sorted(k for k in head if k not in base)
    removed = sorted(k for k in base if k not in head)
    lines = [f'base: {_summary(base)}', f'head: {_summary(head)}']

    def section(title, keys, note=lambda key: ''):
        lines.append(f'{title}: {len(keys)}')
        lines.extend(f'  {file} :: {name}{note((file, name))}' for file, name in keys)

    section('newly failing (passing, skipped or absent in base)', newly, lambda k: f'  (base: {base.get(k, "absent")})')
    section('still failing (failing in base too)', still)
    section('fixed (failing in base, passing in head)', fixed)
    section('new tests', added, lambda k: f'  ({head[k]})')
    section('removed tests (a rename shows as one removed and one new)', removed, lambda k: f'  (base: {base[k]})')
    lines.append('verdict: ' + ('REGRESSIONS' if newly else 'no regressions'))
    return (1 if newly else 0), '\n'.join(lines) + '\n'


# --- command line ---------------------------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('redact')
    sub.add_parser('args-b64').add_argument('pairs', nargs='*')
    sub.add_parser('ps-b64')
    sub.add_parser('record-port')
    p = sub.add_parser('run-id')
    p.add_argument('path')
    p = sub.add_parser('owner')
    p.add_argument('path')
    p.add_argument('user')
    p.add_argument('run_id')
    p.add_argument('field', nargs='?')
    p = sub.add_parser('compare-baseline')
    p.add_argument('before')
    p.add_argument('after')
    sub.add_parser('zip-info').add_argument('zip')
    p = sub.add_parser('zip-variant')
    p.add_argument('kind', choices=sorted(DROPS))
    p.add_argument('zip')
    p.add_argument('version')
    p.add_argument('--out-dir', required=True)
    p = sub.add_parser('truncate')
    p.add_argument('zip')
    p.add_argument('--out-dir', required=True)
    p = sub.add_parser('layout')
    p.add_argument('version')
    p.add_argument('arch', choices=ARCHES)
    p = sub.add_parser('verify')
    p.add_argument('manifest')
    p.add_argument('arch', choices=ARCHES)
    p.add_argument('zip')
    p = sub.add_parser('cdn-stage')
    p.add_argument('root')
    p.add_argument('specs', nargs='+')
    p = sub.add_parser('compare-runs')
    p.add_argument('base')
    p.add_argument('head')
    args = parser.parse_args(argv)
    try:
        if args.command == 'redact':
            sys.stdin.reconfigure(errors='replace')
            for line in sys.stdin:
                sys.stdout.write(redact(line))
                sys.stdout.flush()
        elif args.command == 'args-b64':
            print(args_b64(args.pairs))
        elif args.command == 'ps-b64':
            print(ps_b64(sys.stdin.read()))
        elif args.command == 'record-port':
            print(record_port(json.load(sys.stdin)))
        elif args.command == 'run-id':
            path = Path(args.path)
            if not path.exists():
                # Exclusive create prevents concurrent commands from minting different owners.
                with path.open('x') as output:
                    os.chmod(path, 0o600)
                    json.dump({'run_id': uuid.uuid4().hex}, output)
            run_id = json.loads(path.read_text())['run_id']
            if not re.fullmatch(r'[0-9a-f]{32}', run_id):
                raise ValueError('invalid private run id')
            print(run_id)
        elif args.command == 'owner':
            record = owned_user(json.loads(Path(args.path).read_text()), args.user, args.run_id)
            print(record[args.field] if args.field else json.dumps(record))
        elif args.command == 'compare-baseline':
            changes = compare_baseline(json.loads(Path(args.before).read_text(encoding='utf-8-sig')),
                                       json.loads(Path(args.after).read_text(encoding='utf-8-sig')))
            print('\n'.join(changes) if changes else 'preexisting process/task/listener identities preserved')
            return 1 if changes else 0
        elif args.command == 'zip-info':
            print(json.dumps(zip_info(args.zip), indent=2))
        elif args.command == 'zip-variant':
            dst = zip_variant(args.kind, args.zip, args.version, args.out_dir)
            print(dst)
            print(json.dumps(zip_info(dst), indent=2))
        elif args.command == 'truncate':
            dst = truncate(args.zip, args.out_dir)
            print(f'{dst} ({dst.stat().st_size} of {Path(args.zip).stat().st_size} bytes)')
        elif args.command == 'layout':
            for name, value in layout(args.version, args.arch).items():
                print(f'{name}={value}')
        elif args.command == 'verify':
            ok, sentence = verify(json.loads(Path(args.manifest).read_text()), args.arch, args.zip)
            print(sentence)
            return 0 if ok else 1
        elif args.command == 'cdn-stage':
            print(json.dumps(cdn_stage(args.root, args.specs), indent=2, sort_keys=True))
        elif args.command == 'compare-runs':
            code, report = compare_runs(args.base, args.head)
            sys.stdout.write(report)
            return code
        return 0
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(f'error: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
