import 'package:flutter/painting.dart';

/// Ink the phone's Swarm cards need that the shared theme has no role for.
abstract final class SwarmInk {
  /// Dark ink on the warning fill: a count waiting on the person.
  static const Color onWarning = Color(0xFF1A1200);
}

/// What a ship line's confetti is thrown in: six bright hues, the same in both
/// themes, because confetti is celebration and not chrome.
abstract final class SwarmConfetti {
  static const colors = <Color>[
    Color(0xffff6b6b),
    Color(0xffffc145),
    Color(0xff4ecdc4),
    Color(0xff5b8def),
    Color(0xffb084f5),
    Color(0xff6ad08a),
  ];
}
