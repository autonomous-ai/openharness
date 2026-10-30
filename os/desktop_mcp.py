#!/usr/bin/python3
"""Harness OS's desktop as tools for an agent: what is on the screen, and the mouse and keyboard on it.

A stdio MCP server (JSON-RPC 2.0, a message a line) for an agent to try the desktop app it builds as a person
would: `screenshot`, then `click`, `drag`, `scroll`, `type` and `key` where it sees things, each answered with
the screen as it is afterwards. Off until the person turns it on, with Playwright's, from their phone or with
`harness computer-use on` (cli agentClient/computerUse.ts), never by an agent.

Input goes through the compositor's own virtual devices (labwc: wlr-virtual-pointer for the mouse,
virtual-keyboard for the keys), so it stays inside this session: no /dev/uinput. While the screen is locked
it refuses everything, the screenshot too.

The keyboard is one of its own for as long as the server runs, with the compositor's default keymap: keys reach
an app as a real keyboard's do. wtype, a keyboard with a keymap of just the characters it types, is used only
for text that keymap cannot type (accented letters): GTK 3 ignores wtype's Return, BackSpace and shortcuts.

Coordinates are the screenshot's pixels. A screen wider than WIDTH is shown scaled down to it, and a point on the
screenshot is scaled back up to the screen.
"""
import base64
import ctypes
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

NAME = 'desktop'
VERSION = '0.1.0'
PROTOCOL = '2025-06-18'
# The widest screenshot an agent is shown: wide enough to read a window's text, small enough to send each turn.
WIDTH = 1280
# How long the screen gets to change before the screenshot that answers an action.
SETTLE = 0.4
# A wtype is a keyboard of its own, its keymap sent to the app in front as it starts: keys from another
# keyboard right after it were dropped (labwc, Chromium, 0.4 s apart).
KEY_GAP = 1.0
POINTER_XML = Path('/usr/share/wlr-protocols/unstable/wlr-virtual-pointer-unstable-v1.xml')
# Not in a package of Arch's: Harness OS's own copy of wlroots' (MIT).
KEYBOARD_XML = Path('/usr/share/harness-os/virtual-keyboard-unstable-v1.xml')
CACHE = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'harness-os' / 'desktop-mcp'
# Linux input event codes (linux/input-event-codes.h).
BUTTONS = {'left': 0x110, 'right': 0x111, 'middle': 0x112}
# Friendly key names to XKB keysym names; anything else is looked up as it is (`F5`, `a`, `Page_Up`).
KEYS = {'enter': 'Return', 'return': 'Return', 'esc': 'Escape', 'escape': 'Escape', 'tab': 'Tab',
        'backspace': 'BackSpace', 'delete': 'Delete', 'del': 'Delete', 'space': 'space', 'up': 'Up',
        'down': 'Down', 'left': 'Left', 'right': 'Right', 'home': 'Home', 'end': 'End',
        'pageup': 'Page_Up', 'pagedown': 'Page_Down', 'insert': 'Insert',
        # A modifier pressed on its own.
        'shift': 'Shift_L', 'ctrl': 'Control_L', 'control': 'Control_L', 'alt': 'Alt_L', 'super': 'Super_L'}
MODIFIERS = {'ctrl': 'Control_L', 'control': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L',
             'altgr': 'ISO_Level3_Shift', 'super': 'Super_L', 'logo': 'Super_L', 'win': 'Super_L',
             'meta': 'Super_L', 'cmd': 'Super_L'}
# Each modifier key's XKB modifier: the virtual keyboard's modifiers are said, not worked out from its keys
# (on labwc, Shift and Control held by key alone changed nothing).
MODIFIER_NAMES = {'Shift_L': 'Shift', 'Control_L': 'Control', 'Alt_L': 'Mod1', 'Super_L': 'Mod4',
                  'ISO_Level3_Shift': 'Mod5'}


class Refused(Exception):
    """An action this server will not take, said to the agent as a tool error."""


def environment():
    """The session's display, for a server started from an SSH pane or a service with none of its own."""
    env = dict(os.environ)
    runtime = env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
    if not env.get('WAYLAND_DISPLAY'):
        sockets = sorted(p.name for p in Path(runtime).glob('wayland-*') if not p.name.endswith('.lock'))
        if not sockets:
            raise Refused('No desktop is running on this computer.')
        env['WAYLAND_DISPLAY'] = sockets[0]
    return env


