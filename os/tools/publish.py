#!/usr/bin/env python3
"""Publish an already-tested OS; never turn an incomplete VM run into a release."""
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
                   'USB opens network setup; Super+i opens Install offline;',
                   'USB first agent conversation accepts physical keyboard input',
                   'Bundled OpenCode loads the local TUI guide',
                   'Agent-created USB trial project survives offline installation',
                   'Bundled OpenCode starts offline and its upstream-default clean-profile conversation',
                   'Keyboard disk selection, encryption checkbox, masked password entry and a single Install action',
                   'Browser starts only on shortcut', 'Dated package repositories are queryable',
                   'Closing the last terminal and immediately opening another',
                   'An hn terminal pane inherits', 'OS surface refuses detach',
                   'Terminal process survives screen restart', 'Offline installer completed',
                   'Installed disk boots to hn', 'A real offline package transaction',
                   'Offline checkpoint restored', 'Recovered disk boots to hn']


INSTALL_FIRST_CHECKS = [check for check in REQUIRED_CHECKS if not check.startswith((
    'Live hn', 'USB ', 'Agent-created USB', 'Bundled OpenCode starts offline'))] + [
    'USB opens the installer directly with no trial, network page, hn runtime or agent',
    'Installed Wi-Fi first use advances into three real panes and the bundled default agent answers keyboard input',
    "Bundled OpenCode's upstream-default clean-profile conversation",
]


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def gh(*args):
    return subprocess.check_output(['gh', *map(str, args)], text=True, timeout=120).strip()


def read(path):
    return json.loads(path.read_text())


def is_preview(version):
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-preview\.\d+)?', version):
        raise ValueError('Expected an explicit OS release or numbered preview version.')
    return '-preview.' in version


def version_key(version):
    preview = is_preview(version)
    base, _, number = version.partition('-preview.')
    return (*map(int, base.split('.')), int(not preview), int(number or 0))


def publish_latest_pointer(repo, manifest, release):
    """Advance the OS-only download link after the immutable assets are verified."""
    version = manifest['version']
    preview = is_preview(version)
    tag = 'os-latest'
    endpoint = f'repos/{repo}/releases/tags/{tag}'
    previous = subprocess.run(['gh', 'api', endpoint], capture_output=True, text=True, timeout=120)
    exists = previous.returncode == 0
    if not exists and '404' not in previous.stderr:
        raise ValueError('Cannot inspect the OS latest pointer: ' + previous.stderr)
    if exists:
        old = json.loads(previous.stdout)
        marker = re.search(r'<!-- harness-os-latest:(\{[^\n]+\}) -->', old.get('body', ''))
        if not marker:
            raise ValueError('The existing OS latest release is not a managed pointer.')
        identity = json.loads(marker[1])
        # Once an official OS exists, later previews keep their versioned links
        # and cannot replace that default download.
        if preview and not is_preview(identity['version']):
            return {'status': 'official-release-retained', 'version': identity['version']}
        current = version_key(identity['version'])
        candidate = version_key(version)
        if current > candidate:
            return {'status': 'newer-release-retained', 'version': identity['version']}
        if current == candidate and identity['source_commit'] != manifest['source_commit']:
            raise ValueError('The same OS version cannot point to different source.')
    identity = {'version': version, 'source_commit': manifest['source_commit']}
    prefix = f'https://github.com/{repo}/releases/download/os-v{version}/'
    iso = manifest['iso']['name']
    notes = f'''<!-- harness-os-latest:{json.dumps(identity, separators=(',', ':'))} -->
Harness **{version}** is the latest operating system {'preview' if preview else 'release'}.

[Download the x86-64 ISO]({prefix}{iso}) · [SHA-256 checksum]({prefix}{iso}.sha256) · [Installation guide]({prefix}INSTALL.md)

[Release notes, source and validation]({release['html_url']})

This permanent OS link advances after validation and public download checks. Versioned releases remain unchanged. Once an official OS is available, previews cannot replace that default download.
'''
    with tempfile.TemporaryDirectory(prefix='harness-os-latest-') as temporary:
        path = Path(temporary) / 'notes.md'
        path.write_text(notes)
        if exists:
            # Only this explicitly mutable pointer moves. Versioned tags never do.
            gh('api', '--method', 'PATCH', f'repos/{repo}/git/refs/tags/{tag}',
               '-f', 'sha=' + manifest['source_commit'], '-F', 'force=true')
            gh('release', 'edit', tag, '--repo', repo, '--target', manifest['source_commit'],
               '--draft=false', f'--prerelease={str(preview).lower()}', '--latest=false',
               '--title', 'Harness — latest OS', '--notes-file', path)
        else:
            gh('release', 'create', tag, '--repo', repo, '--target', manifest['source_commit'],
               f'--prerelease={str(preview).lower()}', '--latest=false', '--title', 'Harness — latest OS', '--notes-file', path)
    actual = json.loads(gh('api', endpoint))
    ref = json.loads(gh('api', f'repos/{repo}/git/ref/tags/{tag}'))
    if actual['draft'] or actual['prerelease'] != preview or actual['body'].strip() != notes.strip() or ref['object']['sha'] != manifest['source_commit']:
        raise ValueError('The public OS latest pointer does not match the verified release.')
    if not preview:
        gh('release', 'edit', 'os-v' + version, '--repo', repo, '--latest=true')
    return {'status': 'published', 'url': actual['html_url'], **identity}


