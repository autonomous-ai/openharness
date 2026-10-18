import 'package:flutter/widgets.dart';

/// The scroll physics of a full-screen program's scroll — the alternate screen, where the phone has
/// no history of its own and a scroll is wheel events sent to the machine (`TerminalView`'s
/// `altBufferScrollPhysics`). Drag and fling are the platform's own, so a flick carries as far and
/// slows the way it does in any list on the phone; only the fling's slow tail is cut.
///
/// ⚠️ **The tail, not the fling, is what read as lag.** The platform eases its last few pixels out
/// over a second or more. Here each line is a redraw the program sends back, so that ease arrives as
/// a line, a pause, a line — the screen still ticking well after it looked stopped. A fling ends
/// once it is slower than [stopVelocity].
///
/// ⚠️ **A fling once ran seconds behind the finger** (measured on Claude Code, 2026-10-02: 150–450
/// wheels, the screen moving 2–5 s after the finger lifted), and was cut to a quarter-second coast
/// for it — which stopped a fast flick dead. What ran behind was the queue: a wheel per line went
/// out faster than the program redrew, each waiting on the redraws before it. The scroll now sends
/// only as fast as the program answers (`TerminalView.altBufferScrollPaced`), so a long fling costs
/// a few dozen redraws, not one per line, and stops when the platform's does.
///
/// Only where the extents are infinite. Anywhere else — reused on a scrollable with ends — it
/// defers to the platform entirely, overscroll and all.
class RemoteScrollPhysics extends ScrollPhysics {
  const RemoteScrollPhysics({super.parent});

  /// Slower than this, in logical pixels a second, a fling is over: about ten lines a second, below
  /// which the lines come one at a time.
  static const stopVelocity = 200.0;

  @override
  RemoteScrollPhysics applyTo(ScrollPhysics? ancestor) =>
      RemoteScrollPhysics(parent: buildParent(ancestor));

  @override
  Simulation? createBallisticSimulation(
    ScrollMetrics position,
    double velocity,
  ) {
    final platform = super.createBallisticSimulation(position, velocity);
    if (platform == null ||
        position.minScrollExtent.isFinite ||
        position.maxScrollExtent.isFinite) {
      return platform;
    }
    if (velocity.abs() < stopVelocity) return null;
    return _EndsWhenSlow(platform, stopVelocity);
  }
}

/// [_inner] — the platform's fling — until its speed falls below [_stopVelocity]. Its speed only
/// ever falls, so the fling ends where it is then, with no jump.
class _EndsWhenSlow extends Simulation {
  _EndsWhenSlow(this._inner, this._stopVelocity)
    : super(tolerance: _inner.tolerance);

  final Simulation _inner;
  final double _stopVelocity;

  @override
  double x(double time) => _inner.x(time);

  @override
  double dx(double time) => _inner.dx(time);

  @override
  bool isDone(double time) =>
      _inner.isDone(time) || _inner.dx(time).abs() < _stopVelocity;
}
