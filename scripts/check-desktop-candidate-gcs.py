#!/usr/bin/env python3
"""Exercise candidate sealing/promotion using six tiny run-owned GCS objects."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import tempfile

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('desktop-release-candidate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def main():
    identity = candidate.context()
    bucket = os.environ['GCS_BUCKET']
    candidate.check_bucket(bucket)
    run = f'{identity["run_id"]}-{identity["run_attempt"]}'
    prefix = f'harness/desktop-candidates/{run}-{secrets.token_hex(16)}'
    destination = f'harness/desktop/.candidate-check/{run}/artifacts'
    scratch = f'harness/desktop/.ci/{run}'
    version = '0.0.1'
    uri = f'gs://{bucket}/harness/desktop/.candidate-check/{run}/metadata.json'
    gcloud = candidate.publisher.gcloud
    try:
        with tempfile.TemporaryDirectory(prefix='candidate-gcs-check-') as folder:
            root = Path(folder)
            entries = {}
            for key, filename in candidate.FILES.items():
                data = f'Candidate fixture {key}\n'.encode()
                file = root / filename
                file.write_bytes(data)
                entries[key] = dict(version=version, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                                    url=f'https://storage.googleapis.com/{bucket}/{prefix}/{filename}')
            gcloud('storage', 'cp', *[str(root / file) for file in candidate.FILES.values()],
                   f'gs://{bucket}/{prefix}/', '--if-generation-match=0')
            for name, keys in candidate.publisher.PARTS.items():
                (root / name).write_text(json.dumps({key: entries[key] for key in keys}))
            receipt = candidate.seal(version, bucket, prefix, root, identity)
            candidate.check_sources(receipt)
            candidate.promote(receipt, destination, scratch)
            print('PASS: seal six source generations and promote their exact bytes', flush=True)
            promoted = root / 'promoted'
            promoted.mkdir()
            gcloud('storage', 'cp', f'gs://{bucket}/{scratch}/*.json', str(promoted) + '/')
            candidate.publisher.publish(uri, version, promoted, allow_initialize=True)
            checked = candidate.verification.verify(version, uri.replace('gs://', 'https://storage.googleapis.com/'))
            assert checked['status'] == 'passed', checked
            print('PASS: publish and verify all six promoted fixture downloads', flush=True)
            try:
                candidate.promote(receipt, destination, scratch)
            except RuntimeError as error:
                assert '412' in str(error), error
            else:
                raise AssertionError('promotion overwrote an immutable destination')
            print('PASS: a second promotion fails the atomic destination precondition', flush=True)

            # Verify the actual SDK listing schema and generation-qualified delete
            # command, restricted to this run's disposable objects.
            listed = json.loads(gcloud('storage', 'objects', 'list', f'gs://{bucket}/{prefix}/**', '--raw', '--format=json'))
            now = datetime.now(timezone.utc)
            assert candidate.expired_objects(listed, now) == [], listed
            expired = candidate.expired_objects(listed, now + timedelta(days=8))
            assert len(expired) == 6 and all(item.startswith(prefix + '/') for item in expired), listed
            gcloud('storage', 'rm', f'gs://{bucket}/{expired[0]}')
            print('PASS: recent objects retained; expiry recognizes all six and deletes the selected generation', flush=True)
    finally:
        # No configurable product paths: all three prefixes are constructed from
        # this workflow's own run/attempt and random token above.
        errors = []
        for owned in (prefix, scratch, f'harness/desktop/.candidate-check/{run}'):
            try:
                gcloud('storage', 'rm', '--recursive', f'gs://{bucket}/{owned}/')
            except RuntimeError as error:
                # A failure before upload may leave a prefix empty. Continue
                # through every owned prefix even when one removal fails.
                if '404' not in str(error) and 'matched no objects' not in str(error):
                    errors.append(str(error))
        if errors:
            raise RuntimeError('fixture cleanup failed: ' + '; '.join(errors))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
