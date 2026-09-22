import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../state/terminal_pane.dart';

/// A single GPU snapshot bends into the manager. The live terminal remains
/// mounted at its original size: minimizing never resizes or stops its process.
class PaneMinimizeController extends ChangeNotifier {
  PaneMinimizeController({required TickerProvider vsync}) {
    animation = AnimationController(
      vsync: vsync,
      duration: const Duration(milliseconds: 520),
    )..addListener(notifyListeners);
  }
  late final AnimationController animation;
  final _boundaries = <int, GlobalKey>{};
  ui.Image? snapshot;
  int? paneId;
  Rect source = Rect.zero;
  Offset target = Offset.zero;

  Future<void> animate(TerminalPane pane, Offset destination) async {
    final box = pane.cellKey.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.hasSize || box.size.isEmpty) return;
    source = box.localToGlobal(Offset.zero) & box.size;
    target = destination;
    final boundary = _boundaries[pane.id]?.currentContext?.findRenderObject();
    if (boundary is RenderRepaintBoundary) {
      try {
        // Bound texture memory even on a large Retina display. No PNG encoding
        // or CPU readback, and no repeated capture while the pane is moving.
        final ratio = math.min(
          2.0,
          1600 / math.max(source.width, source.height),
        );
        snapshot = boundary.toImageSync(pixelRatio: ratio);
      } catch (_) {
        // An unpainted/offscreen pane can still close with the live fallback.
      }
    }
    paneId = pane.id;
    notifyListeners();
    await animation.forward(from: 0).orCancel;
  }

  void reset() {
    paneId = null;
    snapshot?.dispose();
    snapshot = null;
    animation.reset();
    notifyListeners();
  }

  @override
  void dispose() {
    snapshot?.dispose();
    animation.dispose();
    super.dispose();
  }
}

class PaneMinimizeScope extends InheritedWidget {
  const PaneMinimizeScope({
    super.key,
    required this.controller,
    required this.close,
    required super.child,
  });
  final PaneMinimizeController controller;
  final Future<void> Function(TerminalPane) close;
  static PaneMinimizeScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PaneMinimizeScope>();
  @override
  bool updateShouldNotify(PaneMinimizeScope oldWidget) =>
      controller != oldWidget.controller;
}

/// The upper edge reaches for the icon first; the rest follows through a smooth
/// neck. Every horizontal slice stays ordered, so the texture never folds over.
Rect paneMinimizeSlice(Size size, Offset target, double progress, double v) {
  final t = progress.clamp(0.0, 1.0);
  final pull = Curves.easeOutCubic.transform(t);
  final rise = Curves.easeInCubic.transform(t);
  final top = (target.dy - 11) * pull;
  final bottom = size.height + (target.dy + 11 - size.height) * rise;
  final wave = ((t - v * .28) / (1 - v * .28)).clamp(0.0, 1.0);
  final narrow = Curves.easeOutCubic.transform(wave);
  final width = size.width + (22 - size.width) * narrow;
  final center = size.width / 2 + (target.dx - size.width / 2) * narrow;
  return Rect.fromLTWH(center - width / 2, top + (bottom - top) * v, width, 0);
}

class _GeniePainter extends CustomPainter {
  _GeniePainter(this.controller) : super(repaint: controller.animation);
  final PaneMinimizeController controller;
  static const _bands = 48;

  @override
  void paint(Canvas canvas, Size size) {
    final image = controller.snapshot;
    if (image == null) return;
    final t = controller.animation.value;
    final target = controller.target - controller.source.topLeft;
    final positions = <Offset>[];
    final texture = <Offset>[];
    for (var i = 0; i <= _bands; i++) {
      final v = i / _bands;
      final slice = paneMinimizeSlice(size, target, t, v);
      positions.addAll([slice.topLeft, slice.topRight]);
      texture.addAll([
        Offset(0, image.height * v),
        Offset(image.width.toDouble(), image.height * v),
      ]);
    }
    final vertices = ui.Vertices(
      ui.VertexMode.triangleStrip,
      positions,
      textureCoordinates: texture,
    );
    final opacity = 1 - Curves.easeIn.transform(((t - .86) / .14).clamp(0, 1));
    final paint = Paint()
      ..color = Colors.white.withValues(alpha: opacity)
      ..filterQuality = FilterQuality.medium
      ..shader = ImageShader(
        image,
        TileMode.clamp,
        TileMode.clamp,
        Float64List.fromList(Matrix4.identity().storage),
      );
    canvas.drawVertices(vertices, BlendMode.modulate, paint);
    vertices.dispose();
  }

  @override
  bool shouldRepaint(_GeniePainter oldDelegate) =>
      controller != oldDelegate.controller;
}

class PaneMinimizeSurface extends StatefulWidget {
  const PaneMinimizeSurface({
    super.key,
    required this.paneId,
    required this.child,
  });
  final int paneId;
  final Widget child;
  @override
  State<PaneMinimizeSurface> createState() => _PaneMinimizeSurfaceState();
}

class _PaneMinimizeSurfaceState extends State<PaneMinimizeSurface> {
  final _boundary = GlobalKey();
  PaneMinimizeController? _controller;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final controller = PaneMinimizeScope.maybeOf(context)?.controller;
    if (_controller == controller) return;
    _controller?._boundaries.remove(widget.paneId);
    _controller = controller;
    controller?._boundaries[widget.paneId] = _boundary;
  }

  @override
  void didUpdateWidget(PaneMinimizeSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.paneId != widget.paneId) {
      _controller?._boundaries.remove(oldWidget.paneId);
      _controller?._boundaries[widget.paneId] = _boundary;
    }
  }

  @override
  void dispose() {
    _controller?._boundaries.remove(widget.paneId);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return widget.child;
    return AnimatedBuilder(
      animation: controller,
      child: RepaintBoundary(key: _boundary, child: widget.child),
      builder: (context, child) {
        final closing = controller.paneId == widget.paneId;
        final t = closing ? controller.animation.value : 0.0;
        final travel = Curves.easeInOutCubic.transform(t);
        final rect = controller.source;
        final movement =
            (controller.target - const Offset(11, 11) - rect.topLeft) * travel;
        final transform = Matrix4.identity()
          ..translateByDouble(movement.dx, movement.dy, 0, 1)
          ..scaleByDouble(
            closing ? 1 - (1 - 22 / rect.width) * travel : 1,
            closing ? 1 - (1 - 22 / rect.height) * travel : 1,
            1,
            1,
          );
        final hasSnapshot = closing && controller.snapshot != null;
        return IgnorePointer(
          ignoring: closing,
          child: CustomPaint(
            foregroundPainter: hasSnapshot ? _GeniePainter(controller) : null,
            child: Transform(
              transform: hasSnapshot ? Matrix4.identity() : transform,
              child: Opacity(
                opacity: hasSnapshot
                    ? 0
                    : 1 -
                          Curves.easeIn.transform(
                            ((t - .86) / .14).clamp(0, 1),
                          ),
                child: child,
              ),
            ),
          ),
        );
      },
    );
  }
}