def locked():
    return subprocess.run(['pgrep', '-x', 'gtklock'], capture_output=True).returncode == 0


def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise Refused('The screenshot is not a PNG.')
    return int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')


def bindings(xml):
    """pywayland's module for the protocol in [xml], made by its scanner once per pywayland version.

    The scanner writes one file a protocol, importing the core one relatively (`from .wayland import WlSeat`):
    so a package of its own, with a `wayland` that is pywayland's.
    """
    import pywayland
    from pywayland.scanner import Protocol
    package = 'harness_desktop_protocols'
    folder = CACHE / pywayland.__version__
    protocol = Protocol.parse_file(str(xml))
    module = folder / package / f'{protocol.name}.py'
    if not module.is_file():
        imports = {interface.name: protocol.name for interface in protocol.interface}
        imports.update({name: 'wayland' for name in ('wl_seat', 'wl_output', 'wl_surface')})
        (folder / package).mkdir(parents=True, exist_ok=True)
        (folder / package / '__init__.py').touch()
        (folder / package / 'wayland.py').write_text('from pywayland.protocol.wayland import *  # noqa: F403\n')
        with tempfile.TemporaryDirectory(dir=folder / package) as temp:
            protocol.output(temp, imports)
            os.replace(Path(temp) / module.name, module)
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))
    return importlib.import_module(f'{package}.{protocol.name}')


class Keymap:
    """The compositor's default keymap (XKB's defaults, as labwc's), compiled by libxkbcommon: its text for the
    virtual keyboard, and where each keysym is, as an evdev key and whether Shift reaches it."""

    def __init__(self):
        xkb = ctypes.CDLL('libxkbcommon.so.0')
        xkb.xkb_context_new.restype = ctypes.c_void_p
        xkb.xkb_keymap_new_from_names.restype = ctypes.c_void_p
        xkb.xkb_keymap_new_from_names.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
        xkb.xkb_keymap_get_as_string.restype = ctypes.c_void_p
        xkb.xkb_keymap_get_as_string.argtypes = [ctypes.c_void_p, ctypes.c_int]
        for name in ('xkb_keymap_min_keycode', 'xkb_keymap_max_keycode'):
            getattr(xkb, name).restype = ctypes.c_uint32
            getattr(xkb, name).argtypes = [ctypes.c_void_p]
        xkb.xkb_keymap_key_get_syms_by_level.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.POINTER(ctypes.c_uint32))]
        xkb.xkb_keysym_from_name.restype = ctypes.c_uint32
        xkb.xkb_keysym_from_name.argtypes = [ctypes.c_char_p, ctypes.c_int]
        xkb.xkb_utf32_to_keysym.restype = ctypes.c_uint32
        xkb.xkb_utf32_to_keysym.argtypes = [ctypes.c_uint32]
        xkb.xkb_keymap_mod_get_index.restype = ctypes.c_uint32
        xkb.xkb_keymap_mod_get_index.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        libc = ctypes.CDLL(None)
        libc.free.argtypes = [ctypes.c_void_p]
        self.xkb = xkb
        keymap = xkb.xkb_keymap_new_from_names(xkb.xkb_context_new(0), None, 0)
        if not keymap:
            raise Refused('Could not make a keymap for the virtual keyboard.')
        text = xkb.xkb_keymap_get_as_string(keymap, 1)  # XKB_KEYMAP_FORMAT_TEXT_V1
        self.text = ctypes.string_at(text) + b'\0'
        libc.free(text)
        self.where = {}
        syms = ctypes.POINTER(ctypes.c_uint32)()
        for keycode in range(xkb.xkb_keymap_min_keycode(keymap), xkb.xkb_keymap_max_keycode(keymap) + 1):
            for level in (0, 1):
                for i in range(xkb.xkb_keymap_key_get_syms_by_level(keymap, keycode, 0, level, ctypes.byref(syms))):
                    # The first, unshifted, place a keysym has wins: `1` is 2's key, not the keypad's.
                    self.where.setdefault(syms[i], (keycode - 8, level == 1))
        # A modifier key's evdev code to its mask.
        self.masks = {}
        for sym_name, mod_name in MODIFIER_NAMES.items():
            index = xkb.xkb_keymap_mod_get_index(keymap, mod_name.encode())
            sym = xkb.xkb_keysym_from_name(sym_name.encode(), 0)
            if index != 0xFFFFFFFF and sym in self.where:
                self.masks[self.where[sym][0]] = 1 << index

    def named(self, name):
        sym = self.xkb.xkb_keysym_from_name(name.encode(), 0) or self.xkb.xkb_keysym_from_name(name.encode(), 1)
        if not sym or sym not in self.where:
            raise Refused(f'Not a key on this keyboard: {name!r}. Use names like "enter", "ctrl+s", "F5".')
        return self.where[sym]

    def character(self, char):
        """Where [char] is, or None for one this keymap cannot type."""
        if char == '\n':
            return self.where.get(0xff0d)  # Return
        if char == '\t':
            return self.where.get(0xff09)  # Tab
        return self.where.get(self.xkb.xkb_utf32_to_keysym(ord(char)))


