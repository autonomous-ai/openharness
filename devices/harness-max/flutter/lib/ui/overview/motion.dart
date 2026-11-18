// The mockup's CSS loops (the rails' sweep, the pulses, the flow bar) on one clock per page. The page's Motion runs a
// ticker only while something on it moves; the painters listen to its clock and repaint without rebuilding a widget.
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

class Motion extends StatefulWidget {
  const Motion({super.key, required this.on, required this.child});

  /// Something on the page moves: the clock runs.
  final bool on;
  final Widget child;

  /// Seconds since the page came up (as a CSS animation counts from when its element appeared).
  static ValueListenable<double> of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_MotionScope>()?.clock ?? _still;

  static final ValueNotifier<double> _still = ValueNotifier(0);

  @override
  State<Motion> createState() => _MotionState();
}

class _MotionState extends State<Motion> with SingleTickerProviderStateMixin {
  final ValueNotifier<double> _clock = ValueNotifier(0);
  late final Ticker _ticker = createTicker((e) => _clock.value = _from + e.inMicroseconds / 1e6);
  double _from = 0;

  @override
  void initState() {
    super.initState();
    _run();
  }

  @override
  void didUpdateWidget(Motion old) {
    super.didUpdateWidget(old);
    _run();
  }

  void _run() {
    if (widget.on && !_ticker.isActive) {
      _from = _clock.value;   // a loop that stopped goes on from where it stood
      _ticker.start();
    } else if (!widget.on && _ticker.isActive) {
      _ticker.stop();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _MotionScope(clock: _clock, child: widget.child);
}

class _MotionScope extends InheritedWidget {
  const _MotionScope({required this.clock, required super.child});
  final ValueNotifier<double> clock;

  @override
  bool updateShouldNotify(_MotionScope old) => old.clock != clock;
}

/// How far through its loop a CSS animation of [period] seconds is at [t] (0..1); before its [delay] it has not begun
/// (null: the element shows its own style).
double? loop(double t, double period, {double delay = 0}) {
  if (t < delay) return null;
  return ((t - delay) % period) / period;
}

/// The CSS `sweep` keyframes: translateX(-100%) to translateX(190%), as the left edge of the moving light in its own
/// widths from the track's left.
double sweep(double p) => -1 + 2.9 * p;

/// A two-stop keyframe loop as CSS plays it: [from] at 0% and 100%, [to] at [at], each leg eased by [curve].
double keyframes(double p, {required double from, required double to, double at = .5, Curve curve = Curves.ease}) =>
    p < at ? from + (to - from) * curve.transform(p / at) : to + (from - to) * curve.transform((p - at) / (1 - at));

/// The CSS `pulse` keyframes (50% opacity .35) over an element whose own opacity is [base].
double pulse(double p, {double base = 1, Curve curve = Curves.ease}) =>
    keyframes(p, from: base, to: .35, curve: curve);

/// What CSS `mix-blend-mode: overlay` of white makes of [c]: where a white light passes over it, its colour moves
/// toward this by the light's alpha. Drawn as a plain gradient to this colour, it needs no blend layer on the GPU.
Color overlayWhite(Color c) {
  double ch(double v) => v < .5 ? 2 * v : 1;
  return Color.from(alpha: 1, red: ch(c.r), green: ch(c.g), blue: ch(c.b));
}

/// How long a page takes to fade in over the last (the mockup's .page: transition opacity .3s ease).
const Duration kPageFade = Duration(milliseconds: 300);

/// The mockup's page change: the new page fades in over the old as the old fades out, both eased; the old one takes
/// no touch (pointer-events: none once it is off). [child] carries the key that tells one page from the next.
class FadeSwitch extends StatelessWidget {
  const FadeSwitch({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
        duration: kPageFade,
        switchInCurve: Curves.ease,
        // The old page's opacity runs 1 - ease(t) as CSS eases it out; AnimatedSwitcher plays it backwards in time.
        switchOutCurve: Curves.ease.flipped,
        layoutBuilder: (current, previous) =>
            Stack(fit: StackFit.expand, children: [...previous, ?current]),
        transitionBuilder: (child, animation) => _Fading(animation: animation, child: child),
        child: child,
      );
}

class _Fading extends StatefulWidget {
  const _Fading({required this.animation, required this.child});
  final Animation<double> animation;
  final Widget child;

  @override
  State<_Fading> createState() => _FadingState();
}

class _FadingState extends State<_Fading> {
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    widget.animation.addStatusListener(_status);
  }

  void _status(AnimationStatus s) {
    final leaving = s == AnimationStatus.reverse || s == AnimationStatus.dismissed;
    if (leaving != _leaving) setState(() => _leaving = leaving);
  }

  @override
  void dispose() {
    widget.animation.removeStatusListener(_status);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => IgnorePointer(
        ignoring: _leaving,
        child: FadeTransition(opacity: widget.animation, child: widget.child),
      );
}
