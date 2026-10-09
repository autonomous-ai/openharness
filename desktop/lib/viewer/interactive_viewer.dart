import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
// The same web/IME input adapter used by our vendored terminal.
// ignore: implementation_imports
import 'package:xterm/src/ui/custom_text_edit.dart';

import '../e2ee/bytes.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../widgets/terminal_text_action.dart';
import '../ws/ws_conn.dart';

typedef ViewerSurfaceRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

/// One frame request in flight at a time bounds both rendering and network work.
///
/// A v1 machine answers each request with one frame. A v2 machine (its replies carry `seq`,
/// cli/src/lib/interactiveViewer.ts) long-polls frames — `after: seq` waits up to a second for a
/// newer one — and takes input as its own request, so a tap is not stuck behind a frame. Until the
/// machine has answered with `seq`, requests stay inside v1's bounds: an older machine refuses
/// anything larger. Input is connection-local: a failed request is never replayed.
class InteractiveViewerSession extends ChangeNotifier {
  InteractiveViewerSession(
    this.request, {
    this.onHostAction,
    this.onClipboard,
    this.mobile = false,
    this.touch = false,
  });
  final ViewerSurfaceRequest request;
  final void Function(Map<String, dynamic>)? onHostAction;
  final void Function(String text)? onClipboard;
  final bool mobile, touch;
  final String id = hexOf(secureRandomBytes(16));
  Uint8List? image;
  String? error;
  bool editable = false;
  bool Function()? focusInput;
  final _events = <Map<String, dynamic>>[];
  Timer? _timer, _resize;
  bool _disposed = false, _busy = false, _reload = false, _sending = false;
  // A size the machine has not been sent yet. Any input request carries it; if one is in flight
  // when the resize timer fires, the next one goes out as soon as it returns.
  bool _resizePending = false;
  int _width = 0, _height = 0;
  double _scale = 1;
  bool _dark = true;
  Size _asked = Size.zero;
  double _askedScale = 1;
  int? _seq;

  bool get isV2 => _seq != null;

  Map<String, dynamic> get _shape => {
    'surfaceId': id,
    'width': _width,
    'height': _height,
    'dark': _dark,
    'scale': _scale,
    'mobile': mobile,
    'touch': touch,
  };

  void configure(Size size, bool dark, {double scale = 1}) {
    if (_disposed || size.isEmpty) return;
    _asked = size;
    _askedScale = scale;
    final width = size.width.round().clamp(160, isV2 ? 3840 : 1920);
    final height = size.height.round().clamp(120, isV2 ? 2400 : 1200);
    final density = isV2 ? scale.clamp(1.0, 3.0) : 1.0;
    final changed = width != _width ||
        height != _height ||
        density != _scale ||
        dark != _dark;
    _width = width;
    _height = height;
    _scale = density;
    _dark = dark;
    if (!isV2) {
      if (!_busy && _timer == null) _schedule(Duration.zero);
      return;
    }
    if (!changed) return;
    // A frame poll may wait a second: send the new size at once as an empty input, once the drag settles.
    _resize?.cancel();
    _resize = Timer(const Duration(milliseconds: 100), () {
      _resizePending = true;
      unawaited(_flush());
    });
  }

  void input(Map<String, dynamic> event) {
    if (_disposed || error != null || image == null) return;
    // Motion can be coalesced, but never across a press, a release or a key.
    final moving = event['event'] == 'mouseMoved' || event['event'] == 'touchMove';
    if (moving && _events.isNotEmpty && _events.last['event'] == event['event']) {
      _events[_events.length - 1] = event;
    } else if (_events.length < 64) {
      _events.add(event);
    } else {
      _events.clear();
      error = 'The connection is too slow. Reconnect the viewer and try again.';
      _timer?.cancel();
      _timer = null;
      notifyListeners();
      return;
    }
    if (isV2) {
      unawaited(_flush());
    } else if (!_busy) {
      _schedule(Duration.zero);
    }
  }

  void reload() {
    if (_disposed) return;
    error = null;
    _events.clear();
    _reload = true;
    notifyListeners();
    if (!_busy) _schedule(Duration.zero);
  }

  void _schedule(Duration delay) {
    _timer?.cancel();
    _timer = Timer(delay, () {
      _timer = null;
      unawaited(_frame());
    });
  }

