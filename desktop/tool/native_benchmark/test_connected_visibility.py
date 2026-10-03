"""Reject misleading background measurements, including the observed null lifecycle."""
import plistlib
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from connected_run import console_session_state, validate_visibility


class ConnectedVisibilityTest(unittest.TestCase):
    def test_console_lock_metadata_accepts_both_registry_shapes_without_account_data(self):
        for locked in [True, False, None]:
            session = {'kCGSSessionOnConsoleKey': True, 'kCGSSessionUserNameKey': 'private-user'}
            if locked is not None:
                session['CGSSessionScreenIsLocked'] = locked
            root = {'IOConsoleUsers': [session]}
            for registry in [root, [root]]:
                with self.subTest(locked=locked, array=isinstance(registry, list)), \
                        patch('connected_run.subprocess.run', return_value=SimpleNamespace(
                            stdout=plistlib.dumps(registry))):
                    state = console_session_state()
                    self.assertIs(state['screenLocked'], locked)
                    self.assertEqual(state['onConsoleSessions'], 1)
                    self.assertNotIn('private-user', str(state))

    def test_unavailable_console_probe_is_unknown_and_does_not_bypass_visibility_checks(self):
        with patch('connected_run.subprocess.run', side_effect=subprocess.TimeoutExpired('ioreg', 5)):
            self.assertIsNone(console_session_state()['screenLocked'])
        with patch('connected_run.subprocess.run', return_value=SimpleNamespace(stdout=b'bad plist')):
            self.assertIsNone(console_session_state()['screenLocked'])

    def test_observed_hidden_native_window_without_framework_lifecycle_is_rejected(self):
        # Reproduced in the native fixture: AppKit had hidden the window, while
        # Flutter drew 343 frames in ten seconds with no lifecycle notification.
        snapshot = {
            'native': {'hidden': True, 'key': False, 'active': False},
            'framework': {'lifecycle': None, 'framesEnabled': True, 'drawnFrames': 552},
        }
        with self.assertRaisesRegex(RuntimeError, 'requires Flutter hidden'):
            validate_visibility(snapshot, 'background')

    def test_native_and_framework_must_agree(self):
        for visibility, lifecycle, enabled, native in [
            ('foreground', 'resumed', True, {'hidden': False, 'key': True, 'active': True}),
            ('background', 'hidden', False, {'hidden': True, 'key': False, 'active': False}),
        ]:
            snapshot = {'native': native, 'framework': {
                'lifecycle': lifecycle, 'framesEnabled': enabled, 'drawnFrames': 100,
            }}
            with self.subTest(visibility=visibility):
                validate_visibility(snapshot, visibility)
                for field, invalid in [('lifecycle', 'inactive'), ('framesEnabled', not enabled),
                                       ('drawnFrames', None)]:
                    broken = {**snapshot, 'framework': {**snapshot['framework'], field: invalid}}
                    with self.assertRaises(RuntimeError):
                        validate_visibility(broken, visibility)
                with self.assertRaises(RuntimeError):
                    validate_visibility({**snapshot, 'native': {
                        'key': False, 'active': False, 'hidden': False,
                    }}, visibility)

    def test_old_fixture_without_framework_observations_requires_rebuild(self):
        with self.assertRaisesRegex(RuntimeError, 'Rebuild'):
            validate_visibility({'native': {'hidden': True}}, 'background')

    def test_hidden_frame_work_between_matching_endpoints_is_rejected(self):
        before = {
            'native': {'hidden': True, 'key': False, 'active': False},
            'framework': {'lifecycle': 'hidden', 'framesEnabled': False, 'drawnFrames': 100},
        }
        validate_visibility(before, 'background', previous=before)
        after = {**before, 'framework': {**before['framework'], 'drawnFrames': 101}}
        with self.assertRaisesRegex(RuntimeError, 'drew frames'):
            validate_visibility(after, 'background', previous=before)


if __name__ == '__main__':
    unittest.main()
