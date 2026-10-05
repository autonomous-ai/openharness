#!/usr/bin/env python3
"""Optional local inference and driver assessment in a disposable installed guest."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, urlopen


ROOT = Path('/home/me/local-ai-check')


def run(*args, timeout=240, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    with (ROOT / 'commands.log').open('a') as log:
        log.write(json.dumps(list(args)) + '\n' + result.stdout + result.stderr + '\n')
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): ' + result.stderr[-1500:])
    return result


def packages():
    return dict(line.split(' ', 1) for line in run('pacman', '-Q').stdout.splitlines())


def api(path, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    request = Request('http://127.0.0.1:11434' + path, data=data,
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def install(names):
    before = packages()
    started = time.monotonic()
    run('systemctl', 'start', 'harness-keyring.service')
    run('pacman', '-S', '--needed', '--noconfirm', *names, timeout=420)
    after = packages()
    assert all(after.get(name) == version for name, version in before.items()), 'Base package changed'
    return {'added': {name: version for name, version in after.items() if name not in before},
            'seconds': round(time.monotonic() - started, 3), 'base_packages_unchanged': True}


def nvidia():
    result = install(['nvidia-open-lts', 'nvidia-utils'])
    kernel = run('uname', '-r').stdout.strip()
    result.update(kernel=kernel, modules={})
    for name in ['nvidia', 'nvidia_modeset', 'nvidia_uvm', 'nvidia_drm']:
        magic = run('modinfo', '-F', 'vermagic', name).stdout.strip()
        version = run('modinfo', '-F', 'version', name).stdout.strip()
        assert magic.split()[0] == kernel
        result['modules'][name] = {'vermagic': magic, 'version': version}
        run('modprobe', '--show-depends', name)
    assert len({row['version'] for row in result['modules'].values()}) == 1
    files = run('pacman', '-Qlq', 'nvidia-utils').stdout.splitlines()
    support = next(Path(p) for p in files if p.endswith('/html/supportedchips.html'))
    (ROOT / 'supportedchips.html').write_bytes(support.read_bytes())
    encoded = ' '.join(html.unescape(re.sub(r'<[^>]*>', ' ', support.read_text())).split())
    targets = ['GeForce RTX 4090', 'GeForce RTX 5090', 'RTX 6000 Ada Generation', 'RTX PRO 6000 Blackwell']
    assert all(target in encoded for target in targets), 'Target absent from the packaged support list'
    result['packaged_support_list_targets'] = targets
    result['support_file_sha256'] = hashlib.sha256(support.read_bytes()).hexdigest()
    # A VM cannot demonstrate binding, GPU compute, or display on a real card.
    probe = run('nvidia-smi', check=False)
    result['nvidia_smi'] = {'exit': probe.returncode, 'output': probe.stdout + probe.stderr}
    result['physical_gpu_validation'] = 'unavailable: no NVIDIA GPU is passed through'
    run('mkinitcpio', '-P', timeout=240)
    result['initramfs_regenerated'] = True
    return result


def local_ai():
    result = install(['ollama'])
    # This is a test-only runtime choice. No model/server enters the OS image.
    override = Path('/etc/systemd/system/ollama.service.d/harness-test.conf')
    override.parent.mkdir(parents=True, exist_ok=True)
    override.write_text('[Service]\nEnvironment=OLLAMA_HOST=127.0.0.1:11434\n'
                        'Environment=OLLAMA_CONTEXT_LENGTH=16384\n'
                        'Environment=OLLAMA_NUM_PARALLEL=1\n')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', 'ollama')
    deadline = time.monotonic() + 30
    while True:
        try:
            result['server'] = api('/api/version', timeout=3)
            break
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(.5)
    started = time.monotonic()
    pulled = api('/api/pull', {'model': 'qwen3:0.6b', 'stream': False}, timeout=420)
    assert pulled.get('status') == 'success', pulled
    result['model_download_seconds'] = round(time.monotonic() - started, 3)
    result['models'] = api('/api/tags')['models']
    model = next(row for row in result['models'] if row['name'] == 'qwen3:0.6b')
    assert model.get('digest') and model.get('size', 0) > 0
    result['model'] = model
    config = {'$schema': 'https://opencode.ai/config.json', 'enabled_providers': ['ollama'],
              'model': 'ollama/qwen3:0.6b', 'small_model': 'ollama/qwen3:0.6b',
              'provider': {'ollama': {'npm': '@ai-sdk/openai-compatible',
                'name': 'Ollama (local)', 'options': {'baseURL': 'http://127.0.0.1:11434/v1'},
                'models': {'qwen3:0.6b': {'name': 'Qwen 3 0.6B (CPU test)',
                  'limit': {'context': 16384, 'output': 512}}}}}}
    (ROOT / 'opencode.json').write_text(json.dumps(config, indent=2) + '\n')
    # The graphical check runs this ordinary user command with networking off.
    prompt = 'What is six times seven? Reply with only the decimal number. Do not use tools. /no_think'
    (ROOT / 'chat.sh').write_text('#!/bin/bash\nset -euo pipefail\ncd /home/me/local-ai-check\n'
        'opencode run --format json ' + __import__('shlex').quote(prompt) +
        ' > chat.jsonl 2> chat.err\npython3 verify-chat.py\n')
    (ROOT / 'verify-chat.py').write_text('''import json,re
from pathlib import Path
events=[json.loads(line) for line in Path('chat.jsonl').read_text().splitlines() if line.startswith('{')]
reply=''.join(row.get('part',{}).get('text','') for row in events if row.get('type')=='text').strip()
assert re.fullmatch(r'(?:6\\s*[×*x]\\s*7\\s*=\\s*)?42[.!]?',reply), repr(reply)
Path('chat-passed').write_text(reply+'\\n')
print('Local model answered: '+reply)
''')
    command = Path('/home/me/.local/bin/local-chat')
    command.parent.mkdir(parents=True, exist_ok=True)
    command.write_text('#!/bin/sh\nexec bash /home/me/local-ai-check/chat.sh\n')
    command.chmod(0o755)
    run('chown', '-R', 'me:me', str(ROOT), str(command))
    # Warm the provider while connected so any dependency fetch is completed.
    run('runuser', '-u', 'me', '--', 'bash', str(ROOT / 'chat.sh'), timeout=300)
    (ROOT / 'chat-passed').unlink()
    (ROOT / 'online-chat.jsonl').write_bytes((ROOT / 'chat.jsonl').read_bytes())
    run('nmcli', 'networking', 'off')
    started = time.monotonic()
    response = api('/api/chat', {'model': 'qwen3:0.6b', 'stream': False, 'think': False,
        'messages': [{'role': 'user', 'content': 'What is six times seven? Reply with only the number.'}],
        'options': {'temperature': 0, 'num_predict': 32}})
    (ROOT / 'offline-api.json').write_text(json.dumps(response, indent=2) + '\n')
    # Check the independently known answer, allowing the small model to show
    # its equation. This assesses inference transport, not formatting skill.
    assert response.get('done') and re.fullmatch(
        r'(?:6\s*[×*x]\s*7\s*=\s*)?42[.!]?', response['message']['content'].strip()), response
    result['offline_api_seconds'] = round(time.monotonic() - started, 3)
    result['offline_reply'] = response['message']['content']
    result['inference'] = {k: response[k] for k in ['eval_count', 'eval_duration', 'prompt_eval_count', 'prompt_eval_duration'] if k in response}
    result['loaded_models'] = api('/api/ps')['models']
    assert all(row.get('size_vram', 0) == 0 for row in result['loaded_models']), 'Expected CPU inference'
    result['networking'] = run('nmcli', 'networking').stdout.strip()
    assert result['networking'] == 'disabled'
    result['listening'] = run('ss', '-ltnp').stdout
    assert re.search(r'127\.0\.0\.1:11434\b', result['listening'])
    assert not re.search(r'(?:0\.0\.0\.0|\*|\[::\]):11434\b', result['listening'])
    result['scope'] = 'CPU inference and agent transport; this tiny model is not a coding-quality benchmark'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('probe', choices=['local-ai', 'nvidia'])
    args = parser.parse_args()
    assert not Path('/etc/harness-live').exists(), 'Installed disposable guest required'
    assert Path('/var/lib/harness-os/install.json').is_file()
    ROOT.mkdir(exist_ok=True)
    result = {'status': 'running', 'probe': args.probe, 'started_at': time.time()}
    try:
        result.update(nvidia() if args.probe == 'nvidia' else local_ai())
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        result['finished_at'] = time.time()
        (ROOT / 'probe.json').write_text(json.dumps(result, indent=2) + '\n')
        print('HN_LOCAL_AI_PROBE=' + json.dumps(result))


if __name__ == '__main__':
    main()
