import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('desktop_mcp', Path(__file__).resolve().parents[1] / 'desktop_mcp.py')
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)

PNG = b'\x89PNG\r\n\x1a\n' + b'\0\0\0\rIHDR' + (1280).to_bytes(4, 'big') + (720).to_bytes(4, 'big') + b'rest'


def screen(width=1920, height=1080):
    """A Screen on a [width]x[height] display, its devices a fake whose keymap has a few keys."""
    with patch.object(desktop, 'environment', return_value={'WAYLAND_DISPLAY': 'wayland-0'}):
        made = desktop.Screen()
    made.size = (width, height)
    places = {'Control_L': (29, False), 'Shift_L': (42, False), 'Super_L': (125, False), 'Return': (28, False),
              't': (20, False), 'b': (48, False), 'question': (53, True)}
    keymap = MagicMock()
    keymap.named.side_effect = lambda name: places[name] if name in places else (_ for _ in ()).throw(
        desktop.Refused(f'Not a key on this keyboard: {name!r}.'))
    keymap.character.side_effect = lambda char: {'h': (35, False), 'i': (23, False), '!': (2, True)}.get(char)
    made.devices = MagicMock(keymap=keymap)
    return made


class Protocol(unittest.TestCase):
    def ask(self, request, made=None):
        return desktop.answer(request, lambda: made or screen())

    def test_it_introduces_itself_in_the_clients_protocol_version(self):
        reply = self.ask({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}})
        self.assertEqual(reply['result']['protocolVersion'], '2025-03-26')
        self.assertEqual(reply['result']['serverInfo']['name'], 'desktop')
        self.assertIn('tools', reply['result']['capabilities'])

    def test_it_lists_its_tools(self):
        tools = self.ask({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})['result']['tools']
        self.assertEqual([tool['name'] for tool in tools], ['screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key'])
        json.dumps(tools)

    def test_it_answers_no_notification_and_refuses_an_unknown_method(self):
        self.assertIsNone(self.ask({'jsonrpc': '2.0', 'method': 'notifications/initialized'}))
        self.assertEqual(self.ask({'jsonrpc': '2.0', 'id': 3, 'method': 'resources/list'})['error']['code'], -32601)

    def test_a_tool_that_cannot_act_answers_an_error_in_words(self):
        with patch.object(desktop, 'locked', return_value=True):
            reply = self.ask({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call',
                              'params': {'name': 'click', 'arguments': {'x': 1, 'y': 1}}})
        self.assertTrue(reply['result']['isError'])
        self.assertIn('locked', reply['result']['content'][0]['text'])


class Screen(unittest.TestCase):
    def test_a_screenshots_pixel_is_scaled_back_to_the_screen(self):
        made = screen()
        self.assertEqual(made.scale(), 1280 / 1920)
        self.assertEqual(made.point(640, 360), (960, 540))
        with self.assertRaisesRegex(desktop.Refused, 'outside the screen'):
            made.point(1280, 10)

    def test_a_narrow_screen_is_shown_as_it_is(self):
        made = screen(1024, 768)
        self.assertEqual(made.scale(), 1.0)
        self.assertEqual(made.point(10, 20), (10, 20))

    def test_the_screenshot_is_refused_while_locked(self):
        with patch.object(desktop, 'locked', return_value=True), self.assertRaisesRegex(desktop.Refused, 'locked'):
            screen().screenshot()

    def test_the_screenshot_is_taken_scaled_down_to_the_width_an_agent_sees(self):
        made = screen()
        with patch.object(desktop, 'locked', return_value=False), \
                patch.object(desktop.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, PNG, b'')) as run:
            data, size = made.screenshot()
        self.assertEqual((data, size), (PNG, (1280, 720)))
        self.assertEqual(run.call_args.args[0], ['grim', '-t', 'png', '-s', '0.6667', '-'])

    def test_an_action_answers_with_the_screen_after_it(self):
        made = screen()
        with patch.object(desktop, 'locked', return_value=False), patch.object(desktop.time, 'sleep'), \
                patch.object(made, 'screenshot', return_value=(PNG, (1280, 720))):
            content = desktop.run_tool(made, 'click', {'x': 640, 'y': 360, 'count': 2})
        made.devices.move.assert_called_with(960, 540, (1920, 1080))
        self.assertEqual(made.devices.button.call_count, 4)
        self.assertEqual([part['type'] for part in content], ['text', 'image'])
        self.assertEqual(content[1]['mimeType'], 'image/png')


class Keys(unittest.TestCase):
    def test_a_combination_holds_its_modifiers_around_the_key(self):
        made = screen()
        made.key('ctrl+shift+t')
        made.devices.press.assert_called_with([29, 42, 20])
        made.key('super+b')
        made.devices.press.assert_called_with([125, 48])
        made.key('enter')
        made.devices.press.assert_called_with([28])

    def test_a_key_shift_reaches_gets_shift(self):
        made = screen()
        made.key('ctrl+question')
        made.devices.press.assert_called_with([29, 42, 53])

    def test_an_unknown_modifier_or_key_is_refused(self):
        made = screen()
        with self.assertRaisesRegex(desktop.Refused, 'Not a modifier'):
            made.key('hyper+t')
        with self.assertRaisesRegex(desktop.Refused, 'Not a key'):
            made.key('ctrl+')
        with self.assertRaisesRegex(desktop.Refused, 'Not a key on this keyboard'):
            made.key('nosuchkey')

    def test_text_the_keymap_types_goes_through_its_own_keyboard(self):
        made = screen()
        with patch.object(desktop.subprocess, 'run') as run:
            made.type('hi!')
        run.assert_not_called()
        self.assertEqual([call.args[0] for call in made.devices.press.call_args_list], [[35], [23], [42, 2]])

    def test_accented_text_goes_through_wtype(self):
        made = screen()
        with patch.object(desktop.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run:
            made.type('chào')
        self.assertEqual(run.call_args.args[0], ['wtype', '--', 'chào'])
        made.devices.press.assert_not_called()


class Environment(unittest.TestCase):
    def test_a_server_with_no_display_finds_the_sessions(self):
        with tempfile.TemporaryDirectory() as runtime:
            (Path(runtime) / 'wayland-1').touch()
            (Path(runtime) / 'wayland-1.lock').touch()
            with patch.dict(desktop.os.environ, {'XDG_RUNTIME_DIR': runtime}, clear=True):
                self.assertEqual(desktop.environment()['WAYLAND_DISPLAY'], 'wayland-1')

    def test_no_desktop_is_said(self):
        with tempfile.TemporaryDirectory() as runtime, \
                patch.dict(desktop.os.environ, {'XDG_RUNTIME_DIR': runtime}, clear=True), \
                self.assertRaisesRegex(desktop.Refused, 'No desktop'):
            desktop.environment()


if __name__ == '__main__':
    unittest.main()
