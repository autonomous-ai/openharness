"""Candidate identity, artifact promotion and bounded discovery contracts."""
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('candidate', ROOT / 'scripts/desktop-release-candidate.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)

REPOSITORY = 'owner/project'
BUCKET = 'fixture-bucket'
SHA = 'a' * 40
TREE = 'b' * 40
PREFIX = 'harness/desktop-candidates/123-1-' + 'c' * 32
VERSION = '1.2.55'
NOW = datetime.now(timezone.utc)


def make_receipt():
    entries = {}
    for index, (key, filename) in enumerate(candidate.FILES.items(), 1):
        payload = key.encode()
        entries[key] = dict(version=VERSION, size=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
                            generation=str(index), url=f'https://storage.googleapis.com/{BUCKET}/{PREFIX}/{filename}?generation={index}')
    return dict(schema=1, status='passed', version=VERSION, bucket=BUCKET, prefix=PREFIX, repository=REPOSITORY,
                run_id=123, run_attempt=1, source_sha=SHA, source_tree=TREE,
                created_at=(NOW - timedelta(seconds=10)).isoformat(), artifacts=entries)


def make_run():
    return dict(id=123, run_attempt=1, head_sha=SHA, path=candidate.WORKFLOW, event='workflow_dispatch',
                repository=dict(full_name=REPOSITORY), display_title=f'Desktop candidate {VERSION}',
                status='completed', conclusion='success', created_at=(NOW - timedelta(minutes=1)).isoformat())


def archive_receipt(receipt):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as bundle:
        bundle.writestr('desktop-release-candidate.json', json.dumps(receipt))
    data = archive.getvalue()
    artifact = dict(id=99, name='desktop-release-candidate-1', expired=False, size_in_bytes=len(data),
                    workflow_run=dict(id=123, head_sha=SHA), digest='sha256:' + hashlib.sha256(data).hexdigest())
    return artifact, data


def make_jobs():
    return [dict(name=name, id=index, run_id=123, run_attempt=1, head_sha=SHA, status='completed', conclusion='success',
                 steps=[dict(conclusion='success')]) for index, name in enumerate(
                     ['version', 'preflight', 'build-macos', 'build-linux (ubuntu-22.04, x64)',
                      'build-linux (ubuntu-22.04-arm, arm64)', 'candidate', 'cleanup'])]


class FakeGithub:
    repository = REPOSITORY

    def __init__(self):
        self.run = make_run()
        self.receipt = make_receipt()
        self.artifact, self.archive = archive_receipt(self.receipt)
        self.tree = TREE
        self.jobs = make_jobs()
        self.calls = []
        self.run_reads = 0

    def api(self, path):
        self.calls.append(path)
        if path.startswith('actions/workflows/'):
            return dict(workflow_runs=[copy.deepcopy(self.run)])
        if path.startswith('git/commits/'):
            return dict(tree=dict(sha=self.tree))
        if '/artifacts?' in path:
            return dict(artifacts=[copy.deepcopy(self.artifact)])
        if '/jobs?' in path:
            return dict(total_count=len(self.jobs), jobs=copy.deepcopy(self.jobs))
        if path == 'actions/runs/123':
            self.run_reads += 1
            return copy.deepcopy(self.run)
        raise AssertionError(path)

    def command(self, *args, binary=False):
        assert args == ('api', f'repos/{REPOSITORY}/actions/artifacts/99/zip') and binary
        return self.archive


class CandidateIdentityTests(unittest.TestCase):
    def read(self, receipt=None, artifact_change=None, **overrides):
        receipt = receipt or make_receipt()
        artifact, archive = archive_receipt(receipt)
        if artifact_change:
            artifact_change(artifact)
        args = dict(run=make_run(), repository=REPOSITORY, version=VERSION, tree=TREE, bucket=BUCKET, now=NOW)
        args.update(overrides)
        return candidate.read_receipt(artifact, archive, **args)

    def test_clean_squash_with_identical_tree_keeps_artifacts(self):
        receipt = self.read()
        self.assertEqual(receipt['source_sha'], SHA)
        self.assertEqual(receipt['source_tree'], TREE)
        # The release commit may differ; its complete tree is the contract.
        client = FakeGithub()
        self.assertEqual(candidate.find_candidate(client, VERSION, TREE, BUCKET, 456), receipt)

    def test_source_version_and_repository_changes_cannot_reuse(self):
        for field, value in [('tree', 'd' * 40), ('version', '1.2.56'), ('repository', 'other/project'), ('bucket', 'other-bucket')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.read(**{field: value})

    def test_receipt_requires_all_six_verified_objects_with_exact_paths(self):
        mutations = [
            lambda r: r.update(status='failed'), lambda r: r.update(schema=2),
            lambda r: r.update(run_attempt=2), lambda r: r.update(source_sha='e' * 40),
            lambda r: r.update(prefix=PREFIX.replace('/123-', '/124-')),
            lambda r: r['artifacts'].pop('desktop-linux-arm64'),
            lambda r: r['artifacts'].update(extra=r['artifacts']['desktop-macos']),
            lambda r: r['artifacts']['desktop-macos'].update(size=True),
            lambda r: r['artifacts']['desktop-macos'].update(sha256='bad'),
            lambda r: r['artifacts']['desktop-macos'].update(generation='0'),
            lambda r: r['artifacts']['desktop-macos'].update(url='https://example.com/other.zip'),
            lambda r: r['artifacts']['desktop-macos'].update(url=r['artifacts']['desktop-macos']['url'].split('?')[0]),
            lambda r: r.update(created_at=(NOW + timedelta(seconds=1)).isoformat()),
            lambda r: r.update(created_at=(NOW - timedelta(days=8)).isoformat()),
        ]
        for index, change in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(ValueError):
                receipt = make_receipt()
                change(receipt)
                self.read(receipt)

    def test_github_artifact_provenance_and_digest_are_required(self):
        for field, value in [('name', 'unrelated'), ('expired', True), ('digest', 'sha256:' + 'f' * 64),
                             ('workflow_run', dict(id=456, head_sha=SHA)), ('workflow_run', dict(id=123, head_sha='f' * 40))]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.read(artifact_change=lambda a: a.update({field: value}))

    def test_no_candidate_for_failed_incomplete_changed_or_old_build(self):
        for change in ['failed', 'different-tree', 'different-version', 'old']:
            with self.subTest(change=change):
                client = FakeGithub()
                if change == 'failed': client.run['conclusion'] = 'failure'
                if change == 'different-tree': client.tree = 'd' * 40
                if change == 'different-version': client.run['display_title'] = 'Desktop candidate 1.2.56'
                if change == 'old': client.run['created_at'] = (NOW - timedelta(days=8)).isoformat()
                with patch.object(candidate.time, 'sleep') as sleep:
                    self.assertIsNone(candidate.find_candidate(client, VERSION, TREE, BUCKET, 456, wait_seconds=0))
                    sleep.assert_not_called()

    def test_builds_and_verification_cannot_be_missing_skipped_or_failed(self):
        for change in ['missing', 'skipped', 'failed-step', 'wrong-source']:
            with self.subTest(change=change), self.assertRaises(ValueError):
                client = FakeGithub()
                if change == 'missing': client.jobs.pop()
                if change == 'skipped': client.jobs[2]['conclusion'] = 'skipped'
                if change == 'failed-step': client.jobs[2]['steps'][0]['conclusion'] = 'failure'
                if change == 'wrong-source': client.jobs[2]['head_sha'] = 'f' * 40
                candidate.find_candidate(client, VERSION, TREE, BUCKET, 456)

    def test_wait_follows_one_live_run_without_starting_another(self):
        client = FakeGithub()
        client.run.update(status='in_progress', conclusion=None)
        def finish(seconds):
            client.run.update(status='completed', conclusion='success')
        with patch.object(candidate.time, 'sleep', side_effect=finish) as sleep:
            result = candidate.find_candidate(client, VERSION, TREE, BUCKET, 456)
        self.assertEqual(result['run_id'], 123)
        self.assertEqual(sleep.call_count, 1)
        self.assertTrue(all(path.startswith(('actions/', 'git/')) for path in client.calls))

    def test_an_old_in_progress_run_does_not_get_another_wait_budget(self):
        client = FakeGithub()
        client.run.update(status='in_progress', conclusion=None,
                          created_at=(NOW - timedelta(seconds=candidate.MAX_AGE_SECONDS + 1)).isoformat())
        with patch.object(candidate.time, 'sleep') as sleep:
            with self.assertRaisesRegex(candidate.CandidatePendingError, 'actions/runs/123'):
                candidate.find_candidate(client, VERSION, TREE, BUCKET, 456)
        sleep.assert_not_called()

    def test_pending_deadline_stops_release_without_dispatching_a_replacement(self):
        client = FakeGithub()
        client.run.update(status='queued', conclusion=None)
        with patch.object(candidate.time, 'sleep') as sleep:
            with self.assertRaises(candidate.CandidatePendingError):
                candidate.find_candidate(client, VERSION, TREE, BUCKET, 456, wait_seconds=0)
        sleep.assert_not_called()
        receipt = make_receipt()
        identity = {key: receipt[key] for key in ['repository', 'run_id', 'run_attempt', 'source_sha', 'source_tree']}
        with patch.object(candidate, 'context', return_value=identity), \
                patch.object(candidate, 'find_candidate', side_effect=candidate.CandidatePendingError('still live')), \
                patch.object(candidate, 'output') as output, patch.object(candidate, 'promote') as promote:
            with self.assertRaises(candidate.CandidatePendingError):
                candidate.main(['reuse', '--version', VERSION, '--bucket', BUCKET])
            output.assert_not_called()
            promote.assert_not_called()

    def test_rerun_during_collection_cannot_reuse_an_old_receipt(self):
        client = FakeGithub()
        original = client.api
        def api(path):
            data = original(path)
            if path == 'actions/runs/123' and client.run_reads == 2:
                data['run_attempt'] = 2
            return data
        client.api = api
        with self.assertRaisesRegex(ValueError, 'changed while collecting'):
            candidate.find_candidate(client, VERSION, TREE, BUCKET, 456)

    def test_failed_observation_of_a_live_build_never_triggers_another_build(self):
        client = FakeGithub()
        client.run.update(status='in_progress', conclusion=None)
        original = client.api
        def api(path):
            if path == 'actions/runs/123' and client.run_reads:
                raise RuntimeError('temporary GitHub outage')
            return original(path)
        client.api = api
        with patch.object(candidate.time, 'sleep'):
            with self.assertRaisesRegex(candidate.CandidatePendingError, 'Cannot confirm'):
                candidate.find_candidate(client, VERSION, TREE, BUCKET, 456)

    def test_other_workflow_or_repository_cannot_produce_a_candidate(self):
        for field, value in [('path', '.github/workflows/desktop-internal-build.yml'), ('event', 'pull_request'),
                             ('repository', dict(full_name='untrusted/fork'))]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                client = FakeGithub()
                client.run[field] = value
                candidate.find_candidate(client, VERSION, TREE, BUCKET, 456)

    def test_copy_failure_is_fatal_and_never_becomes_a_fresh_build(self):
        receipt = make_receipt()
        identity = {key: receipt[key] for key in ['repository', 'run_id', 'run_attempt', 'source_sha', 'source_tree']}
        with patch.object(candidate, 'context', return_value=identity), \
                patch.object(candidate, 'find_candidate', return_value=receipt), \
                patch.object(candidate, 'check_sources'), \
                patch.object(candidate, 'output') as output, \
                patch.object(candidate, 'promote', side_effect=RuntimeError('partial immutable copy')):
            with self.assertRaisesRegex(RuntimeError, 'partial immutable copy'):
                candidate.main(['reuse', '--version', VERSION, '--bucket', BUCKET])
            output.assert_not_called()

    def test_lookup_failure_falls_back_but_disposable_check_requires_reuse(self):
        receipt = make_receipt()
        identity = {key: receipt[key] for key in ['repository', 'run_id', 'run_attempt', 'source_sha', 'source_tree']}
        with patch.object(candidate, 'context', return_value=identity), \
                patch.object(candidate, 'find_candidate', side_effect=RuntimeError('API unavailable')), \
                patch.object(candidate, 'output') as output, patch.object(candidate, 'promote') as promote:
            self.assertEqual(candidate.main(['reuse', '--version', VERSION, '--bucket', BUCKET]), 0)
            output.assert_called_with('reused', 'false')
            with self.assertRaisesRegex(ValueError, 'requires a matching'):
                candidate.main(['reuse', '--version', VERSION, '--bucket', BUCKET, '--require-candidate'])
            promote.assert_not_called()


class CandidatePromotionTests(unittest.TestCase):
    def test_copies_pinned_bytes_and_preserves_canonical_manifest_contract(self):
        receipt = make_receipt()
        objects = {candidate.source_uri(receipt, key): key.encode() for key in candidate.FILES}
        # A different current object cannot change which generation is copied.
        objects.update({uri.split('#')[0]: b'changed after verification' for uri in list(objects)})
        calls = []
        def gcloud(*args):
            self.assertEqual(args[:2], ('storage', 'cp'))
            source, destination = args[2:4]
            self.assertIn('--if-generation-match=0', args)
            if destination in objects:
                raise RuntimeError('412: destination exists')
            objects[destination] = objects[source] if source.startswith('gs://') else Path(source).read_bytes()
            calls.append(args)
            return ''
        with patch.object(candidate.publisher, 'gcloud', side_effect=gcloud):
            candidate.promote(receipt, f'harness/desktop/{VERSION}', 'harness/desktop/.ci/456-1')
            before = copy.deepcopy(objects)
            with self.assertRaisesRegex(RuntimeError, 'destination exists'):
                candidate.promote(receipt, f'harness/desktop/{VERSION}', 'harness/desktop/.ci/456-1')
            self.assertEqual(before, objects)
        for key, filename in candidate.FILES.items():
            self.assertEqual(objects[f'gs://{BUCKET}/harness/desktop/{VERSION}/{filename}'], key.encode())
        with tempfile.TemporaryDirectory() as folder:
            for name in candidate.publisher.PARTS:
                (Path(folder) / name).write_bytes(objects[f'gs://{BUCKET}/harness/desktop/.ci/456-1/{name}'])
            entries = candidate.publisher.read_parts(Path(folder), VERSION)
        self.assertTrue(all(entry['url'].startswith(f'https://cdn.autonomous.ai/harness/desktop/{VERSION}/') for entry in entries.values()))
        self.assertFalse(any('metadata.json' in call[3] for call in calls))

    def test_destinations_and_source_generations_are_checked_before_writes(self):
        receipt = make_receipt()
        with patch.object(candidate.publisher, 'gcloud') as gcloud:
            for destination in ['harness/desktop/1.2.54', 'harness/desktop', '../anything', PREFIX]:
                with self.subTest(destination=destination), self.assertRaises(ValueError):
                    candidate.promote(receipt, destination, 'harness/desktop/.ci/456-1')
            gcloud.assert_not_called()
        with patch.object(candidate, 'describe', return_value=dict(generation='999', size=14)):
            with self.assertRaises(ValueError):
                candidate.check_sources(receipt)

    def test_source_check_uses_every_pinned_generation(self):
        receipt = make_receipt()
        seen = []
        def describe(uri):
            seen.append(uri)
            key = next(key for key in candidate.FILES if uri == candidate.source_uri(receipt, key))
            return receipt['artifacts'][key]
        with patch.object(candidate, 'describe', side_effect=describe):
            candidate.check_sources(receipt)
        self.assertEqual(set(seen), {candidate.source_uri(receipt, key) for key in candidate.FILES})

    def test_sealing_rejects_missing_platform_or_wrong_source_url(self):
        receipt = make_receipt()
        identity = {key: receipt[key] for key in ['repository', 'run_id', 'run_attempt', 'source_sha', 'source_tree']}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for name, keys in candidate.publisher.PARTS.items():
                part = {key: dict(receipt['artifacts'][key], url='https://example.com/unverified') for key in keys}
                (path / name).write_text(json.dumps(part))
            with patch.object(candidate.publisher, 'gcloud') as gcloud:
                with self.assertRaisesRegex(ValueError, 'owned object'):
                    candidate.seal(VERSION, BUCKET, PREFIX, path, identity)
                gcloud.assert_not_called()
                (path / 'linux-arm64.json').unlink()
                with self.assertRaisesRegex(ValueError, 'four platform manifests'):
                    candidate.seal(VERSION, BUCKET, PREFIX, path, identity)

    def test_cleanup_never_selects_production_recent_unknown_or_unpinned_objects(self):
        def object_at(prefix, name, days=8, generation='17'):
            return dict(name=f'{prefix}/{name}', generation=generation, creation_time=(NOW - timedelta(days=days)).isoformat())
        filename = candidate.FILES['desktop-macos']
        old = object_at(PREFIX, filename)
        self.assertEqual(candidate.expired_objects([old], NOW), [f'{PREFIX}/{filename}#17'])
        self.assertEqual(candidate.expired_objects([object_at('harness/desktop/1.2.54', filename)], NOW), [])
        self.assertEqual(candidate.expired_objects([old, object_at(PREFIX, candidate.FILES['desktop-linux-x64'], days=1)], NOW), [])
        self.assertEqual(candidate.expired_objects([old, object_at(PREFIX, 'unrecognized.txt')], NOW), [])
        self.assertEqual(candidate.expired_objects([object_at(PREFIX, filename, generation='')], NOW), [])
        for prefix in ['harness/desktop', '', PREFIX + '/../1.2.54', PREFIX + '/nested']:
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                candidate.check_prefix(prefix)


if __name__ == '__main__':
    unittest.main()
