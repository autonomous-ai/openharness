import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('hn_os', str(Path(__file__).resolve().parents[1] / 'tools/hn-os'))
spec = importlib.util.spec_from_loader(loader.name, loader)
hn_os = importlib.util.module_from_spec(spec)
loader.exec_module(hn_os)


class FirstUse(unittest.TestCase):
    def test_global_agent_guide_is_added_without_replacing_personal_instructions(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(hn_os.os.environ, {'XDG_CONFIG_HOME': temp}):
            guide = Path(temp) / 'opencode/AGENTS.md'
            hn_os.prepare_opencode_guidance()
            self.assertTrue(guide.is_symlink())
            self.assertEqual(guide.readlink(), Path('/usr/share/harness-os/guide.md'))
            hn_os.prepare_opencode_guidance()
            guide.unlink()
            guide.write_text('My own instructions.\n')
            hn_os.prepare_opencode_guidance()
            self.assertEqual(guide.read_text(), 'My own instructions.\n')

    def test_old_cpu_gets_an_explanation_before_network_setup_or_agent_launch(self):
        for cpu, ready in [('flags : sse sse2 ssse3\n', False), ('flags : sse4_2\n', True),
                           ('Features : fp asimd\n', True)]:
            with self.subTest(cpu=cpu), patch.object(hn_os.Path, 'read_text', return_value=cpu):
                self.assertEqual(hn_os.opencode_cpu_ready(), ready)
        with patch.object(hn_os, 'opencode_cpu_ready', return_value=False), \
             patch.object(hn_os.sys.stdin, 'isatty', return_value=True), patch('builtins.input') as wait, \
             patch.object(hn_os, 'connected') as connected, patch.object(hn_os.os, 'execv') as execute:
            hn_os.try_harness()
            connected.assert_not_called()
            execute.assert_not_called()
            wait.assert_called_once()

    def test_connected_machine_starts_bundled_agent_without_model_or_config_override(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(hn_os.Path, 'home', return_value=Path(temp)), \
             patch.object(hn_os, 'connected', return_value=True), patch.object(hn_os, 'wifi') as wifi, \
             patch.object(hn_os.os, 'chdir') as cwd, patch.object(hn_os.os, 'execv') as execute:
            hn_os.try_harness()
            wifi.assert_not_called()
            cwd.assert_called_once_with(Path(temp) / 'Projects')
            execute.assert_called_once_with('/usr/bin/opencode', ['opencode'])

    def test_disconnected_or_cancelled_network_setup_never_launches_agent(self):
        for outcome in [0, 1]:
            with self.subTest(outcome=outcome), patch.object(hn_os, 'connected', return_value=False), \
                 patch.object(hn_os, 'wifi', return_value=outcome) as wifi, \
                 patch.object(hn_os.sys.stdin, 'isatty', return_value=False), \
                 patch.object(hn_os.os, 'execv') as execute:
                hn_os.try_harness()
                wifi.assert_called_once()
                execute.assert_not_called()

    def test_network_setup_flows_into_agent_when_connection_succeeds(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(hn_os.Path, 'home', return_value=Path(temp)), \
             patch.object(hn_os, 'connected', side_effect=[False, True]), \
             patch.object(hn_os, 'wifi', return_value=0), patch.object(hn_os.os, 'chdir'), \
             patch.object(hn_os.os, 'execv') as execute:
            hn_os.try_harness()
            execute.assert_called_once_with('/usr/bin/opencode', ['opencode'])

    def test_install_never_requires_network_setup(self):
        with patch.object(hn_os.sys, 'argv', ['hn-os', 'install']), \
             patch.object(hn_os.os, 'execv', side_effect=SystemExit) as execute, \
             patch.object(hn_os, 'connected') as connected:
            with self.assertRaises(SystemExit):
                hn_os.main()
            self.assertEqual(execute.call_args.args[1], ['python3', '/usr/lib/harness-os/install.py'])
            connected.assert_not_called()

    def test_local_only_and_disconnected_states_require_network_setup(self):
        for state, expected in [('connected', True), ('connected (local only)', False), ('disconnected', False)]:
            with self.subTest(state=state), patch.object(hn_os.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, state + '\n')):
                self.assertEqual(hn_os.connected(), expected)
