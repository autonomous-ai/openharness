// An agent at work, on its page (the mockup's Working): the spinner word large in lavender with a light running through
// it, the activity under it, the last steps in a row; at the right the turn's clock, and a flow bar along the foot.
// While the band is up the word shrinks, the steps and the flow bar go, and the clock moves up.
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../overview/motion.dart';
import '../tokens.dart';
import 'live_text.dart';

/// How many of the turn's steps show.
const int kStepsShown = 3;

class Working extends StatelessWidget {
  const Working({super.key, required this.model, required this.agent, required this.talking});
  final BarModel model;
  final Agent agent;
  final bool talking;

  @override
  Widget build(BuildContext context) {
    final a = agent;
    final steps = a.steps.length > kStepsShown ? a.steps.sublist(a.steps.length - kStepsShown) : a.steps;
    final started = a.turnStarted;
    return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Expanded(
        child: Padding(
          padding: EdgeInsets.fromLTRB(44, talking ? 18 : 24, 30, 24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Verb(model.statusWord(a), size: talking ? 40 : 52),
            const SizedBox(height: 4),
            Text(a.activity,
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
                style: Face.s(25, color: Ink.rest)),
            if (!talking) ...[
              const Spacer(),
              ClipRect(
                child: Row(children: [
                  for (var i = 0; i < steps.length; i++) ...[
                    if (i > 0) const SizedBox(width: 28),
                    _Step(step: steps[i], now: i == steps.length - 1),
                  ],
                ]),
              ),
            ],
          ]),
        ),
      ),
      Container(
        width: 300,
        decoration: const BoxDecoration(border: Border(left: BorderSide(color: Ink.line))),
        padding: EdgeInsets.only(left: 1, top: talking ? 28 : 0),
        alignment: talking ? Alignment.topCenter : Alignment.center,
        child: started == null
            ? null
            : LiveText(() => clockText(model.now().difference(started).inSeconds),
                style: Face.n(talking ? 46 : 76, weight: FontWeight.w300, height: 1)),
      ),
    ]);
  }
}

/// The spinner word (.verb): 600 weight in lavender, a white light sweeping through its letters every 2.2 s (overlay
/// over lavender, so only the letters light), and a new word rises in (.swap, .45 s).
class Verb extends StatefulWidget {
  const Verb(this.text, {super.key, required this.size});
  final String text;
  final double size;

  @override
  State<Verb> createState() => _VerbState();
}

class _VerbState extends State<Verb> with SingleTickerProviderStateMixin {
  late final AnimationController _swap =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 450), value: 1);
  late final Animation<double> _in = CurvedAnimation(parent: _swap, curve: Curves.easeOut);

  @override
  void didUpdateWidget(Verb old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _swap.forward(from: 0);
  }

  @override
  void dispose() {
    _swap.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      fontFamily: Face.sans,
      fontSize: widget.size,
      fontWeight: FontWeight.w600,
      letterSpacing: -.01 * widget.size,
      height: 1.15,
    );
    final measure = TextPainter(
      text: TextSpan(text: widget.text, style: style),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      textHeightBehavior: DefaultTextHeightBehavior.of(context),
    )..layout();
    final size = measure.size;
    measure.dispose();
    return AnimatedBuilder(
      animation: _in,
      builder: (context, child) => Opacity(
        opacity: _in.value,
        child: Transform.translate(offset: Offset(0, 14 * (1 - _in.value)), child: child),
      ),
      child: RepaintBoundary(
        child: CustomPaint(
          size: size,
          painter: _VerbPainter(widget.text, style, DefaultTextHeightBehavior.of(context), Motion.of(context)),
        ),
      ),
    );
  }
}

class _VerbPainter extends CustomPainter {
  _VerbPainter(this.text, this.style, this.height, this.clock) : super(repaint: clock);
  final String text;
  final TextStyle style;
  final TextHeightBehavior? height;
  final ValueListenable<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    // sweep 2.2s ease-in-out: the light is 40% of the word long
    final w = size.width * .4, x = sweep(Curves.easeInOut.transform(loop(clock.value, 2.2)!)) * w;
    final lit = overlayWhite(Ink.accent);
    final ink = Paint()
      ..shader = ui.Gradient.linear(Offset(x, 0), Offset(x + w, 0), [Ink.accent, lit, Ink.accent], const [0, .5, 1]);
    final tp = TextPainter(
      text: TextSpan(text: text, style: style.copyWith(foreground: ink)),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      textHeightBehavior: height,
    )..layout();
    tp.paint(canvas, Offset.zero);
    tp.dispose();
  }

  @override
  bool shouldRepaint(_VerbPainter old) => old.text != text || old.style != style || old.clock != clock;
}

/// One step: a dot and its verb; the current one bright, its lavender dot ringed and pulsing.
class _Step extends StatelessWidget {
  const _Step({required this.step, required this.now});
  final TurnStep step;
  final bool now;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        SizedBox.square(
          dimension: 10,
          child: now
              ? RepaintBoundary(child: CustomPaint(painter: _NowDot(Motion.of(context))))
              : const DecoratedBox(decoration: BoxDecoration(color: Ink.faint, shape: BoxShape.circle)),
        ),
        const SizedBox(width: 10),
        Text(step.verb, style: Face.s(18, color: now ? Ink.fg : Ink.faint)),
      ]);
}

/// .step.now i: a 10 px lavender dot in a 4 px ring of lavender at 25% (box-shadow 0 0 0 4px), pulsing each second.
class _NowDot extends CustomPainter {
  _NowDot(this.clock) : super(repaint: clock);
  final ValueListenable<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    final o = pulse(loop(clock.value, 1)!);
    final c = size.center(Offset.zero);
    canvas.drawCircle(
      c,
      7,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 4
        ..color = Ink.accent.withValues(alpha: .25 * o),
    );
    canvas.drawCircle(c, 5, Paint()..color = Ink.accent.withValues(alpha: o));
  }

  @override
  bool shouldRepaint(_NowDot old) => old.clock != clock;
}

/// .flow: a 3 px track of #111 along the page's foot, a lavender light 30% of it long sweeping every 2.6 s.
class FlowBar extends StatelessWidget {
  const FlowBar({super.key});

  @override
  Widget build(BuildContext context) =>
      RepaintBoundary(child: CustomPaint(size: Size.infinite, painter: _FlowPainter(Motion.of(context))));
}

class _FlowPainter extends CustomPainter {
  _FlowPainter(this.clock) : super(repaint: clock);
  final ValueListenable<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    final track = Offset.zero & size;
    canvas.drawRect(track, Paint()..color = const Color(0xFF111111));
    final w = size.width * .3, x = sweep(loop(clock.value, 2.6)!) * w;
    const clear = Color(0x00C6AAEF);
    // past the light's ends the gradient clamps to clear
    canvas.drawRect(
      track,
      Paint()..shader = ui.Gradient.linear(Offset(x, 0), Offset(x + w, 0), [clear, Ink.accent, clear], const [0, .5, 1]),
    );
  }

  @override
  bool shouldRepaint(_FlowPainter old) => old.clock != clock;
}
