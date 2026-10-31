import 'package:flutter/widgets.dart';

/// A thread's scroll: it opens at the newest reply and stays there, as
/// Slack's threads do (Dee, 2026-10-31).
///
/// The list's end is known only as its rows are laid out: replies still being
/// read, a long message or a picture settling, a lazy list refining its
/// estimate of the rows not built yet. So the view does not jump once and
/// hope; while it follows the end, every layout puts it there, before
/// anything is painted. The reader scrolling away stops that; scrolling back
/// to the end, or Jump to latest, starts it again.
class SuperTabThreadScroll extends ScrollController {
  SuperTabThreadScroll() : super(keepScrollOffset: false);

  /// Puts the view at the newest reply and keeps it there, as when a thread
  /// opens.
  void followEnd() {
    for (final position in positions) {
      if (position is _EndPosition) position._followEnd();
    }
  }

  /// Keeps the view where it is as rows arrive, even at the end: the reader
  /// asked for earlier replies and reads on from where they are.
  void holdPlace() {
    for (final position in positions) {
      if (position is _EndPosition) position._following = false;
    }
  }

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) => _EndPosition(
    physics: physics,
    context: context,
    oldPosition: oldPosition,
    debugLabel: debugLabel,
  );
}

class _EndPosition extends ScrollPositionWithSingleContext {
  _EndPosition({
    required super.physics,
    required super.context,
    super.oldPosition,
    super.debugLabel,
  }) : super(keepScrollOffset: false);

  // A new view starts at the end.
  bool _following = true;

  void _followEnd() {
    // A fling still coasting would move the view off the end again.
    goIdle();
    _following = true;
    // The next layout (a new thread's rows) settles it at the real end.
    notifyListeners();
  }

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    if (_following && (pixels - maxScrollExtent).abs() > .5) {
      // Laid out again from there: rows near the end are built and measured,
      // and the end is checked once more.
      correctPixels(maxScrollExtent);
      return false;
    }
    return super.applyContentDimensions(minScrollExtent, maxScrollExtent);
  }

  // The reader moved the view (a drag, the wheel, a key, a jump): at the
  // end, it follows the end; anywhere else it stays where it is.
  void _moved() {
    if (hasContentDimensions) _following = pixels >= maxScrollExtent - .5;
  }

  @override
  double setPixels(double newPixels) {
    final overscroll = super.setPixels(newPixels);
    _moved();
    return overscroll;
  }

  @override
  void forcePixels(double value) {
    super.forcePixels(value);
    _moved();
  }
}
