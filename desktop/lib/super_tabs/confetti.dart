import 'dart:math';

import 'package:flutter/material.dart';

/// A short burst of confetti over its child, once, then gone. Nothing moves
/// when the system asks for reduced motion: the child shows alone.
class SuperTabConfetti extends StatefulWidget {
  const SuperTabConfetti({
    super.key,
    required this.seed,
    required this.child,
    this.duration = const Duration(milliseconds: 2200),
  });
  final int seed;
  final Widget child;
  final Duration duration;

  @override
  State<SuperTabConfetti> createState() => _SuperTabConfettiState();
}

class _SuperTabConfettiState extends State<SuperTabConfetti>
    with SingleTickerProviderStateMixin {
  late final _motion = AnimationController(
    vsync: this,
    duration: widget.duration,
  );
  late final _pieces = _Piece.burst(widget.seed);
  bool _done = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_done || _motion.isAnimating) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      _done = true;
      return;
    }
    _motion.forward().whenComplete(() {
      if (mounted) setState(() => _done = true);
    });
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Stack(
    clipBehavior: Clip.none,
    children: [
      widget.child,
      if (!_done)
        Positioned.fill(
          child: IgnorePointer(
            child: ExcludeSemantics(
              child: CustomPaint(
                key: const ValueKey('super-confetti'),
                painter: _ConfettiPainter(_pieces, _motion),
              ),
            ),
          ),
        ),
    ],
  );
}

class _Piece {
  const _Piece(this.x, this.drift, this.lift, this.spin, this.size, this.color);
  final double x, drift, lift, spin, size;
  final Color color;

  static const _colors = [
    Color(0xffff6b6b),
    Color(0xffffc145),
    Color(0xff4ecdc4),
    Color(0xff5b8def),
    Color(0xffb084f5),
    Color(0xff6ad08a),
  ];

  static List<_Piece> burst(int seed) {
    final random = Random(seed);
    return [
      for (var i = 0; i < 40; i++)
        _Piece(
          random.nextDouble(),
          (random.nextDouble() - .5) * .3,
          .4 + random.nextDouble() * .6,
          (random.nextDouble() - .5) * 12,
          4 + random.nextDouble() * 4,
          _colors[i % _colors.length],
        ),
    ];
  }
}

class _ConfettiPainter extends CustomPainter {
  _ConfettiPainter(this.pieces, this.motion) : super(repaint: motion);
  final List<_Piece> pieces;
  final Animation<double> motion;

  @override
  void paint(Canvas canvas, Size size) {
    final t = motion.value;
    final paint = Paint();
    for (final piece in pieces) {
      // Thrown up from the line, then falling past it as it fades.
      final y = size.height * (1 - piece.lift * 4 * t * (1 - t) * 2 + t * .6);
      final x = size.width * (piece.x + piece.drift * t);
      paint.color = piece.color.withValues(alpha: (1 - t).clamp(0, 1));
      canvas
        ..save()
        ..translate(x, y)
        ..rotate(piece.spin * t)
        ..drawRect(
          Rect.fromCenter(
            center: Offset.zero,
            width: piece.size,
            height: piece.size * .5,
          ),
          paint,
        )
        ..restore();
    }
  }

  @override
  bool shouldRepaint(_ConfettiPainter old) => false;
}
