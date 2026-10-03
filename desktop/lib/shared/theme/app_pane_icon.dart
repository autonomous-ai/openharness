import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'app_icons.dart';

enum AppPaneSymbol { splitDown, splitRight, zoom, restore, reload, close }

/// Optical variants for the small, repeated pane controls. The split and zoom
/// outlines keep Lucide's 24-unit grid, two-unit stroke and round caps, with
/// four-unit corners that remain visibly rounded at 14 points.
class AppPaneIcon extends StatelessWidget {
  const AppPaneIcon(this.symbol, {super.key, this.color, this.size = 14});

  final AppPaneSymbol symbol;
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    final glyph = switch (symbol) {
      AppPaneSymbol.close => AppIcons.close,
      AppPaneSymbol.reload => AppIcons.refreshCw,
      _ => null,
    };
    if (glyph != null) return Icon(glyph, color: color, size: size);
    final theme = IconTheme.of(context);
    final ink = color ?? theme.color ?? const Color(0xFF000000);
    return CustomPaint(
      size: Size.square(size),
      painter: _PaneIconPainter(
        symbol,
        ink.withValues(alpha: ink.a * (theme.opacity ?? 1)),
      ),
    );
  }
}

class _PaneIconPainter extends CustomPainter {
  const _PaneIconPainter(this.symbol, this.color);

  final AppPaneSymbol symbol;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    switch (symbol) {
      case AppPaneSymbol.splitDown:
      case AppPaneSymbol.splitRight:
        final outline = Path()
          ..addRRect(
            RRect.fromRectAndRadius(
              const Rect.fromLTRB(3, 3, 21, 21),
              const Radius.circular(4),
            ),
          );
        final horizontal = symbol == AppPaneSymbol.splitDown;
        outline
          ..moveTo(horizontal ? 3 : 12, horizontal ? 12 : 3)
          ..lineTo(horizontal ? 21 : 12, horizontal ? 12 : 21);
        canvas.drawPath(outline, stroke);
      case AppPaneSymbol.zoom:
      case AppPaneSymbol.restore:
        final corner = symbol == AppPaneSymbol.zoom
            ? (Path()
                ..moveTo(9, 3)
                ..lineTo(7, 3)
                ..quadraticBezierTo(3, 3, 3, 7)
                ..lineTo(3, 9))
            : (Path()
                ..moveTo(3, 9)
                ..lineTo(5, 9)
                ..quadraticBezierTo(9, 9, 9, 5)
                ..lineTo(9, 3));
        for (var i = 0; i < 4; i++) {
          canvas.drawPath(corner, stroke);
          canvas.translate(12, 12);
          canvas.rotate(math.pi / 2);
          canvas.translate(-12, -12);
        }
      case AppPaneSymbol.close:
      case AppPaneSymbol.reload:
        break; // These delegate to the catalogue's font glyphs above.
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_PaneIconPainter oldDelegate) =>
      oldDelegate.symbol != symbol || oldDelegate.color != color;
}
