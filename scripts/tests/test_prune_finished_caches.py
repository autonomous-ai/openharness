"""Finished CI caches cannot be confused with reachable branch or release caches."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location('cache_pruner', Path(__file__).resolve().parents[1] / 'prune-finished-caches.py')
pruner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pruner)


class FakeClient:
    repository = 'owner/repo'

    def __init__(self, ref='refs/pull/17/merge', states=None, pages=None):
        self.ref = ref
        self.states = list(states or [False, False])  # whether the source is active
        self.pages = pages if pages is not None else [[dict(id=101, ref=ref, size_in_bytes=4096)]]
        self.calls = []
        self.missing = set()

    def api(self, path='', method='GET'):
        self.calls.append((method, path))
        if not path:
            return dict(full_name=self.repository, default_branch='main')
        if path.startswith('pulls/'):
            return dict(state='open' if self.states.pop(0) else 'closed')
        if path.startswith('git/ref/'):
            if self.states.pop(0):
                return dict(ref=self.ref)
            raise pruner.NotFound('deleted branch')
        if method == 'DELETE':
            if int(path.rsplit('/', 1)[1]) in self.missing:
                raise pruner.NotFound('evicted')
            return None
        query = parse_qs(urlsplit(path).query)
        if query['ref'] != [self.ref] or query['per_page'] != ['100']:
            raise AssertionError('inventory request changed scope')
        return dict(actions_caches=copy.deepcopy(self.pages[int(query['page'][0]) - 1]))

    @property
    def deleted(self):
        return [path for method, path in self.calls if method == 'DELETE']


class FinishedCacheTests(unittest.TestCase):
    def test_closed_pr_deletes_only_listed_immutable_ids(self):
        client = FakeClient()
        result = pruner.prune(client, pull_request=17, apply=True)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['removed_ids'], [101])
        self.assertEqual(result['removed_bytes'], 4096)
        self.assertEqual(client.deleted, ['actions/caches/101'])

    def test_deleted_branch_has_no_live_git_reference(self):
        client = FakeClient(ref='refs/heads/feature/cache&probe')
        result = pruner.prune(client, deleted_branch='feature/cache&probe', apply=True)
        self.assertEqual(result['status'], 'passed')
        self.assertIn(('GET', 'git/ref/heads/feature/cache%26probe'), client.calls)
        self.assertEqual(client.deleted, ['actions/caches/101'])

    def test_open_pr_and_existing_branch_do_not_even_list_caches(self):
        for selector, ref in [(dict(pull_request=17), 'refs/pull/17/merge'),
                              (dict(deleted_branch='work'), 'refs/heads/work')]:
            with self.subTest(selector=selector):
                client = FakeClient(ref=ref, states=[True])
                self.assertEqual(pruner.prune(client, apply=True, **selector)['status'], 'skipped')
                self.assertFalse(any('actions/caches' in p for _, p in client.calls))

    def test_reopened_pr_and_recreated_branch_cancel_pending_deletions(self):
        for selector, ref in [(dict(pull_request=17), 'refs/pull/17/merge'),
                              (dict(deleted_branch='work'), 'refs/heads/work')]:
            with self.subTest(selector=selector):
                client = FakeClient(ref=ref, states=[False, True])
                result = pruner.prune(client, apply=True, **selector)
                self.assertEqual(result['status'], 'skipped')
                self.assertEqual(client.deleted, [])

    def test_default_branch_and_invalid_refs_are_rejected(self):
        selectors = [dict(deleted_branch='main'), dict(deleted_branch=''),
                     dict(deleted_branch=42), dict(deleted_branch=True),
                     dict(deleted_branch='../main'), dict(deleted_branch='bad\nname'),
                     dict(pull_request=0), dict(pull_request=True), {},
                     dict(pull_request=17, deleted_branch='work')]
        for selector in selectors:
            with self.subTest(selector=selector):
                client = FakeClient()
                with self.assertRaises(ValueError):
                    pruner.prune(client, apply=True, **selector)
                self.assertEqual(client.deleted, [])

    def test_inventory_is_fully_validated_before_any_delete(self):
        ref = 'refs/pull/17/merge'
        invalid = [dict(id=102, ref='refs/heads/main', size_in_bytes=3),
                   dict(id=102, ref='refs/tags/v1.2.55_desktop', size_in_bytes=3),
                   dict(id=101, ref=ref, size_in_bytes=3),
                   dict(id=True, ref=ref, size_in_bytes=3),
                   dict(id=102, ref=ref, size_in_bytes=-1), None]
        for row in invalid:
            with self.subTest(row=row):
                client = FakeClient(pages=[[dict(id=101, ref=ref, size_in_bytes=3), row]])
                with self.assertRaises(ValueError):
                    pruner.prune(client, pull_request=17, apply=True)
                self.assertEqual(client.deleted, [])

    def test_pagination_keeps_the_same_exact_ref(self):
        ref = 'refs/pull/17/merge'
        rows = [dict(id=i, ref=ref, size_in_bytes=i) for i in range(1, 102)]
        client = FakeClient(pages=[rows[:100], rows[100:]])
        result = pruner.prune(client, pull_request=17, apply=True)
        self.assertEqual(len(result['removed_ids']), 101)
        self.assertEqual(result['removed_bytes'], sum(range(1, 102)))
        self.assertEqual(len(client.deleted), 101)

    def test_dry_run_has_no_mutations(self):
        client = FakeClient()
        result = pruner.prune(client, pull_request=17)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['selected_ids'], [101])
        self.assertEqual(client.deleted, [])

    def test_concurrent_eviction_is_idempotent(self):
        client = FakeClient()
        client.missing.add(101)
        result = pruner.prune(client, pull_request=17, apply=True)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['removed_ids'], [])
        self.assertEqual(result['removed_bytes'], 0)

    def test_unknown_api_or_auth_failure_never_means_deleted_branch(self):
        client = FakeClient(ref='refs/heads/work')
        original = client.api
        def fail(path='', method='GET'):
            if path.startswith('git/ref/'):
                raise RuntimeError('API unavailable')
            return original(path, method)
        client.api = fail
        with self.assertRaises(RuntimeError):
            pruner.prune(client, deleted_branch='work', apply=True)
        self.assertEqual(client.deleted, [])

    def test_client_distinguishes_missing_from_auth_failure_and_bounds_calls(self):
        client = pruner.Client('owner/repo')
        for status, error in [('404', pruner.NotFound), ('403', RuntimeError)]:
            with patch.object(pruner.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr=f'gh: failed (HTTP {status})')) as run:
                with self.assertRaises(error):
                    client.api('git/ref/heads/work')
                self.assertLessEqual(run.call_args.kwargs['timeout'], 20)
        with patch.object(pruner.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['gh'], 20)):
            with self.assertRaises(subprocess.TimeoutExpired):
                client.api()

    def test_wrong_repository_and_exhausted_budget_fail_closed(self):
        client = FakeClient()
        client.api = lambda *a, **k: dict(full_name='elsewhere/repo', default_branch='main')
        with self.assertRaises(ValueError):
            pruner.prune(client, pull_request=17, apply=True)
        with patch.object(pruner.subprocess, 'run') as run:
            with self.assertRaises(TimeoutError):
                pruner.Client('owner/repo', budget=0).api()
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
