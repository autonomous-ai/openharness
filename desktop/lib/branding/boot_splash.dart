// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:async';
import 'dart:io' show Platform;
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'brand_mark.dart';
import 'brand_prefs.dart';
import '../fleet/neon.dart';

/// The cold-launch splash, off until a boot logo is chosen in Settings, Appearance (the Harness
/// icon, the system's own Omarchy wordmark read from /usr/share/omarchy at runtime, or a picture)
/// lights up in the theme's accent: a bloom that breathes, a shimmer band cut at the Omarchy
/// chamfer's 45 degrees, one scan line down the screen, then a quick handoff.
///
/// It says one thing, "the app is up and following your theme", and gets out of the way:
/// - the app builds and runs underneath from the first frame, so nothing waits on the splash;
/// - 1.5 s end to end, a click or any key skips it to a 180 ms fade;
/// - once per process: a window re-opened (the widget rebuilt) never shows it again;
/// - reduced motion: a static, lit logo held for 0.9 s, still skippable;
/// - boot logo "None", or `HARNESS_NO_SPLASH=1`, turns it off.
class BootSplash extends StatefulWidget {
  const BootSplash({super.key, required this.child, this.brand});

  final Widget child;

  /// Where the logo choice comes from; the app's [brandPrefsStore] when null.
  final BrandPrefsStore? brand;

  static const overlayKey = ValueKey('boot-splash');
  static const total = Duration(milliseconds: 1500);
  static const reducedHold = Duration(milliseconds: 900);

  static bool _shown = false;
  static final bool _disabled = const bool.fromEnvironment('HARNESS_NO_SPLASH') || (!kIsWeb && Platform.environment['HARNESS_NO_SPLASH'] == '1');

  @visibleForTesting
  static void debugReset() => _shown = false;

  @override
  State<BootSplash> createState() => BootSplashState();
}

