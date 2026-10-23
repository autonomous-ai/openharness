import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// The dial's drag on a conversation list (a cloud harness's pane, a Swarm's
/// chat), as it scrolls a terminal: the same scale, speed and fling decay as
/// terminal_panel.dart. A positive dy shows earlier lines, here older messages,
/// whichever way the list runs: a reversed list's offset grows toward them, a
/// forward one's shrinks, so the sign follows the list to keep the direction on
/// screen the same. The owner calls [cancel] when it goes.
class DialListScroll {
  DialListScroll(this._list);

  /// The list on screen now (null or unattached: the dial moves nothing).
  final ScrollController? Function() _list;

  static const _scale = 2.5;
  static const _stopVelocity = 40.0;
  static const _decayPerSecond = 0.002;
  Timer? _inertia;
  double _velocity = 0;
  int? _lastInertiaMicros;

  /// One piece of a stroke: phase 0 down, 1 move, 2 up (with its velocity).
  void handle(int phase, int dy, int velocity) {
    if (phase == 0) cancel();
    if (dy != 0) _apply(dy * _scale);
    if (phase == 2) _fling(velocity.toDouble());
  }

  void _apply(double delta) {
    final list = _list();
    if (list == null || !list.hasClients) return;
    final position = list.position;
    final older = position.axisDirection == AxisDirection.up ? 1 : -1;
    position.jumpTo(
      (position.pixels + delta * older)
          .clamp(position.minScrollExtent, position.maxScrollExtent)
          .toDouble(),
    );
  }

  void _fling(double velocity) {
    cancel();
    if (velocity.abs() < _stopVelocity) return;
    _velocity = velocity;
    _lastInertiaMicros = DateTime.now().microsecondsSinceEpoch;
    _inertia = Timer.periodic(const Duration(milliseconds: 16), (_) {
      final now = DateTime.now().microsecondsSinceEpoch;
      final elapsed = math.min((now - (_lastInertiaMicros ?? now)) / 1e6, 0.05);
      _lastInertiaMicros = now;
      _apply(_velocity * elapsed * _scale);
      _velocity *= math.pow(_decayPerSecond, elapsed).toDouble();
      if (_velocity.abs() < _stopVelocity) cancel();
    });
  }

  /// Stops a fling still running.
  void cancel() {
    _inertia?.cancel();
    _inertia = null;
    _velocity = 0;
    _lastInertiaMicros = null;
  }
}
