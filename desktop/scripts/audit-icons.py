#!/usr/bin/env python3
"""Audit every first-party desktop/web Dart icon; optionally save its inventory."""

import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'lib/shared/theme/app_icons.dart'


def audit():
    catalogue = dict(re.findall(
        r'static const (\w+)\s*=\s*LucideIcons\.(\w+);',
        CATALOG.read_text(),
    ))
    errors = []
    uses = {name: [] for name in catalogue}
    special = {}
    files = list((ROOT / 'lib').rglob('*.dart'))
    for name, glyph in catalogue.items():
        if not glyph.endswith('400'):
            errors.append(f'AppIcons.{name}: use the regular 400 outline')
    for file in sorted(files):
        if file == CATALOG:
            continue
        relative = str(file.relative_to(ROOT))
        for number, line in enumerate(file.read_text().splitlines(), 1):
            code = line.split('//', 1)[0]
            location = f'{relative}:{number}'
            for match in re.finditer(r'\b(?:Icons|CupertinoIcons|LucideIcons)\.\w+', code):
                errors.append(f'{location}: {match.group()} bypasses AppIcons')
            if 'package:lucide_icons_flutter/' in code:
                errors.append(f'{location}: import AppIcons instead of the font package')
            for name in re.findall(r'\bAppIcons\.(\w+)', code):
                if name in uses:
                    uses[name].append(location)
            for name in re.findall(r'\bAppPaneSymbol\.(\w+)', code):
                special.setdefault(name, []).append(location)
    return {
        'scope': 'desktop/lib, including Linux menus and the shared web UI',
        'dart_files_scanned': len(files),
        'catalogue_symbols': len(catalogue),
        'symbols_used': sum(bool(locations) for locations in uses.values()),
        'references': sum(map(len, uses.values())),
        'symbols': {name: {'glyph': catalogue[name], 'locations': locations}
                    for name, locations in sorted(uses.items())},
        'pane_symbols': dict(sorted(special.items())),
        'errors': errors,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Write the complete JSON inventory')
    args = parser.parse_args()
    report = audit()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(f"Scanned {report['dart_files_scanned']} Dart files; "
          f"{report['catalogue_symbols']} catalogue symbols, "
          f"{report['references']} references.")
    if report['errors']:
        print('\n'.join(report['errors']))
        raise SystemExit(1)
    print('All action icons use the shared catalogue and regular outline weight.')
