"""Private scheduling/observation hook, injected only into a disposable VM.

Every wrapped product function receives its original arguments and retains its
real return value or exception. No request, lock result or worker result is faked.
Release feed redirection is generated and hashed separately by the host driver.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import time


def install(namespace, folder):
    folder = Path(folder)
    active = [None]

    def event(kind, **fields):
        intent = active[0]
        phase = json.loads((folder / 'gate.json').read_text()).get('token')
        record = dict(event=kind, phase=phase, at=time.monotonic(), pid=os.getpid(),
                      start=(namespace['PROC'] / str(os.getpid()) / 'stat').read_text().rsplit(')', 1)[1].split()[19],
                      backend_pane=os.environ.get('TMUX_PANE'), token=os.environ.get('HARNESS_UPDATE_INSTANCE'),
                      pending=intent.pending if intent is not None else None,
                      retry_at=intent.retry_at if intent is not None else None, **fields)
        with (folder / ('events-' + str(os.getpid()) + '.jsonl')).open('a') as stream:
            stream.write(json.dumps(record) + '\n')

    original_screen = namespace['screen']
    def screen(window, message='', refresh=False, intent=None):
        active[0] = intent
        event('screen-enter')
        result = original_screen(window, message, refresh, intent)
        event('screen-exit', action=result)
        # run_screen retains this same object while it calls update_all outside
        # curses.wrapper. Observe it through that real worker result as well.
        return result

    original_write = namespace['write']
    request_path = namespace['STATE'] / 'request.json'
    def write(path, data):
        result = original_write(path, data)
        if path == request_path:
            event('request-published', request=data)
        return result

    def request():
        try:
            return namespace['read'](request_path)
        except FileNotFoundError:
            return None

    original_consume = namespace['consume_request']
    original_read = namespace['read']
    consuming = [None]
    def read(path, *args, **kwargs):
        value = original_read(path, *args, **kwargs)
        if consuming[0] is not None and path == request_path:
            # The unchanged consume helper reads this document under its own
            # open.lock. Outside before/after samples are only diagnostics.
            consuming[0].append(value)
        return value

    def consume_request():
        token = os.environ.get('HARNESS_UPDATE_INSTANCE')
        if token and (folder / 'claim-arm').exists():
            (folder / 'claim-arm').unlink()
            event('claim-gate')
            deadline = time.monotonic() + 5
            while not (folder / 'direct-poll.json').exists():
                if time.monotonic() >= deadline:
                    event('observer-error', reason='Private target-claim scheduling barrier expired')
                    raise TimeoutError('Private target-claim scheduling barrier expired')
                time.sleep(.025)
            observed = json.loads((folder / 'direct-poll.json').read_text())
            if observed['before'].get('target') != token:
                event('observer-error', reason='Direct inspection observed a different target')
                raise ValueError('Private target-claim barrier matched a different request')
        before = request()
        locked_reads = []
        consuming[0] = locked_reads
        try:
            result = original_consume()
        finally:
            consuming[0] = None
        after = request()
        if result:
            event('request-claimed', result=result, before=before, after=after, locked_reads=locked_reads)
        elif isinstance(before, dict) and before.get('target'):
            event('request-rejected', result=result, before=before, after=after, locked_reads=locked_reads)
        if (token is None and isinstance(before, dict) and before.get('target') and (before == after or result)
                and not (folder / 'direct-poll.json').exists()):
            # Preserve the real result even if it is incorrectly True. Release
            # the other observer so acceptance can report the wrong claimant,
            # instead of disguising a product regression as a barrier timeout.
            original_write(folder / 'direct-poll.json', dict(pid=os.getpid(), token=token,
                result=result, before=before, after=after, locked_reads=locked_reads, at=time.monotonic()))
        return result

    original_locked = namespace['locked']
    @contextmanager
    def locked():
        try:
            with original_locked():
                yield
        except namespace['UpdateBusy']:
            event('lock-busy')
            raise

    original_run = namespace['run']
    def run(*args, **kwargs):
        worker = (args and args[0] == 'systemd-run' and
                  '--unit=harness-apply-update' in args and args[-2:] == ('apply', '--worker'))
        if not worker:
            return original_run(*args, **kwargs)
        event('worker-start', argv=list(args))
        arm = folder / 'worker-arm'
        if arm.exists():
            arm.unlink()
            event('worker-gate')
            deadline = time.monotonic() + 30
            while not (folder / 'worker-go').exists():
                if time.monotonic() >= deadline:
                    event('observer-error', reason='Private pre-worker scheduling barrier expired')
                    raise TimeoutError('Private pre-worker scheduling barrier expired')
                time.sleep(.025)
        try:
            result = original_run(*args, **kwargs)
        except subprocess.CalledProcessError as error:
            event('worker-result', status=error.returncode, stdout=error.stdout, stderr=error.stderr)
            raise
        else:
            event('worker-result', status=0, stdout=result)
            return result

    namespace.update(screen=screen, locked=locked, run=run, write=write, read=read, consume_request=consume_request)