def validate_install_guide(manifest, guide):
    if (f'These instructions are for **{manifest["version"]}**' not in guide or
            manifest['iso']['name'] not in guide):
        raise ValueError('The installation guide must match the release version and ISO filename.')


def validate_hardware(manifest, receipt):
    if (receipt.get('status') != 'passed' or receipt.get('iso_sha256') != manifest['iso']['sha256'] or
            receipt.get('image_source_commit') != manifest['source_commit'] or
            receipt.get('test_source_commit') != manifest['source_commit']):
        raise ValueError('Hardware installation evidence covers a different image or did not pass.')
    installed = receipt.get('installation', {})
    if installed.get('status') != 'passed' or installed.get('kernel') != manifest['hardware']['broadcom']['kernel']:
        raise ValueError('The offline hardware installation did not pass for this kernel.')
    for check in ['corrupted_bundle_rejected', 'cache_removed', 'base_packages_unchanged', 'native_drivers_preserved']:
        if installed.get(check) is not True:
            raise ValueError('Missing hardware installation check: ' + check)
    expected = {value['name']: value['version'] for value in manifest['hardware']['broadcom']['packages'].values()}
    if installed.get('optional_packages') != expected:
        raise ValueError('Installed optional packages differ from the image manifest.')
    for check in ['keyboard', 'post_rebuild_keyboard']:
        if not isinstance(receipt.get(check), dict) or receipt[check].get('confirmed_seconds_since_boot', 0) <= 0:
            raise ValueError('The installed hardware profile has not passed keyboard acceptance.')
    if receipt.get('installed_offline_rebuild_seconds', 0) <= 0:
        raise ValueError('Installed driver dependencies have not passed an offline rebuild.')


