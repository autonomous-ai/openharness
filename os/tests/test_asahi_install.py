"""Installer orchestration boundaries. Native acceptance drives the actual form."""
from contextlib import contextmanager
import curses
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('asahi_install', Path(__file__).resolve().parents[1] /
                                               'platforms/apple-silicon/install.py')
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class Screen:
    def __init__(self, keys=(), size=(30, 90)):
        self.keys, self.size, self.lines = iter(keys), size, []
    def keypad(self, *_): pass
    def erase(self): self.lines = []
    def refresh(self): pass
    def move(self, *_): pass
    def getmaxyx(self): return self.size
    def get_wch(self): return next(self.keys)
    def addnstr(self, row, column, text, size, attr): self.lines.append((row, column, text[:size], attr))


class Installer(unittest.TestCase):
    def page(self, keys=(), size=(30, 90)):
        with patch.object(curses, 'start_color', side_effect=curses.error):
            return install.Page(Screen(keys, size))

    def test_cancel_clears_secrets_without_installing(self):
        view = self.page(['s', 'e', 'c', 'r', 'e', 't', '\x1b'])
        with patch.object(install, 'install') as commit:
            self.assertIsNone(view.password('Prepared space'))
        self.assertEqual(view.values, ['', ''])
        commit.assert_not_called()

    def test_mismatch_stays_in_form_then_corrected_password_submits(self):
        view = self.page(['x', '\n', 'y', '\n', '\n', curses.KEY_BTAB, '\x15', 'x', '\n', '\n'])
        messages = []
        render = view.render
        def observe(*args, **kwargs):
            messages.append(view.error)
            return render(*args, **kwargs)
        view.render = observe
        self.assertEqual(view.password('Prepared space'), 'x')
        self.assertIn('Passwords do not match.', messages)
        self.assertEqual(view.values, ['', ''])

    def test_secrets_never_render_and_labels_are_not_highlighted(self):
        view = self.page()
        view.values = ['fixture secret', 'fixture secret']
        view.positions = [14, 14]
        view.render('Prepared space')
        self.assertNotIn('fixture secret', str(view.screen.lines))
        self.assertTrue(any('**************' in line[2] for line in view.screen.lines))
        self.assertEqual(next(line[3] for line in view.screen.lines if line[2] == 'Password'), 0)
        focused = [line for line in view.screen.lines if line[0] == view.top + 8 and line[1] == view.left + 18]
        self.assertEqual(focused[0][3], view.active)

    def test_resize_and_mouse_cannot_submit_a_hidden_form(self):
        view = self.page([curses.KEY_MOUSE, '\x1b'], size=(10, 25))
        with patch.object(curses, 'getmouse', return_value=(0, 30, 22, 0, curses.BUTTON1_CLICKED)):
            self.assertIsNone(view.password('Prepared space'))

    def test_only_a_visible_button_click_submits(self):
        view = self.page([curses.KEY_MOUSE])
        view.render('Prepared space')
        row, x, end, _ = view.hits[-1]
        with patch.object(curses, 'getmouse', return_value=(0, x + 2, row, 0, curses.BUTTON1_CLICKED)):
            self.assertEqual(view.key(), '\n')
        self.assertEqual(view.focus, 2)

    def test_bad_payload_stops_before_any_destination_write(self):
        @contextmanager
        def bad():
            raise install.storage.StorageError('Image checksum changed')
            yield
        payload = SimpleNamespace(open=bad)
        with patch.object(install.storage, 'run') as command, patch.object(install.target, 'save_plan') as save:
            with self.assertRaisesRegex(ValueError, 'checksum'):
                install.install(Path('/unused'), {}, payload, 'pw', lambda _: None)
        command.assert_not_called()
        save.assert_not_called()

    def test_password_validation_precedes_payload_access(self):
        for password in ('', 'a\nb', 'a\rb', 'a\0b'):
            payload = Mock()
            with self.subTest(password=repr(password)), self.assertRaises(ValueError):
                install.install(Path('/unused'), {}, payload, password, lambda _: None)
            payload.open.assert_not_called()

    def test_lost_screen_does_not_interrupt_disk_progress(self):
        view = self.page()
        view.render = Mock(side_effect=curses.error)
        view.progress('Copying Harness…')

    def test_shutdown_failure_does_not_restart_installation(self):
        view = self.page(['\n', '\n'])
        with patch.object(curses, 'flushinp'), patch.object(install, 'diagnostic'), \
             patch.object(install.storage, 'run', side_effect=[OSError('unavailable'), '']) as run, \
             patch.object(install, 'install') as commit:
            view.complete()
        self.assertEqual(run.call_args_list, [unittest.mock.call('systemctl', 'poweroff')] * 2)
        commit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