  String _failure(Object e) => switch (e) {
    WsRequestTimeout() =>
      'Update Harness on this machine to use its viewer in the browser.',
    WsRequestFailure(code: 'UNSUPPORTED') =>
      'Update Harness on this machine to use its viewer in the browser.',
    WsRequestFailure(:final detail) when detail?.trim().isNotEmpty == true =>
      detail!,
    _ => 'The viewer disconnected. Reconnect and try again.',
  };

  Future<void> _flush() async {
    if (_disposed || _sending || error != null || (_events.isEmpty && !_resizePending)) {
      return;
    }
    _sending = true;
    _resizePending = false;
    final events = List<Map<String, dynamic>>.of(_events);
    _events.clear();
    try {
      final reply = await request({..._shape, 'op': 'input', 'events': events});
      if (_disposed) return;
      if (reply['error'] != null) {
        error = reply['detail'] as String? ?? 'The viewer is unavailable. Try again.';
        notifyListeners();
        return;
      }
      final nowEditable = reply['editable'] == true;
      if (nowEditable != editable) {
        editable = nowEditable;
        notifyListeners();
      }
      final text = reply['clipboard'];
      if (text is String) {
        (onClipboard ?? (t) => Clipboard.setData(ClipboardData(text: t)))(text);
      }
    } catch (e) {
      if (!_disposed) {
        error = _failure(e);
        notifyListeners();
      }
    } finally {
      _sending = false;
      if (!_disposed && (_events.isNotEmpty || _resizePending)) unawaited(_flush());
    }
  }

