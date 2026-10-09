import 'package:flutter/material.dart';
// The same IME input adapter the phone's terminal uses.
// ignore: implementation_imports
import 'package:xterm/src/ui/custom_text_edit.dart';

import 'interactive_viewer_session.dart';

/// A remote page under the finger: touches go to Chrome as touches (the page scrolls and pinches
/// itself, with `touch: true` it believes it is on a phone), and the keyboard comes up when the page
/// focuses a text field. A machine that has not proved v2 (`session.isV2`) refuses touch events, so
/// there one finger drives the mouse instead.
class TouchViewerSurface extends StatefulWidget {
  const TouchViewerSurface({super.key, required this.session});
  final InteractiveViewerSession session;
  @override
  State<TouchViewerSurface> createState() => _TouchViewerSurfaceState();
}

class _TouchViewerSurfaceState extends State<TouchViewerSurface> {
  final _focus = FocusNode();
  final _editor = GlobalKey<CustomTextEditState>();
  final _points = <int, Offset>{};
  // The finger standing in for the mouse on a v1 machine.
  int? _mouse;
  Size _size = Size.zero;
  bool _keyboard = false;

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_followFocus);
    widget.session.focusInput = _focusInput;
  }

  bool _focusInput() {
    final editor = _editor.currentState;
    if (editor == null) return false;
    editor.requestKeyboard();
    return true;
  }

  @override
  void dispose() {
    widget.session.removeListener(_followFocus);
    widget.session.focusInput = null;
    _focus.dispose();
    super.dispose();
  }

  // The page decides when typing makes sense: show the keyboard while a text field has focus.
  void _followFocus() {
    if (widget.session.editable == _keyboard) return;
    _keyboard = widget.session.editable;
    if (_keyboard) {
      // The editor may be mounted by the rebuild this notification triggers: ask after it.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _keyboard) _focusInput();
      });
    } else {
      _focus.unfocus();
    }
  }

  // Chrome ends or cancels the points a touchEnd/touchCancel lists, so those carry only the lifted
  // finger; listing the ones still down released them and left the lifted one stuck.
  void _touch(String type, Map<int, Offset> points) {
    if (_size.isEmpty) return;
    widget.session.input({
      'type': 'touch',
      'event': type,
      'points': [
        for (final point in points.entries)
          {
            'x': (point.value.dx / _size.width).clamp(0.0, 1.0),
            'y': (point.value.dy / _size.height).clamp(0.0, 1.0),
            'id': point.key % 32,
          },
      ],
      'modifiers': 0,
    });
  }

  void _pointer(String type, Offset at) {
    if (_size.isEmpty) return;
    widget.session.input({
      'type': 'pointer',
      'event': type,
      'x': (at.dx / _size.width).clamp(0.0, 1.0),
      'y': (at.dy / _size.height).clamp(0.0, 1.0),
      'buttons': type == 'mouseReleased' ? 0 : 1,
      'button': 'left',
      'clickCount': type == 'mouseMoved' ? 0 : 1,
      'modifiers': 0,
    });
  }

  void _lifted(PointerEvent event, {required bool cancelled}) {
    if (event.pointer == _mouse) {
      _mouse = null;
      _pointer('mouseReleased', event.localPosition);
    } else if (_points.remove(event.pointer) != null) {
      _touch(cancelled ? 'touchCancel' : 'touchEnd', {event.pointer: event.localPosition});
    } else {
      return;
    }
    // A tap on the page brings the keyboard back after it was dismissed.
    if (!cancelled && _points.isEmpty && widget.session.editable) _focusInput();
  }

  void _key(String key, String code, int keyCode) {
    for (final down in [true, false]) {
      widget.session.input({
        'type': 'key',
        'event': down ? 'keyDown' : 'keyUp',
        'key': key,
        'code': code,
        'keyCode': keyCode,
        'modifiers': 0,
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        _size = constraints.biggest;
        // configure() never notifies, so it is called here: a size change (the keyboard opening,
        // a rotation) must reach the machine even when nothing else rebuilds.
        widget.session.configure(
          _size,
          Theme.of(context).brightness == Brightness.dark,
          scale: MediaQuery.devicePixelRatioOf(context),
        );
        return ListenableBuilder(
          listenable: widget.session,
          builder: (context, _) {
            final error = widget.session.error;
            // No editor and no Listener are mounted on the error and loading screens: forget the
            // keyboard and any finger whose up/cancel can no longer arrive.
            if (error != null || widget.session.image == null) {
              _keyboard = false;
              _points.clear();
              _mouse = null;
            }
            if (error != null) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(error, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      TextButton(
                        onPressed: widget.session.reload,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              );
            }
            final bytes = widget.session.image;
            if (bytes == null) {
              return const Center(child: Text('Opening viewer…'));
            }
            return CustomTextEdit(
              key: _editor,
              focusNode: _focus,
              onInsert: (text) =>
                  widget.session.input({'type': 'text', 'text': text}),
              onDelete: (count) {
                for (var i = 0; i < count.clamp(0, 32); i++) {
                  _key('Backspace', 'Backspace', 8);
                }
              },
              onComposing: (_, _) {},
              onKeyEvent: (_, _) => KeyEventResult.ignored,
              onAction: (_) {
                _key('Enter', 'Enter', 13);
                _editor.currentState?.resetEditingState();
              },
              child: Listener(
                behavior: HitTestBehavior.opaque,
                onPointerDown: (event) {
                  if (!widget.session.isV2) {
                    // The older parser takes no touch: the first finger is the mouse, the rest are ignored.
                    if (_mouse != null || _points.isNotEmpty) return;
                    _mouse = event.pointer;
                    _pointer('mousePressed', event.localPosition);
                    return;
                  }
                  if (_mouse != null || _points.length >= 5) return;
                  _points[event.pointer] = event.localPosition;
                  _touch('touchStart', _points);
                },
                onPointerMove: (event) {
                  if (event.pointer == _mouse) {
                    _pointer('mouseMoved', event.localPosition);
                    return;
                  }
                  if (!_points.containsKey(event.pointer)) return;
                  _points[event.pointer] = event.localPosition;
                  _touch('touchMove', _points);
                },
                onPointerUp: (event) => _lifted(event, cancelled: false),
                onPointerCancel: (event) => _lifted(event, cancelled: true),
                child: Image.memory(
                  bytes,
                  width: _size.width,
                  height: _size.height,
                  fit: BoxFit.fill,
                  gaplessPlayback: true,
                  // A frame that fails to decode keeps the touch area; the next frame replaces it.
                  errorBuilder: (_, _, _) =>
                      SizedBox(width: _size.width, height: _size.height),
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
