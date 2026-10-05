#!/usr/bin/env python3
"""Remove caches scoped to a closed PR or a branch that no longer exists.

Dry-run by default. All metadata is checked before deleting immutable cache IDs;
main, tags, open PRs and existing branches cannot be selected by this command.
"""
import argparse
import json
import os
import re
import subprocess
import time
from urllib.parse import quote, urlencode


class NotFound(RuntimeError):
    pass


class Client:
    def __init__(self, repository, budget=90):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
            raise ValueError('repository must be owner/name')
        if any(part in {'.', '..'} for part in repository.split('/')):
            raise ValueError('invalid repository')
        self.repository = repository
        self.deadline = time.monotonic() + budget

    def api(self, path='', method='GET'):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('cache cleanup budget exhausted')
        endpoint = f'repos/{self.repository}' + (f'/{path}' if path else '')
        result = subprocess.run(['gh', 'api', '--method', method, endpoint],
                                capture_output=True, text=True, timeout=min(20, remaining))
        if result.returncode:
            if re.search(r'\(HTTP 404\)', result.stderr):
                raise NotFound(endpoint)
            raise RuntimeError(f'{method} {path or "repository"} failed')
        return json.loads(result.stdout) if result.stdout.strip() else None


def target_ref(client, pull_request=None, deleted_branch=None):
    repository = client.api()
    if not isinstance(repository, dict) or repository.get('full_name', '').lower() != client.repository.lower():
        raise ValueError('repository identity differs')
    default = repository.get('default_branch')
    if not isinstance(default, str) or not default:
        raise ValueError('repository default branch is unavailable')
    if (pull_request is None) == (deleted_branch is None):
        raise ValueError('select exactly one closed PR or deleted branch')
    if pull_request is not None:
        if type(pull_request) is not int or pull_request <= 0:
            raise ValueError('pull request number must be positive')
        return f'refs/pull/{pull_request}/merge'
    if not isinstance(deleted_branch, str) or not deleted_branch:
        raise ValueError('invalid branch name')
    if deleted_branch == default:
        raise ValueError('the default branch cannot be pruned')
    ref = f'refs/heads/{deleted_branch}'
    result = subprocess.run(['git', 'check-ref-format', ref], capture_output=True, timeout=10)
    if result.returncode:
        raise ValueError('invalid branch name')
    return ref


def finished(client, ref):
    match = re.fullmatch(r'refs/pull/([1-9][0-9]*)/merge', ref)
    if match:
        data = client.api(f'pulls/{match[1]}')
        if not isinstance(data, dict) or data.get('state') not in {'open', 'closed'}:
            raise ValueError('pull request state is unavailable')
        return data['state'] == 'closed'
    if not ref.startswith('refs/heads/'):
        raise ValueError('only branch and pull-request cache refs are supported')
    try:
        data = client.api('git/ref/' + quote(ref.removeprefix('refs/'), safe='/'))
    except NotFound:
        return True
    if not isinstance(data, dict) or data.get('ref') != ref:
        raise ValueError('branch identity differs')
    return False


def entries(client, ref):
    result = []
    seen = set()
    for page in range(1, 21):
        query = urlencode(dict(ref=ref, per_page=100, page=page))
        data = client.api(f'actions/caches?{query}')
        caches = data.get('actions_caches') if isinstance(data, dict) else None
        if not isinstance(caches, list):
            raise ValueError('cache inventory is unavailable')
        for cache in caches:
            if not isinstance(cache, dict) or cache.get('ref') != ref:
                raise ValueError('cache inventory escaped the requested ref')
            identifier, size = cache.get('id'), cache.get('size_in_bytes')
            if type(identifier) is not int or identifier <= 0 or identifier in seen:
                raise ValueError('invalid or duplicate cache identity')
            if type(size) is not int or size < 0:
                raise ValueError('invalid cache size')
            seen.add(identifier)
            result.append(dict(id=identifier, size_in_bytes=size))
        if len(caches) < 100:
            return result
    raise ValueError('cache inventory exceeded its page budget')


def prune(client, *, pull_request=None, deleted_branch=None, apply=False):
    ref = target_ref(client, pull_request, deleted_branch)
    report = dict(repository=client.repository, ref=ref, status='skipped',
                  removed_ids=[], removed_bytes=0)
    if not finished(client, ref):
        return dict(report, reason='pull request or branch is still active')
    selected = entries(client, ref)
    # A PR can reopen or a deleted branch can be recreated while listing caches.
    if not finished(client, ref):
        return dict(report, reason='pull request or branch became active while listing')
    report.update(status='ready', selected_ids=[c['id'] for c in selected],
                  selected_bytes=sum(c['size_in_bytes'] for c in selected))
    if not apply:
        return report
    for cache in selected:
        try:
            client.api(f'actions/caches/{cache["id"]}', method='DELETE')
        except NotFound:
            continue  # Already evicted/deleted; never substitute another cache.
        report['removed_ids'].append(cache['id'])
        report['removed_bytes'] += cache['size_in_bytes']
    report['status'] = 'passed'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY'))
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--pull-request', type=int)
    target.add_argument('--deleted-branch')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.repo:
        parser.error('--repo or GITHUB_REPOSITORY is required')
    try:
        result = prune(Client(args.repo), pull_request=args.pull_request,
                       deleted_branch=args.deleted_branch, apply=args.apply)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f'cache cleanup failed: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
