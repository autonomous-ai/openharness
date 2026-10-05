#!/usr/bin/env python3
"""Exercise explicit Fedora login setup on a private, enforcing ARM VM clone.

The image/runtime producer remains separate from this setup/observer source.
Only the disposable guest is provisioned. Never use this fixture on hardware.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

from arm_boot import digest
from arm_session import ROOT, SessionVM, failure_evidence, fixture_identity
from session_vm import put


PASSWORD = 'private-login-42'  # Public fixture credential, never a person's password.
HELPER = ROOT / 'os/fedora_session.py'
PROTECTED = '''import hashlib,json,pathlib,sys
names=['/etc/passwd','/etc/shadow','/etc/group','/etc/gshadow','/etc/sudoers',
 '/etc/greetd/config.toml','/etc/pam.d/greetd','/etc/pam.d/greetd-greeter',
 '/etc/selinux/config','/etc/NetworkManager/conf.d','/etc/pipewire','/etc/wireplumber',
 '/etc/sudoers.d','/home/me/.bash_profile','/home/me/.bashrc','/home/me/.profile',
 '/home/me/projects/login-preservation/proof.txt']
excluded={'/etc/sudoers.d/harness-session-network'}
files={}
for name in ['/home/me','/home/me/projects','/home/me/.config','/home/me/.config/systemd',
 '/home/me/.config/systemd/user']:
 s=pathlib.Path(name).stat()
 files[name]={'mode':s.st_mode&0o7777,'uid':s.st_uid,'gid':s.st_gid}
for name in names:
 p=pathlib.Path(name)
 for item in sorted(p.rglob('*')) if p.is_dir() else [p]:
  if str(item) in excluded: continue
  if item.is_symlink(): files[str(item)]={'link':str(item.readlink())}
  elif item.is_file():
   s=item.stat()
   files[str(item)]={'sha256':hashlib.sha256(item.read_bytes()).hexdigest(),
                    'mode':s.st_mode&0o7777,'uid':s.st_uid,'gid':s.st_gid}
  elif not item.exists(): files[str(item)]={'absent':True}
record=pathlib.Path('/var/lib/harness-test/login-preserved.json')
if sys.argv[1]=='record': record.write_text(json.dumps(files,sort_keys=True)+'\\n')
else: assert files==json.loads(record.read_text()), 'An existing account/project/policy changed'
print(json.dumps(files,sort_keys=True))
'''

LOGIN_PROBE = '''import json,os,pathlib,re,subprocess
assert subprocess.check_output(['getenforce'],text=True).strip()=='Enforcing'
pid=int(subprocess.check_output(['pgrep','-u','1000','-x','labwc'],text=True).strip())
proc=pathlib.Path('/proc')/str(pid)
assert proc.stat().st_uid==1000
env=dict(entry.split('=',1) for entry in (proc/'environ').read_text().split('\\0') if '=' in entry)
assert env['XDG_RUNTIME_DIR']=='/run/user/1000'
assert env['DBUS_SESSION_BUS_ADDRESS']=='unix:path=/run/user/1000/bus'
assert env['XDG_SESSION_TYPE']=='wayland'
sid=re.search(r'session-([^/]+)\\.scope',(proc/'cgroup').read_text())[1]
properties=dict(line.split('=',1) for line in subprocess.check_output(
 ['loginctl','show-session',sid],text=True).splitlines() if '=' in line)
assert all(properties.get(k)==v for k,v in {'User':'1000','Name':'me','Service':'greetd',
 'Seat':'seat0','VTNr':'1','Remote':'no','Class':'user'}.items()), properties
assert pathlib.Path('/run/user/1000/bus').is_socket()
result={'pid':pid,'session':sid,'properties':properties,'environment':{k:env[k] for k in
 ['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XDG_SESSION_TYPE']},
 'selinux_context':(proc/'attr/current').read_text().strip()}
pathlib.Path('/tmp/harness-login-probe.json').write_text(json.dumps(result,indent=2)+'\\n')
'''

HANDOFF_PROBE = '''import hashlib,json,os,pathlib,re,shlex,subprocess,sys
out=pathlib.Path('/var/lib/harness-test')
stage=sys.argv[1]
result={'processes':[], 'files':{}, 'process_tree':subprocess.check_output(
 ['ps','-eo','pid,ppid,uid,stat,comm'],text=True)}
for name in ['/usr/bin/hn','/usr/bin/hn-os','/usr/bin/harness','/usr/bin/opencode',
 '/usr/lib/harness/hn','/usr/lib/harness/harness-tui','/usr/lib/harness/cli.mjs',
 '/usr/lib/harness-os/onboarding.py','/usr/lib/harness-os/runtime-path',
 '/home/me/.local/state/harness-os/onboarded']:
 p=pathlib.Path(name)
 result['files'][name]={'exists':p.exists(),'resolved':str(p.resolve())}
 if p.is_file():
  result['files'][name].update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(),uid=p.stat().st_uid)
for proc in pathlib.Path('/proc').iterdir():
 if not proc.name.isdigit(): continue
 try:
  argv=(proc/'cmdline').read_text().strip('\\0').split('\\0')
  if not any(arg in ['/usr/lib/harness-os/onboarding.py','/usr/lib/harness-os/network.py',
    '/usr/lib/harness/cli.mjs','/usr/lib/harness/hn','/usr/bin/opencode'] for arg in argv): continue
  env=dict(item.split('=',1) for item in (proc/'environ').read_text().split('\\0') if '=' in item)
  record={'pid':int(proc.name),'uid':proc.stat().st_uid,'argv':argv,'exe':str((proc/'exe').readlink()),
   'stdin':str((proc/'fd/0').readlink()),'cgroup':(proc/'cgroup').read_text(),
   'environment':{k:env[k] for k in ['HOME','PATH','TMUX','TMUX_PANE','HARNESS_TUI_BIN',
    'HARNESS_CLI','HARNESS_CLI_ARGS','HARNESS_OS','XDG_RUNTIME_DIR'] if k in env}}
  result['processes'].append(record)
  if stage=='before' and '/usr/lib/harness-os/onboarding.py' in argv:
   assert record['uid']==1000 and re.fullmatch(r'%[0-9]+',env['TMUX_PANE'])
   socket=pathlib.Path(env['TMUX'].split(',')[0])
   assert socket.is_socket() and socket.stat().st_uid==1000
   output='/home/me/.local/state/harness-os/login-welcome-output.log'
   base=['runuser','-u','me','--','tmux','-S',str(socket)]
   pane=subprocess.check_output(base+['display-message','-p','-t',env['TMUX_PANE'],
    '#{pane_pid} #{pane_pipe}'],text=True).split()
   assert len(pane)==2 and pane[1]=='0', ('Unexpected first-use pane',pane)
   ancestors=[proc.name]
   while ancestors[-1]!=pane[0] and len(ancestors)<8:
    ancestors.append(re.search(r'^PPid:\\s+(\\d+)',
     (pathlib.Path('/proc')/ancestors[-1]/'status').read_text(),re.M)[1])
   assert ancestors[-1]==pane[0], ('First-use process is outside its tmux pane',ancestors,pane)
   exited='printf "%s\\\\n" "pane=#{pane_id} status=#{pane_dead_status} signal=#{pane_dead_signal}" > '+output+'.exit'
   subprocess.run(base+['set-hook','-p','-t',env['TMUX_PANE'],'pane-exited',
    'run-shell '+shlex.quote(exited)],check=True,timeout=10)
   subprocess.run(base+['pipe-pane','-t',env['TMUX_PANE'],'cat > '+output],check=True,timeout=10)
   result['observed_pane']={'socket':str(socket),'pane':env['TMUX_PANE'],
    'process_ancestry':ancestors,'output':output}
 except (FileNotFoundError,ProcessLookupError): pass
if stage=='before': assert 'observed_pane' in result, 'No exact first-use pane to observe'
exited=pathlib.Path('/home/me/.local/state/harness-os/login-welcome-output.log.exit')
result['pane_exit']=exited.read_text() if exited.exists() else None
(out/('handoff-'+stage+'.json')).write_text(json.dumps(result,indent=2)+'\\n')
'''


def handoff_evidence(machine, stage):
    machine.command('python3 /usr/local/lib/harness-test/login-handoff.py ' + stage, timeout=30)
    (machine.folder / ('handoff-' + stage + '.json')).write_bytes(
        machine.read_file('/var/lib/harness-test/handoff-' + stage + '.json'))
    if stage != 'before':
        (machine.folder / 'welcome-output.log').write_bytes(
            machine.read_file('/home/me/.local/state/harness-os/login-welcome-output.log'))


def home_directory_evidence(machine, name, require_owned=False):
    paths = '/home/me /home/me/projects /home/me/.config /home/me/.config/systemd /home/me/.config/systemd/user'
    text, _ = machine.command("stat -c '%n uid=%u gid=%g mode=%a type=%F' " + paths +
                              '; ls -Zd ' + paths, check=False)
    (machine.folder / (name + '-home-directories.txt')).write_text(text)
    if require_owned:
        machine.user('for p in ' + paths + '; do test -O "$p" && test -w "$p" || exit 1; done')


def wait_root(machine, condition, seconds=30):
    machine.command('for n in $(seq 1 ' + str(seconds * 2) + '); do if ' + condition +
                    '; then exit 0; fi; sleep .5; done; exit 1', timeout=seconds + 10)


def typed(machine, command):
    machine.type_probe(command)
    machine.keys('ret')


def console_login(machine, tty, name, wrong=False, graphical=False):
    machine.keys('ctrl', 'alt', 'f' + str(tty))
    machine.frame(name + '-login', 'login:')
    typed(machine, 'me')
    machine.frame(name + '-password', 'password:')
    if wrong:
        typed(machine, 'incorrect-fixture-password')
        machine.frame(name + '-rejected', 'incorrect', 30)
        # Both login(1) and agreety return to the username prompt after failure.
        machine.frame(name + '-retry', 'login:')
        typed(machine, 'me')
        machine.frame(name + '-retry-password', 'password:')
    typed(machine, PASSWORD)
    if not graphical:
        machine.frame(name + '-shell', 'me@harness')
        marker = '/tmp/' + name + '-authenticated'
        typed(machine, 'touch ' + marker)
        wait_root(machine, 'test -f ' + marker + ' && test "$(stat -c %u ' + marker + ')" = 1000')


def sudo_setup(machine, action):
    typed(machine, 'sudo -k')
    command = 'sudo harness-session-setup ' + action
    if action == 'enable':
        command += ' --user me --autologin'
    typed(machine, command)
    machine.frame(action + '-sudo-authentication', 'password for me')
    typed(machine, PASSWORD)
    condition = ('grep -q ' + shlex.quote('"phase": "enabled"') + ' /var/lib/harness-os/session-setup.json'
                 if action == 'enable' else 'test ! -e /var/lib/harness-os/session-setup.json')
    wait_root(machine, condition)
    machine.frame(action + '-complete', 'next boot')


def inventory(machine, destination):
    machine.command("rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}\\t%{SIZE}\\n' | sort > " + destination)
    return machine.read_file(destination).decode()


def diagnostics(machine, name):
    if not machine:
        return
    try:
        text, _ = machine.command('getenforce; systemctl status greetd getty@tty1 getty@tty2 --no-pager; '
            'loginctl list-sessions; ls -lZ /etc/greetd /etc/sudoers.d; '
            'journalctl -b -u greetd -u getty@tty1 -u getty@tty2 --no-pager; '
            'journalctl -b _UID=1000 --no-pager; '
            'journalctl -b -k --no-pager | tail -n 160', timeout=30, check=False)
        (machine.folder / (name + '-login-diagnostics.txt')).write_text(text)
    except (OSError, RuntimeError, TimeoutError) as error:
        (machine.folder / (name + '-diagnostic-error.txt')).write_text(str(error))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--fixture-source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'], text=True).strip():
        parser.error('Commit the exact setup/observer source before native acceptance.')
    fixture = args.fixture.resolve()
    image = fixture_identity(fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(output).free < image['raw_disk']['bytes'] + 2 * 1024**3:
        parser.error('Keep at least the private disk size plus 2 GiB free before this VM.')
    result = {'status': 'running', 'started_at': time.time(), 'test_source_commit': source,
              'image_source_commit': args.fixture_source, 'runtime': image['package']['runtime'],
              'image_manifest_sha256': digest(fixture / 'manifest.json'),
              'helper_sha256': digest(HELPER), 'scope': 'Explicit Fedora login setup on enforcing 16 KiB ARM VM',
              'checks': [], 'normalization': [], 'boots': [],
              'limitations': ['Private fixture and public test credential; never install or publish this disk',
                  'Candidate setup helper is overlaid; the immutable RPM/runtime producer remains separate',
                  'No Apple boot/firmware/graphics/audio, physical installation or base-update/recovery acceptance']}
    machine = None
    with tempfile.TemporaryDirectory(prefix='harness-fedora-login-') as temporary:
        disk = Path(temporary) / 'guest.raw'
        try:
            subprocess.run(['zstd', '-d', '--sparse', str(fixture / 'guest.raw.zst'), '-o', str(disk)],
                           check=True, timeout=180)
            assert disk.stat().st_size == image['raw_disk']['bytes'] and digest(disk) == image['raw_disk']['sha256']

            def boot(name, offline=False, allow_relabel=False):
                nonlocal machine
                if machine:
                    diagnostics(machine, 'completed')
                    result['boots'][-1]['shutdown'] = machine.poweroff()
                    machine.close()
                machine = SessionVM(output / name, disk, fixture / 'Image')
                result['boots'].append({'name': name, 'started_at': time.time()})
                try:
                    machine.start(offline=offline)
                except RuntimeError:
                    # Fedora's initial policy install requests one full relabel
                    # and reboot before a login console can become available.
                    # QEMU -no-reboot exits for that request; retain and verify
                    # the actual guest reset before starting the next cold boot.
                    serial = (machine.folder / 'serial.log').read_text(errors='replace')
                    if (not allow_relabel or 'selinux-autorelabel.service' not in serial or
                            'Relabeling / ' not in serial or 'reboot: Restarting system' not in serial):
                        raise
                    exit_code = machine.process.wait(timeout=15)
                    events = []
                    while line := machine.qmp_file.readline():
                        events.append(json.loads(line))
                    assert exit_code == 0 and any(event.get('event') == 'SHUTDOWN' and
                        event.get('data', {}).get('guest') is True and
                        event['data'].get('reason') == 'guest-reset' for event in events), 'Missing completed Fedora relabel reboot'
                    result['boots'][-1]['relabel_reboot'] = {'exit_code': exit_code, 'events': events}
                    (machine.folder / 'relabel-reboot.json').write_text(json.dumps(result['boots'][-1], indent=2) + '\n')
                    machine.close()
                    machine = SessionVM(output / (name + '-after-relabel'), disk, fixture / 'Image')
                    result['boots'].append({'name': name + '-after-relabel', 'started_at': time.time()})
                    machine.start(offline=offline)  # A second relabel/reboot is a failure.
                result['boots'][-1]['accelerator'] = machine.accelerator

            boot('01-private-normalization', offline=True)
            # Stop only this fixture's passwordless login before enabling its NIC.
            machine.command('systemctl stop getty@tty1.service; loginctl terminate-user me', check=False)
            wait_root(machine, '! pgrep -u 1000 -x labwc >/dev/null')
            machine.monitor('set_link', name='hnnet', up=True)
            wait_root(machine, 'nmcli -t -f STATE general | grep -qx connected', 60)
            package_before = inventory(machine, '/tmp/packages-before.tsv')
            manager = 'manager=$(command -v dnf5 || command -v microdnf); "$manager"'
            text, _ = machine.command(manager + ' install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True '
                                      'selinux-policy-targeted policycoreutils libselinux-utils', timeout=600)
            (output / 'normalization-policy-install.log').write_text(text)
            policy_before = inventory(machine, '/tmp/packages-policy.tsv')
            text, _ = machine.command(manager + ' install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True greetd', timeout=600)
            (output / 'greetd-install.log').write_text(text)
            package_after = inventory(machine, '/tmp/packages-after.tsv')
            for name, data in [('before', package_before), ('policy', policy_before), ('after', package_after)]:
                (output / ('packages-' + name + '.tsv')).write_text(data)
            prior = {line.split('\t')[0]: line for line in policy_before.splitlines()}
            added = [line for line in package_after.splitlines() if line.split('\t')[0] not in prior]
            result['greetd_transaction'] = {'added_packages': added,
                                          'installed_bytes': sum(int(line.split('\t')[3]) for line in added)}
            machine.command('rpm -V greetd && rpm -q greetd-selinux && test -f /etc/selinux/targeted/contexts/files/file_contexts')
            # Verify the known fixture before removing just its private shortcuts.
            for local, guest in [('os/root/etc/profile.d/harness-os.sh', '/etc/profile.d/harness-os.sh'),
                                 ('os/root/etc/sudoers.d/20-harness-network', '/etc/sudoers.d/20-harness-network')]:
                expected = subprocess.check_output(['git', '-C', str(ROOT), 'show', args.fixture_source + ':' + local])
                assert machine.read_file(guest) == expected, 'Private fixture source changed: ' + guest
                machine.command('rm -- ' + shlex.quote(guest))
            autologin = '/etc/systemd/system/getty@tty1.service.d/autologin.conf'
            expected = ('[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin me --noclear %I $TERM\n').encode()
            assert machine.read_file(autologin) == expected
            machine.command('rm -- ' + autologin)
            machine.command('printf %s ' + shlex.quote('me:' + PASSWORD + '\n') + ' | chpasswd')
            machine.command('test ! -e /home/me/.local/state/harness-os/onboarded')
            home_directory_evidence(machine, 'before-fixture')
            # Root install -d assigns only its leaf ownership: intermediate
            # .config can become root-owned and break the real first-use agent.
            # All private home fixtures must be created by the existing user.
            machine.user('mkdir -p ~/projects/login-preservation ~/.config/systemd/user && '
                         'ln -s /dev/null ~/.config/systemd/user/harness-update.timer && '
                         'printf %s existing-private-project > ~/projects/login-preservation/proof.txt')
            home_directory_evidence(machine, 'after-fixture', require_owned=True)
            put(machine, '/usr/lib/harness-os/fedora_session.py', HELPER.read_text())
            put(machine, '/usr/local/lib/harness-test/login-protected.py', PROTECTED)
            put(machine, '/usr/local/lib/harness-test/login-handoff.py', HANDOFF_PROBE)
            machine.command('install -d /var/lib/harness-test')
            machine.command('chmod 755 /usr/lib/harness-os/fedora_session.py && '
                            'ln -s ../lib/harness-os/fedora_session.py /usr/bin/harness-session-setup')
            assert hashlib.sha256(machine.read_file('/usr/lib/harness-os/fedora_session.py')).hexdigest() == result['helper_sha256']
            # Label the private ext4 root even if its container base had no active LSM.
            machine.command('test "$(sed -n \'s/^SELINUX=//p\' /etc/selinux/config)" = enforcing && '
                'setfiles -F -e /proc -e /sys -e /dev -e /run '
                '/etc/selinux/targeted/contexts/files/file_contexts /', timeout=300)
            result['normalization'] = ['Installed signed Fedora targeted policy/tools and greetd; package deltas retained',
                'Removed only source-verified private profile, tty1 autologin and global-wheel network grant',
                'Assigned existing private me account a test password; masked only its update timer',
                'Added preservation project and exact-source helper/symlink; labeled only the private ext4 root']

            boot('02-enforcing-console', allow_relabel=True)
            machine.command('test "$(getenforce)" = Enforcing && test "$(systemctl get-default)" = multi-user.target && '
                            '! systemctl is-active --quiet greetd && ! pgrep -u 1000 -x labwc >/dev/null')
            home_directory_evidence(machine, 'enforcing', require_owned=True)
            console_login(machine, 1, 'baseline-console')
            machine.command('python3 /usr/local/lib/harness-test/login-protected.py record')
            (output / 'protected-baseline.json').write_bytes(machine.read_file('/var/lib/harness-test/login-preserved.json'))
            sudo_setup(machine, 'enable')
            machine.command('python3 /usr/local/lib/harness-test/login-protected.py compare && '
                            '! systemctl is-active --quiet greetd && ! pgrep -u 1000 -x labwc >/dev/null')
            result['setup_receipt'] = json.loads(machine.read_file('/var/lib/harness-os/session-setup.json'))
            result['checks'].append('An actual password console and sudo enable setup without starting a session or changing existing account/project/platform policy')

            boot('03-enforcing-harness', offline=True)
            machine.wait_user('systemctl --user is-active --quiet hn-screen && hn capture-pane -p | grep -q "Connect to Wi-Fi"', 150)
            machine.frame('01-passwordless-wifi', 'Connect to Wi-Fi', absent=['password for me'])
            put(machine, '/tmp/harness-login-probe.py', LOGIN_PROBE)
            machine.command('python3 /tmp/harness-login-probe.py && pgrep -u 0 -f "^/usr/bin/python3 /usr/lib/harness-os/network.py --first-use$"')
            result['login'] = json.loads(machine.read_file('/tmp/harness-login-probe.json'))
            machine.keyboard('login-offline')
            machine.user('sudo -K')
            text, status = machine.user('sudo -n /usr/bin/true', check=False)
            assert status != 0 and 'password' in text.lower(), 'Setup granted unrelated passwordless sudo'
            text, status = machine.user('sudo -n /usr/bin/python3 /usr/lib/harness-os/network.py --unexpected', check=False)
            assert status != 0 and 'password' in text.lower(), 'Network rule accepted extra arguments'
            handoff_evidence(machine, 'before')
            machine.monitor('set_link', name='hnnet', up=True)
            try:
                machine.wait_user('test -f ~/.local/state/harness-os/onboarded && pgrep -u 1000 -x opencode >/dev/null', 150)
            finally:
                handoff_evidence(machine, 'after')
            machine.frame('02-connected-workspace', ['OpenCode', 'Ask anything'], 90)
            machine.keys('meta_l', 'w')
            machine.frame('03-wifi-form', 'Wi-Fi', absent=['password for me'])
            wait_root(machine, 'pgrep -u 0 -f "^/usr/bin/python3 /usr/lib/harness-os/network.py$" >/dev/null')
            machine.keys('esc')
            result['checks'].append('Enforcing greetd/PAM login creates the correct seat/user bus; offline first-use and regular Wi-Fi form run passwordlessly only through the exact selected-user rules; configured link reaches the workspace')

            console_login(machine, 2, 'recovery-console', wrong=True)
            machine.keys('ctrl', 'alt', 'f1')
            machine.command('loginctl terminate-session ' + shlex.quote(result['login']['session']))
            console_login(machine, 1, 'greetd-fallback', wrong=True, graphical=True)
            machine.wait_user('systemctl --user is-active --quiet hn-screen', 90)
            machine.command('python3 /tmp/harness-login-probe.py')
            machine.keyboard('after-authentication')
            result['checks'].append('tty2 password recovery and greetd logout fallback both reject a wrong password and accept the existing account password using QMP virtual keyboard input')
            machine.command('pgrep -u 1000 -x labwc > /tmp/harness-login-compositor-before')
            before = machine.read_file('/tmp/harness-login-compositor-before')
            machine.keys('ctrl', 'alt', 'f2')
            sudo_setup(machine, 'disable')
            machine.command('pgrep -u 1000 -x labwc > /tmp/harness-login-compositor-after')
            assert before == machine.read_file('/tmp/harness-login-compositor-after'), 'Disable interrupted the graphical session'
            machine.command('python3 /usr/local/lib/harness-test/login-protected.py compare && '
                            'test "$(systemctl get-default)" = multi-user.target && '
                            'test ! -e /etc/sudoers.d/harness-session-network && test ! -e /etc/greetd/harness.toml')
            machine.keys('ctrl', 'alt', 'f1')
            machine.keyboard('after-disable')
            result['checks'].append('Authenticated disable restores exact prior policy and target while the running graphical session still accepts keyboard input')

            boot('04-restored-console')
            machine.command('test "$(getenforce)" = Enforcing && test "$(systemctl get-default)" = multi-user.target && '
                            '! systemctl is-active --quiet greetd && ! pgrep -u 1000 -x labwc >/dev/null && '
                            'python3 /usr/local/lib/harness-test/login-protected.py compare && rpm -V harness-os-session')
            console_login(machine, 1, 'restored-console')
            runtime = json.loads(machine.read_file('/usr/share/harness-os/runtime.json'))
            assert runtime == image['package']['runtime'], 'Setup changed the immutable runtime provenance'
            result['checks'].append('Final cold boot returns to enforcing Fedora password console with existing account/project and packaged runtime unchanged')
            diagnostics(machine, 'completed')
            result['boots'][-1]['shutdown'] = machine.poweroff()
            result['status'] = 'passed'
        except BaseException as error:
            result.update(status='failed', error=str(error))
            diagnostics(machine, 'failure')
            failure_evidence(machine)
            raise
        finally:
            if machine:
                machine.close()
            result['finished_at'] = time.time()
            (output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
