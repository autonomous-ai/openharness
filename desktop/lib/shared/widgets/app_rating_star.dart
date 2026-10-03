import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// A quantitative mark: the same rounded star outline at every value, with a
/// clipped fill so full, fractional and empty ratings also differ without color.
class AppRatingStar extends StatelessWidget {
  const AppRatingStar({
    super.key,
    required this.fraction,
    required this.color,
    required this.outlineColor,
    this.size = 16,
  });

  final double fraction;
  final Color color;
  final Color outlineColor;
  final double size;

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: Size.square(size),
    painter: _StarPainter(fraction.clamp(0, 1), color, outlineColor),
  );
}

class _StarPainter extends CustomPainter {
  const _StarPainter(this.fraction, this.color, this.outlineColor);
  final double fraction;
  final Color color;
  final Color outlineColor;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    final path = Path();
    for (var point = 0; point < 10; point++) {
      final angle = -math.pi / 2 + point * math.pi / 5;
      final radius = point.isEven ? 10.5 : 4.8;
      final x = 12 + radius * math.cos(angle);
      final y = 12 + radius * math.sin(angle);
      if (point == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    path.close();
    canvas.save();
    canvas.clipRect(Rect.fromLTWH(0, 0, 24 * fraction, 24));
    canvas.drawPath(path, Paint()..color = color);
    canvas.restore();
    canvas.drawPath(
      path,
      Paint()
        ..color = outlineColor
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.8
        ..strokeJoin = StrokeJoin.round,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_StarPainter oldDelegate) =>
      fraction != oldDelegate.fraction ||
      color != oldDelegate.color ||
      outlineColor != oldDelegate.outlineColor;
}
