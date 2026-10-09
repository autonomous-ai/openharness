import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../e2ee/bytes.dart';
import '../ws/ws_conn.dart';

typedef ViewerSurfaceRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

// Copied from desktop/lib/viewer/interactive_viewer.dart's InteractiveViewerSession — there is no
// shared Dart package. Keep the two identical in logic; change both together.

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
