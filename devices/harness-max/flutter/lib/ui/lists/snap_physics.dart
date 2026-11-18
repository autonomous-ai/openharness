// A row of cards that comes to rest with a card's left edge on the row's left edge, as the mockup's
// `scroll-snap-type: x mandatory` with `scroll-snap-align: start`.
import 'package:flutter/widgets.dart';

class SnapPhysics extends ScrollPhysics {
  /// Rest points are [origin] + k * [extent] (the row's leading padding, then one card and its gap), and the ends.
  const SnapPhysics({required this.origin, required this.extent, super.parent});
  final double origin, extent;

  @override
  SnapPhysics applyTo(ScrollPhysics? ancestor) =>
      SnapPhysics(origin: origin, extent: extent, parent: buildParent(ancestor));

  /// The rest point a release at [velocity] goes to: the nearest card, or the next one in a fling's direction.
  double restFor(ScrollMetrics position, double velocity, Tolerance tolerance) {
    var card = (position.pixels - origin) / extent;
    if (velocity < -tolerance.velocity) {
      card -= 0.5;
    } else if (velocity > tolerance.velocity) {
      card += 0.5;
    }
    return (origin + card.roundToDouble() * extent).clamp(position.minScrollExtent, position.maxScrollExtent);
  }

  @override
  Simulation? createBallisticSimulation(ScrollMetrics position, double velocity) {
    // Out of range and not headed back: the parent brings it back to an end, which is a rest point too.
    if ((velocity <= 0 && position.pixels <= position.minScrollExtent) ||
        (velocity >= 0 && position.pixels >= position.maxScrollExtent)) {
      return super.createBallisticSimulation(position, velocity);
    }
    final tolerance = toleranceFor(position);
    final target = restFor(position, velocity, tolerance);
    if (target == position.pixels) return null;
    return ScrollSpringSimulation(spring, position.pixels, target, velocity, tolerance: tolerance);
  }

  @override
  bool get allowImplicitScrolling => false;
}

/// Starts the row on its first rest point: the mockup's snap pulls the first card onto the row's edge when the row
/// overflows (Inbox's first card sits at x 220, not after its 6 px of padding). A row that fits cannot scroll and stays
/// put, from its first frame: the plain controller would start it out of range and spring it back into place.
class SnapController extends ScrollController {
  SnapController(double origin) : super(initialScrollOffset: origin);

  @override
  ScrollPosition createScrollPosition(ScrollPhysics physics, ScrollContext context, ScrollPosition? oldPosition) =>
      _SnapPosition(
        physics: physics,
        context: context,
        initialPixels: initialScrollOffset,
        keepScrollOffset: keepScrollOffset,
        oldPosition: oldPosition,
        debugLabel: debugLabel,
      );
}

class _SnapPosition extends ScrollPositionWithSingleContext {
  _SnapPosition({
    required super.physics,
    required super.context,
    super.initialPixels,
    super.keepScrollOffset,
    super.oldPosition,
    super.debugLabel,
  });

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    if (!haveDimensions && hasPixels && (pixels < minScrollExtent || pixels > maxScrollExtent)) {
      correctPixels(pixels.clamp(minScrollExtent, maxScrollExtent));
      return false; // the viewport lays the row out again from the corrected place
    }
    return super.applyContentDimensions(minScrollExtent, maxScrollExtent);
  }
}
