import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// The smallest thing a thumb can reliably hit — Apple's 44pt.
const double minTouchTarget = 44;

/// Lets a small control be pressed across a [minTouchTarget] square around it
/// while it takes, and draws in, only its own size.
///
/// ⚠️ **Hit area only, never layout.** Headers here are laid out from their
/// controls' drawn sizes — the terminal page flies its buttons from positions
/// computed off the 24pt box — so padding the control out to 44pt would move
/// every row it sits in. This is what Material's padded tap target does,
/// without the padding.
///
/// The reach stops at the parents' own bounds: a point outside the row a
/// control sits in never reaches it to be tested.
class TouchTarget extends SingleChildRenderObjectWidget {
  const TouchTarget({super.key, required Widget super.child});

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderTouchTarget();
}

class _RenderTouchTarget extends RenderProxyBox {
  @override
  bool hitTest(BoxHitTestResult result, {required Offset position}) {
    if (super.hitTest(result, position: position)) return true;
    final child = this.child;
    if (child == null) return false;
    final reachX = math.max(0.0, (minTouchTarget - size.width) / 2);
    final reachY = math.max(0.0, (minTouchTarget - size.height) / 2);
    final target = Rect.fromLTRB(
      -reachX,
      -reachY,
      size.width + reachX,
      size.height + reachY,
    );
    if (!target.contains(position)) return false;
    // Handed to the child at its centre, so it answers as though pressed there.
    final center = child.size.center(Offset.zero);
    return result.addWithRawTransform(
      transform: MatrixUtils.forceToPoint(center),
      position: center,
      hitTest: (result, position) => child.hitTest(result, position: center),
    );
  }
}
