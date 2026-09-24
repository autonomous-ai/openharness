#!/usr/bin/env python3
"""Copy route artifacts with explicit diagnostic redactions and SHA-256 inventory."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def sha(data):
    return hashlib.sha256(data).hexdigest()


def publish(source, destination, allow_partial=False):
    plan_bytes = (source / 'plan.json').read_bytes()
    plan = json.loads(plan_bytes)
    missing = [trial['file'] for trial in plan['trials'] if not (source / trial['file']).exists()]
    if missing and not allow_partial:
        raise ValueError('Incomplete matrix; --allow-partial is only for checkpoints')
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'plan.json').write_bytes(plan_bytes)
    inventory = [{'file': 'plan.json', 'sha256': sha(plan_bytes), 'redactions': []}]
    for trial in plan['trials']:
        name = trial['file']
        if not re.fullmatch(r'[a-z][a-z0-9-]*-(p2p|turn|relay)-[0-9]+\.json', name):
            raise ValueError('Unexpected artifact filename')
        path = source / name
        if not path.exists():
            continue
        raw = path.read_bytes()
        result = json.loads(raw)
        redactions = []
        for parent, field in [('failureDiagnostics', 'outputTail'), ('cleanup', 'agentId')]:
            if field in result.get(parent, {}):
                del result[parent][field]
                redactions.append(parent + '.' + field)
        if redactions:
            result['publicationRedactions'] = redactions
        published = (json.dumps(result, indent=2, ensure_ascii=False) + '\n').encode()
        # Fail for human review instead of guessing how to redact an unexpected
        # payload. Revision hashes are intended; private IDs/paths/addresses aren't.
        scan = dict(result)
        scan.pop('sourceRevision', None)
        text = json.dumps(scan)
        if re.search(r'/Users/|/home/|(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{32,}|accessToken|refreshToken|"credential"|"sdp"|"identity"', text):
            raise ValueError(f'Potential private content in {name}; inspect before publishing')
        existing = destination / name
        if existing.exists() and existing.read_bytes() != published:
            raise ValueError(f'Refusing to rewrite an already published observation: {name}')
        existing.write_bytes(published)
        inventory.append({'file': name, 'sha256': sha(published), 'sourceSha256': sha(raw), 'redactions': redactions})
    manifest = {'schema': 1, 'complete': not missing, 'missingTrials': missing,
                'note': 'Console logs remain private. Only listed fields were removed; timings and route evidence are unchanged.',
                'artifacts': inventory}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    result = publish(args.source, args.destination, args.allow_partial)
    print(json.dumps({'complete': result['complete'], 'artifacts': len(result['artifacts']),
                      'missing': len(result['missingTrials'])}))
