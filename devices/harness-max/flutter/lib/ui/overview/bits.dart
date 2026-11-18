// The mockup's shared bits: its line icons (ICON: bell, back, grid, mic, x), the round button, and text laid out as
// CSS lays it.
import 'package:flutter/widgets.dart';

import '../tokens.dart';

/// CSS splits a line's leading evenly above and below the text; Flutter's default splits it by the face's ascent and
/// descent, which would move every line with a line-height off the mockup's.
const TextHeightBehavior kEvenLeading = TextHeightBehavior(leadingDistribution: TextLeadingDistribution.even);

/// The mockup's .round: a card-coloured circle inside a 1 px rim (the bell, the band's X).
class RoundButton extends StatelessWidget {
  const RoundButton({super.key, required this.size, required this.child});
  final double size;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: Ink.card, shape: BoxShape.circle, border: Border.all(color: Ink.rim)),
        child: child,
      );
}

/// The icons are 24-unit SVG paths stroked 1.8 wide with round ends, drawn at any size.
enum Glyph { bell, back, grid, mic, x }

class GlyphIcon extends StatelessWidget {
  const GlyphIcon(this.glyph, {super.key, required this.size, required this.color});
  final Glyph glyph;
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) =>
      CustomPaint(size: Size.square(size), painter: _GlyphPainter(glyph, color));
}

class _GlyphPainter extends CustomPainter {
  const _GlyphPainter(this.glyph, this.color);
  final Glyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 24);
    final pen = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(_path(glyph), pen);
  }

  static Path _path(Glyph g) => switch (g) {
        // M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4
        Glyph.bell => Path()
          ..moveTo(6, 16)
          ..lineTo(6, 11)
          ..arcToPoint(const Offset(18, 11), radius: const Radius.circular(6))
          ..lineTo(18, 16)
          ..lineTo(19.5, 18)
          ..lineTo(4.5, 18)
          ..close()
          ..moveTo(10, 20.5)
          ..lineTo(14, 20.5),
        // m15 6-6 6 6 6
        Glyph.back => Path()
          ..moveTo(15, 6)
          ..lineTo(9, 12)
          ..lineTo(15, 18),
        // four 6 x 6 squares, corners 1.5
        Glyph.grid => Path()
          ..addRRect(RRect.fromLTRBR(4, 4, 10, 10, const Radius.circular(1.5)))
          ..addRRect(RRect.fromLTRBR(14, 4, 20, 10, const Radius.circular(1.5)))
          ..addRRect(RRect.fromLTRBR(4, 14, 10, 20, const Radius.circular(1.5)))
          ..addRRect(RRect.fromLTRBR(14, 14, 20, 20, const Radius.circular(1.5))),
        // rect 9,3 6x11 r3; M5 11a7 7 0 0 0 14 0M12 18v3
        Glyph.mic => Path()
          ..addRRect(RRect.fromLTRBR(9, 3, 15, 14, const Radius.circular(3)))
          ..moveTo(5, 11)
          ..arcToPoint(const Offset(19, 11), radius: const Radius.circular(7), clockwise: false)
          ..moveTo(12, 18)
          ..lineTo(12, 21),
        // M6 6l12 12M18 6 6 18
        Glyph.x => Path()
          ..moveTo(6, 6)
          ..lineTo(18, 18)
          ..moveTo(18, 6)
          ..lineTo(6, 18),
      };

  @override
  bool shouldRepaint(_GlyphPainter old) => old.glyph != glyph || old.color != color;
}
