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
             patch.object(hn_os, 'wifi') as network, patch.object(hn_os.os, 'execv') as execute:
            hn_os.try_harness()
            network.assert_not_called()
            execute.assert_not_called()
            wait.assert_called_once()

    def test_agent_launch_never_reopens_network_setup_or_overrides_model_configuration(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(hn_os.Path, 'home', return_value=Path(temp)), \
             patch.object(hn_os, 'wifi') as wifi, \
             patch.object(hn_os.os, 'chdir') as cwd, patch.object(hn_os.os, 'execv') as execute, \
             patch.object(hn_os.subprocess, 'check_output', return_value=str(Path(temp) / 'projects/opencode-2026-10-04-09-05')):
            hn_os.try_harness()
            wifi.assert_not_called()
            cwd.assert_called_once_with(str(Path(temp) / 'projects/opencode-2026-10-04-09-05'))
            execute.assert_called_once_with('/usr/bin/opencode', ['opencode'])

    def test_install_never_requires_network_setup(self):
        with patch.object(hn_os.sys, 'argv', ['hn-os', 'install']), \
             patch.object(hn_os, 'system_profile', return_value='arch'), \
             patch.object(hn_os.os, 'execv', side_effect=SystemExit) as execute, \
             patch.object(hn_os, 'wifi') as network:
            with self.assertRaises(SystemExit):
                hn_os.main()
            self.assertEqual(execute.call_args.args[1], ['python3', '/usr/lib/harness-os/install.py'])
            network.assert_not_called()
