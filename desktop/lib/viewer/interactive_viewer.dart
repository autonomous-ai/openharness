import 'dart:async';
import 'dart:convert';

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

/// Pulling the next frame only after the previous reply bounds both rendering and network work.
/// Input is connection-local: a failed request is never replayed into a replacement viewer.
class InteractiveViewerSession extends ChangeNotifier {
  InteractiveViewerSession(this.request, {this.onHostAction});
  final ViewerSurfaceRequest request;
  final void Function(Map<String, dynamic>)? onHostAction;
  final String id = hexOf(secureRandomBytes(16));
  Uint8List? image;
  String? error;
  bool Function()? focusInput;
  final _events = <Map<String, dynamic>>[];
  Timer? _timer;
  bool _disposed = false, _busy = false, _reload = false;
  int _width = 0, _height = 0;
  bool _dark = true;

  void configure(Size size, bool dark) {
    if (_disposed || size.isEmpty) return;
    _width = size.width.round().clamp(160, 1920);
    _height = size.height.round().clamp(120, 1200);
    _dark = dark;
    if (!_busy && _timer == null) _schedule(Duration.zero);
  }

  void input(Map<String, dynamic> event) {
    if (_disposed || error != null || image == null) return;
    // Mouse motion can be coalesced, but never across a press/release or key event.
    if (event['event'] == 'mouseMoved' &&
        _events.isNotEmpty &&
        _events.last['event'] == 'mouseMoved') {
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
    if (!_busy) _schedule(Duration.zero);
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

  Future<void> _frame() async {
    if (_disposed || _busy || _width == 0 || error != null) return;
    _busy = true;
    final events = List<Map<String, dynamic>>.of(_events);
    _events.clear();
    final reload = _reload;
    _reload = false;
    try {
      final reply = await request({
        'surfaceId': id,
        'op': 'frame',
        'width': _width,
        'height': _height,
        'dark': _dark,
        'reload': reload,
        'events': events,
      });
      if (_disposed) return;
      if (reply['error'] != null) {
        error =
            reply['detail'] as String? ??
            'The viewer is unavailable. Try again.';
      } else if (reply['mime'] != 'image/jpeg' ||
          reply['data'] is! String ||
          (reply['data'] as String).length > 2 * 1024 * 1024) {
        error = 'The viewer sent an invalid image.';
      } else {
        image = base64Decode(reply['data'] as String);
        final actions = reply['hostActions'];
        if (actions is List && actions.length <= 8) {
          for (final action in actions) {
            if (action is Map<String, dynamic>) onHostAction?.call(action);
          }
        }
      }
    } on WsRequestTimeout {
      if (!_disposed) {
        error =
            'Update Harness on this machine to use its viewer in the browser.';
      }
    } on WsRequestFailure catch (failure) {
      if (!_disposed) {
        error = failure.code == 'UNSUPPORTED'
            ? 'Update Harness on this machine to use its viewer in the browser.'
            : (failure.detail?.trim().isNotEmpty == true
                  ? failure.detail!
                  : 'The viewer disconnected. Reconnect and try again.');
      }
    } catch (_) {
      if (!_disposed) {
        error = 'The viewer disconnected. Reconnect and try again.';
      }
    } finally {
      _busy = false;
      if (!_disposed) {
        notifyListeners();
        if (error == null) {
          _schedule(
            _events.isEmpty && !_reload
                ? const Duration(milliseconds: 160)
                : Duration.zero,
          );
        }
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
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

  KeyEventResult _onKey(FocusNode _, KeyEvent event) {
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