  Future<void> _frame() async {
    if (_disposed || _busy || _width == 0 || error != null) return;
    _busy = true;
    final wasV2 = isV2;
    final events = wasV2 ? const <Map<String, dynamic>>[] : List<Map<String, dynamic>>.of(_events);
    if (!wasV2) _events.clear();
    final reload = _reload;
    _reload = false;
    try {
      final reply = await request({
        ..._shape,
        'op': 'frame',
        'reload': reload,
        'events': events,
        if (wasV2) 'after': _seq,
      });
      if (_disposed) return;
      if (reply['error'] != null) {
        error = reply['detail'] as String? ?? 'The viewer is unavailable. Try again.';
      } else {
        final seq = reply['seq'];
        if (seq is int) _seq = seq;
        if (reply['unchanged'] != true) {
          // A pushed frame (P2pViewerTransport) is already bytes; the WS long-poll's is base64.
          final bytes = reply['bytes'], data = reply['data'];
          if (reply['mime'] != 'image/jpeg') {
            error = 'The viewer sent an invalid image.';
          } else if (bytes is Uint8List) {
            image = bytes;
          } else if (data is String && data.length <= 2 * 1024 * 1024) {
            image = base64Decode(data);
          } else {
            error = 'The viewer sent an invalid image.';
          }
        }
        if (error == null) {
          final actions = reply['hostActions'];
          if (actions is List && actions.length <= 8) {
            for (final action in actions) {
              if (action is Map<String, dynamic>) onHostAction?.call(action);
            }
          }
        }
        // Just proved v2: widen to the pane's real size and density.
        if (!wasV2 && isV2) configure(_asked, _dark, scale: _askedScale);
      }
    } catch (e) {
      if (!_disposed) error = _failure(e);
    } finally {
      _busy = false;
      if (!_disposed) {
        notifyListeners();
        if (error == null) {
          if (isV2 && _events.isNotEmpty) unawaited(_flush());
          _schedule(
            isV2 || _events.isNotEmpty || _reload
                ? Duration.zero
                : const Duration(milliseconds: 160),
          );
        }
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _resize?.cancel();
    _events.clear();
    unawaited(
      request({'surfaceId': id, 'op': 'close'})
          .catchError((_) => <String, dynamic>{}),
    );
    super.dispose();
  }
}

class RemoteViewerSurface extends StatefulWidget {
  const RemoteViewerSurface({super.key, required this.session});
  final InteractiveViewerSession session;
  @override
  State<RemoteViewerSurface> createState() => _InteractiveViewerState();
}

class _InteractiveViewerState extends State<RemoteViewerSurface> {
  final _focus = FocusNode();
  final _editor = GlobalKey<CustomTextEditState>();
  Size _size = Size.zero;
  int _pressed = 0;
  int _lastPress = 0, _clicks = 0;
  Offset _lastPosition = Offset.zero;

  bool _focusInput() {
    final editor = _editor.currentState;
    if (editor == null) return false;
    editor.requestKeyboard();
    return true;
  }

  @override
  void initState() {
    super.initState();
    widget.session.focusInput = _focusInput;
  }

  @override
  void didUpdateWidget(RemoteViewerSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) {
      oldWidget.session.focusInput = null;
      widget.session.focusInput = _focusInput;
    }
  }

  int get _modifiers {
    final keys = HardwareKeyboard.instance;
    return (keys.isAltPressed ? 1 : 0) |
        (keys.isControlPressed ? 2 : 0) |
        (keys.isMetaPressed ? 4 : 0) |
        (keys.isShiftPressed ? 8 : 0);
  }

  String _button(int buttons) => buttons & kSecondaryButton != 0
      ? 'right'
      : buttons & kMiddleMouseButton != 0
      ? 'middle'
      : buttons & kPrimaryButton != 0
      ? 'left'
      : 'none';

  void _pointer(PointerEvent event, String type, {int? buttons}) {
    if (_size.isEmpty) return;
    final down = buttons ?? event.buttons;
    widget.session.input({
      'type': 'pointer',
      'event': type,
      'x': (event.localPosition.dx / _size.width).clamp(0.0, 1.0),
      'y': (event.localPosition.dy / _size.height).clamp(0.0, 1.0),
      'buttons': event.buttons & 7,
      'button': _button(down),
      'modifiers': _modifiers,
      'clickCount': type == 'mouseMoved' || type == 'mouseWheel' ? 0 : _clicks,
      if (event is PointerScrollEvent) ...{
        'deltaX': event.scrollDelta.dx.clamp(-2000.0, 2000.0),
        'deltaY': event.scrollDelta.dy.clamp(-2000.0, 2000.0),
      },
    });
  }

  static final _keys = <LogicalKeyboardKey, (String, String, int)>{
    LogicalKeyboardKey.enter: ('Enter', 'Enter', 13),
    LogicalKeyboardKey.numpadEnter: ('Enter', 'NumpadEnter', 13),
    LogicalKeyboardKey.backspace: ('Backspace', 'Backspace', 8),
    LogicalKeyboardKey.delete: ('Delete', 'Delete', 46),
    LogicalKeyboardKey.tab: ('Tab', 'Tab', 9),
    LogicalKeyboardKey.escape: ('Escape', 'Escape', 27),
    LogicalKeyboardKey.arrowUp: ('ArrowUp', 'ArrowUp', 38),
    LogicalKeyboardKey.arrowDown: ('ArrowDown', 'ArrowDown', 40),
    LogicalKeyboardKey.arrowLeft: ('ArrowLeft', 'ArrowLeft', 37),
    LogicalKeyboardKey.arrowRight: ('ArrowRight', 'ArrowRight', 39),
    LogicalKeyboardKey.home: ('Home', 'Home', 36),
    LogicalKeyboardKey.end: ('End', 'End', 35),
    LogicalKeyboardKey.pageUp: ('PageUp', 'PageUp', 33),
    LogicalKeyboardKey.pageDown: ('PageDown', 'PageDown', 34),
  };

  void _key((String, String, int) key, bool down) => widget.session.input({
    'type': 'key',
    'event': down ? 'keyDown' : 'keyUp',
    'key': key.$1,
    'code': key.$2,
    'keyCode': key.$3,
    'modifiers': _modifiers,
  });

  VoidCallback? _shortcut(LogicalKeyboardKey key, bool shift) {
    final session = widget.session;
    void command(String letter, String name) {
      for (final down in [true, false]) {
        session.input({
          'type': 'key',
          'event': down ? 'keyDown' : 'keyUp',
          'key': letter,
          'code': 'Key${letter.toUpperCase()}',
          'keyCode': letter.toUpperCase().codeUnitAt(0),
          'modifiers': _modifiers,
          if (down) 'commands': [name],
        });
      }
    }
    if (key == LogicalKeyboardKey.keyC) return () => session.input({'type': 'copy'});
    if (key == LogicalKeyboardKey.keyX) return () => session.input({'type': 'cut'});
    if (key == LogicalKeyboardKey.keyV) {
      return () async {
        final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
        if (text == null || text.isEmpty) return;
        session.input({'type': 'text', 'text': text.length > 65536 ? text.substring(0, 65536) : text});
      };
    }
    if (key == LogicalKeyboardKey.keyA) return () => command('a', 'selectAll');
    if (key == LogicalKeyboardKey.keyZ) return () => command('z', shift ? 'redo' : 'undo');
    return null;
  }

  KeyEventResult _onKey(FocusNode _, KeyEvent event) {
    final keys = HardwareKeyboard.instance;
    final mac = defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    // The page's own copy/paste never reaches this computer's clipboard (Chrome runs on the
    // machine), so the editing shortcuts go through the surface. v2 machines only: a v1 machine
    // refuses the copy/cut events and key commands.
    if (widget.session.isV2 &&
        event is KeyDownEvent &&
        (mac ? keys.isMetaPressed : keys.isControlPressed)) {
      final shortcut = _shortcut(event.logicalKey, keys.isShiftPressed);
      if (shortcut != null) {
        shortcut();
        return KeyEventResult.handled;
      }
    }
    // Alt/Command shortcuts remain workspace navigation, as in a terminal pane.
    if (HardwareKeyboard.instance.isAltPressed ||
        HardwareKeyboard.instance.isMetaPressed) {
      return KeyEventResult.ignored;
    }
    var key = _keys[event.logicalKey];
    if (key == null && HardwareKeyboard.instance.isControlPressed) {
      final label = event.logicalKey.keyLabel;
      if (label.length == 1) {
        key = (
          label.toLowerCase(),
          'Key${label.toUpperCase()}',
          label.toUpperCase().codeUnitAt(0),
        );
      }
    }
    if (key == null) return KeyEventResult.ignored;
    final down = event is! KeyUpEvent;
    _key(key, down);
    if (down) _editor.currentState?.resetEditingState();
    return KeyEventResult.handled;
  }

  @override
  void dispose() {
    widget.session.focusInput = null;
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        _size = constraints.biggest;
        widget.session.configure(
          _size,
          grid.AppTheme.brightness.value == Brightness.dark,
          scale: MediaQuery.devicePixelRatioOf(context),
        );
        return ListenableBuilder(
          listenable: widget.session,
          builder: (context, _) {
            final error = widget.session.error;
            if (error != null) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        error,
                        style: terminalContentStyle(),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 16),
                      TerminalTextAction(
                        label: 'Retry',
                        onPressed: widget.session.reload,
                      ),
                    ],
                  ),
                ),
              );
            }
            final bytes = widget.session.image;
            if (bytes == null) {
              return Center(
                child: Text('Opening viewer…', style: terminalContentStyle()),
              );
            }
            return CustomTextEdit(
              key: _editor,
              focusNode: _focus,
              semanticLabel: 'Viewer input',
              onInsert: (text) =>
                  widget.session.input({'type': 'text', 'text': text}),
              onDelete: (count) {
                for (var i = 0; i < count.clamp(0, 32); i++) {
                  _key(_keys[LogicalKeyboardKey.backspace]!, true);
                  _key(_keys[LogicalKeyboardKey.backspace]!, false);
                }
              },
              onComposing: (_, _) {},
              onKeyEvent: _onKey,
              onAction: (_) {
                _key(_keys[LogicalKeyboardKey.enter]!, true);
                _key(_keys[LogicalKeyboardKey.enter]!, false);
                _editor.currentState?.resetEditingState();
              },
              child: Listener(
                behavior: HitTestBehavior.opaque,
                onPointerDown: (event) {
                  _editor.currentState?.requestKeyboard();
                  final now = DateTime.now().millisecondsSinceEpoch;
                  _clicks =
                      now - _lastPress < 400 &&
                          (event.localPosition - _lastPosition).distance < 5
                      ? 2
                      : 1;
                  _lastPress = now;
                  _lastPosition = event.localPosition;
                  _pressed = event.buttons;
                  _pointer(event, 'mousePressed');
                },
                onPointerUp: (event) {
                  _pointer(event, 'mouseReleased', buttons: _pressed);
                  _pressed = 0;
                },
                onPointerCancel: (event) {
                  _pointer(event, 'mouseReleased', buttons: _pressed);
                  _pressed = 0;
                },
                onPointerMove: (event) => _pointer(event, 'mouseMoved'),
                onPointerHover: (event) => _pointer(event, 'mouseMoved'),
                onPointerSignal: (event) {
                  if (event is PointerScrollEvent) {
                    GestureBinding.instance.pointerSignalResolver.register(
                      event,
                      (event) => _pointer(event, 'mouseWheel'),
                    );
                  }
                },
                child: Image.memory(
                  bytes,
                  // A viewer frame can be smaller than the viewport (the renderer caps its
                  // resolution). Keep painting and pointer coordinates on the same surface,
                  // including while the first image codec is still decoding.
                  width: _size.width,
                  height: _size.height,
                  fit: BoxFit.fill,
                  gaplessPlayback: true,
                  excludeFromSemantics: true,
                ),
              ),
            );
          },
        );
      },
    );
  }
}