class BootSplashState extends State<BootSplash> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: BootSplash.total);
  bool _visible = false;
  bool _animated = true;
  Timer? _hold;
  late ResolvedLogo _logo;

  /// False under reduced motion: the logo is drawn once and held.
  bool get animated => _animated;

  @override
  void initState() {
    super.initState();
    _logo = (widget.brand ?? brandPrefsStore).resolveBootLogo();
    if (!BootSplash._shown && !BootSplash._disabled && _logo.kind != BootLogo.none) {
      BootSplash._shown = true;
      _visible = true;
      HardwareKeyboard.instance.addHandler(_onKey);
      _c.addStatusListener((s) {
        if (s == AnimationStatus.completed) _finish();
      });
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_visible || _c.isAnimating || _hold != null) return;
    _animated = !Motion.reducedOf(context);
    if (_animated) {
      _c.forward();
    } else {
      _c.value = 0.6; // a lit, settled frame
      _hold = Timer(BootSplash.reducedHold, _finish);
    }
  }

  bool _onKey(KeyEvent e) {
    if (!_visible) return false;
    if (e is KeyDownEvent) skip();
    return true; // the skipping key never reaches the app underneath
  }

  /// Jump to the handoff; a no-op once it is under way.
  void skip() {
    if (!_visible) return;
    _hold?.cancel();
    if (!_animated) return _finish();
    if (_c.value >= 0.84) return;
    _c.animateTo(1, duration: const Duration(milliseconds: 180), curve: Curves.easeOut);
  }

  void _finish() {
    if (!_visible) return;
    HardwareKeyboard.instance.removeHandler(_onKey);
    if (mounted) setState(() => _visible = false);
  }

  @override
  void dispose() {
    _hold?.cancel();
    HardwareKeyboard.instance.removeHandler(_onKey);
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_visible) return widget.child;
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        GestureDetector(
          key: BootSplash.overlayKey,
          behavior: HitTestBehavior.opaque,
          onTap: skip,
          child: RepaintBoundary(
            child: AnimatedBuilder(animation: _c, builder: (context, _) => _frame(_c.value)),
          ),
        ),
      ],
    );
  }

  Widget _frame(double t) {
    final neon = Neon.current();
    double seg(double a, double b) => ((t - a) / (b - a)).clamp(0.0, 1.0);
    final enter = Curves.easeOutCubic.transform(seg(0, 0.28));
    final exit = Curves.easeInCubic.transform(seg(0.82, 1));
    final breath = 0.5 - 0.5 * math.cos(seg(0.1, 0.82) * 2 * math.pi * 1.5);
    final bloom = _animated ? enter * (0.45 + 0.4 * breath) : 0.7;
    final shimmer = _animated ? seg(0.22, 0.7) : -1.0;
    final scan = _animated ? seg(0.05, 0.62) : -1.0;
    const h = 100.0;
    BrandLogo mark(double glow) => BrandLogo(logo: _logo, accent: neon.accent, glow: glow, height: h);
    final aspect = mark(0).aspect;
    return Opacity(
      opacity: 1 - exit,
      child: ColoredBox(
        color: neon.background,
        child: CustomPaint(
          painter: _SplashPainter(accent: neon.accent, scan: scan, frame: _animated ? seg(0.08, 0.5) : 1, box: Size(h * aspect + 60, h + 60)),
          child: Center(
            child: Transform.scale(
              scale: (_animated ? 0.94 + 0.06 * enter : 1) + 0.05 * exit,
              child: Opacity(
                opacity: _animated ? enter : 1,
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    // The chosen logo with its bloom breathing.
                    mark(bloom),
                    if (shimmer >= 0 && shimmer < 1)
                      Positioned.fill(
                        child: ShaderMask(
                          blendMode: BlendMode.srcATop,
                          shaderCallback: (r) => LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [Colors.transparent, Colors.white.withValues(alpha: 0.85), Colors.transparent],
                            stops: [(shimmer * 1.4 - 0.25).clamp(0.0, 1.0), (shimmer * 1.4 - 0.15).clamp(0.0, 1.0), (shimmer * 1.4 - 0.05).clamp(0.0, 1.0)],
                          ).createShader(Rect.fromLTWH(0, 0, r.width, r.width)), // square rect: the band runs at 45 degrees
                          child: mark(0),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SplashPainter extends CustomPainter {
  const _SplashPainter({required this.accent, required this.scan, required this.frame, required this.box});

  final Size box;

  final Color accent;
  final double scan; // 0..1 down the screen, <0 when none
  final double frame; // 0..1 how much of the chamfered frame is drawn

  @override
  void paint(Canvas canvas, Size size) {
    // Scanlines at 7 percent: a transition screen, and they stay off the wordmark's own pixels
    // only by being faint (design/attention-motion.md allows them on transition screens).
    final lines = Paint()..color = accent.withValues(alpha: 0.07);
    for (var y = 0.0; y < size.height; y += 3) {
      canvas.drawRect(Rect.fromLTWH(0, y, size.width, 1), lines);
    }
    if (scan >= 0 && scan < 1) {
      final y = size.height * scan;
      canvas.drawRect(
        Rect.fromLTWH(0, y - 24, size.width, 48),
        Paint()
          ..shader = ui.Gradient.linear(Offset(0, y - 24), Offset(0, y + 24), [accent.withValues(alpha: 0), accent.withValues(alpha: 0.18), accent.withValues(alpha: 0)], const [0, 0.5, 1]),
      );
    }
    // The chamfered frame around the wordmark draws itself, the Omarchy bevel as the border.
    final rect = Rect.fromCenter(center: size.center(Offset.zero), width: box.width, height: box.height);
    final metric = chamferPath(rect, 18).computeMetrics().first;
    canvas.drawPath(
      metric.extractPath(0, metric.length * frame),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = accent.withValues(alpha: 0.55),
    );
  }

  @override
  bool shouldRepaint(_SplashPainter old) => old.accent != accent || old.scan != scan || old.frame != frame || old.box != box;
}
