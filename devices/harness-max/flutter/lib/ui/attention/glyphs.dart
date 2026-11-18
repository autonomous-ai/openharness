// The mockup's line icons (ICON.mic, ICON.x): 24-unit SVG paths stroked 1.8 units wide with round ends, drawn at any
// size.
import 'package:flutter/widgets.dart';

enum Glyph { mic, cross }

class GlyphIcon extends StatelessWidget {
  const GlyphIcon(this.glyph, {super.key, required this.size, required this.color});
  final Glyph glyph;
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) =>
      SizedBox.square(dimension: size, child: CustomPaint(painter: _GlyphPainter(glyph, color)));
}

class _GlyphPainter extends CustomPainter {
  _GlyphPainter(this.glyph, this.color);
  final Glyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final u = size.width / 24;
    canvas.scale(u);
    final pen = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (glyph) {
      case Glyph.mic:
        // <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
        canvas.drawRRect(RRect.fromLTRBR(9, 3, 15, 14, const Radius.circular(3)), pen);
        canvas.drawArc(const Rect.fromLTWH(5, 4, 14, 14), 3.141592653589793, -3.141592653589793, false, pen);
        canvas.drawLine(const Offset(12, 18), const Offset(12, 21), pen);
      case Glyph.cross:
        // <path d="M6 6l12 12M18 6 6 18"/>
        canvas.drawLine(const Offset(6, 6), const Offset(18, 18), pen);
        canvas.drawLine(const Offset(18, 6), const Offset(6, 18), pen);
    }
  }

  @override
  bool shouldRepaint(_GlyphPainter old) => old.glyph != glyph || old.color != color;
}
