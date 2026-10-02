#!/usr/bin/env python3
"""Seal, find and promote verified Desktop packages without rebuilding them.

A candidate is evidence about bytes, never permission to merge or publish. The
release still requires the normal validation, version and publication gates.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import zipfile


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publisher = sibling('publish-desktop-manifest')
Client = sibling('record-ci-validation').Client
verification = publisher.verification
WORKFLOW = '.github/workflows/release-desktop.yml'
FILES = dict(zip(verification.KEYS, (
    'Harness-macos.zip', 'Harness-macos.dmg', 'Harness-macos-arm64.zip',
    'Harness-macos-arm64.dmg', 'Harness-linux-x64.AppImage', 'Harness-linux-arm64.AppImage',
)))
PREFIX = r'harness/desktop-candidates/([1-9][0-9]*)-([1-9][0-9]*)-[0-9a-f]{32}'
RETENTION = timedelta(days=7)
MAX_AGE_SECONDS = 1200
# Whole component/helper trees include new files, removals and executable modes.
# These cover every native sparse checkout, the workflow/toolchain pin, and the
# root Git files that can affect materialization. Extend this contract whenever
# a build starts reading another component; the checkout coverage test guards it.
BUILD_INPUTS = {
    'desktop': 'tree',
    'scripts': 'tree',
    '.github/actions': 'tree',
    WORKFLOW: 'blob',
    'mobile/pubspec.lock': None,  # included when present in the shared pub-cache key
    '.gitattributes': None,
    '.gitignore': None,
    '.gitmodules': None,
}


class CandidatePendingError(RuntimeError):
    """The observed build is still live; a deadline is not a failed build."""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'timestamp must include its timezone')
    return parsed


def git(value):
    return subprocess.check_output(['git', 'rev-parse', value], text=True, timeout=10).strip()


def local_tree(sha, cwd=None):
    records = subprocess.check_output(['git', 'ls-tree', '--full-tree', '-z', sha], cwd=cwd, text=True, timeout=10)
    entries = []
    for record in records.split('\0'):
        if record:
            metadata, path = record.split('\t', 1)
            mode, kind, object_sha = metadata.split()
            entries.append(dict(path=path, mode=mode, type=kind, sha=object_sha))
    return dict(sha=sha, tree=entries, truncated=False)


def build_inputs(tree, read_tree):
    """Read complete Git objects, including optional-file absence, without blobs."""
    cache = {}
    def entries(sha):
        require(isinstance(sha, str) and re.fullmatch(r'[0-9a-f]{40}', sha), 'invalid input tree')
        if sha not in cache:
            data = read_tree(sha)
            require(isinstance(data, dict) and data.get('sha') == sha and data.get('truncated') is False
                    and isinstance(data.get('tree'), list), 'incomplete input tree response')
            indexed = {}
            for entry in data['tree']:
                require(isinstance(entry, dict), 'invalid input tree entry')
                path = entry['path']
                require(isinstance(path, str) and path and '/' not in path and path not in indexed,
                        'invalid or duplicate input tree entry')
                indexed[path] = entry
            cache[sha] = indexed
        return cache[sha]

    result = {}
    for path, required_type in BUILD_INPUTS.items():
        parent = tree
        parts = path.split('/')
        for index, name in enumerate(parts):
            entry = entries(parent).get(name)
            if entry is None:
                require(required_type is None, f'missing build input: {path}')
                result[path] = None
                break
            kind = 'tree' if index < len(parts) - 1 else required_type or 'blob'
            require(entry.get('type') == kind and entry.get('mode') in
                    (('040000',) if kind == 'tree' else ('100644', '100755')),
                    f'unsupported build input type: {path}')
            require(isinstance(entry.get('sha'), str) and re.fullmatch(r'[0-9a-f]{40}', entry['sha']),
                    f'invalid build input object: {path}')
            parent = entry['sha']
            if index == len(parts) - 1:
                result[path] = {key: entry[key] for key in ('mode', 'type', 'sha')}
    return result


def input_fingerprint(inputs):
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def context():
    repository = os.environ['GITHUB_REPOSITORY']
    run, attempt = (int(os.environ[key]) for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'))
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'invalid repository')
    require(run > 0 and attempt > 0, 'invalid run identity')
    sha = git('HEAD')
    require(sha == os.environ['GITHUB_SHA'], 'checkout differs from workflow source')
    tree = git('HEAD^{tree}')
    return dict(repository=repository, run_id=run, run_attempt=attempt, source_sha=sha, source_tree=tree,
                build_inputs=build_inputs(tree, local_tree))


def check_prefix(prefix, run=None, attempt=None):
    match = re.fullmatch(PREFIX, prefix)
    require(match is not None, 'invalid candidate object prefix')
    if run is not None:
        require((int(match[1]), int(match[2])) == (run, attempt), 'candidate prefix belongs to another run/attempt')
    return prefix


def check_bucket(bucket):
    require(re.fullmatch(r'[a-z0-9][a-z0-9._-]+', bucket), 'invalid bucket')


def describe(uri):
    return json.loads(publisher.gcloud('storage', 'objects', 'describe', uri, '--format=json'))


def seal(version, bucket, prefix, parts, identity):
    """Verify immutable source generations and retain their hashes in GitHub."""
    check_bucket(bucket)
    check_prefix(prefix, identity['run_id'], identity['run_attempt'])
    entries = publisher.read_parts(parts, version)
    sources = {}
    for key, entry in entries.items():
        name = f'{prefix}/{FILES[key]}'
        require(entry['url'] == f'https://storage.googleapis.com/{bucket}/{name}', 'candidate URL differs from its owned object')
        sources[key] = f'gs://{bucket}/{name}'
    # Candidate downloads must remain removable; promotion restores immutable
    # release headers on the destination objects only.
    publisher.gcloud('storage', 'objects', 'update', *sources.values(), '--cache-control=private, max-age=0, no-store')
    pinned = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        descriptions = dict(zip(sources, pool.map(describe, sources.values())))
    for key, entry in entries.items():
        metadata = descriptions[key]
        generation = str(metadata.get('generation', ''))
        require(re.fullmatch(r'[1-9][0-9]*', generation), 'missing source generation')
        require(int(metadata.get('size', -1)) == entry['size'], 'source size differs from the build manifest')
        pinned[key] = dict(entry, generation=generation, url=entry['url'] + '?generation=' + generation)
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda item: verification.verify_artifact(item, 90), pinned.items()))
    require(all(item['status'] == 'passed' for item in results), 'candidate downloads failed verification')
    return dict(schema=2, status='passed', version=version, bucket=bucket, prefix=prefix,
                created_at=verification.utc_now(), **identity, artifacts=pinned)


def check_run(run, repository, version):
    require(run.get('repository', {}).get('full_name', '').lower() == repository.lower(), 'candidate repository mismatch')
    require(run.get('path') == WORKFLOW and run.get('event') == 'workflow_dispatch', 'candidate workflow mismatch')
    require(run.get('display_title') == f'Desktop candidate {version}', 'candidate mode/version mismatch')
    require(re.fullmatch(r'[0-9a-f]{40}', run.get('head_sha', '')), 'candidate has no source commit')
    require(type(run.get('id')) is int and run['id'] > 0 and type(run.get('run_attempt')) is int and run['run_attempt'] > 0,
            'candidate has no run/attempt identity')


def read_receipt(artifact, archive, run, repository, version, tree, inputs, bucket, now):
    name = f'desktop-release-candidate-{run["run_attempt"]}'
    provenance = artifact.get('workflow_run', {})
    require(artifact.get('name') == name and artifact.get('expired') is False
            and provenance.get('id') == run['id'] and provenance.get('head_sha') == run['head_sha'],
            'candidate artifact identity mismatch')
    require(artifact.get('digest') == 'sha256:' + hashlib.sha256(archive).hexdigest(), 'candidate archive digest mismatch')
    require(len(archive) <= 65536, 'candidate archive is too large')
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        require(bundle.namelist() == ['desktop-release-candidate.json']
                and bundle.infolist()[0].file_size <= 65536, 'unexpected candidate archive contents')
        receipt = json.loads(bundle.read('desktop-release-candidate.json'))
    require(isinstance(receipt, dict) and receipt.get('schema') == 2 and receipt.get('status') == 'passed', 'candidate did not pass')
    expected = dict(repository=repository, run_id=run['id'], run_attempt=run['run_attempt'],
                    source_sha=run['head_sha'], source_tree=tree, build_inputs=inputs, version=version, bucket=bucket)
    require(all(receipt.get(key) == value for key, value in expected.items()), 'candidate source/version/run differs from release')
    created = timestamp(receipt['created_at'])
    require(timestamp(run['created_at']) <= created <= now and now - created < RETENTION, 'candidate is expired or has invalid timestamps')
    prefix = check_prefix(receipt['prefix'], run['id'], run['run_attempt'])
    entries = receipt['artifacts']
    require(isinstance(entries, dict) and set(entries) == set(FILES), 'candidate does not contain exactly six artifacts')
    verification.entries_for_version(entries, version)
    for key, entry in entries.items():
        generation = entry.get('generation', '')
        require(isinstance(generation, str) and re.fullmatch(r'[1-9][0-9]*', generation), 'invalid candidate generation')
        require(entry['url'] == f'https://storage.googleapis.com/{bucket}/{prefix}/{FILES[key]}?generation={generation}',
                'candidate artifact is outside its generation-pinned prefix')
    return receipt


def check_jobs(run, jobs):
    required = {'version', 'preflight', 'build-macos', 'build-linux (ubuntu-22.04, x64)',
                'build-linux (ubuntu-22.04-arm, arm64)', 'candidate', 'cleanup'}
    require(required <= {job['name'] for job in jobs}, 'candidate build/verification jobs are missing')
    for job in jobs:
        require(job.get('run_id') == run['id'] and job.get('head_sha') == run['head_sha']
                and 1 <= job.get('run_attempt', 0) <= run['run_attempt'], 'candidate job identity mismatch')
        require(job.get('status') == 'completed' and job.get('conclusion') in {'success', 'skipped'}, 'candidate job did not pass')
        if job['name'] in required:
            require(job['conclusion'] == 'success', 'required candidate job was skipped')
        require(all(step.get('conclusion') in {'success', 'skipped'} for step in job.get('steps', [])), 'candidate contains a failed step')


def find_candidate(client, version, inputs, bucket, current_run, wait_seconds=MAX_AGE_SECONDS):
    """Look at a bounded recent set. Never wait past a candidate's build budget."""
    now = datetime.now(timezone.utc)
    runs = client.api('actions/workflows/release-desktop.yml/runs?event=workflow_dispatch&per_page=30')['workflow_runs']
    # Unrelated commits often share these small parent trees. Keep immutable API
    # responses for this lookup, without downloading whole recursive file lists.
    trees = {}
    def read_tree(sha):
        if sha not in trees:
            trees[sha] = client.api(f'git/trees/{sha}')
        return trees[sha]
    # A completed candidate with identical bytes is immediately usable even if
    # someone has unnecessarily started another build of the same tree/version.
    runs.sort(key=lambda run: (run.get('conclusion') != 'success', -run['id']))
    for listed in runs:
        if listed.get('display_title') != f'Desktop candidate {version}' or listed.get('id') == current_run:
            continue
        run = client.api(f'actions/runs/{listed["id"]}')
        check_run(run, client.repository, version)
        original_source = run['head_sha']
        if now - timestamp(run['created_at']) >= RETENTION:
            continue
        commit = client.api(f'git/commits/{run["head_sha"]}')
        producer_tree = commit.get('tree', {}).get('sha')
        if build_inputs(producer_tree, read_tree) != inputs:
            continue
        # Producer provenance still names its actual full tree. Only unrelated
        # components may differ from the release; every build input must match.
        end = time.monotonic() + max(0, min(wait_seconds, MAX_AGE_SECONDS - (now - timestamp(run['created_at'])).total_seconds()))
        while run['status'] != 'completed' and time.monotonic() < end:
            print(f'Waiting for matching candidate {run["id"]} ({run["status"]})', flush=True)
            time.sleep(min(10, max(0, end - time.monotonic())))
            try:
                run = client.api(f'actions/runs/{listed["id"]}')
                check_run(run, client.repository, version)
                require(run['head_sha'] == original_source and run['id'] == listed['id'], 'candidate source changed while waiting')
            except (OSError, KeyError, TypeError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                raise CandidatePendingError(
                    f'Cannot confirm the matching candidate has finished: https://github.com/{client.repository}/actions/runs/{listed["id"]}. '
                    'Follow that same run; no duplicate build was started.') from error
        if run.get('status') != 'completed':
            raise CandidatePendingError(
                f'Candidate is still {run["status"]}: https://github.com/{client.repository}/actions/runs/{run["id"]}. '
                'Follow that run and retry release after it passes; no duplicate build was started.')
        if run.get('conclusion') != 'success':
            continue
        jobs = client.api(f'actions/runs/{run["id"]}/jobs?filter=latest&per_page=100')
        require(jobs['total_count'] == len(jobs['jobs']), 'candidate job list is incomplete')
        check_jobs(run, jobs['jobs'])
        artifacts = client.api(f'actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
        selected = [item for item in artifacts if item['name'] == f'desktop-release-candidate-{run["run_attempt"]}']
        require(len(selected) == 1 and selected[0].get('size_in_bytes', 65537) <= 65536, 'candidate receipt is missing or too large')
        artifact = selected[0]
        archive = client.command('api', f'repos/{client.repository}/actions/artifacts/{artifact["id"]}/zip', binary=True)
        receipt = read_receipt(artifact, archive, run, client.repository, version, producer_tree,
                               inputs, bucket, datetime.now(timezone.utc))
        latest = client.api(f'actions/runs/{run["id"]}')
        require(all(latest.get(key) == run.get(key) for key in ('id', 'head_sha', 'run_attempt', 'status', 'conclusion')),
                'candidate run changed while collecting it')
        return receipt
    return None


def source_uri(receipt, key):
    return f'gs://{receipt["bucket"]}/{receipt["prefix"]}/{FILES[key]}#{receipt["artifacts"][key]["generation"]}'


def check_sources(receipt):
    with ThreadPoolExecutor(max_workers=3) as pool:
        descriptions = dict(zip(FILES, pool.map(lambda key: describe(source_uri(receipt, key)), FILES)))
    for key, metadata in descriptions.items():
        entry = receipt['artifacts'][key]
        require(str(metadata.get('generation')) == entry['generation'] and int(metadata.get('size', -1)) == entry['size'],
                'candidate source disappeared or changed')


def promote(receipt, destination, scratch):
    """Copy pinned generations, never overwrite any release artifact."""
    bucket, version = receipt['bucket'], receipt['version']
    require(destination == f'harness/desktop/{version}' or
            re.fullmatch(r'harness/desktop/\.candidate-check/[1-9][0-9]*-[1-9][0-9]*/artifacts', destination), 'invalid promotion destination')
    require(re.fullmatch(r'harness/desktop/\.ci/[1-9][0-9]*-[1-9][0-9]*', scratch), 'invalid scratch prefix')
    def copy(key):
        publisher.gcloud('storage', 'cp', source_uri(receipt, key), f'gs://{bucket}/{destination}/{FILES[key]}',
                         '--if-generation-match=0', '--cache-control=public, max-age=31536000, immutable')
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(copy, FILES))
    base = 'https://cdn.autonomous.ai' if destination == f'harness/desktop/{version}' else f'https://storage.googleapis.com/{bucket}'
    with tempfile.TemporaryDirectory(prefix='desktop-candidate-parts-') as folder:
        for name, keys in publisher.PARTS.items():
            entries = {key: {field: receipt['artifacts'][key][field] for field in ('version', 'size', 'sha256')} for key in keys}
            for key, entry in entries.items():
                entry['url'] = f'{base}/{destination}/{FILES[key]}'
            path = Path(folder) / name
            path.write_text(json.dumps(entries) + '\n')
            publisher.gcloud('storage', 'cp', str(path), f'gs://{bucket}/{scratch}/{name}', '--if-generation-match=0',
                             '--content-type=application/json', '--cache-control=no-cache, no-store, must-revalidate')


def expired_objects(objects, now):
    """Select only old, known candidate objects, pinned to listed generations."""
    groups = {}
    for item in objects:
        name = item.get('name', '')
        prefix, _, filename = name.rpartition('/')
        if re.fullmatch(PREFIX, prefix):
            groups.setdefault(prefix, []).append((filename, item))
    expired = []
    for prefix, items in groups.items():
        selected = []
        for filename, item in items:
            generation = str(item.get('generation', ''))
            created = item.get('creation_time', item.get('timeCreated', ''))
            if filename not in FILES.values() or not re.fullmatch(r'[1-9][0-9]*', generation):
                break
            try:
                if now - timestamp(created) < RETENTION:
                    break
            except (TypeError, ValueError):
                break
            selected.append(f'{prefix}/{filename}#{generation}')
        else:
            expired.extend(selected)
    return expired


def output(name, value):
    if destination := os.environ.get('GITHUB_OUTPUT'):
        with open(destination, 'a') as stream:
            stream.write(f'{name}={value}\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('seal', 'reuse', 'remove', 'expire'))
    parser.add_argument('--bucket', default=os.environ.get('GCS_BUCKET', 's3-autonomous-upgrade-3'))
    parser.add_argument('--version')
    parser.add_argument('--prefix')
    parser.add_argument('--parts', type=Path)
    parser.add_argument('--destination')
    parser.add_argument('--scratch')
    parser.add_argument('--require-candidate', action='store_true')
    parser.add_argument('--wait-seconds', type=int, choices=range(0, MAX_AGE_SECONDS + 1), default=MAX_AGE_SECONDS)
    args = parser.parse_args(argv)
    check_bucket(args.bucket)
    if args.operation == 'remove':
        check_prefix(args.prefix)
        publisher.gcloud('storage', 'rm', '--recursive', f'gs://{args.bucket}/{args.prefix}/')
        return 0
    if args.operation == 'expire':
        objects = json.loads(publisher.gcloud('storage', 'objects', 'list', f'gs://{args.bucket}/harness/desktop-candidates/**', '--raw', '--format=json'))
        selected = expired_objects(objects, datetime.now(timezone.utc))
        if selected:
            publisher.gcloud('storage', 'rm', *[f'gs://{args.bucket}/{path}' for path in selected])
        print(f'Removed {len(selected)} expired candidate objects')
        return 0
    publisher.version_tuple(args.version)
    identity = context()
    if args.operation == 'seal':
        require(args.parts is not None, 'sealing requires platform manifests')
        receipt = seal(args.version, args.bucket, args.prefix, args.parts, identity)
        Path('desktop-release-candidate.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print('All six candidate downloads passed; no product manifest was published')
        return 0
    started = time.monotonic()
    client = Client(identity['repository'], started + args.wait_seconds + 90)
    try:
        receipt = find_candidate(client, args.version, identity['build_inputs'], args.bucket, identity['run_id'], args.wait_seconds)
        if receipt:
            check_sources(receipt)
    except CandidatePendingError:
        raise
    except (OSError, KeyError, TypeError, ValueError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f'Candidate unavailable; use a fresh build: {error}', flush=True)
        receipt = None
    if receipt is None:
        output('reused', 'false')
        require(not args.require_candidate, 'disposable promotion check requires a matching successful candidate')
        return 0
    # From the first destination write onward, failure is fatal. Rebuilding after
    # a partial immutable copy could leave mixed packages under one version.
    promote(receipt, args.destination, args.scratch)
    output('reused', 'true')
    output('candidate_prefix', receipt['prefix'])
    result = dict(status='passed', version=args.version, source_sha=identity['source_sha'], source_tree=identity['source_tree'],
                  candidate_source_sha=receipt['source_sha'], candidate_source_tree=receipt['source_tree'],
                  build_inputs_sha256=input_fingerprint(identity['build_inputs']),
                  candidate_run=receipt['run_id'], candidate_attempt=receipt['run_attempt'],
                  duration_seconds=round(time.monotonic() - started, 3))
    Path('desktop-candidate-reuse.json').write_text(json.dumps(result, indent=2) + '\n')
    message = f'Reused all six verified packages from candidate {receipt["run_id"]} in {result["duration_seconds"]}s'
    print(message)
    if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(summary, 'a') as stream:
            stream.write(message + '\n')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, KeyError, TypeError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
