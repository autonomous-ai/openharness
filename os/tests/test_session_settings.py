import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('session_settings',
    Path(__file__).resolve().parents[1] / 'root/usr/lib/harness-os/session-settings.py')
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


class SavedSessionSettings(unittest.TestCase):
    def test_old_os_footer_is_reset_to_the_tuis_current_defaults(self):
        with patch.object(settings, 'hn', side_effect=['#{@harness-update}', '60', '', '', '']) as hn:
            settings.migrate()
        self.assertIn((('set-option', '-gu', 'status-right'),), hn.call_args_list)
        self.assertIn((('set-option', '-gu', 'status-right-length'),), hn.call_args_list)
        self.assertEqual(hn.call_args.args, ('set-option', '-goq', '@hn-new-window', 'shell'))

    def test_custom_footer_and_length_are_preserved(self):
        with patch.object(settings, 'hn', side_effect=['my own footer', '']) as hn:
            settings.migrate()
        self.assertEqual(hn.call_count, 2)
        with patch.object(settings, 'hn', side_effect=['#{@harness-update}', '100', '', '']) as hn:
            settings.migrate()
        self.assertNotIn((('set-option', '-gu', 'status-right-length'),), hn.call_args_list)

    def test_usb_configuration_is_not_migrated(self):
        with patch.object(settings.Path, 'exists', return_value=True), patch.object(settings, 'migrate') as migrate:
            settings.main()
        migrate.assert_not_called()
