#!/usr/bin/env python3
"""Publish an already-tested preview; never turn an incomplete VM run into a release."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile

REQUIRED_CHECKS = ['Live hn ready;', 'Wayland clipboard round trip',
                   'Browser starts only on shortcut', 'Dated package repositories are queryable',
                   'Closing the last terminal and immediately opening another',
                   'An hn terminal pane inherits', 'OS surface refuses detach',
                   'Terminal process survives screen restart', 'Offline installer completed',
                   'Installed disk boots to hn', 'A real offline package transaction',
                   'Offline checkpoint restored', 'Recovered disk boots to hn']


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def gh(*args):
    return subprocess.check_output(['gh', *map(str, args)], text=True, timeout=120).strip()


def read(path):
    return json.loads(path.read_text())


def validate_receipts(manifest, receipts):
    rows = {(r['firmware'], r['encrypted']): r for r in receipts}
    if set(rows) != {('bios', False), ('uefi', True)} or len(receipts) != 2:
        raise ValueError('Need one plain BIOS and one encrypted UEFI receipt.')
    for receipt in receipts:
        if receipt['status'] != 'passed' or receipt.get('scope') == 'live session only':
            raise ValueError('Machine validation is incomplete or failed.')
        if receipt['iso_sha256'] != manifest['iso']['sha256'] or receipt['image_source_commit'] != manifest['source_commit']:
            raise ValueError('Machine receipt covers a different image or source.')
        checks = receipt.get('checks', [])
        if any(not any(check.startswith(prefix) for check in checks) for prefix in REQUIRED_CHECKS):
            raise ValueError('A required live, installation or recovery check is absent.')
    if not any(check.startswith('Real Claude Code, Codex, OpenCode and pi install') for check in rows[('bios', False)]['checks']):
        raise ValueError('Real agent executable compatibility has not passed.')
    if not any(check.startswith('On-demand gcc/make installation') for check in rows[('bios', False)]['checks']):
        raise ValueError('The real compiler and local web development check has not passed.')


def validate_examples(folder, kind):
    """Reject missing/failed independent application evidence before publishing it."""
    reports = list(folder.rglob(f'{kind}/reports'))
    if len(reports) != 1:
        raise ValueError(f'Expected one {kind} report directory.')
    report = reports[0]
    if kind == 'dsh':
        rows = read(report / 'results.json')
        if len(rows) != 3 or {r['name'] for r in rows} != {'hello', 'logs', 'game'} or any(r['status'] != 'passed' for r in rows):
            raise ValueError('All three real DSH exercises must pass.')
    else:
        for name in ['terminal-tool', 'website', 'game', 'fullstack']:
            for stage in ['agent', 'checks']:
                if (report / f'{name}-{stage}.status').read_text().strip() != '0':
                    raise ValueError(f'{name} {stage} did not complete successfully.')
        rows = read(report / 'browser-receipt.json')['results']
        names = {'website keyboard filtering and help', 'game movement pause restart and state restoration',
                 'fullstack browser CRUD validation and persistence'}
        if len(rows) != 3 or {r['name'] for r in rows} != names or any(r['status'] != 'passed' for r in rows):
            raise ValueError('All independent browser/API checks must pass.')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--tests', type=int, required=True)
    parser.add_argument('--image', type=int, required=True)
    parser.add_argument('--dsh', type=int, default=0)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--prepare-only', action='store_true', help='Validate and assemble local review files without publishing')
    args = parser.parse_args()
    root = args.input.resolve()
    folder = root / 'image'
    manifest = read(folder / 'manifest.json')
    version = manifest['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+-preview\.\d+', version):
        raise ValueError('This publisher only creates explicitly versioned previews.')
    iso = folder / manifest['iso']['name']
    if iso.parent != folder or not iso.name.endswith('.iso') or iso.stat().st_size != manifest['iso']['bytes'] or digest(iso) != manifest['iso']['sha256']:
        raise ValueError('ISO identity does not match its manifest.')
    inspection = read(folder / 'inspection.json')
    if inspection['status'] != 'passed' or inspection['iso_sha256'] != manifest['iso']['sha256'] or inspection['source_commit'] != manifest['source_commit']:
        raise ValueError('The actual image payload has not passed inspection.')
    receipts = [read(path) for path in (root / 'machines').rglob('receipt.json')]
    validate_receipts(manifest, receipts)
    run = json.loads(gh('api', f'repos/{args.repo}/actions/runs/{args.tests}'))
    image = json.loads(gh('api', f'repos/{args.repo}/actions/runs/{args.image}'))
    jobs = json.loads(gh('api', f'repos/{args.repo}/actions/runs/{args.image}/jobs?filter=latest&per_page=100'))
    if run['conclusion'] != 'success' or run['status'] != 'completed' or run['path'] != '.github/workflows/os.yml':
        raise ValueError('The machine workflow did not finish successfully.')
    if image['head_sha'] != manifest['source_commit'] or not any(j['name'] == 'image' and j['conclusion'] == 'success' for j in jobs['jobs']):
        raise ValueError('The image does not match a successful build job.')
    examples = {}
    if list((root / 'machines').rglob('workloads/reports')):
        examples['workloads'] = {'run': run['html_url'], 'browser_checks': validate_examples(root / 'machines', 'workloads')}
    if args.dsh:
        dsh_run = json.loads(gh('api', f'repos/{args.repo}/actions/runs/{args.dsh}'))
        if dsh_run['conclusion'] != 'success' or dsh_run['status'] != 'completed' or dsh_run['path'] != '.github/workflows/os.yml':
            raise ValueError('The DSH workflow did not finish successfully.')
        dsh_receipts = [read(path) for path in (root / 'dsh-machines').rglob('receipt.json')]
        validate_receipts(manifest, dsh_receipts)
        examples['dsh'] = {'run': dsh_run['html_url'], 'machines': dsh_receipts,
                           'checks': validate_examples(root / 'dsh-machines', 'dsh')}
    limitations = ['Physical ThinkPad, Wi-Fi, suspend and NVIDIA hardware remain unverified.',
                   'Account-authenticated Claude/Codex model turns remain unverified; free OpenCode turns are recorded separately.',
                   'Timing and memory measurements describe these VMs, not physical laptop power-on time.']
    validation = {'status': 'passed', 'image_run': image['html_url'], 'machine_run': run['html_url'],
                  'machines': receipts, 'examples': examples, 'limitations': limitations}
    (folder / 'validation.json').write_text(json.dumps(validation, indent=2) + '\n')
    manifest['validation'] = {'status': 'passed', 'receipt': 'validation.json', 'machine_run': run['html_url'], 'limitations': limitations}
    (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with zipfile.ZipFile(folder / 'machine-evidence.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for directory in ['machines', 'dsh-machines']:
            for path in sorted((root / directory).rglob('*')):
                if path.is_file() and path.suffix in {'.png', '.json', '.txt', '.jsonl'} and 'Projects' not in path.relative_to(root / directory).parts:
                    archive.write(path, path.relative_to(root))
    if examples:
        with zipfile.ZipFile(folder / 'programmer-examples.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for directory, kind in [('machines', 'workloads'), ('dsh-machines', 'dsh')]:
                if kind not in examples:
                    continue
                for project_root in (root / directory).rglob('Projects'):
                    for path in sorted(project_root.rglob('*')):
                        if path.is_file() and not set(path.relative_to(project_root).parts) & {'node_modules', '.git', '.harness', '__pycache__'}:
                            archive.write(path, path.relative_to(project_root))
    assets = sorted(p for p in folder.iterdir() if p.is_file())
    identities = {p.name: {'sha256': digest(p), 'bytes': p.stat().st_size} for p in assets}
    tag = 'os-v' + version
    notes = root / 'release-notes.md'
    interactive_install = all(any(c.startswith('Keyboard disk selection, encryption checkbox') for c in r['checks']) for r in receipts)
    update_retry = all(any(c.startswith('Failed full update blocks package changes') for c in r['checks']) for r in receipts)
    notes.write_text(f'''Boot directly into hn. Open agents with Ctrl+B, then N. Super+B opens Chromium or returns to hn.

Arch Linux with the LTS kernel, labwc, foot, and an on-demand browser. No desktop panels or preinstalled development stacks.

To try it: verify the ISO's SHA-256, write the whole ISO to a USB stick, and boot an x86-64 PC with Secure Boot disabled. In an hn Terminal pane, run `sudo hn-os install`. This preview's installer erases the entire selected disk; it does not resize another OS. Encryption is enabled by default.

{'The installer uses a keyboard disk picker, an encryption checkbox under the disk, and two password fields. Continue opens a separate confirmation with Back selected initially. Choose Erase and install to begin; no device-path typing is needed. The account is me@harness. The password initially protects both the local account and, when enabled, the encrypted disk. There is no first-boot account wizard.' if interactive_install else ''}

{'Interrupted full OS updates now block ordinary package transactions until a full retry succeeds. Retrying keeps the original recovery checkpoint. This was exercised with a real failed repository refresh, blocked package upgrade, successful retry, and offline recovery. The bundled Harness runtime remains pinned to this preview; hn-os update updates Arch packages.' if update_retry else ''}

BIOS/plain and UEFI/encrypted VM boot, clipboard, browser switching, offline installation and package-checkpoint recovery passed. The BIOS VM also installed a compiler on demand, built C, served a local Node preview, and installed and started the four agent executables. See `validation.json` and `machine-evidence.zip` for the exact checks and measurements.

{'Real free OpenCode agents built a Python CLI, a conference website, a keyboard game and a Fastify/SQLite application. Their unit tests and independent browser/API checks passed. The retained projects are in `programmer-examples.zip`, separate from the minimal ISO.' if 'workloads' in examples else ''}

{'Three DSHs also passed: a live HTML greeting, a terminal CSV tool, and a game using the existing shared viewers, including keyboard play, pause and standalone export.' if 'dsh' in examples else ''}

{chr(10).join('- ' + item for item in limitations)}

Source: `{manifest['source_commit']}`. [Machine validation]({run['html_url']}).
''')
    if args.prepare_only:
        print(json.dumps({'status': 'prepared', 'tag': tag, 'repository': args.repo,
                          'notes': str(notes), 'files': identities}, indent=2))
        return
    subprocess.run(['gh', 'release', 'create', tag, '--repo', args.repo, '--target', manifest['source_commit'],
                    '--draft', '--prerelease', '--title', 'Programmer OS ' + version, '--notes-file', str(notes),
                    *map(str, assets)], check=True, timeout=900)
    try:
        subprocess.run(['gh', 'release', 'edit', tag, '--repo', args.repo, '--draft=false'], check=True, timeout=120)
        release = json.loads(gh('api', f'repos/{args.repo}/releases/tags/{tag}'))
        def verify(asset):
            expected = identities[asset['name']]
            with tempfile.TemporaryDirectory(prefix='hn-release-check-') as temp:
                downloaded = Path(temp) / asset['name']
                subprocess.run(['curl', '--fail', '--location', '--retry', '2', '--max-time', '600', '--silent', '--show-error',
                                asset['browser_download_url'], '--output', str(downloaded)], check=True, timeout=650)
                if downloaded.stat().st_size != expected['bytes'] or digest(downloaded) != expected['sha256']:
                    raise ValueError('Public asset checksum mismatch: ' + asset['name'])
            return asset['name']
        if {a['name'] for a in release['assets']} != set(identities):
            raise ValueError('Published asset set differs from the verified build.')
        with ThreadPoolExecutor(max_workers=3) as pool:
            checked = list(pool.map(verify, release['assets']))
        receipt = {'status': 'passed', 'release_url': release['html_url'], 'source_commit': manifest['source_commit'],
                   'finished_at_unix': time.time(), 'verified_public_assets': checked, 'files': identities}
        (root / 'publication.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(release['html_url'])
    except BaseException:
        subprocess.run(['gh', 'release', 'edit', tag, '--repo', args.repo, '--draft=true'], check=True, timeout=120)
        raise


if __name__ == '__main__':
    main()
