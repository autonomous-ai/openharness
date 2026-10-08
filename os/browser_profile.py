#!/usr/bin/python3
"""Offer the OS start page without replacing an existing New Tab customization.

Only our supported external-extension descriptor is written. Browser preferences,
bookmarks, acknowledgement/disable records and other extensions are read-only.
"""
import json
import os
from pathlib import Path
import re
import sys
import tempfile

PACKAGE = Path('/usr/share/harness-os/browser-home/extension.json')


def read_json(path):
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Oversized browser preferences')
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError('Invalid browser preferences')
    return data


def customized(root, extension_id):
    for pattern in ['*/Preferences', '*/Secure Preferences']:
        for path in root.glob(pattern):
            extensions = read_json(path).get('extensions', {})
            for entry in extensions.get('chrome_url_overrides', {}).get('newtab', []):
                url = entry.get('entry', '') if isinstance(entry, dict) else entry
                if not isinstance(url, str) or not url.startswith('chrome-extension://' + extension_id + '/'):
                    return True
            for other_id, entry in extensions.get('settings', {}).items():
                if (other_id != extension_id and
                        'newtab' in entry.get('manifest', {}).get('chrome_url_overrides', {})):
                    return True
    return False


def prepare(root, package=PACKAGE):
    try:
        record = read_json(package)
        extension_id = record['extension_id']
        if not re.fullmatch('[a-p]{32}', extension_id):
            return False
        descriptor = record['descriptor']
        target = root / 'External Extensions' / (extension_id + '.json')
        if target.is_symlink():
            return False
        if target.exists():
            previous = read_json(target)
            if previous.get('external_crx') != descriptor['external_crx']:
                return False  # This file is no longer ours to update.
            if previous == descriptor:
                return True
        elif customized(root, extension_id):
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, mode='w', delete=False) as out:
                temporary = Path(out.name)
                json.dump(descriptor, out)
                out.write('\n')
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False  # An optional start page must never prevent browsing.


if __name__ == '__main__':
    # Custom profile launches belong to their caller. Chromium's usual profile
    # and XDG configuration are the only defaults provisioned here.
    if not os.environ.get('CHROME_USER_DATA_DIR') and not any(
            arg == '--user-data-dir' or arg.startswith('--user-data-dir=') for arg in sys.argv[1:]):
        config = Path(os.environ.get('CHROME_CONFIG_HOME') or os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
        prepare(config / 'chromium')
