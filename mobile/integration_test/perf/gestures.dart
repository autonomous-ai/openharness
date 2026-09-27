import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'frames.dart';
import 'perf_binding.dart';

/// Touches delivered the way the engine delivers the phone's own: into
/// [GestureBinding]'s hit test and dispatch, as device events.
///
/// ⚠️ **Not `WidgetTester.tap`/`fling`.** Those are TEST-sourced events, and
/// the live binding paints a crosshair over the app for each of them and
/// repaints the root to fade it out — extra paint and raster work inside the
/// very frames being timed. Device-sourced events go straight to the framework
/// while [LiveTestWidgetsFlutterBinding.shouldPropagateDevicePointerEvents] is
/// on, exactly as a finger's would.
///
/// ⚠️ **On for each synthetic event only, never across the run.** Left on, the
/// phone's REAL touches reach the app too — somebody picking the phone up
/// mid-run scrolls the terminal and the frames it draws are counted as the
/// benchmark's. Each event here turns it on, is dispatched synchronously, and
/// turns it off; a real touch, which arrives between them from the engine, is
/// dropped by the live binding as it always is.
///
/// This is the desktop benchmark's boundary moved to touch: **framework
/// dispatch**. Digitizer sampling, the OS's touch delivery and the engine's
/// pointer packet conversion are outside it.
class Touches {
  Touches(this.binding);

  final PerfBinding binding;
  final Stopwatch _clock = Stopwatch()..start();
  int _nextPointer = 100;

  Duration get _stamp => Duration(microseconds: _clock.elapsedMicroseconds);

  void _send(PointerEvent event) {
    binding.shouldPropagateDevicePointerEvents = true;
    try {
      binding.handlePointerEventForSource(
        event,
        source: TestBindingEventSource.device,
      );
    } finally {
      binding.shouldPropagateDevicePointerEvents = false;
    }
  }

  /// A finger put down at [position]; returns it for moves and the lift.
  Finger down(Offset position) {
    final finger = Finger._(this, TestPointer(_nextPointer++), position);
    _send(finger._pointer.down(position, timeStamp: _stamp));
    return finger;
  }

  /// The centre of [element]'s box, in the coordinates hit testing uses —
  /// checked by hit testing it, so a tap is known to land on what it names.
  Offset centerOf(Element element, {Offset shift = Offset.zero}) {
    final box = element.renderObject! as RenderBox;
    final point = box.localToGlobal(box.size.center(Offset.zero)) + shift;
    final result = HitTestResult();
    binding.hitTestInView(
      result,
      point,
      binding.platformDispatcher.implicitView!.viewId,
    );
    final hit =
        result.path.any((entry) => entry.target == box) ||
        result.path.any(
          (entry) =>
              entry.target is RenderObject &&
              _isDescendant(entry.target as RenderObject, box),
        );
    if (!hit) {
      throw StateError(
        'A touch at $point would not reach ${element.widget.runtimeType}',
      );
    }
    return point;
  }

  static bool _isDescendant(RenderObject node, RenderObject ancestor) {
    RenderObject? current = node;
    while (current != null) {
      if (identical(current, ancestor)) return true;
      current = current.parent;
    }
    return false;
  }
}

class Finger {
  Finger._(this._touches, this._pointer, this._at);

  final Touches _touches;
  final TestPointer _pointer;
  Offset _at;

  Offset get position => _at;

  /// Moves by [delta]; answers the wall-clock time just before dispatch.
  int moveBy(Offset delta) {
    _at += delta;
    final began = wallMicros();
    _touches._send(_pointer.move(_at, timeStamp: _touches._stamp));
    return began;
  }

  /// Lifts the finger; answers the wall-clock time just before dispatch.
  int up() {
    final began = wallMicros();
    _touches._send(_pointer.up(timeStamp: _touches._stamp));
    return began;
  }

  void cancel() => _touches._send(_pointer.cancel(timeStamp: _touches._stamp));
}

/// A finger's path at the touch rate: one move every [interval], real time
/// between them, so frames and gesture recognizers interleave the way they do
/// under a thumb.
Future<void> glide(
  Finger finger,
  Offset delta, {
  required int steps,
  Duration interval = const Duration(milliseconds: 8),
}) async {
  final step = delta / steps.toDouble();
  for (var i = 0; i < steps; i++) {
    await Future<void>.delayed(interval);
    finger.moveBy(step);
  }
}
