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

/// The chat composer's card (Tony's composer brief, 11-01): the measures the
/// shared roles have no name for. Used by the chat, New message and a
/// thread's reply box.
abstract final class SwarmComposer {
  /// Around the composer column: no band of its own, the card floats.
  static const EdgeInsets padding = EdgeInsets.symmetric(
    horizontal: 8,
    vertical: 6,
  );

  static const double cardRadius = 24;

  /// The files going, inside the card above the field.
  static const EdgeInsets chipsPadding = EdgeInsets.fromLTRB(10, 10, 10, 0);

  /// The field's text. The right 44 is always kept for the X, so the text
  /// does not rewrap as it comes and goes.
  static const EdgeInsets fieldPadding = EdgeInsets.fromLTRB(16, 12, 44, 2);

  /// The toolbar's 44pt row inside the card.
  static const EdgeInsets toolbarPadding = EdgeInsets.fromLTRB(6, 0, 6, 4);

  /// The @ Tag chip's pill.
  static const EdgeInsets tagPadding = EdgeInsets.only(left: 10, right: 13);
  static const double tagRadius = 18;

  /// The voice row's stop: a filled square with softened corners.
  static const double stopRadius = 2;
}
