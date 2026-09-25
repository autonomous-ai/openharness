import 'package:flutter/widgets.dart';

/// Lets the lists inside a sheet pull the sheet down, the way an iOS sheet
/// does: a downward drag on a list already at its top moves the sheet, not
/// the list.
///
/// ⚠️ **Without this, only the strip above the lists could close the sheet.**
/// The lists win every vertical drag that starts on them. On a sheet standing
/// full height, that left a grip-high band as the one place a thumb could pull
/// from — "kéo mỏi tay".
///
/// The lists keep their bounce at the foot. At the top they stop dead instead
/// ([_TopClampedPhysics]), so the pull past it reaches the sheet as overscroll
/// rather than being spent on a bounce that would move the rows under a sheet
/// that is itself moving.
class SheetPull extends StatelessWidget {
  const SheetPull({
    super.key,
    required this.onPull,
    required this.onRelease,
    required this.child,
  });

  /// Points the sheet should move down (negative: back up).
  final ValueChanged<double> onPull;

  /// The finger left a list mid-pull, at this downward velocity in points per
  /// second.
  final ValueChanged<double> onRelease;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ScrollConfiguration(
      behavior: const _TopClampedBehavior(),
      child: NotificationListener<ScrollNotification>(
        onNotification: _handle,
        child: child,
      ),
    );
  }

  bool _handle(ScrollNotification notification) {
    if (notification.metrics.axis != Axis.vertical) return false;
    // Overscroll past the top, while a finger drives it — not a fling's coast.
    if (notification is OverscrollNotification &&
        notification.dragDetails != null &&
        notification.overscroll < 0) {
      onPull(-notification.overscroll);
    }
    if (notification is ScrollEndNotification) {
      onRelease(notification.dragDetails?.primaryVelocity ?? 0);
    }
    return false;
  }
}

class _TopClampedBehavior extends ScrollBehavior {
  const _TopClampedBehavior();

  @override
  ScrollPhysics getScrollPhysics(BuildContext context) =>
      _TopClampedPhysics(parent: super.getScrollPhysics(context));
}

/// The platform's physics, except that the top edge clamps: a drag past it is
/// reported as overscroll instead of bouncing.
class _TopClampedPhysics extends ScrollPhysics {
  const _TopClampedPhysics({super.parent});

  @override
  _TopClampedPhysics applyTo(ScrollPhysics? ancestor) =>
      _TopClampedPhysics(parent: buildParent(ancestor));

  @override
  double applyBoundaryConditions(ScrollMetrics position, double value) {
    final top = position.minScrollExtent;
    // Moving further past a top edge already reached.
    if (value < position.pixels && position.pixels <= top) {
      return value - position.pixels;
    }
    // Crossing the top edge in this step: stop at it, report the rest.
    if (value < top && top < position.pixels) return value - top;
    return super.applyBoundaryConditions(position, value);
  }
}