class Devices:
    """This session's own mouse and keyboard, made by the compositor (one Wayland connection, kept)."""

    def __init__(self, env):
        from pywayland.client import Display
        from pywayland.protocol.wayland import WlSeat
        pointer, keyboard = bindings(POINTER_XML), bindings(KEYBOARD_XML)
        self.display = Display(env['WAYLAND_DISPLAY'])
        self.display.connect()
        found = {}

        def announced(registry, name, interface, version):
            if interface == 'wl_seat' and 'seat' not in found:
                found['seat'] = registry.bind(name, WlSeat, 1)
            elif interface == 'zwlr_virtual_pointer_manager_v1':
                found['pointers'] = registry.bind(name, pointer.ZwlrVirtualPointerManagerV1, 1)
            elif interface == 'zwp_virtual_keyboard_manager_v1':
                found['keyboards'] = registry.bind(name, keyboard.ZwpVirtualKeyboardManagerV1, 1)

        registry = self.display.get_registry()
        registry.dispatcher['global'] = announced
        self.display.roundtrip()
        missing = {'seat', 'pointers', 'keyboards'} - set(found)
        if missing:
            self.display.disconnect()
            raise Refused('This desktop has no virtual mouse or keyboard (' + ', '.join(sorted(missing)) + ').')
        self.pointer = found['pointers'].create_virtual_pointer(found['seat'])
        self.keymap = Keymap()
        self.keyboard = found['keyboards'].create_virtual_keyboard(found['seat'])
        fd = os.memfd_create('harness-desktop-keymap')
        os.write(fd, self.keymap.text)
        self.keyboard.keymap(1, fd, len(self.keymap.text))  # WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1
        self.display.roundtrip()
        os.close(fd)

    @staticmethod
    def now():
        return int(time.monotonic() * 1000) & 0xFFFFFFFF

    def frame(self):
        self.pointer.frame()
        self.display.roundtrip()

    def move(self, x, y, size):
        self.pointer.motion_absolute(self.now(), x, y, size[0], size[1])
        self.frame()

    def button(self, code, pressed):
        self.pointer.button(self.now(), code, 1 if pressed else 0)
        self.frame()

    def scroll(self, steps):
        # A wheel's notches: 15 units each, as a mouse wheel reports them. Positive scrolls down.
        self.pointer.axis_source(0)
        self.pointer.axis_discrete(self.now(), 0, 15.0 * steps, steps)
        self.frame()

    def key(self, code, pressed):
        self.keyboard.key(self.now(), code, 1 if pressed else 0)
        self.display.roundtrip()

    def press(self, codes):
        """Hold [codes] down in order, then let them go in reverse: a shortcut, or a key with Shift. The
        modifiers among them are said as they go down and up."""
        held = 0
        for code in codes:
            self.key(code, True)
            if code in self.keymap.masks:
                held |= self.keymap.masks[code]
                self.keyboard.modifiers(held, 0, 0, 0)
        for code in reversed(codes):
            self.key(code, False)
            if code in self.keymap.masks:
                held &= ~self.keymap.masks[code]
                self.keyboard.modifiers(held, 0, 0, 0)
        self.display.roundtrip()
        time.sleep(0.01)


