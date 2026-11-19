// One agent in App Detail's row (the mockup's .cell): its status rail, the faint glow of its colour from the top, and
// its face (pet, name, the line of its task, the state chip) laid out a third of the row wide. Beside an open agent it
// is a sliver: dimmed and blurred, its pet smaller and centred in it, its words gone. Opened, its face gives way to the
// open agent, which fades in over it.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../pet.dart';
import '../tokens.dart';
import 'chip.dart';
import 'motion.dart';
import 'open_agent.dart' show kOpenW, kSliverW;
import 'rail.dart';

/// The row between the app column and the bell, and a cell's width while no agent is open: a third of it.
const double kRowW = 1172;
const double kCellW = kRowW / 3;

/// How the row's cells change width as an agent opens or closes (the mockup's flex-basis .42s var(--ease)).
const Duration kRowMove = Duration(milliseconds: 420);
const Curve kRowEase = Cubic(.2, .8, .2, 1);

/// The cell's pet box (the mockup's canvas, data-w 150 data-h 108), standing on the floor of its 112 px slot.
const Size kCellPet = Size(150, 108);

/// A cell while no agent is open, beside the open one, or the open one.
enum CellLook { closed, sliver, open }

class AgentCell extends StatelessWidget {
  const AgentCell({
    super.key,
    required this.agent,
    required this.word,
    this.look = CellLook.closed,
    this.open,
    this.onTap,
  });
  final Agent agent;

  /// The status word (BarModel.statusWord).
  final String word;
  final CellLook look;

  /// The open agent laid over the cell ([CellLook.open]); null otherwise, and the last one fades out.
  final Widget? open;

  /// Null: the cell takes no tap (the open agent takes its own).
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = agent.state, opened = look == CellLook.open;
    final cell = Stack(fit: StackFit.expand, children: [
      AnimatedContainer(
        duration: const Duration(milliseconds: 350),
        curve: Curves.ease,
        padding: const EdgeInsets.only(right: 1),
        decoration: BoxDecoration(
          color: opened ? const Color(0xFF060609) : const Color(0x00060609),
          border: const Border(right: BorderSide(color: Ink.line)),
        ),
        child: Stack(fit: StackFit.expand, children: [
          if (s != AgentState.idle)
            RepaintBoundary(
              child: CustomPaint(
                  painter: _GlowPainter(chipInk(s), s, s == AgentState.asking ? Motion.of(context) : null)),
            ),
          Positioned(left: 0, top: 0, bottom: 0, width: kCellW, child: _Face(agent: agent, word: word, look: look)),
          Positioned(left: 0, right: 0, top: 0, height: 5, child: Rail(color: railInk(s), state: s)),
        ]),
      ),
      Positioned(left: 0, top: 0, bottom: 0, width: kOpenW, child: _Opening(child: open)),
    ]);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: _Dim(on: look == CellLook.sliver, child: cell),
    );
  }
}

/// The face a cell shows while it is not open (.compact): the pet in its slot, the name, the task in two lines at
/// most, and the chip at the foot. In a sliver it moves to the sliver's middle, its pet smaller and lower, its words
/// gone; opened, it fades.
class _Face extends StatelessWidget {
  const _Face({required this.agent, required this.word, required this.look});
  final Agent agent;
  final String word;
  final CellLook look;

  @override
  Widget build(BuildContext context) {
    final a = agent, sliver = look == CellLook.sliver, sum = summaryOf(a), scene = petSceneFor(a, list: true);
    Widget words(Widget child) => AnimatedOpacity(
          opacity: sliver ? 0 : 1,
          duration: const Duration(milliseconds: 200),
          curve: Curves.ease,
          child: child,
        );
    final face = Stack(fit: StackFit.expand, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(22, 24, 22, 0),
        child: Column(children: [
          SizedBox(
            height: 112,
            child: TweenAnimationBuilder<double>(
              tween: Tween(end: sliver ? 1 : 0),
              duration: kRowMove,
              curve: kRowEase,
              // translateY(52px) scale(.6), about the slot's foot
              builder: (context, t, pet) => Transform.translate(
                offset: Offset(0, 52 * t),
                child: Transform.scale(scale: 1 - .4 * t, alignment: Alignment.bottomCenter, child: pet),
              ),
              child: Align(
                alignment: Alignment.bottomCenter,
                child: PetView(engine: a.engine, scene: scene, size: petFit(a.engine, scene, kCellPet)),
              ),
            ),
          ),
          const SizedBox(height: 12),
          words(Text(a.name,
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: Face.s(26, weight: FontWeight.w600, height: 1.2))),
          const SizedBox(height: 6),
          words(ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 330),
            child: Text(sum.isEmpty ? 'No task yet' : sum,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: Face.s(16, color: sum.isEmpty ? Ink.faint : Ink.dim, height: 1.35)),
          )),
        ]),
      ),
      Positioned(
        left: 0,
        right: 0,
        bottom: 18,
        child: Center(child: words(StateChip(state: a.state, word: word))),
      ),
    ]);
    return AnimatedOpacity(
      opacity: look == CellLook.open ? 0 : 1,
      duration: const Duration(milliseconds: 250),
      curve: Curves.ease,
      child: TweenAnimationBuilder<double>(
        tween: Tween(end: sliver ? (kSliverW - kCellW) / 2 : 0),
        duration: kRowMove,
        curve: kRowEase,
        builder: (context, dx, face) => Transform.translate(offset: Offset(dx, 0), child: face),
        child: face,
      ),
    );
  }
}