def validate_nvidia(manifest, receipt):
    if (receipt.get('status') != 'passed' or receipt.get('iso_sha256') != manifest['iso']['sha256'] or
            receipt.get('image_source_commit') != manifest['source_commit'] or
            receipt.get('test_source_commit') != manifest['source_commit'] or
            receipt.get('candidate_injected') is not False):
        raise ValueError('NVIDIA evidence must pass against the exact unmodified image.')
    bundle = manifest['hardware']['nvidia']
    installed = receipt.get('installation', {})
    if (installed.get('status') != 'passed' or installed.get('kernel') != bundle['kernel'] or
            installed.get('driver_version') != bundle['driver_version']):
        raise ValueError('The NVIDIA installation does not match the bundled kernel and driver.')
    for check in ['cache_extraction_excluded', 'corrupted_archive_rejected', 'invalid_signature_rejected',
                  'negative_selections_unchanged', 'cache_absent', 'base_packages_unchanged']:
        if installed.get(check) is not True:
            raise ValueError('Missing NVIDIA installation check: ' + check)
    expected = {value['name']: value['version'] for value in bundle['packages'].values()}
    if installed.get('optional_packages') != expected:
        raise ValueError('Installed NVIDIA packages differ from the image manifest.')
    for check in ['keyboard', 'return_keyboard']:
        if not isinstance(receipt.get(check), dict) or receipt[check].get('confirmed_seconds_since_boot', 0) <= 0:
            raise ValueError('NVIDIA package acceptance has not passed actual keyboard input.')
    for check in ['early_display_modules_and_firmware', 'generic_browser_after_driver_reboot']:
        if receipt.get(check) != 'passed':
            raise ValueError('Missing NVIDIA boot or browser acceptance: ' + check)


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
        required = INSTALL_FIRST_CHECKS if 'install-first' in manifest.get('capabilities', []) else REQUIRED_CHECKS
        if any(not any(check.startswith(prefix) for check in checks) for prefix in required):
            raise ValueError('A required live, installation or recovery check is absent.')
        if 'broadcom-offline' in manifest.get('capabilities', []) and not any(
                check.startswith('Unrelated hardware receives no optional Wi-Fi packages') for check in checks):
            raise ValueError('The generic installation has not passed optional-driver exclusion.')
        if 'nvidia-offline' in manifest.get('capabilities', []) and not any(
                check.startswith('Unrelated hardware receives no NVIDIA packages, boot configuration or USB GPU cache') for check in checks):
            raise ValueError('The generic installation has not passed NVIDIA-driver exclusion.')
    if not any(check.startswith('Harness unlock screen renders, masks input, accepts a retry') for check in rows[('uefi', True)]['checks']):
        raise ValueError('The encrypted graphical unlock and retry checks have not passed.')
    if not any(check.startswith('Claude Code, Codex and pi install on demand; bundled OpenCode') for check in rows[('bios', False)]['checks']):
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
    preview = is_preview(version)
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
    hardware = None
    if 'broadcom-offline' in manifest.get('capabilities', []):
        if not any(j['name'] == 'hardware' and j['conclusion'] == 'success' for j in jobs['jobs']):
            raise ValueError('The image build has no successful hardware installation job.')
        gh('run', 'download', args.image, '--repo', args.repo, '--name', 'harness-os-hardware', '--dir', root / 'hardware')
        hardware = read(root / 'hardware/receipt.json')
        validate_hardware(manifest, hardware)
    nvidia = None
    if 'nvidia-offline' in manifest.get('capabilities', []):
        if not any(j['name'] == 'nvidia' and j['conclusion'] == 'success' for j in jobs['jobs']):
            raise ValueError('The image build has no successful NVIDIA installation job.')
        gh('run', 'download', args.image, '--repo', args.repo, '--name', 'harness-os-nvidia-install', '--dir', root / 'nvidia')
        nvidia = read(root / 'nvidia/receipt.json')
        validate_nvidia(manifest, nvidia)
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
    limitations = ['ThinkPad installation and use have user confirmation; physical Intel Mac coverage, suspend and NVIDIA rendering/inference remain unverified.',
                   'This release is x86-64. Apple Silicon and Raspberry Pi images are not included.',
                   'Account-authenticated Claude/Codex model turns remain unverified. Bundled OpenCode default first-use turns are recorded in the machine evidence; upstream model availability may change.',
                   'Timing and memory measurements describe these VMs, not physical laptop power-on time.']
    validation = {'status': 'passed', 'image_run': image['html_url'], 'machine_run': run['html_url'],
                  'machines': receipts, 'examples': examples, 'limitations': limitations}
    if hardware is not None:
        validation['hardware'] = hardware
    if nvidia is not None:
        validation['nvidia'] = nvidia
    (folder / 'validation.json').write_text(json.dumps(validation, indent=2) + '\n')
    manifest['validation'] = {'status': 'passed', 'receipt': 'validation.json', 'machine_run': run['html_url'], 'limitations': limitations}
    (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    guide = (Path(__file__).resolve().parents[1] / 'INSTALL.md').read_text()
    validate_install_guide(manifest, guide)
    (folder / 'INSTALL.md').write_text(guide)
    with zipfile.ZipFile(folder / 'machine-evidence.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for directory in ['machines', 'dsh-machines', 'hardware', 'nvidia']:
            for path in sorted((root / directory).rglob('*')):
                include = path.suffix in {'.png', '.json', '.txt', '.jsonl'} or path.name.endswith('-boot-journal.log')
                if path.is_file() and include and not {'Projects', 'projects'} & set(path.relative_to(root / directory).parts):
                    archive.write(path, path.relative_to(root))
    if examples:
        with zipfile.ZipFile(folder / 'harness-examples.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for directory, kind in [('machines', 'workloads'), ('dsh-machines', 'dsh')]:
                if kind not in examples:
                    continue
                for project_root in (path for path in (root / directory).rglob('*') if path.name in {'Projects', 'projects'} and path.is_dir()):
                    for path in sorted(project_root.rglob('*')):
                        if path.is_file() and not set(path.relative_to(project_root).parts) & {'node_modules', '.git', '.harness', '__pycache__'}:
                            archive.write(path, path.relative_to(project_root))
    assets = sorted(p for p in folder.iterdir() if p.is_file())
    identities = {p.name: {'sha256': digest(p), 'bytes': p.stat().st_size} for p in assets}
    tag = 'os-v' + version
    notes = root / 'release-notes.md'
    interactive_install = all(any(c.startswith('Keyboard disk selection, encryption checkbox') for c in r['checks']) for r in receipts)
    update_retry = all(any(c.startswith('Failed full update blocks package changes') for c in r['checks']) for r in receipts)
    in_place_updates = {'runtime-updates', 'system-updates'}.issubset(manifest.get('capabilities', []))
    single_action_updates = 'single-action-updates' in manifest.get('capabilities', [])
    project_source_runs = sorted({str(r['workload_project_source_run_id']) for r in receipts if r.get('workload_project_source_run_id')})
    reuse_note = ('Completed project sources were retained from ' + ', '.join(
        f'[run {source}](https://github.com/{args.repo}/actions/runs/{source})' for source in project_source_runs) +
        '. The game agent ran again; all four projects\' unit tests and independent acceptance checks reran on this exact image.') if project_source_runs else ''
    notes.write_text(f'''Harness is a Linux operating system built by agents, for agents. Boot into the terminal, start another agent with Super+n, and open the browser with Super+b.

Arch Linux with the LTS kernel, labwc, foot, and an on-demand browser. No desktop panels or preinstalled development stacks.

To install: follow the included `INSTALL.md` for Mac → USB → ThinkPad instructions. Verify the ISO's SHA-256, write the whole ISO to a USB stick, and boot an x86-64 PC with Secure Boot disabled. The USB opens the installer directly; installation works offline. Select the disk, enter the password twice and choose Install Harness. Shut down, remove the USB and boot the installed disk. The existing Wi-Fi page appears when disconnected, then bundled OpenCode opens on the left beside two terminal panes. Working Ethernet skips Wi-Fi setup. OpenCode starts on Muse Spark 1.3 Free, a free OpenCode Zen model that answers tool calls, with upstream provider defaults and the local Harness guide. Super+n opens New Harness, Super+m connects a computer, and Super+t opens a shell directly. These shortcuts require no Shift; existing Ctrl+b bindings remain available. The installer erases the entire selected disk and does not resize another OS. Encryption is enabled by default.

{'The installer has four aligned fields: disk, encryption, password, repeat password. Disk choices fit on one line. Activate Install to begin; there is no second confirmation screen or minimum password length. Empty passwords are rejected. The account is me@harness. The password initially protects both the local account and, when enabled, the encrypted disk. There is no first-boot account wizard.' if interactive_install else ''}

{'Interrupted full OS updates block ordinary package transactions until a full retry succeeds. Retrying keeps the original recovery checkpoint. This was exercised with a real failed repository refresh, blocked package upgrade, successful retry, and offline recovery. hn-os update upgrades Arch packages.' if update_retry else ''}

{'Super+u starts the update immediately. The Update button is clickable too. No confirmation or password prompt is needed. Running agents and terminals stay alive; system updates keep a recovery checkpoint and leave restarting to you. After that reboot, the same request finishes any remaining runtime update. Background checks otherwise prepare downloads without activating them. Older previews use their existing Super+u, then s action to receive this change once; routine updates do not require reflashing.' if single_action_updates else 'Super+u opens Updates. hn and CLI releases are prepared automatically; Enter activates an available runtime update. System updates are a separate action in the same screen, with a checkpoint and a restart when ready. Routine updates do not require reflashing.' if in_place_updates else ''}

BIOS/plain and UEFI/encrypted VM boot, clipboard, browser switching, offline installation and package-checkpoint recovery passed. The BIOS VM uses a Nehalem CPU profile without AVX2, starts bundled OpenCode, installs the other agent executables, installs a compiler on demand, builds C, and serves a local Node preview. See `validation.json` and `machine-evidence.zip` for the exact checks and measurements.

{'The USB carries an optional Broadcom Wi-Fi module and signed offline dependencies for selected BCM4331/BCM4360 radios. Fresh installations retain those packages only when needed; other computers receive no additional compiler or driver packages. The exact module and offline installation/rebuild path passed native VM checks with synthetic PCI selection. Physical Mac radio association and sleep/wake remain unverified.' if hardware is not None else ''}

{'Supported NVIDIA machines install a snapshot-matched open kernel driver and userspace offline. The installer uses the bundled driver support table and leaves mixed legacy GPUs and passthrough assignments unchanged. Other computers receive no NVIDIA packages or package cache. Signed package installation, early display modules and firmware, encrypted reboot and a browser on a virtual GPU passed; physical NVIDIA rendering and inference remain unverified.' if nvidia is not None else ''}

{'Real free OpenCode agents built a Python CLI, a conference website, a keyboard game and a Fastify/SQLite application. Their unit tests and independent browser/API checks passed. The retained projects are in `harness-examples.zip`, separate from the minimal ISO.' if 'workloads' in examples else ''}

{reuse_note}

{'Three DSHs also passed: a live HTML greeting, a terminal CSV tool, and a game using the existing shared viewers, including keyboard play, pause and standalone export.' if 'dsh' in examples else ''}

{chr(10).join('- ' + item for item in limitations)}

Source: `{manifest['source_commit']}`. [Machine validation]({run['html_url']}).
''')
    if args.prepare_only:
        print(json.dumps({'status': 'prepared', 'tag': tag, 'repository': args.repo,
                          'notes': str(notes), 'files': identities}, indent=2))
        return
    subprocess.run(['gh', 'release', 'create', tag, '--repo', args.repo, '--target', manifest['source_commit'],
                    '--draft', f'--prerelease={str(preview).lower()}', '--latest=false', '--title', 'Harness ' + version, '--notes-file', str(notes),
                    *map(str, assets)], check=True, timeout=900)
    try:
        subprocess.run(['gh', 'release', 'edit', tag, '--repo', args.repo, '--draft=false', '--latest=false'], check=True, timeout=120)
        release = json.loads(gh('api', f'repos/{args.repo}/releases/tags/{tag}'))
        ref = json.loads(gh('api', f'repos/{args.repo}/git/ref/tags/{tag}'))
        if release['draft'] or release['prerelease'] != preview or ref['object']['sha'] != manifest['source_commit']:
            raise ValueError('Published release kind or tag source does not match the verified build.')
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
    except BaseException:
        subprocess.run(['gh', 'release', 'edit', tag, '--repo', args.repo, '--draft=true'], check=True, timeout=120)
        raise
    # Pointer failure must not hide an already-verified immutable release.
    latest = publish_latest_pointer(args.repo, manifest, release)
    receipt = {'status': 'passed', 'release_url': release['html_url'], 'source_commit': manifest['source_commit'],
               'finished_at_unix': time.time(), 'verified_public_assets': checked, 'files': identities,
               'prerelease': preview, 'latest_os': latest}
    (root / 'publication.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(release['html_url'])


if __name__ == '__main__':
    main()