class Screen:
    def __init__(self):
        self.env = environment()
        self.size = None
        self.devices = None
        self.wtyped = 0.0

    def grab(self, scale=None):
        args = ['grim', '-t', 'png'] + (['-s', f'{scale:.4f}'] if scale else []) + ['-']
        done = subprocess.run(args, capture_output=True, env=self.env, timeout=15)
        if done.returncode:
            raise Refused('Could not take a screenshot: ' + done.stderr.decode(errors='replace').strip())
        return done.stdout

    def scale(self):
        """The screenshot's size over the screen's: 1 for a screen no wider than WIDTH."""
        if self.size is None:
            self.size = png_size(self.grab())
        return min(1.0, WIDTH / self.size[0])

    def screenshot(self):
        if locked():
            raise Refused('The screen is locked. Ask the person to unlock it.')
        scale = self.scale()
        data = self.grab(scale if scale < 1 else None)
        return data, png_size(data)

    def point(self, x, y):
        """A screenshot's pixel on the screen."""
        scale = self.scale()
        width, height = self.size
        x, y = round(float(x) / scale), round(float(y) / scale)
        if not (0 <= x < width and 0 <= y < height):
            raise Refused(f'({x}, {y}) is outside the screen ({width}x{height} on the screen).')
        return x, y

    def input(self):
        if self.devices is None:
            self.devices = Devices(self.env)
        return self.devices

    def after_wtype(self):
        time.sleep(max(0.0, self.wtyped + KEY_GAP - time.monotonic()))

    def type(self, text):
        devices = self.input()
        places = [devices.keymap.character(char) for char in text]
        if all(places):
            self.after_wtype()
            shift = devices.keymap.named('Shift_L')[0]
            for code, shifted in places:
                devices.press([shift, code] if shifted else [code])
            return
        # Accented letters and the like: wtype, with a keymap of its own made of them.
        self.after_wtype()
        done = subprocess.run(['wtype', '--', text], capture_output=True, env=self.env, timeout=60)
        self.wtyped = time.monotonic()
        if done.returncode:
            raise Refused('Could not type: ' + done.stderr.decode(errors='replace').strip())

    def key(self, keys):
        """`ctrl+shift+t`: the modifiers held around the key, then let go."""
        parts = [part.strip() for part in str(keys).split('+')]
        if not parts or not all(parts):
            raise Refused(f'Not a key: {keys!r}. Use names like "enter", "ctrl+s" or "super+b".')
        devices = self.input()
        *modifiers, key = parts
        codes = []
        for modifier in modifiers:
            if modifier.lower() not in MODIFIERS:
                raise Refused(f'Not a modifier: {modifier!r}. Use ctrl, shift, alt, altgr or super.')
            codes.append(devices.keymap.named(MODIFIERS[modifier.lower()])[0])
        code, shifted = devices.keymap.named(KEYS.get(key.lower(), key))
        shift = devices.keymap.named('Shift_L')[0]
        if shifted and shift not in codes:
            codes.append(shift)
        self.after_wtype()
        devices.press(codes + [code])


POINT = {'x': {'type': 'number', 'description': 'Pixels from the left of the screenshot.'},
         'y': {'type': 'number', 'description': 'Pixels from the top of the screenshot.'}}