/// The open agent over its cell (.full): it fades in once the cell has begun to widen (.3s ease after .14s) and out at
/// once (.3s ease) when the cell closes, kept until it has gone.
class _Opening extends StatefulWidget {
  const _Opening({required this.child});
  final Widget? child;

  @override
  State<_Opening> createState() => _OpeningState();
}

class _OpeningState extends State<_Opening> {
  late Widget? _shown = widget.child;

  @override
  void didUpdateWidget(_Opening old) {
    super.didUpdateWidget(old);
    if (widget.child != null) _shown = widget.child;
  }

  @override
  Widget build(BuildContext context) {
    final on = widget.child != null;
    return IgnorePointer(
      ignoring: !on,
      child: GestureDetector(
        // A finger that slides on the open agent is its tap (its Taps count a tap that slides a little), so the row
        // must not also scroll under it: this drag wins over the row's and does nothing.
        onHorizontalDragStart: on ? (_) {} : null,
        child: AnimatedOpacity(
          opacity: on ? 1 : 0,
          duration: Duration(milliseconds: on ? 440 : 300),
          curve: on ? const Interval(140 / 440, 1, curve: Curves.ease) : Curves.ease,
          onEnd: () {
            if (widget.child == null && _shown != null) setState(() => _shown = null);
          },
          child: _shown ?? const SizedBox.shrink(),
        ),
      ),
    );
  }
}

/// A sliver's dimming (opacity .62, filter brightness(.62) saturate(.55) blur(1.2px), .35s ease; the mock's .42 read too
/// dark on the bar, the owner's call 19 Nov): one colour matrix and the blur in one filter, off (no layer) while the cell
/// is not dimmed at all.
class _Dim extends StatelessWidget {
  const _Dim({required this.on, required this.child});
  final bool on;
  final Widget child;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(end: on ? 1 : 0),
        duration: const Duration(milliseconds: 350),
        curve: Curves.ease,
        builder: (context, t, child) => ImageFiltered(
          enabled: t > 0,
          imageFilter: ui.ImageFilter.compose(
            outer: ui.ImageFilter.blur(sigmaX: 1.2 * t, sigmaY: 1.2 * t, tileMode: TileMode.decal),
            inner: ColorFilter.matrix(dimMatrix(t)),
          ),
          child: child,
        ),
        child: child,
      );
}

/// The colour matrix of a sliver dimmed [t] of the way: brightness and saturate as the Filter Effects spec writes
/// them, then the opacity on alpha.
@visibleForTesting
List<double> dimMatrix(double t) {
  final b = 1 - .38 * t, s = 1 - .45 * t, o = 1 - .38 * t;
  return [
    b * (.213 + .787 * s), b * (.715 - .715 * s), b * (.072 - .072 * s), 0, 0, //
    b * (.213 - .213 * s), b * (.715 + .285 * s), b * (.072 - .072 * s), 0, 0,
    b * (.213 - .213 * s), b * (.715 - .715 * s), b * (.072 + .928 * s), 0, 0,
    0, 0, 0, o, 0,
  ];
}

/// The cell's glow: radial-gradient(110% 60% at 50% 0%, c, transparent 72%) at .08, a failure's at .14; a waiting
/// cell's at .18, breathing to .05 and back each second.
class _GlowPainter extends CustomPainter {
  _GlowPainter(this.color, this.state, this.clock) : super(repaint: clock);
  final Color color;
  final AgentState state;

  /// The page's clock while the glow breathes (a waiting agent), else null.
  final ValueListenable<double>? clock;

  @override
  void paint(Canvas canvas, Size size) {
    final c = clock;
    final o = c != null
        ? keyframes(loop(c.value, 1)!, from: .18, to: .05, curve: Curves.easeInOut)
        : state == AgentState.failed
            ? .14
            : .08;
    final rx = 1.1 * size.width, ry = .6 * size.height;
    // A unit circle's gradient, stretched to the ellipse.
    canvas
      ..save()
      ..clipRect(Offset.zero & size)
      ..translate(size.width / 2, 0)
      ..scale(rx, ry);
    canvas.drawRect(
      Rect.fromLTRB(-size.width / 2 / rx, 0, size.width / 2 / rx, size.height / ry),
      Paint()
        ..shader = ui.Gradient.radial(
            Offset.zero, 1, [color.withValues(alpha: o), color.withValues(alpha: 0)], const [0, .72]),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_GlowPainter old) => old.color != color || old.state != state || old.clock != clock;
}
