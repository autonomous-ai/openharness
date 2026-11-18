// A page's touch, as the dial reads it (max_ui_touch.c) and the mockup's pointer handlers do: a contact that ends 80 px
// or more sideways of where it began, and more sideways than down, is a swipe; any other is a tap on the Tap it began
// on, wherever it ends. The bar's touch is imprecise, so a tap that slides a little still counts as the tap it began as.
import 'package:flutter/widgets.dart';

/// How far sideways a contact goes to be a swipe (the mockup's 80 px).
const double kSwipe = 80;

class SwipeArea extends StatefulWidget {
  const SwipeArea({super.key, required this.onSwipe, this.onTap, required this.child});

  /// A swipe: +1 when the finger went left (what comes next), -1 when it went right.
  final ValueChanged<int> onSwipe;

  /// A tap that began on no [Tap].
  final VoidCallback? onTap;
  final Widget child;

  @override
  State<SwipeArea> createState() => _SwipeAreaState();
}

class _SwipeAreaState extends State<SwipeArea> {
  final Map<int, Offset> _from = {};
  final Map<int, _TapState> _on = {};

  // A Tap hears the contact before its area does (the deepest first), so the first to claim it is the innermost.
  void _claim(int pointer, _TapState tap) => _on[pointer] ??= tap;

  void _up(PointerUpEvent e) {
    final from = _from.remove(e.pointer);
    final tap = _on.remove(e.pointer);
    tap?._press(false);
    if (from == null) return;
    final d = e.localPosition - from;
    if (d.dx.abs() >= kSwipe && d.dx.abs() * 2 > d.dy.abs() * 3) {
      widget.onSwipe(d.dx < 0 ? 1 : -1);
    } else if (tap != null) {
      tap.widget.onTap?.call();
    } else {
      widget.onTap?.call();
    }
  }

  void _cancel(PointerCancelEvent e) {
    _from.remove(e.pointer);
    _on.remove(e.pointer)?._press(false);
  }

  @override
  Widget build(BuildContext context) => _AreaScope(
        area: this,
        child: Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: (e) => _from[e.pointer] = e.localPosition,
          onPointerUp: _up,
          onPointerCancel: _cancel,
          child: widget.child,
        ),
      );
}

class _AreaScope extends InheritedWidget {
  const _AreaScope({required this.area, required super.child});
  final _SwipeAreaState area;

  @override
  bool updateShouldNotify(_AreaScope old) => old.area != area;
}

/// Something the finger can tap inside a [SwipeArea]: the whole of its box counts. [pressed] fills it while the finger
/// is down (the mockup's `:active`).
class Tap extends StatefulWidget {
  const Tap({super.key, required this.onTap, this.pressed, required this.child});

  /// Null: not tappable now (the tap goes to what is under it).
  final VoidCallback? onTap;
  final Color? pressed;
  final Widget child;

  @override
  State<Tap> createState() => _TapState();
}

class _TapState extends State<Tap> {
  bool _down = false;

  void _press(bool down) {
    if (mounted && down != _down && widget.pressed != null) setState(() => _down = down);
  }

  @override
  Widget build(BuildContext context) {
    final area = context.dependOnInheritedWidgetOfExactType<_AreaScope>()?.area;
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: widget.onTap == null || area == null
          ? null
          : (e) {
              area._claim(e.pointer, this);
              if (area._on[e.pointer] == this) _press(true);
            },
      // The same tree pressed or not, so what it holds (a pet's player) keeps its state.
      child: widget.pressed == null
          ? widget.child
          : ColoredBox(color: _down ? widget.pressed! : const Color(0x00000000), child: widget.child),
    );
  }
}