TOOLS = [
    {'name': 'screenshot', 'description': 'What is on the screen now, as an image. Coordinates for the other '
     'tools are this image\'s pixels.', 'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'click', 'description': 'Move the mouse to a point and click there. Answers with the screen after.',
     'inputSchema': {'type': 'object', 'required': ['x', 'y'], 'properties': {
         **POINT, 'button': {'type': 'string', 'enum': list(BUTTONS), 'default': 'left'},
         'count': {'type': 'integer', 'minimum': 1, 'maximum': 3, 'default': 1,
                   'description': '2 for a double click.'}}}},
    {'name': 'move', 'description': 'Move the mouse to a point without clicking (to hover). Answers with the '
     'screen after.', 'inputSchema': {'type': 'object', 'required': ['x', 'y'], 'properties': POINT}},
    {'name': 'drag', 'description': 'Press the left button at one point, move to another and let go. Answers '
     'with the screen after.', 'inputSchema': {'type': 'object', 'required': ['x', 'y', 'to_x', 'to_y'],
                                               'properties': {**POINT, 'to_x': {'type': 'number'},
                                                              'to_y': {'type': 'number'}}}},
    {'name': 'scroll', 'description': 'Turn the mouse wheel over a point: positive steps scroll down, negative '
     'up. Answers with the screen after.', 'inputSchema': {'type': 'object', 'required': ['x', 'y', 'steps'],
                                                          'properties': {**POINT, 'steps': {'type': 'integer'}}}},
    {'name': 'type', 'description': 'Type text into whatever has the keyboard focus, as a person would ("\\n" '
     'is Enter). Answers with the screen after.',
     'inputSchema': {'type': 'object', 'required': ['text'], 'properties': {'text': {'type': 'string'}}}},
    {'name': 'key', 'description': 'Press a key or a combination: "enter", "esc", "tab", "backspace", "ctrl+s", '
     '"ctrl+shift+t", "super+b", "F5". Answers with the screen after.',
     'inputSchema': {'type': 'object', 'required': ['keys'], 'properties': {'keys': {'type': 'string'}}}},
]


def run_tool(screen, name, args):
    """Do [name] with [args]; the screen afterwards, as the answer's content."""
    if name != 'screenshot':
        if locked():
            raise Refused('The screen is locked. Ask the person to unlock it.')
        if name in ('click', 'move', 'drag', 'scroll'):
            x, y = screen.point(args['x'], args['y'])
            devices = screen.input()
            devices.move(x, y, screen.size)
            if name == 'click':
                code = BUTTONS.get(args.get('button', 'left'))
                if code is None:
                    raise Refused('button is left, right or middle.')
                for _ in range(max(1, min(3, int(args.get('count', 1))))):
                    devices.button(code, True)
                    devices.button(code, False)
            elif name == 'drag':
                to = screen.point(args['to_x'], args['to_y'])
                devices.button(BUTTONS['left'], True)
                for step in range(1, 11):
                    devices.move(round(x + (to[0] - x) * step / 10), round(y + (to[1] - y) * step / 10), screen.size)
                    time.sleep(0.02)
                devices.button(BUTTONS['left'], False)
            elif name == 'scroll':
                devices.scroll(int(args['steps']))
        elif name == 'type':
            screen.type(str(args['text']))
        elif name == 'key':
            screen.key(args['keys'])
        else:
            raise Refused(f'No tool {name!r}.')
        time.sleep(SETTLE)
    data, (width, height) = screen.screenshot()
    return [{'type': 'text', 'text': f'The screen now, {width}x{height}.'},
            {'type': 'image', 'data': base64.b64encode(data).decode(), 'mimeType': 'image/png'}]


def answer(request, screen):
    method, ident = request.get('method'), request.get('id')
    if method == 'initialize':
        asked = (request.get('params') or {}).get('protocolVersion')
        result = {'protocolVersion': asked or PROTOCOL, 'capabilities': {'tools': {}},
                  'serverInfo': {'name': NAME, 'version': VERSION}}
    elif method == 'tools/list':
        result = {'tools': TOOLS}
    elif method == 'tools/call':
        params = request.get('params') or {}
        try:
            result = {'content': run_tool(screen(), params.get('name'), params.get('arguments') or {})}
        except (Refused, KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError) as error:
            text = str(error) if isinstance(error, Refused) else f'{type(error).__name__}: {error}'
            result = {'content': [{'type': 'text', 'text': text}], 'isError': True}
    elif method == 'ping':
        result = {}
    elif ident is None:
        return None  # A notification (initialized, cancelled): nothing to answer.
    else:
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': f'No method {method}'}}
    return {'jsonrpc': '2.0', 'id': ident, 'result': result}


def main():
    held = {}

    def screen():
        # Made at the first tool call, so the server starts (and lists its tools) without a desktop.
        if 'screen' not in held:
            held['screen'] = Screen()
        return held['screen']

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            reply = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Not JSON'}}
        else:
            reply = answer(request, screen)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
