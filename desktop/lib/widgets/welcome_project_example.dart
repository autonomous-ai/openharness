import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';

/// Illustrative project outputs for the welcome guide, not live workspaces.
enum WelcomeProjectExample { code, gripper, circuit }

class WelcomeProjectOutput extends StatelessWidget {
  const WelcomeProjectOutput({
    super.key,
    required this.example,
    required this.ink,
    required this.faint,
  });

  final WelcomeProjectExample example;
  final Color ink, faint;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    if (example != WelcomeProjectExample.code) {
      return SizedBox.expand(
        child: CustomPaint(painter: _RobotComponent(example)),
      );
    }
    final syntax = grid.AppPalette.teal;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('controller.ts', style: boxMonoStyle(color: faint)),
            const SizedBox(height: 10),
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: 'const ',
                    style: TextStyle(color: syntax),
                  ),
                  const TextSpan(text: 'arm = new RobotArm();\n\n'),
                  for (final command in [
                    'arm.moveTo(pickup);',
                    'arm.gripper.close();',
                    'arm.moveTo(dropoff);',
                    'arm.gripper.open();',
                  ]) ...[
                    TextSpan(
                      text: 'await ',
                      style: TextStyle(color: syntax),
                    ),
                    TextSpan(text: '$command\n'),
                  ],
                ],
              ),
              softWrap: false,
              style: boxMonoStyle(color: ink),
            ),
          ],
        ),
      ),
    );
  }
}

class _RobotComponent extends CustomPainter {
  const _RobotComponent(this.example);
  final WelcomeProjectExample example;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = math.min(size.width / 200, size.height / 140);
    canvas.save();
    canvas.translate(
      (size.width - 200 * scale) / 2,
      (size.height - 140 * scale) / 2,
    );
    canvas.scale(scale);
    switch (example) {
      case WelcomeProjectExample.gripper:
        _gripper(canvas);
      case WelcomeProjectExample.circuit:
        _circuit(canvas);
      case WelcomeProjectExample.code:
        break;
    }
    canvas.restore();
  }

  void _gripper(Canvas canvas) {
    const steel = Color(0xffa4b1c0);
    const jaw = Color(0xffd5a55c);
    Offset project(double x, double y, double z) =>
        Offset(114 + (x - y) * 1.1, 66 + (x + y) * .45 - z);
    void face(List<Offset> points, Color color) {
      final path = Path()..addPolygon(points, true);
      canvas.drawPath(path, Paint()..color = color);
      canvas.drawPath(
        path,
        Paint()
          ..color = const Color(0xff192127)
          ..style = PaintingStyle.stroke
          ..strokeWidth = .9,
      );
    }

    void block(double x, double y, double w, double d, double h, Color color) {
      face([
        project(x, y + d, 0),
        project(x + w, y + d, 0),
        project(x + w, y + d, h),
        project(x, y + d, h),
      ], Color.lerp(color, Colors.black, .28)!);
      face([
        project(x + w, y, 0),
        project(x + w, y + d, 0),
        project(x + w, y + d, h),
        project(x + w, y, h),
      ], Color.lerp(color, Colors.black, .48)!);
      face([
        project(x, y, h),
        project(x + w, y, h),
        project(x + w, y + d, h),
        project(x, y + d, h),
      ], color);
    }

    canvas.drawOval(
      const Rect.fromLTWH(33, 106, 137, 15),
      Paint()..color = Colors.black.withValues(alpha: .20),
    );
    block(-32, -25, 64, 34, 18, steel);
    block(-23, -20, 46, 21, 23, const Color(0xff798c9e));
    block(19, 9, 12, 43, 13, steel);
    block(8, 43, 23, 12, 17, jaw);
    block(-31, 9, 12, 43, 13, steel);
    block(-31, 43, 23, 12, 17, jaw);
    for (final x in [-26.0, 26.0]) {
      for (final y in [-19.0, 3.0]) {
        canvas.drawOval(
          Rect.fromCenter(center: project(x, y, 18), width: 5, height: 2.8),
          Paint()..color = const Color(0xff303941),
        );
      }
    }
    final track = Paint()
      ..color = const Color(0xff45545f)
      ..strokeWidth = 1;
    for (var i = 0; i < 4; i++) {
      canvas.drawLine(
        project(-12 + i * 8, -16, 23),
        project(-12 + i * 8, -3, 23),
        track,
      );
    }
  }

  void _circuit(Canvas canvas) {
    final board = RRect.fromRectAndRadius(
      const Rect.fromLTWH(17, 24, 165, 92),
      const Radius.circular(6),
    );
    canvas.drawRRect(
      board.shift(const Offset(0, 4)),
      Paint()..color = const Color(0xff082e27),
    );
    canvas.drawRRect(board, Paint()..color = const Color(0xff164f42));
    canvas.drawRRect(
      board,
      Paint()
        ..color = const Color(0xff458f76)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
    final trace = Paint()
      ..color = const Color(0xff62b994)
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;
    for (var i = 0; i < 4; i++) {
      final y = 53.0 + i * 7;
      canvas.drawPath(
        Path()
          ..moveTo(34, y)
          ..lineTo(49 + i * 3, y)
          ..lineTo(49 + i * 3, 46 + i * 7)
          ..lineTo(72, 46 + i * 7),
        trace,
      );
      canvas.drawPath(
        Path()
          ..moveTo(108, 46 + i * 7)
          ..lineTo(121 + i * 4, 46 + i * 7)
          ..lineTo(121 + i * 4, 91 - i * 7)
          ..lineTo(163, 91 - i * 7),
        trace,
      );
    }
    final gold = Paint()..color = const Color(0xffd4b36e);
    final dark = Paint()..color = const Color(0xff182421);
    for (var i = 0; i < 6; i++) {
      final y = 40.0 + i * 6;
      canvas.drawRect(Rect.fromLTWH(67, y, 7, 2.4), gold);
      canvas.drawRect(Rect.fromLTWH(107, y, 7, 2.4), gold);
    }
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        const Rect.fromLTWH(73, 35, 35, 43),
        const Radius.circular(2),
      ),
      dark,
    );
    canvas.drawCircle(
      const Offset(79, 41),
      1.5,
      Paint()..color = const Color(0xff73817a),
    );
    for (final x in [26.0, 163.0]) {
      canvas.drawRect(Rect.fromLTWH(x - 2, 43, 11, 49), dark);
      for (var i = 0; i < 5; i++) {
        canvas.drawRect(Rect.fromLTWH(x, 46 + i * 9, 7, 4), gold);
      }
    }
    for (final point in [
      const Offset(27, 33),
      const Offset(172, 33),
      const Offset(27, 106),
      const Offset(172, 106),
    ]) {
      canvas.drawCircle(point, 3.5, gold);
      canvas.drawCircle(point, 1.9, dark);
    }
    for (var i = 0; i < 3; i++) {
      canvas.drawRect(Rect.fromLTWH(80 + i * 18, 94, 12, 5), gold);
      canvas.drawRect(Rect.fromLTWH(82 + i * 18, 94, 8, 5), dark);
    }
  }

  @override
  bool shouldRepaint(_RobotComponent old) => old.example != example;
}
